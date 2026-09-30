// Adversarial coverage for GET /api/system/usage (features/system/usage.ts),
// complementing tests/system-usage.test.ts. That file covers the happy paths;
// this one goes after the edges: the probe timeout's exact boundary, close()
// on every exit path, TTL boundaries, the observed-payload conversions on
// out-of-range / wrong-unit / wrong-type values, and a failing DB read
// through the real createApp() onError.
//
// Hermetic: the SDK is faked with mock.module (as in system-usage.test.ts),
// getUsage() gets its DB reader injected, and the one test that goes through
// the real app (which uses the default reader) swaps `@/db/client` for a
// delegating stand-in that is restored in afterAll, because mock.module is
// process-global.

import { afterAll, afterEach, expect, jest, mock, test } from 'bun:test'
import './setup-env'
// Registers zod's `.openapi()` extension before schema.ts loads. See
// system-models.test.ts for why.
import '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

// --- the fake SDK -------------------------------------------------------------

type Behaviour = (abort: AbortController) => unknown

interface QueryCall {
  prompt: unknown
  options: Record<string, unknown>
  abort: AbortController
}
let queryCalls: QueryCall[] = []
let closeCalls = 0

const ACCOUNT_OK = { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }
const USAGE_NOT_LIVE = { subscription_type: null, rate_limits_available: false, rate_limits: null }

let accountInfoBehaviour: Behaviour = () => Promise.resolve(ACCOUNT_OK)
let skipCallBehaviour: Behaviour = () => Promise.resolve(USAGE_NOT_LIVE)
let fullCallBehaviour: Behaviour = () => Promise.resolve({ ...USAGE_NOT_LIVE, behaviors: null })
let closeBehaviour: () => void = () => {}
/** When set, query() itself throws synchronously (after recording the call). */
let queryThrows: Error | null = null
/** When true the fake Query has no usage method at all (an older SDK). */
let omitUsageMethod = false

// Spread the real SDK in, and put it back in afterAll: mock.module is
// process-global, and other test files import SDK exports besides `query`
// (a query-only mock left in place makes them fail to load).
const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) } as Record<string, unknown>

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    const abort = params.options.abortController as AbortController
    queryCalls.push({ prompt: params.prompt, options: params.options, abort })
    if (queryThrows) throw queryThrows
    const q: Record<string, unknown> = {
      accountInfo: () => accountInfoBehaviour(abort),
      close: () => {
        closeCalls++
        closeBehaviour()
      },
    }
    if (!omitUsageMethod) {
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = (opts?: {
        skipBehaviors?: boolean
      }) => (opts?.skipBehaviors ? skipCallBehaviour(abort) : fullCallBehaviour(abort))
    }
    return q
  },
}))

// --- a delegating stand-in for @/db/client (only the route test uses it) -------

// Spread at capture time: a namespace is a live view (see
// docker-cleanup-safety.test.ts), so holding it would restore the mock.
const realDbClient = { ...(await import(`${B}/db/client.ts`)) } as Record<string, unknown> & {
  db: object
}
let dbSelectFailure: Error | null = null
const failingChain = () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy']) chain[m] = () => chain
  chain.limit = () => Promise.reject(dbSelectFailure)
  return chain
}
mock.module(`${B}/db/client.ts`, () => ({
  ...realDbClient,
  db: new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'select' && dbSelectFailure
          ? () => failingChain()
          : Reflect.get(realDbClient.db, prop),
    },
  ),
}))

const { getUsage, resetUsageCacheForTests, USAGE_TTL_MS, USAGE_FAILURE_TTL_MS } = await import(
  `${B}/features/system/usage.ts`
)
const { usageResponseSchema } = await import(`${B}/features/system/schema.ts`)

type Row = { createdAt: Date; payload: unknown } | null
const reader = (row: Row) => () => Promise.resolve(row)
const NO_ROW = reader(null)
const observed = (info: unknown, createdAt = new Date('2026-09-29T12:00:00.000Z')) =>
  reader({ createdAt, payload: { rate_limit_info: info } })

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function expectValid(result: unknown) {
  const parsed = usageResponseSchema.safeParse(result)
  if (!parsed.success) throw new Error(`schema mismatch: ${JSON.stringify(parsed.error.issues)}`)
}

