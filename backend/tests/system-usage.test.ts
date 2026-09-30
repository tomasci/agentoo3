// GET /api/system/usage: features/system/usage.ts.
//
// The SDK is faked exactly as tests/system-models.test.ts fakes it — see that
// file's own notes on why `mock.module` swaps a module for the whole test
// run. The one difference here: a single fake `Query` answers three control
// methods (accountInfo, and usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_
// THIS_API_YET called twice, once with skipBehaviors), each independently
// scriptable per test.
//
// The database read is never exercised for real — getUsage() takes it as an
// injectable function (readLatestRateLimitEvent's own default), so every test
// below passes a stub returning a fixed row (or null) instead of touching
// Postgres. That is also why this file never imports '@/db/client'.

import { afterEach, expect, jest, mock, test } from 'bun:test'
import './setup-env'
// Side-effect only — see system-models.test.ts's identical import for why:
// registers zod's `.openapi()` extension before schema.ts is imported below.
import '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

/** Every call `query()` was made with. */
let queryCalls: { options: Record<string, unknown> }[] = []
/** How many times the fake query's `close()` ran — the subprocess this
 * module must never leak one of per probe. */
let closeCalls = 0

/** A believable "everything worked, but this box has no live limits" default
 * — the exact shape measured on a CLAUDE_CODE_OAUTH_TOKEN box (see usage.ts's
 * header comment). Each test overrides only what it needs. */
let accountInfoBehaviour: () => Promise<unknown> = () =>
  Promise.resolve({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' })
let skipCallBehaviour: (abort: AbortController | undefined) => Promise<unknown> = () =>
  Promise.resolve({ subscription_type: null, rate_limits_available: false, rate_limits: null })
let fullCallBehaviour: (abort: AbortController | undefined) => Promise<unknown> = () =>
  Promise.resolve({
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
    behaviors: null,
  })

function defaultSdkFactory() {
  return {
    query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
      queryCalls.push({ options: params.options })
      const abort = params.options.abortController as AbortController | undefined
      return {
        accountInfo: () => accountInfoBehaviour(),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts?: {
          skipBehaviors?: boolean
        }) => (opts?.skipBehaviors ? skipCallBehaviour(abort) : fullCallBehaviour(abort)),
        close: () => {
          closeCalls++
        },
      }
    },
  }
}

mock.module('@anthropic-ai/claude-agent-sdk', defaultSdkFactory)

const { getUsage, resetUsageCacheForTests, USAGE_TTL_MS, USAGE_FAILURE_TTL_MS } = await import(
  `${B}/features/system/usage.ts`
)
const { usageResponseSchema } = await import(`${B}/features/system/schema.ts`)

/** A stub for getUsage()'s injectable DB read — resolves to a fixed row (or
 * null for "no rate_limit_event has ever been recorded"). */
function reader(row: { createdAt: Date; payload: unknown } | null) {
  return () => Promise.resolve(row)
}
const NO_ROW = reader(null)

