// The Usage page: this box's claude.ai plan rate limits (5-hour / weekly
// utilization and reset times), the account Claude Code is authenticated as,
// and what has been consuming the plan.
//
// Two independent sources feed `limits`, and they disagree about units:
//   - A *live* probe (Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_
//     THIS_API_YET — see getUsageExperimental() below for why the SDK's own
//     name for this is only spelled out once) needs profile-scope auth
//     (`claude login`); a `claude setup-token` credential — CLAUDE_CODE_
//     OAUTH_TOKEN, inference-only scope — gets `rate_limits_available: false`
//     and `rate_limits: null` every time, verified against this box. Its
//     `utilization` is already a percent 0-100 and `resets_at` an ISO string.
//   - The *observed* fallback is the newest `rate_limit_event` row in the
//     `messages` table: every SDK message of every session is stored there
//     (see session-run.worker.ts's appendMessage), and the SDK emits one of
//     these whenever a turn's rate-limit status changes. Its
//     `payload.rate_limit_info.utilization` is a FRACTION 0-1 and its
//     `resetsAt` is UNIX SECONDS — this module is what normalises both onto
//     the wire shape (percent 0-100, ISO), never the caller.
// Precedence: live wins when it actually has non-null rate_limits; the
// observed row is only read when it does not.
//
// Probed the same way features/system/models.ts probes supportedModels():
// one query() opened with a never-yielding prompt (no turn runs, nothing is
// spent), permissionMode 'bypassPermissions', an AbortController bounding the
// whole probe, `q.close()` in a finally, and a module-level cache + inFlight
// dedup so concurrent page loads collapse onto one CLI subprocess. The
// difference from models.ts: this probe makes three sequential control calls
// on the one spawned `Query`, and each is caught independently — accountInfo()
// succeeding while the behaviors scan times out must still report the account
// and whatever limits the SDK already handed back, not discard everything
// because the last call in the sequence failed.
//
// Deliberately does NOT gate on hasClaudeCredential — same reasoning as
// models.ts's own header comment: a box authenticated purely through
// ~/.claude has neither env var set, and gating here would permanently hide
// this page's data on exactly that box.

import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { messages } from '@/db/schema'
import { logger } from '@/lib/logger'
import type {
  UsageAccountDto,
  UsageBreakdownDto,
  UsageLimitsDto,
  UsageOverageDto,
  UsagePeriodDto,
  UsageResponseDto,
  UsageWindowDto,
  UsageWindowKey,
} from './schema'

/** How long a live-or-degraded probe result is trusted before re-probing.
 * Rate-limit utilization moves in minutes, not hours, but a CLI subprocess
 * spawn per page load (this page is expected to poll) is real cost for a
 * number that has not meaningfully changed a second later. */
export const USAGE_TTL_MS = 60_000

/** How long a probe where every one of its three calls failed is trusted
 * before retrying — short, on the same reasoning as models.ts's
 * MODELS_FAILURE_TTL_MS: whatever broke it (no CLI, a network blip) is often
 * fixed within minutes, and 60s of that read as "broken" is cheap to shorten. */
export const USAGE_FAILURE_TTL_MS = 15_000

/** The only timeout mechanism the SDK offers for a control request, bounding
 * all three sequential calls together, not each on its own — see probeUsage(). */
const PROBE_TIMEOUT_MS = 30_000

const WINDOW_KEYS_IN_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const satisfies readonly UsageWindowKey[]

// --- opening the control channel without ever starting a turn ---------------
// Identical to models.ts's noMessages(): control requests only work in
// streaming-input mode, and a prompt that never yields never sends a user
// message, so no turn runs and nothing is spent.

async function* noMessages(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

/**
 * The one place this module spells out the SDK's real (and self-admittedly
 * temporary) method name. Both usage calls in probeUsage() go through this,
 * so the day the SDK stabilises it, one line changes rather than two.
 */
function getUsageExperimental(q: Query, opts?: { skipBehaviors?: boolean }) {
  return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts)
}