/** A control call that behaves the way the real SDK was measured to: it
 * never answers on its own, and rejects once the AbortController fires. */
const hangUntilAbort: Behaviour = (abort) =>
  new Promise((_resolve, reject) => {
    if (abort.signal.aborted) reject(new Error('Operation aborted'))
    abort.signal.addEventListener('abort', () => reject(new Error('Operation aborted')), {
      once: true,
    })
  })

afterEach(() => {
  jest.useRealTimers()
  resetUsageCacheForTests()
  queryCalls = []
  closeCalls = 0
  accountInfoBehaviour = () => Promise.resolve(ACCOUNT_OK)
  skipCallBehaviour = () => Promise.resolve(USAGE_NOT_LIVE)
  fullCallBehaviour = () => Promise.resolve({ ...USAGE_NOT_LIVE, behaviors: null })
  closeBehaviour = () => {}
  queryThrows = null
  omitUsageMethod = false
  dbSelectFailure = null
})

afterAll(() => {
  mock.module(`${B}/db/client.ts`, () => realDbClient)
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  resetUsageCacheForTests()
})

// --- how the probe is opened: no turn can run -----------------------------------

test('the probe prompt is an async iterable that never yields a message', async () => {
  await getUsage(NO_ROW)
  const prompt = queryCalls[0]?.prompt as AsyncIterable<unknown>
  expect(typeof prompt[Symbol.asyncIterator]).toBe('function')
  let yielded = false
  prompt[Symbol.asyncIterator]()
    .next()
    .then(() => {
      yielded = true
    })
  await new Promise((r) => setTimeout(r, 30))
  await flush()
  expect(yielded).toBe(false)
})

test('the probe runs with bypassPermissions and an AbortController', async () => {
  await getUsage(NO_ROW)
  expect(queryCalls[0]?.options.permissionMode).toBe('bypassPermissions')
  expect(queryCalls[0]?.options.abortController).toBeInstanceOf(AbortController)
})

// --- the 30s timeout ------------------------------------------------------------

test('a hung accountInfo() is aborted at exactly 30s, and the request then resolves', async () => {
  jest.useFakeTimers()
  accountInfoBehaviour = hangUntilAbort
  // After an abort the real SDK rejects every later control call at once.
  skipCallBehaviour = hangUntilAbort
  fullCallBehaviour = hangUntilAbort

  let settled = false
  const pending = getUsage(NO_ROW).then((r: unknown) => {
    settled = true
    return r
  })
  jest.advanceTimersByTime(29_999)
  await flush()
  expect(settled).toBe(false)
  expect(queryCalls[0]?.abort.signal.aborted).toBe(false)

  jest.advanceTimersByTime(1)
  const result = await pending
  expectValid(result)
  expect(queryCalls[0]?.abort.signal.aborted).toBe(true)
  expect(result.probeError).toContain('Could not read account info')
  expect(result.probeError).toContain('Could not read plan rate limits')
  expect(result.probeError).toContain('Could not read usage behaviors')
})

test('close() runs exactly once after a timed-out probe', async () => {
  jest.useFakeTimers()
  skipCallBehaviour = hangUntilAbort
  fullCallBehaviour = hangUntilAbort
  const pending = getUsage(NO_ROW)
  await flush()
  jest.advanceTimersByTime(30_000)
  await pending
  expect(closeCalls).toBe(1)
})

test('the timeout is cleared on success: nothing aborts the controller afterwards', async () => {
  jest.useFakeTimers()
  await getUsage(NO_ROW)
  jest.advanceTimersByTime(120_000)
  expect(queryCalls[0]?.abort.signal.aborted).toBe(false)
})

test('the timeout is cleared when query() itself throws synchronously', async () => {
  jest.useFakeTimers()
  queryThrows = new Error('spawn ENOENT')
  const result = await getUsage(NO_ROW)
  jest.advanceTimersByTime(120_000)
  expect(result.probeError).toContain('spawn ENOENT')
  expect(queryCalls[0]?.abort.signal.aborted).toBe(false)
})

// --- close() on every path ------------------------------------------------------