afterEach(() => {
  jest.useRealTimers()
  resetUsageCacheForTests()
  queryCalls = []
  closeCalls = 0
  accountInfoBehaviour = () =>
    Promise.resolve({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' })
  skipCallBehaviour = () =>
    Promise.resolve({ subscription_type: null, rate_limits_available: false, rate_limits: null })
  fullCallBehaviour = () =>
    Promise.resolve({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    })
  mock.module('@anthropic-ai/claude-agent-sdk', defaultSdkFactory)
})

/** Every getUsage() result must satisfy the same schema the route publishes —
 * nothing in @hono/zod-openapi checks a handler's return value against it, so
 * this has to happen here, at the boundary, the same as
 * system-models.test.ts's expectValidResponse. */
function expectValidResponse(result: unknown) {
  const parsed = usageResponseSchema.safeParse(result)
  if (!parsed.success) {
    throw new Error(
      `response did not match usageResponseSchema: ${JSON.stringify(parsed.error.issues)}\n` +
        JSON.stringify(result, null, 2),
    )
  }
}

// --- the live limits path -----------------------------------------------------

test('live rate_limits: percent and ISO pass through unchanged, model_scoped rows and extra_usage included', async () => {
  const liveRateLimits = {
    five_hour: { utilization: 42, resets_at: '2026-10-01T05:00:00.000Z' },
    seven_day: { utilization: 18.5, resets_at: '2026-10-06T00:00:00.000Z' },
    model_scoped: [
      { display_name: 'Fable', utilization: 5, resets_at: '2026-10-06T00:00:00.000Z' },
      { display_name: 'Opus', utilization: 60, resets_at: '2026-10-06T00:00:00.000Z' },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1234,
      utilization: 24.68,
      currency: 'usd',
    },
  }
  skipCallBehaviour = () =>
    Promise.resolve({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: liveRateLimits,
    })

  const result = await getUsage(NO_ROW)
  expectValidResponse(result)

  expect(result.limits.source).toBe('live')
  expect(result.limits.status).toBeNull()
  expect(result.limits.overage).toBeNull()
  expect(result.limits.windows).toEqual([
    { key: 'five_hour', label: null, utilization: 42, resetsAt: '2026-10-01T05:00:00.000Z' },
    { key: 'seven_day', label: null, utilization: 18.5, resetsAt: '2026-10-06T00:00:00.000Z' },
    { key: 'model', label: 'Fable', utilization: 5, resetsAt: '2026-10-06T00:00:00.000Z' },
    { key: 'model', label: 'Opus', utilization: 60, resetsAt: '2026-10-06T00:00:00.000Z' },
  ])
  expect(result.limits.extraUsage).toEqual({
    isEnabled: true,
    monthlyLimit: 5000,
    usedCredits: 1234,
    utilization: 24.68,
    currency: 'usd',
  })
  expect(result.account?.subscriptionType).toBe('max')
  // The DB is never consulted once a live reading exists.
  expect(result.limits.asOf).not.toBeNull()
})

test('a live rate_limits with rate_limits_available: false is not treated as live, even if rate_limits happens to be non-null', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({
      subscription_type: null,
      rate_limits_available: false,
      // Not a shape the real SDK would send alongside `false`, but the guard
      // must be the flag, never "rate_limits happens to be truthy" — see
      // usage.ts's own comment on parseUsageCall.
      rate_limits: { five_hour: { utilization: 99, resets_at: '2026-10-01T00:00:00.000Z' } },
    })

  const result = await getUsage(NO_ROW)
  expect(result.limits.source).toBe('none')
})

test('rate_limits_available: true with rate_limits: {} (no windows, no extra_usage) falls through to the observed row, not an empty "live"', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({ subscription_type: 'pro', rate_limits_available: true, rate_limits: {} })
  const createdAt = new Date('2026-09-29T12:00:00.000Z')
  const payload = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } }

  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)
  expect(result.limits.source).toBe('observed')
  expect(result.limits.windows).toEqual([
    { key: 'five_hour', label: null, utilization: 10, resetsAt: null },
  ])
})

// --- the observed fallback, using the two real payloads from the brief -------

test('observed payload (allowed): fraction to percent, unix seconds to ISO, overage mapped', async () => {
  const payload = {
    status: 'allowed',
    resetsAt: 1790761800,
    overageStatus: 'rejected',
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { resetsAt: 1790761800, utilization: 0.04 },
      seven_day: { resetsAt: 1791158400, utilization: 0.23 },
    },
    overageDisabledReason: 'org_level_disabled_until',
  }
  const createdAt = new Date('2026-09-29T12:00:00.000Z')

  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)

  expect(result.limits.source).toBe('observed')
  expect(result.limits.asOf).toBe(createdAt.toISOString())
  expect(result.limits.status).toBe('allowed')
  expect(result.limits.windows).toEqual([
    {
      key: 'five_hour',
      label: null,
      utilization: 4,
      resetsAt: new Date(1790761800 * 1000).toISOString(),
    },
    {
      key: 'seven_day',
      label: null,
      utilization: 23,
      resetsAt: new Date(1791158400 * 1000).toISOString(),
    },
  ])
  expect(result.limits.overage).toEqual({
    status: 'rejected',
    disabledReason: 'org_level_disabled_until',
    inUse: false,
  })
  expect(result.limits.extraUsage).toBeNull()
})