// --- validating what the SDK handed back, before any of it is trusted ------
//
// Nothing here throws past its own safeParse: a shape mismatch in one part
// (a bad rate_limits block, a bad behaviors block, accountInfo() resolving
// something unexpected) degrades that one part to null and logs a warn,
// exactly like models.ts's parseModelOptions degrades one bad model entry
// without discarding the rest of a good list.

const rawAccountInfoSchema = z
  .object({
    email: z.string().optional(),
    organization: z.string().optional(),
    subscriptionType: z.string().optional(),
    tokenSource: z.string().optional(),
    apiKeySource: z.string().optional(),
    apiProvider: z.string().optional(),
  })
  // AccountInfo may grow fields this app does not describe yet; passthrough
  // keeps an unrecognised extra field from failing the whole parse.
  .passthrough()
type RawAccountInfo = z.infer<typeof rawAccountInfoSchema>

function parseAccountInfo(raw: unknown): RawAccountInfo | null {
  const parsed = rawAccountInfoSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  logger.warn(`accountInfo() did not match the expected shape: ${parsed.error.issues[0]?.message}`)
  return null
}

const rawWindowSchema = z
  .object({
    utilization: z.number().nullable().optional(),
    resets_at: z.string().nullable().optional(),
  })
  .nullable()
  .optional()