test('accountInfo() throwing synchronously: caught, close() still runs once, later calls still made', async () => {
  accountInfoBehaviour = () => {
    throw new Error('sync boom')
  }
  skipCallBehaviour = () =>
    Promise.resolve({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-01T00:00:00.000Z' } },
    })
  const result = await getUsage(NO_ROW)
  expectValid(result)
  expect(closeCalls).toBe(1)
  expect(result.account).toBeNull()
  expect(result.probeError).toContain('sync boom')
  expect(result.limits.source).toBe('live')
})

test('all three control calls throwing synchronously: close() once, three sentences in probeError', async () => {
  const boom = () => {
    throw new Error('sync')
  }
  accountInfoBehaviour = boom
  skipCallBehaviour = boom
  fullCallBehaviour = boom
  const result = await getUsage(NO_ROW)
  expectValid(result)
  expect(closeCalls).toBe(1)
  expect(result.probeError?.split('; ')).toHaveLength(3)
})

test('an SDK without the usage method: account kept, close() once, probeError set', async () => {
  omitUsageMethod = true
  const result = await getUsage(NO_ROW)
  expectValid(result)
  expect(closeCalls).toBe(1)
  expect(result.account?.tokenSource).toBe('CLAUDE_CODE_OAUTH_TOKEN')
  expect(result.probeError).toContain('Could not read plan rate limits')
})

test('query() throwing synchronously never calls close() on a missing Query and still answers', async () => {
  queryThrows = new Error('Claude Code executable not found')
  const result = await getUsage(observed({ unifiedWindows: { five_hour: { utilization: 0.5 } } }))
  expectValid(result)
  expect(closeCalls).toBe(0)
  expect(result.limits.source).toBe('observed')
})

test('close() throwing does not turn the request into a rejection', async () => {
  closeBehaviour = () => {
    throw new Error('close failed')
  }
  const result = await getUsage(NO_ROW)
  expectValid(result)
})

test('a probe that rejected once does not poison every later request (next call re-probes)', async () => {
  closeBehaviour = () => {
    throw new Error('close failed')
  }
  await getUsage(NO_ROW).catch(() => {})
  closeBehaviour = () => {}
  const second = await getUsage(NO_ROW)
  expectValid(second)
  expect(queryCalls).toHaveLength(2)
})

// --- limits precedence ------------------------------------------------------------

test('rate_limits_available true but rate_limits null on both calls: falls through to observed', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({ subscription_type: 'pro', rate_limits_available: true, rate_limits: null })
  fullCallBehaviour = () =>
    Promise.resolve({ subscription_type: 'pro', rate_limits_available: true, rate_limits: null, behaviors: null })
  const createdAt = new Date('2026-09-30T07:08:17.904Z')
  const result = await getUsage(
    observed({ unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1790761800 } } }, createdAt),
  )
  expectValid(result)
  expect(result.limits.source).toBe('observed')
  expect(result.limits.asOf).toBe('2026-09-30T07:08:17.904Z')
  expect(result.limits.windows).toEqual([
    { key: 'five_hour', label: null, utilization: 15, resetsAt: '2026-09-30T09:50:00.000Z' },
  ])
})

test('rate_limits_available as the string "true" is not live', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({
      rate_limits_available: 'true',
      rate_limits: { five_hour: { utilization: 99, resets_at: '2026-10-01T00:00:00.000Z' } },
    })
  const result = await getUsage(NO_ROW)
  expect(result.limits.source).toBe('none')
})

test('skip call rejecting while the full call has live limits: live from the full call', async () => {
  skipCallBehaviour = () => Promise.reject(new Error('control request timed out'))
  fullCallBehaviour = () =>
    Promise.resolve({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 33.3, resets_at: '2026-10-06T00:00:00.000Z' } },
      behaviors: null,
    })
  const result = await getUsage(NO_ROW)
  expectValid(result)
  expect(result.limits.source).toBe('live')
  expect(result.limits.windows).toEqual([
    { key: 'seven_day', label: null, utilization: 33.3, resetsAt: '2026-10-06T00:00:00.000Z' },
  ])
  expect(result.probeError).toContain('control request timed out')
})