test('observed payload (allowed_warning): 0.97 -> 97, surpassedThreshold ignored, overage still mapped', async () => {
  const payload = {
    status: 'allowed_warning',
    resetsAt: 1789914000,
    utilization: 0.97,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { resetsAt: 1789914000, utilization: 0.97 },
      seven_day: { resetsAt: 1789948800, utilization: 0.75 },
    },
    surpassedThreshold: 0.9,
  }
  const createdAt = new Date('2026-09-20T08:00:00.000Z')

  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)

  expect(result.limits.status).toBe('allowed_warning')
  expect(result.limits.windows).toEqual([
    {
      key: 'five_hour',
      label: null,
      utilization: 97,
      resetsAt: new Date(1789914000 * 1000).toISOString(),
    },
    {
      key: 'seven_day',
      label: null,
      utilization: 75,
      resetsAt: new Date(1789948800 * 1000).toISOString(),
    },
  ])
  // isUsingOverage: false is still "present" — the row reports overage
  // status even while not in use, so it must not collapse to null.
  expect(result.limits.overage).toEqual({ status: null, disabledReason: null, inUse: false })
})

test('unifiedWindows absent: falls back to the single top-level rateLimitType/utilization/resetsAt window', async () => {
  const payload = {
    status: 'allowed',
    resetsAt: 1790000000,
    rateLimitType: 'seven_day_opus',
    utilization: 0.5,
  }
  const createdAt = new Date('2026-09-28T00:00:00.000Z')

  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)

  expect(result.limits.windows).toEqual([
    {
      key: 'seven_day_opus',
      label: null,
      utilization: 50,
      resetsAt: new Date(1790000000 * 1000).toISOString(),
    },
  ])
  expect(result.limits.overage).toBeNull()
})

test('a rateLimitType this app does not have an enum member for is dropped, not invented', async () => {
  const payload = { status: 'allowed', rateLimitType: 'overage', utilization: 0.3 }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([])
})

// --- floating-point rounding on the observed fraction-to-percent path -------

test('observed utilization is rounded to at most 2 decimal places, not raw floating-point noise', async () => {
  // 0.07 * 100 === 7.000000000000001 and 0.29 * 100 === 28.999999999999996 in
  // plain floating point — this must not reach the wire.
  const payload = {
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.07 },
      seven_day: { utilization: 0.29 },
      seven_day_opus: { utilization: 0.975 },
    },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  const byKey = Object.fromEntries(result.limits.windows.map((w) => [w.key, w.utilization]))
  expect(byKey.five_hour).toBe(7)
  expect(byKey.seven_day).toBe(29)
  expect(byKey.seven_day_opus).toBe(97.5)
})

test('the top-level (no-unifiedWindows) percent conversion is rounded the same way', async () => {
  const payload = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.29 }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([
    { key: 'five_hour', label: null, utilization: 29, resetsAt: null },
  ])
})

// --- resetsAt safety guards: out-of-range and the "stored in milliseconds by
// --- mistake" case -----------------------------------------------------------

test('a resetsAt so large it would throw RangeError degrades to null, not a 500, and costs only that field', async () => {
  const payload = {
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.5, resetsAt: 1e300 },
      seven_day: { utilization: 0.25, resetsAt: 1791158400 },
    },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([
    { key: 'five_hour', label: null, utilization: 50, resetsAt: null },
    {
      key: 'seven_day',
      label: null,
      utilization: 25,
      resetsAt: new Date(1791158400 * 1000).toISOString(),
    },
  ])
})