const rawRateLimitsSchema = z
  .object({
    five_hour: rawWindowSchema,
    seven_day: rawWindowSchema,
    seven_day_opus: rawWindowSchema,
    seven_day_sonnet: rawWindowSchema,
    seven_day_oauth_apps: rawWindowSchema,
    model_scoped: z
      .array(
        z.object({
          display_name: z.string(),
          utilization: z.number().nullable().optional(),
          resets_at: z.string().nullable().optional(),
        }),
      )
      .optional(),
    extra_usage: z
      .object({
        is_enabled: z.boolean(),
        monthly_limit: z.number().nullable().optional(),
        used_credits: z.number().nullable().optional(),
        utilization: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable()
type RawRateLimits = z.infer<typeof rawRateLimitsSchema>

const rawBehaviorPeriodSchema = z.object({
  request_count: z.number(),
  session_count: z.number(),
  behaviors: z.array(z.object({ key: z.string(), pct: z.number(), count: z.number() })),
  agents: z.array(z.object({ name: z.string(), pct: z.number() })),
  skills: z.array(z.object({ name: z.string(), pct: z.number() })),
  plugins: z.array(z.object({ name: z.string(), pct: z.number() })),
  mcp_servers: z.array(z.object({ name: z.string(), pct: z.number() })),
})
type RawBehaviorPeriod = z.infer<typeof rawBehaviorPeriodSchema>

const rawBehaviorsSchema = z
  .object({ day: rawBehaviorPeriodSchema, week: rawBehaviorPeriodSchema })
  .nullable()

/** What one `usage_EXPERIMENTAL...()` call resolved to, validated. Each field
 * degrades to null on its own — a malformed `rate_limits` block must not cost
 * a good `behaviors` block from the same response, or vice versa. */
interface ParsedUsageCall {
  subscriptionType: string | null
  rateLimits: RawRateLimits | null
  behaviors: NonNullable<z.infer<typeof rawBehaviorsSchema>> | null
}

function parseUsageCall(raw: unknown, callLabel: string): ParsedUsageCall {
  if (typeof raw !== 'object' || raw === null) {
    logger.warn(`${callLabel} resolved ${raw === null ? 'null' : typeof raw}, not an object`)
    return { subscriptionType: null, rateLimits: null, behaviors: null }
  }
  const obj = raw as Record<string, unknown>
  const subscriptionType = typeof obj.subscription_type === 'string' ? obj.subscription_type : null

  let rateLimits: RawRateLimits | null = null
  // rate_limits_available is the SDK's own gate — a truthy rate_limits object
  // on a false/absent flag is not treated as "live" data (see the header
  // comment: the shipped meaning of the flag is what this app trusts, not the
  // mere presence of the object it guards).
  if (obj.rate_limits_available === true) {
    const parsed = rawRateLimitsSchema.safeParse(obj.rate_limits)
    if (parsed.success) rateLimits = parsed.data
    else
      logger.warn(
        `${callLabel} rate_limits did not match the expected shape: ${parsed.error.issues[0]?.message}`,
      )
  }

  let behaviors: NonNullable<z.infer<typeof rawBehaviorsSchema>> | null = null
  if (obj.behaviors != null) {
    const parsed = rawBehaviorsSchema.safeParse(obj.behaviors)
    if (parsed.success) behaviors = parsed.data
    else
      logger.warn(
        `${callLabel} behaviors did not match the expected shape: ${parsed.error.issues[0]?.message}`,
      )
  }

  return { subscriptionType, rateLimits, behaviors }
}

// --- the probe: one CLI spawn, three sequential control calls ---------------

interface ProbeResult {
  account: RawAccountInfo | null
  /** subscription_type from whichever usage call answered one — used for
   * `account.subscriptionType` fallback and to help pick which call's
   * rate_limits to prefer. */
  subscriptionType: string | null
  /** rate_limits from the skipBehaviors call, preferred: it is the one made
   * for exactly this purpose and returns in ~10ms on this box. */
  skipCallRateLimits: RawRateLimits | null
  /** rate_limits from the full call — used only if the skip call's own
   * rate_limits came back null (that call failed, or genuinely had none),
   * so a successful full call is not wasted just because it ran second. */
  fullCallRateLimits: RawRateLimits | null
  behaviors: NonNullable<z.infer<typeof rawBehaviorsSchema>> | null
  /** When this probe attempt finished — the `asOf` a 'live' limits reading
   * reports, which must be the probe's own time, not whenever a cached
   * result is later served from. */
  probedAt: string
  /** One readable sentence per call that threw or was aborted by the
   * timeout; empty when every call succeeded. Joined into `probeError`. */
  errors: string[]
  /** Whether `q.close()` itself threw. Never surfaced to the caller (the
   * three calls above already gathered whatever they gathered, and a close()
   * failure costs none of it — see the finally block below) — only used by
   * getProbe() to decide this particular reading is not trustworthy enough
   * to cache: a subprocess whose teardown did not go as expected is reason
   * enough to spawn fresh next time rather than serve this one again for up
   * to USAGE_TTL_MS. */
  closeFailed: boolean
}

async function probeUsage(): Promise<ProbeResult> {
  const abortController = new AbortController()
  // Armed outside the try that constructs `q`, cleared in the outer finally —
  // see models.ts's probeModels() for why: if query() itself throws, there is
  // no `q` for an inner finally to hang the clear off.
  const timeout = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS)

  const result: ProbeResult = {
    account: null,
    subscriptionType: null,
    skipCallRateLimits: null,
    fullCallRateLimits: null,
    behaviors: null,
    probedAt: new Date().toISOString(),
    errors: [],
    closeFailed: false,
  }

  try {
    let q: Query
    try {
      q = query({
        prompt: noMessages(),
        options: { permissionMode: 'bypassPermissions', abortController },
      })
    } catch (error) {
      result.errors.push(`Could not start Claude Code: ${String(error)}`)
      return result
    }

    try {
      try {
        result.account = parseAccountInfo(await q.accountInfo())
      } catch (error) {
        result.errors.push(`Could not read account info: ${String(error)}`)
      }

      try {
        const skip = parseUsageCall(
          await getUsageExperimental(q, { skipBehaviors: true }),
          'usage (rate limits)',
        )
        result.skipCallRateLimits = skip.rateLimits
        result.subscriptionType = skip.subscriptionType
      } catch (error) {
        result.errors.push(`Could not read plan rate limits: ${String(error)}`)
      }

      try {
        const full = parseUsageCall(await getUsageExperimental(q), 'usage (behaviors)')
        result.fullCallRateLimits = full.rateLimits
        result.behaviors = full.behaviors
        result.subscriptionType ??= full.subscriptionType
      } catch (error) {
        result.errors.push(`Could not read usage behaviors: ${String(error)}`)
      }
    } finally {
      // Every path out of this block — three successes, any mix of thrown
      // calls, or the timeout aborting whichever call was in flight — goes
      // through here, or this leaks the CLI subprocess query() just spawned.
      // A close() failure must not fail the probe: the three calls above
      // already gathered whatever they gathered, and none of it is worth
      // discarding just because tearing the subprocess down afterwards had
      // trouble — see models.ts's own precedent of never letting cleanup
      // fail the read it is cleaning up after. Left for getProbe() to decide
      // not to cache (see ProbeResult.closeFailed), instead of turning the
      // whole `getUsage()` request into a rejection the way an uncaught
      // throw here would (see this module's header comment on why nothing
      // past this file's own boundary should ever propagate a raw error).
      try {
        q.close()
      } catch (error) {
        logger.warn(`q.close() failed: ${String(error)}`)
        result.closeFailed = true
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  result.probedAt = new Date().toISOString()
  return result
}

// --- mapping the SDK's live shape onto the wire shape -----------------------

function pushWindow(
  out: UsageWindowDto[],
  key: UsageWindowKey,
  label: string | null,
  window: { utilization?: number | null; resets_at?: string | null } | null | undefined,
): void {
  if (!window) return
  out.push({
    key,
    label,
    utilization: window.utilization ?? null,
    resetsAt: window.resets_at ?? null,
  })
}

function liveLimitsFrom(rateLimits: RawRateLimits, probedAt: string): UsageLimitsDto {
  const windows: UsageWindowDto[] = []
  for (const key of WINDOW_KEYS_IN_ORDER) pushWindow(windows, key, null, rateLimits?.[key])
  for (const model of rateLimits?.model_scoped ?? []) {
    pushWindow(windows, 'model', model.display_name, model)
  }

  const extra = rateLimits?.extra_usage
  const extraUsage = extra
    ? {
        isEnabled: extra.is_enabled,
        monthlyLimit: extra.monthly_limit ?? null,
        usedCredits: extra.used_credits ?? null,
        utilization: extra.utilization ?? null,
        currency: extra.currency ?? null,
      }
    : null

  return {
    source: 'live',
    asOf: probedAt,
    // The live SDK response has no equivalent of the observed event's own
    // `status` verdict — only a per-window utilization/reset pair.
    status: null,
    windows,
    overage: null,
    extraUsage,
  }
}

/** A stored fraction (0-1) converted to a percent (0-100), rounded to at most
 * two decimal places. `fraction * 100` alone carries binary floating-point
 * noise onto the wire (0.07 * 100 === 7.000000000000001) — this is the one
 * place both observed-path conversion sites go through, so neither drifts
 * out of step with the other. The live path's own `utilization` is already
 * a percent from the SDK and never passes through here. */
function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 10000) / 100
}

/** Converts a stored unix-seconds timestamp into an ISO string without ever
 * throwing, on the same "one bad field costs that field" principle as the
 * rest of this observed-payload path. Two hazards, both seen from this box's
 * stored rows: a value so far outside the range `Date` can represent that
 * `new Date(x * 1000).toISOString()` throws `RangeError: Invalid Date` (e.g.
 * x >= ~8.64e12), and a value that was clearly recorded in *milliseconds* by
 * mistake (a real resetsAt a few hours out is ~1.8e9 in seconds but ~1.8e12
 * in milliseconds). A seconds value above 1e11 is already year 5138 or
 * later — no genuine rate-limit reset is that far out — so anything past
 * that threshold is assumed to be milliseconds and divided down rather than
 * nulled outright, recovering the plausible intended date; whatever is still
 * unrepresentable after that (or non-finite to begin with) degrades to null
 * instead of throwing. */
function unixSecondsToIso(value: number): string | null {
  if (!Number.isFinite(value)) return null
  const seconds = Math.abs(value) > 1e11 ? value / 1000 : value
  const ms = seconds * 1000
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// --- the observed fallback: the newest rate_limit_event row -----------------
//
// unifiedWindows is not in the SDK's public types (sdk.d.ts's SDKRateLimitInfo
// has no such field) — treated here as undocumented and validated the same as
// everything else that reaches this boundary from outside the process.
//
// This field set is not a stable public contract — it is whatever a given CLI
// build happened to emit into `messages.payload`. So every field below
// degrades to undefined on its own type mismatch (`.catch(undefined)`) rather
// than failing the object's parse: a future CLI writing a `status` value this
// app's enum does not yet know about must cost that one field, not the whole
// reading (which would otherwise drop this page from 'observed' to 'none' over
// a single unrecognised label). Same reasoning for a single unifiedWindows
// entry that does not parse — `observedWindowSchema` itself `.catch(undefined)`s
// so `record()` still succeeds, leaving the other windows in the map intact.

// Each field its own `.catch(undefined)`, not just the object as a whole: a
// wrong-typed or null `utilization` (or `resetsAt`) must cost that one field,
// not the whole window — see this file's header comment on why a single bad
// field here must never read as "this window was never reported." Only a
// window value that is not an object at all (a string, an array, ...) fails
// the outer `.catch(undefined)` and is dropped, same as before.
const observedWindowSchema = z
  .object({
    utilization: z.number().optional().catch(undefined),
    resetsAt: z.number().optional().catch(undefined),
  })
  .optional()
  .catch(undefined)

const observedRateLimitInfoSchema = z
  .object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional().catch(undefined),
    resetsAt: z.number().optional().catch(undefined),
    rateLimitType: z.string().optional().catch(undefined),
    utilization: z.number().optional().catch(undefined),
    overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional().catch(undefined),
    overageDisabledReason: z.string().optional().catch(undefined),
    isUsingOverage: z.boolean().optional().catch(undefined),
    overageInUse: z.boolean().optional().catch(undefined),
    unifiedWindows: z.record(z.string(), observedWindowSchema).optional().catch(undefined),
  })
  .passthrough()

const observedPayloadSchema = z
  .object({ rate_limit_info: observedRateLimitInfoSchema })
  .passthrough()

const WINDOW_KEY_SET = new Set<string>(WINDOW_KEYS_IN_ORDER)

function observedLimitsFrom(payload: unknown, createdAt: Date): UsageLimitsDto | null {
  const parsed = observedPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    logger.warn(
      `rate_limit_event payload did not match the expected shape: ${parsed.error.issues[0]?.message}`,
    )
    return null
  }
  const info = parsed.data.rate_limit_info

  const windows: UsageWindowDto[] = []
  if (info.unifiedWindows) {
    // Only keys this app's window enum knows about; an unrecognised key
    // (a future window this app has not been taught yet) is ignored rather
    // than invented a slot for.
    for (const key of WINDOW_KEYS_IN_ORDER) {
      const w = info.unifiedWindows[key]
      if (!w) continue
      windows.push({
        key,
        label: null,
        utilization: w.utilization != null ? fractionToPercent(w.utilization) : null,
        resetsAt: w.resetsAt != null ? unixSecondsToIso(w.resetsAt) : null,
      })
    }
  }
  // Falls back to the single top-level rateLimitType/utilization/resetsAt
  // whenever `unifiedWindows` produced zero known windows — not only when it
  // was absent/malformed. A `unifiedWindows` that came back non-empty but
  // entirely made of keys this app does not recognise yet (a future window)
  // must not hide an otherwise-valid top-level reading; that is a real,
  // usable window this app already knows how to describe.
  if (windows.length === 0 && info.rateLimitType && WINDOW_KEY_SET.has(info.rateLimitType)) {
    windows.push({
      key: info.rateLimitType as UsageWindowKey,
      label: null,
      utilization: info.utilization != null ? fractionToPercent(info.utilization) : null,
      resetsAt: info.resetsAt != null ? unixSecondsToIso(info.resetsAt) : null,
    })
  }

  const overagePresent =
    info.overageStatus !== undefined ||
    info.overageDisabledReason !== undefined ||
    info.isUsingOverage !== undefined ||
    info.overageInUse !== undefined
  const overage: UsageOverageDto = overagePresent
    ? {
        status: info.overageStatus ?? null,
        disabledReason: info.overageDisabledReason ?? null,
        inUse: info.isUsingOverage ?? info.overageInUse ?? null,
      }
    : null

  return {
    source: 'observed',
    asOf: createdAt.toISOString(),
    status: info.status ?? null,
    windows,
    overage,
    extraUsage: null,
  }
}

/** The newest rate_limit_event row, or null if there has never been one on
 * this box. Its own function so a test can stub the database read without
 * touching Postgres — see tests/system-usage.test.ts. */
export async function readLatestRateLimitEvent(): Promise<{
  createdAt: Date
  payload: unknown
} | null> {
  const [row] = await db
    .select({ createdAt: messages.createdAt, payload: messages.payload })
    .from(messages)
    .where(eq(messages.type, 'rate_limit_event'))
    .orderBy(desc(messages.createdAt))
    .limit(1)
  return row ?? null
}

const EMPTY_LIMITS: UsageLimitsDto = {
  source: 'none',
  asOf: null,
  status: null,
  windows: [],
  overage: null,
  extraUsage: null,
}

async function resolveLimits(
  probe: ProbeResult,
  readEvent: () => Promise<{ createdAt: Date; payload: unknown } | null>,
): Promise<UsageLimitsDto> {
  const liveRateLimits = probe.skipCallRateLimits ?? probe.fullCallRateLimits
  if (liveRateLimits) {
    const live = liveLimitsFrom(liveRateLimits, probe.probedAt)
    // rate_limits_available: true with a `rate_limits` object that happens to
    // describe nothing (no window this app recognises, no model_scoped rows,
    // no extra_usage) is not meaningfully "live" — it is empty. Reporting
    // `source: 'live'` with nothing in it would hide a perfectly good observed
    // row below it, which is exactly the state this app is trying to answer
    // with. Anything live worth showing still short-circuits normally.
    if (live.windows.length > 0 || live.extraUsage) return live
  }

  // Not cached — see this module's header comment: cheap with
  // messages_rate_limit_idx, and it should reflect the latest turn, which a
  // 60s-old probe cache would otherwise mask.
  const row = await readEvent()
  if (row) {
    const observed = observedLimitsFrom(row.payload, row.createdAt)
    if (observed) return observed
  }
  return EMPTY_LIMITS
}

function toPeriodDto(period: RawBehaviorPeriod): UsagePeriodDto {
  return {
    requestCount: period.request_count,
    sessionCount: period.session_count,
    behaviors: period.behaviors,
    agents: period.agents,
    skills: period.skills,
    plugins: period.plugins,
    mcpServers: period.mcp_servers,
  }
}

function toBreakdownDto(behaviors: ProbeResult['behaviors']): UsageBreakdownDto {
  if (!behaviors) return null
  return { day: toPeriodDto(behaviors.day), week: toPeriodDto(behaviors.week) }
}

function toAccountDto(probe: ProbeResult): UsageAccountDto {
  if (!probe.account) return null
  return {
    subscriptionType: probe.subscriptionType ?? probe.account.subscriptionType ?? null,
    email: probe.account.email ?? null,
    organization: probe.account.organization ?? null,
    tokenSource: probe.account.tokenSource ?? null,
    apiKeySource: probe.account.apiKeySource ?? null,
    apiProvider: probe.account.apiProvider ?? null,
  }
}

// --- caching the probe, exactly like models.ts's getModels() ----------------

let cache: { at: number; value: ProbeResult } | null = null
// Deduplicates concurrent callers onto one spawn — several Usage-page loads
// (or polls) landing in the same tick must not each start their own probe.
let inFlight: Promise<ProbeResult> | null = null

/** Whether the probe came back with nothing at all — every one of
 * accountInfo(), the rate-limit call and the behaviors call either threw or
 * degraded to null at validation, including query() itself never spawning
 * (which never even attempts the three calls, so counting thrown errors
 * would undercount that as a "success"). This, not the error count, is what
 * the two TTLs below actually distinguish: a call that resolved to something
 * this app could not use (a malformed shape, or the well-formed
 * "rate_limits_available: false" this box always reports) still counts as
 * data if *any other* call produced some, since the CLI did answer. */
function probeGotNothing(result: ProbeResult): boolean {
  return (
    result.account === null &&
    result.skipCallRateLimits === null &&
    result.fullCallRateLimits === null &&
    result.behaviors === null
  )
}

function ttlFor(result: ProbeResult): number {
  return probeGotNothing(result) ? USAGE_FAILURE_TTL_MS : USAGE_TTL_MS
}

async function getProbe(): Promise<ProbeResult> {
  const now = Date.now()
  if (cache && now - cache.at < ttlFor(cache.value)) return cache.value
  if (inFlight) return inFlight

  inFlight = probeUsage()
    .catch((error): ProbeResult => {
      // probeUsage() is only ever supposed to resolve — every failure it
      // anticipates (a thrown call, a timed-out control request, q.close()
      // itself) is already caught inside it and folded into a ProbeResult.
      // Landing here means something it did not anticipate blew up, and
      // *that* is the bug this whole function exists to not repeat: the
      // original `inFlight = probeUsage().then(...)` had no rejection path
      // at all, so a rejection here left `inFlight` set to a rejected
      // promise forever — never cleared, never replaced — and every later
      // request just re-awaited the same rejection. Converting it into a
      // ProbeResult (mirroring models.ts's getModels() `.catch()`) is what
      // lets the `.then()` below still run and clear `inFlight`, and what
      // keeps `getUsage()`'s own "never rejects" guarantee true regardless
      // of what broke inside the probe.
      logger.warn(`the usage probe rejected outright: ${String(error)}`)
      return {
        account: null,
        subscriptionType: null,
        skipCallRateLimits: null,
        fullCallRateLimits: null,
        behaviors: null,
        probedAt: new Date().toISOString(),
        errors: [`The usage probe failed unexpectedly: ${String(error)}`],
        closeFailed: false,
      }
    })
    .then((value) => {
      // Not written to the cache when this probe's own close() failed — see
      // ProbeResult.closeFailed — so the very next call gets a clean spawn
      // instead of reusing a reading whose subprocess teardown did not go as
      // expected for up to USAGE_TTL_MS. Every other outcome, including the
      // all-null fallback from the .catch() above, is cached normally —
      // ttlFor()/probeGotNothing() already give a fully-failed reading the
      // short failure TTL on their own, with no special case needed here.
      if (!value.closeFailed) cache = { at: Date.now(), value }
      inFlight = null
      return value
    })
  return inFlight
}

/**
 * The full Usage page payload: always resolves, never rejects. A failed or
 * partially failed probe still answers 200 with whatever it did get plus a
 * readable `probeError`; the DB-observed limits (unlike the probe) are read
 * fresh on every call, since they are cheap and should reflect the latest
 * turn rather than up to USAGE_TTL_MS behind it.
 */
export async function getUsage(
  readEvent: () => Promise<{ createdAt: Date; payload: unknown } | null> = readLatestRateLimitEvent,
): Promise<UsageResponseDto> {
  const probe = await getProbe()
  const limits = await resolveLimits(probe, readEvent)

  return {
    fetchedAt: new Date().toISOString(),
    account: toAccountDto(probe),
    limits,
    breakdown: toBreakdownDto(probe.behaviors),
    probeError: probe.errors.length > 0 ? probe.errors.join('; ') : null,
  }
}

/** Test-only: setup-env-style state reset between tests. */
export function resetUsageCacheForTests(): void {
  cache = null
  inFlight = null
}