test('with live limits the DB is never read', async () => {
  skipCallBehaviour = () =>
    Promise.resolve({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 1, resets_at: '2026-10-01T00:00:00.000Z' } },
    })
  let reads = 0
  const counting = () => {
    reads++
    return Promise.resolve(null)
  }
  await getUsage(counting)
  await getUsage(counting)
  expect(reads).toBe(0)
})

test("a cached live reading keeps the probe's asOf while fetchedAt moves on", async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-30T00:00:00.000Z'))
  skipCallBehaviour = () =>
    Promise.resolve({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 1, resets_at: '2026-10-01T00:00:00.000Z' } },
    })
  const first = await getUsage(NO_ROW)
  jest.setSystemTime(new Date('2026-09-30T00:00:30.000Z'))
  const second = await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)
  expect(second.limits.asOf).toBe(first.limits.asOf)
  expect(second.fetchedAt).toBe('2026-09-30T00:00:30.000Z')
})

// --- observed conversions: fraction -> percent, unix seconds -> ISO ----------------

async function observedWindows(info: unknown) {
  const result = await getUsage(observed(info))
  expectValid(result)
  return result.limits.windows as { key: string; utilization: number | null; resetsAt: string | null }[]
}

test('utilization above 1 (1.2) converts to 120, not clamped or dropped', async () => {
  const [w] = await observedWindows({ unifiedWindows: { five_hour: { utilization: 1.2 } } })
  expect(w?.utilization).toBe(120)
})

test('utilization 0 converts to 0, not null', async () => {
  const [w] = await observedWindows({ unifiedWindows: { five_hour: { utilization: 0 } } })
  expect(w?.utilization).toBe(0)
})

test('resetsAt 0 converts to the epoch, not null', async () => {
  const [w] = await observedWindows({ unifiedWindows: { five_hour: { resetsAt: 0 } } })
  expect(w?.resetsAt).toBe('1970-01-01T00:00:00.000Z')
})

test('negative utilization (-0.1) passes through as -10 without costing the reading', async () => {
  const windows = await observedWindows({
    unifiedWindows: {
      five_hour: { utilization: -0.1, resetsAt: 1790761800 },
      seven_day: { utilization: 0.24, resetsAt: 1791158400 },
    },
  })
  expect(windows.map((w) => w.utilization)).toEqual([-10, 24])
})

test('rounding: 0.123456 -> 12.35, 0.005 -> 0.5, 0.33333 -> 33.33', async () => {
  const windows = await observedWindows({
    unifiedWindows: {
      five_hour: { utilization: 0.123456 },
      seven_day: { utilization: 0.005 },
      seven_day_opus: { utilization: 0.33333 },
    },
  })
  expect(windows.map((w) => w.utilization)).toEqual([12.35, 0.5, 33.33])
})

test('resetsAt stored in milliseconds by mistake does not fail the request', async () => {
  const windows = await observedWindows({
    unifiedWindows: {
      five_hour: { utilization: 0.15, resetsAt: 1790761800000 },
      seven_day: { utilization: 0.24, resetsAt: 1791158400 },
    },
  })
  expect(windows[1]).toEqual({
    key: 'seven_day',
    label: null,
    utilization: 24,
    resetsAt: '2026-10-05T00:00:00.000Z',
  })
})

test('a unifiedWindows resetsAt outside the Date range (1e13) costs that field, not the whole response', async () => {
  const windows = await observedWindows({
    unifiedWindows: {
      five_hour: { utilization: 0.15, resetsAt: 1e13 },
      seven_day: { utilization: 0.24, resetsAt: 1791158400 },
    },
  })
  expect(windows.find((w) => w.key === 'seven_day')?.utilization).toBe(24)
})

test('a top-level resetsAt outside the Date range (1e13) costs that field, not the whole response', async () => {
  const windows = await observedWindows({
    rateLimitType: 'five_hour',
    utilization: 0.4,
    resetsAt: 1e13,
  })
  expect(windows[0]?.utilization).toBe(40)
})

test('a wrong-typed utilization ("0.5") costs that field only: the window keeps its resetsAt', async () => {
  const windows = await observedWindows({
    unifiedWindows: { five_hour: { utilization: '0.5', resetsAt: 1790761800 } },
  })
  expect(windows).toEqual([
    { key: 'five_hour', label: null, utilization: null, resetsAt: '2026-09-30T09:50:00.000Z' },
  ])
})