test('a resetsAt stored in milliseconds by mistake (> 1e11) is recovered by dividing by 1000, not nulled or thrown', async () => {
  // 1790761800000 is 1790761800 (a plausible resetsAt, used elsewhere in this
  // file as seconds) written in milliseconds instead — see usage.ts's
  // unixSecondsToIso for why anything above 1e11 is treated as milliseconds
  // rather than a literal, wildly-far-future seconds value.
  const payload = {
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1790761800000 } },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([
    {
      key: 'five_hour',
      label: null,
      utilization: 15,
      resetsAt: new Date(1790761800 * 1000).toISOString(),
    },
  ])
})

// --- the observed field set is not a stable contract: one bad field degrades,
// --- it never fails the whole reading ---------------------------------------

test('an unrecognised status value degrades to null, keeping windows intact', async () => {
  // The stored rows are whatever the CLI emitted at the time — a future build
  // writing a status this app's enum does not know about yet must not drop
  // the whole reading from 'observed' to 'none'.
  const payload = {
    status: 'some_new_status',
    unifiedWindows: { five_hour: { resetsAt: 1790761800, utilization: 0.04 } },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.source).toBe('observed')
  expect(result.limits.status).toBeNull()
  expect(result.limits.windows).toEqual([
    {
      key: 'five_hour',
      label: null,
      utilization: 4,
      resetsAt: new Date(1790761800 * 1000).toISOString(),
    },
  ])
})

test('a malformed unifiedWindows entry is dropped on its own, the sibling window is still reported', async () => {
  const payload = {
    status: 'allowed',
    unifiedWindows: {
      five_hour: 'oops',
      seven_day: { resetsAt: 1791158400, utilization: 0.23 },
    },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([
    {
      key: 'seven_day',
      label: null,
      utilization: 23,
      resetsAt: new Date(1791158400 * 1000).toISOString(),
    },
  ])
})

test('an unrecognised overageStatus plus wrong-typed overageDisabledReason/isUsingOverage each degrade alone', async () => {
  const payload = {
    status: 'allowed',
    overageStatus: 'some_new_status',
    overageDisabledReason: 12345,
    isUsingOverage: 'not-a-boolean',
    unifiedWindows: { five_hour: { resetsAt: 1790761800, utilization: 0.04 } },
  }
  const result = await getUsage(
    reader({ createdAt: new Date(), payload: { rate_limit_info: payload } }),
  )
  expectValidResponse(result)
  expect(result.limits.windows).toEqual([
    {
      key: 'five_hour',
      label: null,
      utilization: 4,
      resetsAt: new Date(1790761800 * 1000).toISOString(),
    },
  ])
  // All three overage fields degraded to undefined, so nothing is left to
  // report — this is the same "none of the four fields present" null as a
  // reading that never mentioned overage at all.
  expect(result.limits.overage).toBeNull()
})

// --- 'none' ------------------------------------------------------------------

test("no live rate_limits and no rate_limit_event row ever recorded: source 'none', empty windows", async () => {
  const result = await getUsage(NO_ROW)
  expectValidResponse(result)
  expect(result.limits).toEqual({
    source: 'none',
    asOf: null,
    status: null,
    windows: [],
    overage: null,
    extraUsage: null,
  })
})

// --- partial and total probe failure ------------------------------------------

test('the whole probe throwing (query() itself throws) still answers with observed limits, and sets probeError', async () => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: () => {
      throw new Error('Claude Code executable not found')
    },
  }))

  const createdAt = new Date('2026-09-29T00:00:00.000Z')
  const payload = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } }
  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)

  expect(result.account).toBeNull()
  expect(result.breakdown).toBeNull()
  expect(result.probeError).not.toBeNull()
  expect(result.probeError).toContain('Claude Code executable not found')
  // The DB fallback still works — a broken CLI must not also hide what the
  // last real turn already reported.
  expect(result.limits.source).toBe('observed')
  expect(result.limits.windows).toEqual([{ key: 'five_hour', label: null, utilization: 10, resetsAt: null }])
})

