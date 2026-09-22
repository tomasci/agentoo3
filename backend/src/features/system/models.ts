// The real, current list of models this box's Claude Code can use — the
// source of truth is Query.supportedModels() from the agent SDK, not the
// Console-only GET /v1/models: that endpoint needs an x-api-key and is dark
// on every box that authenticates with CLAUDE_CODE_OAUTH_TOKEN instead, and
// it returns wire ids only, knowing nothing about the aliases and brackets
// (`opus[1m]`) that actually reach an agent's `model` frontmatter or
// Options.model. supportedModels() returns exactly the string set legal
// there, because it comes from the same CLI build that parses them.
//
// Cached the same way features/docker/hosts.ts caches `tailscale status`: a
// module-level `cache` plus an `inFlight` promise that dedups concurrent
// callers onto one probe. That dedup is not optional here either — each
// probe spawns a full CLI subprocess, and several library-page loads landing
// in the same tick must not each start their own.
//
// Deliberately does NOT gate on `hasClaudeCredential` (env.ts:148 —
// ANTHROPIC_API_KEY || CLAUDE_CODE_OAUTH_TOKEN) the way
// queue/session-run.worker.ts and features/ideas/prompt-service.ts gate
// running a real turn. Those gate because running a turn is expensive and
// its only credential path this app knows about is one of those two env
// vars. Listing models is neither: Claude Code can be — and, on a box
// provisioned via `claude login` rather than `claude setup-token`, normally
// is — authenticated entirely through `~/.claude`, with neither env var set,
// and a probe is one short-lived subprocess bounded by PROBE_TIMEOUT_MS and,
// on failure, retried at most once every MODELS_FAILURE_TTL_MS. Gating this
// endpoint on the env-var check would permanently hide the real list (and
// any model newer than the hardcoded fallback) on exactly that box. A
// missing credential of every kind still degrades to the fallback list —
// see probeModels()'s catch in getModels() — it just no longer short-circuits
// before finding out.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '@/lib/logger'
import { FALLBACK_MODELS, type ModelOption } from '@/library/models'
import { modelOptionSchema } from './schema'

export interface ModelsResult {
  models: ModelOption[]
  source: 'live' | 'fallback'
  fetchedAt: string
}

/** Model releases are a weeks-scale event; no reason to re-probe more than a
 * few times a day. */
export const MODELS_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How long a failed attempt is trusted before trying again. Short on
 * purpose: whatever broke the probe — no credential anywhere, a CLI that
 * cannot spawn, a network blip — is often fixed within minutes, and caching
 * that negative for the full TTL above would keep this reading as broken for
 * hours after the fix landed.
 */
export const MODELS_FAILURE_TTL_MS = 5 * 60 * 1000

/** The only timeout mechanism the SDK offers for a control request. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Opens the control channel without ever starting a turn. Control requests
 * (supportedModels included) are only available in streaming input mode —
 * see Query's own doc on every control method — and streaming input mode
 * means `prompt` is an AsyncIterable rather than a string. One that never
 * yields never sends a user message, so no turn runs and nothing is spent;
 * `supportedModels()` only needs the CLI's init handshake to have completed.
 */