test('utilization: null yields a null utilization, window kept', async () => {
  const windows = await observedWindows({
    unifiedWindows: { five_hour: { utilization: null, resetsAt: 1790761800 } },
  })
  expect(windows).toEqual([
    { key: 'five_hour', label: null, utilization: null, resetsAt: '2026-09-30T09:50:00.000Z' },
  ])
})

test('unifiedWindows with only an unknown key: still observed, no invented window', async () => {
  const result = await getUsage(
    observed({ status: 'allowed', unifiedWindows: { ten_minute: { utilization: 0.9 } } }),
  )
  expectValid(result)
  expect(result.limits.source).toBe('observed')
  expect(result.limits.status).toBe('allowed')
  expect(result.limits.windows.some((w: { key: string }) => w.key !== 'five_hour')).toBe(false)
})

test('unifiedWindows with only an unknown key still reports the top-level rateLimitType window', async () => {
  const windows = await observedWindows({
    rateLimitType: 'five_hour',
    utilization: 0.3,
    resetsAt: 1790761800,
    unifiedWindows: { ten_minute: { utilization: 0.9 } },
  })
  expect(windows).toEqual([
    { key: 'five_hour', label: null, utilization: 30, resetsAt: '2026-09-30T09:50:00.000Z' },
  ])
})

test('unifiedWindows: null falls back to the top-level window', async () => {
  const windows = await observedWindows({
    rateLimitType: 'seven_day',
    utilization: 0.24,
    resetsAt: 1791158400,
    unifiedWindows: null,
  })
  expect(windows).toEqual([
    { key: 'seven_day', label: null, utilization: 24, resetsAt: '2026-10-05T00:00:00.000Z' },
  ])
})

for (const [label, payload] of [
  ['payload null', null],
  ['payload a string', 'rate_limit_event'],
  ['rate_limit_info null', { rate_limit_info: null }],
  ['rate_limit_info an array', { rate_limit_info: [] }],
  ['payload missing rate_limit_info', { type: 'rate_limit_event' }],
] as const) {
  test(`${label}: degrades to source 'none', 200-shaped`, async () => {
    const result = await getUsage(reader({ createdAt: new Date(), payload }))
    expectValid(result)
    expect(result.limits.source).toBe('none')
    expect(result.limits.windows).toEqual([])
  })
}

// --- the breakdown -----------------------------------------------------------------

test('very large behaviors arrays pass through intact', async () => {
  const N = 20_000
  const big = Array.from({ length: N }, (_, i) => ({ key: `k${i}`, pct: i % 101, count: i }))
  const period = {
    request_count: N,
    session_count: 1,
    behaviors: big,
    agents: [],
    skills: [],
    plugins: [],
    mcp_servers: [],
  }
  fullCallBehaviour = () =>
    Promise.resolve({ ...USAGE_NOT_LIVE, behaviors: { day: period, week: period } })
  const result = await getUsage(NO_ROW)
  expectValid(result)
  expect(result.breakdown?.day.behaviors).toHaveLength(N)
  expect(result.breakdown?.week.behaviors[N - 1]).toEqual({ key: `k${N - 1}`, pct: (N - 1) % 101, count: N - 1 })
})

// --- TTL boundaries ------------------------------------------------------------------

const T0 = Date.parse('2026-09-30T00:00:00.000Z')

test('success TTL: cached at +59_999ms, re-probed at exactly +60_000ms', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(T0))
  await getUsage(NO_ROW)
  jest.setSystemTime(new Date(T0 + USAGE_TTL_MS - 1))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)
  jest.setSystemTime(new Date(T0 + USAGE_TTL_MS))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(2)
})

test('failure TTL: a probe that got nothing is cached at +14_999ms, re-probed at exactly +15_000ms', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(T0))
  queryThrows = new Error('spawn ENOENT')
  await getUsage(NO_ROW)
  jest.setSystemTime(new Date(T0 + USAGE_FAILURE_TTL_MS - 1))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)
  jest.setSystemTime(new Date(T0 + USAGE_FAILURE_TTL_MS))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(2)
})