test('a probe that never settles until the timeout fires still resolves, with a probeError', async () => {
  jest.useFakeTimers()
  fullCallBehaviour = (abort) =>
    new Promise((_resolve, reject) => {
      abort?.signal.addEventListener(
        'abort',
        () => reject(new Error('Claude Code process aborted by user')),
        { once: true },
      )
    })

  let settled = false
  const pending = getUsage(NO_ROW).then((r) => {
    settled = true
    return r
  })

  jest.advanceTimersByTime(29_000)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(settled).toBe(false)

  jest.advanceTimersByTime(2_000)
  const result = await pending
  expectValidResponse(result)
  expect(result.probeError).toContain('behaviors')
  // accountInfo() and the skip call both resolved before the abort fired.
  expect(result.account).not.toBeNull()
  expect(result.breakdown).toBeNull()
})

test('the behaviors call rejecting outright (account + skip-call succeed) keeps account, drops breakdown, sets probeError', async () => {
  fullCallBehaviour = () => Promise.reject(new Error('control request failed'))

  const result = await getUsage(NO_ROW)
  expectValidResponse(result)

  expect(result.account).not.toBeNull()
  expect(result.breakdown).toBeNull()
  expect(result.probeError).toContain('control request failed')
})

test('accountInfo() rejecting alone: account is null, but limits and breakdown are unaffected', async () => {
  accountInfoBehaviour = () => Promise.reject(new Error('exited with code 1'))
  fullCallBehaviour = () =>
    Promise.resolve({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: {
        day: {
          request_count: 3,
          session_count: 1,
          behaviors: [{ key: 'long_context', pct: 40, count: 2 }],
          agents: [{ name: 'orchestrator', pct: 100 }],
          skills: [],
          plugins: [],
          mcp_servers: [],
        },
        week: {
          request_count: 10,
          session_count: 4,
          behaviors: [],
          agents: [],
          skills: [],
          plugins: [],
          mcp_servers: [],
        },
      },
    })

  const result = await getUsage(NO_ROW)
  expectValidResponse(result)

  expect(result.account).toBeNull()
  expect(result.probeError).toContain('account')
  expect(result.breakdown).toEqual({
    day: {
      requestCount: 3,
      sessionCount: 1,
      behaviors: [{ key: 'long_context', pct: 40, count: 2 }],
      agents: [{ name: 'orchestrator', pct: 100 }],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    week: {
      requestCount: 10,
      sessionCount: 4,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
  })
})

// --- malformed shapes degrade, never throw ------------------------------------

test('accountInfo() resolving a bare string degrades account to null without throwing', async () => {
  accountInfoBehaviour = () => Promise.resolve('not an object')
  const result = await getUsage(NO_ROW)
  expectValidResponse(result)
  expect(result.account).toBeNull()
})

test('the skip call resolving null degrades limits to the DB/none fallback, not a throw', async () => {
  skipCallBehaviour = () => Promise.resolve(null)
  const result = await getUsage(NO_ROW)
  expectValidResponse(result)
  expect(result.limits.source).toBe('none')
})

test('rate_limits with the wrong field types is dropped, source falls through to observed', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({
      subscription_type: null,
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 'a lot', resets_at: 12345 } },
    })
  const createdAt = new Date('2026-09-29T00:00:00.000Z')
  const payload = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5 } } }

  const result = await getUsage(reader({ createdAt, payload: { rate_limit_info: payload } }))
  expectValidResponse(result)
  expect(result.limits.source).toBe('observed')
})

test('a rate_limit_event payload with no rate_limit_info key at all degrades to none, not a throw', async () => {
  const result = await getUsage(reader({ createdAt: new Date(), payload: { nonsense: true } }))
  expectValidResponse(result)
  expect(result.limits.source).toBe('none')
})