async function* noMessages(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

/**
 * Validates what `supportedModels()` actually handed back before any of it is
 * trusted or cached. `supportedModels()` is `(await this.initialization).models`
 * in the SDK itself — a CLI build whose init response carries no `models` key,
 * or a malformed one, resolves that straight through with no validation of
 * its own, and @hono/zod-openapi only validates requests, never a handler's
 * own return value. Parsing here is what keeps a shape the SDK changes (or a
 * bug in it) from being cached for MODELS_TTL_MS and served as a 200 that
 * violates modelsResponseSchema.
 *
 * A top-level shape that is not an array (null, undefined, a bare string, ...)
 * cannot be salvaged at all and is thrown, so it is handled by the same catch
 * in getModels() a rejected `supportedModels()` call already goes through —
 * one failure path, not two.
 *
 * A single malformed *entry* inside an otherwise-good array is not treated
 * the same way: it is dropped and logged, and every entry that does parse is
 * still returned as a live result. Chosen over discarding the whole probe,
 * matching the precedent in library/index.ts's listAgents (a malformed agent
 * file is skipped, not fatal to the rest of the directory) — one model
 * description in a shape this app does not yet recognise should not cost the
 * operator every other real, live model for MODELS_TTL_MS. The degenerate
 * case — every entry in a non-empty array is malformed — falls out of this
 * the same way: the surviving list is empty, but `source` stays 'live',
 * because the top-level shape was exactly what was expected; only the shape
 * that fails to prove itself is even a list is a failed probe.
 */
function parseModelOptions(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `supportedModels() resolved ${raw === null ? 'null' : typeof raw}, not an array of models`,
    )
  }

  const models: ModelOption[] = []
  raw.forEach((entry, index) => {
    const parsed = modelOptionSchema.safeParse(entry)
    if (parsed.success) {
      models.push(parsed.data)
      return
    }
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    logger.warn(
      `Query.supportedModels() entry ${index} does not match the expected shape (${reason}) — dropping it, keeping the rest`,
    )
  })
  return models
}

async function probeModels(): Promise<ModelOption[]> {
  const abortController = new AbortController()
  // Armed, and cleared, from *outside* the block that constructs `q`: if
  // `query()` itself throws (the SDK cannot spawn the CLI at all — missing
  // binary, bad pathToClaudeCodeExecutable), there is no `q` for an inner
  // finally to hang the clear off, and a timer armed before an outer
  // try/finally like this one would never be cleared — it would sit on the
  // event loop for the full PROBE_TIMEOUT_MS and then abort a controller
  // nobody is still awaiting.
  const timeout = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS)
  try {
    const q = query({
      prompt: noMessages(),
      options: { permissionMode: 'bypassPermissions', abortController },
    })
    try {
      const raw = await q.supportedModels()
      return parseModelOptions(raw)
    } finally {
      // Every return path out of this inner block — a good result, a
      // rejection, or parseModelOptions() throwing on a bad shape — goes
      // through here, or this leaks the CLI subprocess `query()` just
      // spawned.
      q.close()
    }
  } finally {
    clearTimeout(timeout)
  }
}

function fallbackResult(): ModelsResult {
  return { models: FALLBACK_MODELS, source: 'fallback', fetchedAt: new Date().toISOString() }
}

let cache: { at: number; value: ModelsResult } | null = null
// Deduplicates concurrent callers onto one spawn, exactly as
// getTailscaleAddresses does — see that function's identical comment.
let inFlight: Promise<ModelsResult> | null = null

function ttlFor(source: ModelsResult['source']): number {
  return source === 'live' ? MODELS_TTL_MS : MODELS_FAILURE_TTL_MS
}

/**
 * The model list this box can actually offer, live if it can be reached and
 * the built-in alias list otherwise. Never rejects and never represents a
 * failure any other way: a non-200 here would make react-query retry and
 * make the editor that calls this look broken when the honest answer is
 * "here is the built-in list, pick from it."
 */
export async function getModels(): Promise<ModelsResult> {
  const now = Date.now()
  if (cache && now - cache.at < ttlFor(cache.value.source)) return cache.value

  if (inFlight) return inFlight

  inFlight = probeModels()
    .then(
      (models): ModelsResult => ({ models, source: 'live', fetchedAt: new Date().toISOString() }),
    )
    .catch((error) => {
      logger.warn(
        `Query.supportedModels() failed: ${String(error)} — falling back to the built-in list`,
      )
      return fallbackResult()
    })
    .then((value) => {
      cache = { at: Date.now(), value }
      inFlight = null
      return value
    })
  return inFlight
}

/** Test-only: setup-env-style state reset between tests. */
export function resetModelsCacheForTests(): void {
  cache = null
  inFlight = null
}