test('every call resolving but degrading to null counts as "got nothing": the 15s TTL applies', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(T0))
  accountInfoBehaviour = () => Promise.resolve('not an object')
  skipCallBehaviour = () => Promise.resolve(null)
  fullCallBehaviour = () => Promise.resolve({ ...USAGE_NOT_LIVE, behaviors: { day: 'bad' } })
  const first = await getUsage(NO_ROW)
  expect(first.probeError).toBeNull()
  jest.setSystemTime(new Date(T0 + USAGE_FAILURE_TTL_MS))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(2)
})

test('a probe with only account info counts as data: still cached at +15_000ms', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(T0))
  skipCallBehaviour = () => Promise.reject(new Error('x'))
  fullCallBehaviour = () => Promise.reject(new Error('y'))
  await getUsage(NO_ROW)
  jest.setSystemTime(new Date(T0 + USAGE_FAILURE_TTL_MS))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)
})

test('the TTL counts from when the probe finished, not when it started (a 30s timeout is still cached for 60s after)', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(T0))
  fullCallBehaviour = hangUntilAbort
  const pending = getUsage(NO_ROW)
  await flush()
  jest.advanceTimersByTime(30_000) // also advances the fake clock to T0 + 30s
  await pending
  jest.setSystemTime(new Date(T0 + 30_000 + USAGE_TTL_MS - 1))
  await getUsage(NO_ROW)
  expect(queryCalls).toHaveLength(1)
})

// --- the observed DB read is fresh on every call ------------------------------------

test('while the probe is cached, a newer rate_limit_event row shows up on the very next call', async () => {
  let row: Row = {
    createdAt: new Date('2026-09-30T07:00:00.000Z'),
    payload: { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1 } } } },
  }
  const live = () => Promise.resolve(row)
  const first = await getUsage(live)
  row = {
    createdAt: new Date('2026-09-30T07:05:00.000Z'),
    payload: { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2 } } } },
  }
  const second = await getUsage(live)
  expect(queryCalls).toHaveLength(1)
  expect(first.limits.windows[0]?.utilization).toBe(10)
  expect(second.limits.windows[0]?.utilization).toBe(20)
  expect(second.limits.asOf).toBe('2026-09-30T07:05:00.000Z')
})

test('five concurrent cold callers: one probe, one close(), five DB reads', async () => {
  let reads = 0
  const counting = () => {
    reads++
    return Promise.resolve(null)
  }
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => getUsage(counting)))
  for (const r of results) expectValid(r)
  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
  expect(reads).toBe(5)
})

test('a rejected DB read rejects getUsage() (no hang), and the probe stays cached for the next call', async () => {
  const dbDown = () => Promise.reject(new Error('ECONNREFUSED'))
  await expect(getUsage(dbDown)).rejects.toThrow('ECONNREFUSED')
  const next = await getUsage(NO_ROW)
  expectValid(next)
  expect(queryCalls).toHaveLength(1)
})

test('through the real createApp(): a failing Postgres read answers 500 JSON via onError, not a hang', async () => {
  dbSelectFailure = new Error('connect ECONNREFUSED 127.0.0.1:5432')
  const { createApp } = await import(`${B}/app.ts`)
  const app = createApp()
  const res = await app.request('/api/system/usage')
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ error: 'Internal server error' })
})

test('through the real createApp(): with no DB row and a working probe it is 200 and schema-valid', async () => {
  const { createApp } = await import(`${B}/app.ts`)
  const app = createApp()
  // No live limits, so the real default reader runs; the stand-in delegates
  // to the real client unless dbSelectFailure is set. Use live limits here so
  // the route never needs Postgres.
  skipCallBehaviour = () =>
    Promise.resolve({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 5, resets_at: '2026-10-01T00:00:00.000Z' } },
    })
  const res = await app.request('/api/system/usage')
  expect(res.status).toBe(200)
  const body = await res.json()
  expectValid(body)
  expect(body.limits.windows[0]).toEqual({
    key: 'five_hour',
    label: null,
    utilization: 5,
    resetsAt: '2026-10-01T00:00:00.000Z',
  })
})