test('a behaviors block with the wrong shape drops the breakdown but keeps everything else', async () => {
  fullCallBehaviour = () =>
    Promise.resolve({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: { day: 'nonsense', week: null },
    })
  const result = await getUsage(NO_ROW)
  expectValidResponse(result)
  expect(result.breakdown).toBeNull()
  expect(result.account).not.toBeNull()
})

// --- caching and dedup, mirroring system-models.test.ts's own coverage -------

test('concurrent callers dedup onto exactly one probe', async () => {
  let resolveSkip: (v: unknown) => void = () => {}
  skipCallBehaviour = () => new Promise((resolve) => (resolveSkip = resolve))

  const calls = [getUsage(NO_ROW), getUsage(NO_ROW), getUsage(NO_ROW)]
  expect(queryCalls).toHaveLength(1)

  // accountInfo() is awaited (and resolves on a microtask) before the probe
  // ever reaches the skip call, so `resolveSkip` is not the real resolver
  // until that microtask has had a chance to run.
  for (let i = 0; i < 5; i++) await Promise.resolve()

  resolveSkip({ subscription_type: null, rate_limits_available: false, rate_limits: null })
  await Promise.all(calls)
  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
})

test('a cached probe is reused within USAGE_TTL_MS, and re-probed after it', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-29T00:00:00Z'))

  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)

  jest.setSystemTime(new Date(Date.now() + USAGE_TTL_MS - 1000))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)

  jest.setSystemTime(new Date(Date.now() + 2000))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(2)
})

test('a totally failed probe is retried after USAGE_FAILURE_TTL_MS, well before USAGE_TTL_MS', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-29T00:00:00Z'))
  accountInfoBehaviour = () => Promise.reject(new Error('exited with code 1'))
  skipCallBehaviour = () => Promise.reject(new Error('exited with code 1'))
  fullCallBehaviour = () => Promise.reject(new Error('exited with code 1'))

  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)

  jest.setSystemTime(new Date(Date.now() + USAGE_FAILURE_TTL_MS - 1000))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)

  jest.setSystemTime(new Date(Date.now() + 2000))
  accountInfoBehaviour = () =>
    Promise.resolve({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' })
  const recovered = await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(2)
  expect(recovered.account).not.toBeNull()
})

test('the two TTLs are distinct constants, the failure one much the shorter', () => {
  expect(USAGE_FAILURE_TTL_MS).toBeLessThan(USAGE_TTL_MS)
})

// --- the DB read is fresh on every call, never cached alongside the probe ----

test('a live probe result is cached, but the DB read still runs on every call while there is nothing live', async () => {
  let reads = 0
  const countingReader = () => {
    reads++
    return Promise.resolve(null)
  }

  await getUsage(countingReader)
  await getUsage(countingReader)
  await getUsage(countingReader)

  expect(queryCalls).toHaveLength(1)
  expect(reads).toBe(3)
})

// --- the route itself: always 200, body matches the published schema --------

test('GET /api/system/usage is mounted and answers 200 with a schema-valid body', async () => {
  // The route itself uses getUsage()'s real default DB reader — nothing in
  // this test process has a real Postgres to serve it (see setup-env.ts's
  // placeholder DATABASE_URL) — so the probe is scripted to answer live,
  // which is what lets resolveLimits() return before ever touching the DB.
  skipCallBehaviour = () =>
    Promise.resolve({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 10, resets_at: '2026-10-01T00:00:00.000Z' } },
    })

  const { OpenAPIHono } = await import('@hono/zod-openapi')
  const { systemRouter } = await import(`${B}/features/system/routes.ts`)
  const app = new OpenAPIHono()
  app.route('/api', systemRouter)

  const res = await app.request('/api/system/usage')
  expect(res.status).toBe(200)
  const body = await res.json()
  expectValidResponse(body)
  expect(body.limits.source).toBe('live')
})
