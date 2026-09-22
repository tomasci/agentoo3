// GET /api/system/models, exercised through the real router rather than by
// calling getModels() directly: "always 200, and always a body shaped like
// the response schema the route publishes" is a claim about the endpoint, and
// @hono/zod-openapi validates *requests* only — nothing re-checks what the
// handler hands to c.json(). Calling the service would therefore pass on a
// body no client could read.
//
// tests/system-models.test.ts covers the happy paths of the cache itself.
// This file covers what the probe can hand back when Claude Code is not the
// version, the build, or the mood this code was written against, plus the two
// timing rules (the two TTLs, the inFlight dedup) that only mean anything
// under a clock you control.
//
// The SDK is faked exactly as tests/system-models.test.ts and
// tests/idea-prompt-worker.test.ts fake it — see their notes on why
// `mock.module` swaps a module for the whole run and why `hasClaudeCredential`
// is re-registered rather than mutated.

import { afterAll, afterEach, expect, jest, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

/** Options every `query()` call was made with, so dedup counts and the abort
 * wiring can both be asserted. */
let queryCalls: { options: Record<string, unknown> }[] = []
/** How many times the fake query's `close()` ran. One CLI subprocess per
 * probe is spawned; one that is never closed is one that never exits. */
let closeCalls = 0
/** What the fake `supportedModels()` control request does, set per test. It
 * receives the AbortController the module passed to `query()`, so a test can
 * model the SDK's real behaviour: an aborted probe rejects (verified against
 * the shipped SDK — aborting a hung CLI rejects with "Claude Code process
 * aborted by user"). */
let probeBehaviour: (abort: AbortController | undefined) => Promise<unknown> = () =>
  Promise.resolve([])

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls.push({ options: params.options })
    return {
      supportedModels: () =>
        probeBehaviour(params.options.abortController as AbortController | undefined),
      close: () => {
        closeCalls++
      },
    }
  },
}))

const realEnv = (await import(`${B}/env.ts`)) as { env: unknown; hasClaudeCredential: boolean }
function setCredential(has: boolean) {
  mock.module(`${B}/env.ts`, () => ({ ...realEnv, hasClaudeCredential: has }))
}
setCredential(true)

const { getModels, resetModelsCacheForTests, MODELS_TTL_MS, MODELS_FAILURE_TTL_MS } = await import(
  `${B}/features/system/models.ts`
)
const { systemRouter } = await import(`${B}/features/system/routes.ts`)
const { modelsResponseSchema, modelOptionSchema } = await import(`${B}/features/system/schema.ts`)
const { FALLBACK_MODELS } = await import(`${B}/library/models.ts`)

// Mounted the way createApp() mounts it (app.ts); none of this route's work
// touches the database or the queue, so nothing else is needed — the same
// setup tests/system-prompts.test.ts uses.
const app = new OpenAPIHono()
app.route('/api', systemRouter)

const GET = () => app.request('/api/system/models')

afterEach(() => {
  jest.useRealTimers()
  resetModelsCacheForTests()
  queryCalls = []
  closeCalls = 0
  probeBehaviour = () => Promise.resolve([])
  setCredential(true)
})

afterAll(() => {
  mock.module(`${B}/env.ts`, () => realEnv)
})

/**
 * The list this box's Claude Code actually returned on 2026-09-22, captured by
 * running `Query.supportedModels()` against the shipped SDK (0.3.252) with the
 * same never-yielding prompt features/system/models.ts uses. Trimmed to the
 * fields that matter here, verbatim otherwise. Two properties of it are load
 * bearing and neither is hypothetical:
 *   - `opus[1m]` is a real `value`, brackets and all;
 *   - `haiku` carries neither `supportsEffort` nor `supportedEffortLevels`,
 *     and `claude-fable-5-1` carries no `supportsFastMode`.
 */
const REAL_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5.5 (1M context)) · $4/$20 per Mtok',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks · $4/$20 per Mtok',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: 'claude-fable-5-1',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
  },
]

/**
 * Everything `Query.supportedModels()` has been seen to, or could, hand back
 * that is not the list this code hopes for. `undefined` is not a thought
 * experiment: `supportedModels()` is `(await this.initialization).models`, so
 * a CLI whose `initialize` control response carries no `models` key resolves
 * it to `undefined` — reproduced against the shipped SDK with a stub CLI that
 * answers `initialize` without that field.
 */
const GARBAGE: [name: string, probe: () => Promise<unknown>][] = [
  ['resolves null', () => Promise.resolve(null)],
  ['resolves undefined (a CLI whose init response has no `models`)', () => Promise.resolve()],
  ['resolves a non-array', () => Promise.resolve('sonnet')],
  ['resolves an object instead of a list', () => Promise.resolve({ models: [] })],
  ['resolves entries missing displayName/description', () => Promise.resolve([{ value: 'x' }])],
  [
    'resolves entries whose fields are the wrong type',
    () =>
      Promise.resolve([
        { value: 1, displayName: null, description: [], supportedEffortLevels: ['turbo'] },
      ]),
  ],
  ['resolves an empty list', () => Promise.resolve([])],
  ['rejects', () => Promise.reject(new Error('Claude Code process exited with code 1'))],
  [
    'throws synchronously',
    () => {
      throw new Error('spawn ENOENT')
    },
  ],
]

// --- the contract: 200, always ----------------------------------------------

test('every probe outcome, however malformed, still answers 200', async () => {
  for (const [name, probe] of GARBAGE) {
    resetModelsCacheForTests()
    probeBehaviour = probe
    const res = await GET()
    expect({ name, status: res.status }).toEqual({ name, status: 200 })
  }
})

test('a probe that never settles until the abort fires still answers 200, once', async () => {
  jest.useFakeTimers()
  // The shipped SDK rejects an aborted query rather than hanging — confirmed
  // by pointing `pathToClaudeCodeExecutable` at a CLI that never answers the
  // init handshake: abort produced "Claude Code process aborted by user".
  probeBehaviour = (abort) =>
    new Promise((_resolve, reject) => {
      abort?.signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')), {
        once: true,
      })
    })

  let settled = false
  const pending = GET().then((res) => {
    settled = true
    return res
  })

  // Nothing before the 15s deadline may settle it: a shorter timeout would
  // fall back while a slow-but-healthy box was still handshaking.
  jest.advanceTimersByTime(14_000)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(settled).toBe(false)

  jest.advanceTimersByTime(2_000)
  const res = await pending
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.source).toBe('fallback')
  expect(body.models).toEqual(FALLBACK_MODELS)
})

test('the body always matches the response schema the route publishes', async () => {
  // The route declares `modelsResponseSchema` as its 200, and the frontend
  // client is generated from exactly that. @hono/zod-openapi does not check a
  // response against it, so if getModels() forwards whatever the SDK handed
  // over, the published contract is a wish rather than a guarantee.
  const violations: { probe: string; issue: string; body: unknown }[] = []
  for (const [name, probe] of GARBAGE) {
    resetModelsCacheForTests()
    probeBehaviour = probe
    const body = await (await GET()).json()
    const parsed = modelsResponseSchema.safeParse(body)
    if (!parsed.success) {
      violations.push({ probe: name, issue: parsed.error.issues[0]?.message ?? '', body })
    }
  }
  expect(violations).toEqual([])
})

// --- the subprocess ----------------------------------------------------------

test('the query is closed on every path: success, rejection, sync throw, abort', async () => {
  const paths: [string, () => Promise<unknown>][] = [
    ['success', () => Promise.resolve(REAL_MODELS)],
    ['rejection', () => Promise.reject(new Error('exited with code 1'))],
    [
      'sync throw',
      () => {
        throw new Error('control request failed')
      },
    ],
  ]
  for (const [name, probe] of paths) {
    resetModelsCacheForTests()
    closeCalls = 0
    probeBehaviour = probe
    await GET()
    expect({ name, closeCalls }).toEqual({ name, closeCalls: 1 })
  }

  // The abort path needs the clock moved, so it is not in the loop above.
  jest.useFakeTimers()
  resetModelsCacheForTests()
  closeCalls = 0
  probeBehaviour = (abort) =>
    new Promise((_r, reject) => {
      abort?.signal.addEventListener('abort', () => reject(new Error('aborted by user')), {
        once: true,
      })
    })
  const pending = GET()
  jest.advanceTimersByTime(16_000)
  await pending
  expect({ name: 'abort', closeCalls }).toEqual({ name: 'abort', closeCalls: 1 })
})

// features/system/models.ts deliberately does NOT gate this on
// hasClaudeCredential (env.ts:148 — ANTHROPIC_API_KEY || CLAUDE_CODE_OAUTH_TOKEN)
// the way queue/session-run.worker.ts and features/ideas/prompt-service.ts gate
// running a real turn: Claude Code can be, and often is, authenticated purely
// through ~/.claude with neither env var set, and a missing env var used to
// mean this endpoint stayed on the fallback list forever on exactly that kind
// of box. A probe is cheap and self-limiting (PROBE_TIMEOUT_MS, then
// MODELS_FAILURE_TTL_MS before the next attempt), unlike running a session, so
// there is nothing to gain by short-circuiting it here.
test('no env credential configured: the probe still runs, and a live result still wins', async () => {
  setCredential(false)
  probeBehaviour = () => Promise.resolve(REAL_MODELS)
  const res = await GET()
  const body = await res.json()

  expect(res.status).toBe(200)
  // The whole point of the change: a box authenticated through ~/.claude
  // alone (no ANTHROPIC_API_KEY, no CLAUDE_CODE_OAUTH_TOKEN) must see the
  // real, live list rather than being stuck on the fallback forever.
  expect(body.source).toBe('live')
  expect(body.models).toEqual(REAL_MODELS)
  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
})

test('no env credential configured and the probe fails anyway: still the fallback, not a throw', async () => {
  setCredential(false)
  probeBehaviour = () => Promise.reject(new Error('exited with code 1'))
  const res = await GET()
  const body = await res.json()

  expect(res.status).toBe(200)
  expect(body.source).toBe('fallback')
  expect(body.models).toEqual(FALLBACK_MODELS)
  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
})

test('the abort controller the probe is given is the one it passes to query()', async () => {
  let seen: AbortController | undefined
  probeBehaviour = (abort) => {
    seen = abort
    return Promise.resolve(REAL_MODELS)
  }
  await GET()
  expect(queryCalls).toHaveLength(1)
  expect(seen).toBeInstanceOf(AbortController)
  expect(queryCalls[0]?.options.abortController).toBe(seen)
  // Not aborted on the success path — the timeout is cleared, not fired.
  expect(seen?.signal.aborted).toBe(false)
})

// --- dedup -------------------------------------------------------------------

test('twenty callers arriving across separate ticks produce exactly one probe', async () => {
  let release: (models: unknown) => void = () => {}
  probeBehaviour = () => new Promise((resolve) => (release = resolve))

  const responses: Promise<Response>[] = []
  for (let i = 0; i < 20; i++) {
    responses.push(GET())
    // A real macrotask gap between callers: a dedup that only works because
    // three calls were made in one synchronous array literal is not a dedup.
    await new Promise((r) => setTimeout(r, 0))
    expect(queryCalls).toHaveLength(1)
  }

  release(REAL_MODELS)
  const bodies = await Promise.all((await Promise.all(responses)).map((r) => r.json()))

  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
  for (const body of bodies) expect(body).toEqual(bodies[0])
  expect(bodies[0].source).toBe('live')
  expect(bodies[0].models).toEqual(REAL_MODELS)
})

test('callers that pile up on a failing probe all get the fallback, from one probe', async () => {
  let fail: (error: Error) => void = () => {}
  probeBehaviour = () => new Promise((_r, reject) => (fail = reject))

  const responses = [GET(), GET()]
  await new Promise((r) => setTimeout(r, 0))
  responses.push(GET())
  fail(new Error('exited with code 1'))

  const bodies = await Promise.all((await Promise.all(responses)).map((r) => r.json()))
  expect(queryCalls).toHaveLength(1)
  expect(closeCalls).toBe(1)
  for (const body of bodies) expect(body.source).toBe('fallback')
})

test('no credential plus twenty concurrent callers still produce exactly one probe', async () => {
  setCredential(false)
  let release: (models: unknown) => void = () => {}
  probeBehaviour = () => new Promise((resolve) => (release = resolve))

  // The credential gate is gone, but the dedup is not: twenty callers still
  // collapse onto the one probe already in flight, same as with a credential
  // configured (see "twenty callers arriving across separate ticks" above).
  const responses = Array.from({ length: 20 }, () => GET())
  release(REAL_MODELS)
  const bodies = await Promise.all((await Promise.all(responses)).map((r) => r.json()))

  expect(queryCalls).toHaveLength(1)
  for (const body of bodies) expect(body.source).toBe('live')
  for (const body of bodies) expect(body.models).toEqual(REAL_MODELS)
})

// --- the two TTLs ------------------------------------------------------------

/** Moves the wall clock without touching timers, so a cache age can be aged
 * past a TTL without also firing the 15s probe deadline. */
const advance = (ms: number) => jest.setSystemTime(new Date(Date.now() + ms))

test('a live result is reused for six hours and re-probed after them', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-22T00:00:00Z'))
  probeBehaviour = () => Promise.resolve(REAL_MODELS)

  expect((await (await GET()).json()).source).toBe('live')
  expect(queryCalls).toHaveLength(1)

  // Well past the *failure* TTL, and still no second spawn: the two TTLs are
  // genuinely different numbers, not one constant used twice.
  advance(MODELS_FAILURE_TTL_MS * 2)
  await GET()
  expect(queryCalls).toHaveLength(1)

  advance(MODELS_TTL_MS - MODELS_FAILURE_TTL_MS * 2 - 1000)
  await GET()
  expect(queryCalls).toHaveLength(1)

  advance(2000)
  await GET()
  expect(queryCalls).toHaveLength(2)
})

test('a failed probe is retried after five minutes, not after six hours', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-22T00:00:00Z'))
  probeBehaviour = () => Promise.reject(new Error('exited with code 1'))

  expect((await (await GET()).json()).source).toBe('fallback')
  expect(queryCalls).toHaveLength(1)

  advance(MODELS_FAILURE_TTL_MS - 1000)
  await GET()
  expect(queryCalls).toHaveLength(1)

  advance(2000)
  probeBehaviour = () => Promise.resolve(REAL_MODELS)
  const recovered = await (await GET()).json()
  expect(queryCalls).toHaveLength(2)
  // A box whose credential was just fixed must stop reading as broken.
  expect(recovered.source).toBe('live')
  expect(recovered.models).toEqual(REAL_MODELS)
})

test('a credential-less probe failure is also only trusted for the failure TTL', async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-09-22T00:00:00Z'))
  setCredential(false)
  // No env credential no longer means no probe — it means the probe runs
  // with nothing to authenticate with beyond whatever ~/.claude has, and here
  // that genuinely fails on its own, not via a short-circuit.
  probeBehaviour = () => Promise.reject(new Error('exited with code 1'))
  expect((await (await GET()).json()).source).toBe('fallback')
  expect(queryCalls).toHaveLength(1)

  advance(MODELS_FAILURE_TTL_MS - 1000)
  await GET()
  expect(queryCalls).toHaveLength(1)

  // Past the failure TTL, and the credential situation has since improved —
  // an operator ran `claude login`, or ~/.claude was there all along and this
  // is simply the first attempt that reached it: a fresh probe is attempted
  // and can succeed without any env var ever being set.
  advance(2000)
  probeBehaviour = () => Promise.resolve(REAL_MODELS)
  const after = await (await GET()).json()
  expect(queryCalls).toHaveLength(2)
  expect(after.source).toBe('live')
  expect(after.models).toEqual(REAL_MODELS)
})

test('the two TTLs are distinct constants, the failure one much the shorter', () => {
  expect(MODELS_FAILURE_TTL_MS).toBe(5 * 60 * 1000)
  expect(MODELS_TTL_MS).toBe(6 * 60 * 60 * 1000)
  expect(MODELS_FAILURE_TTL_MS).toBeLessThan(MODELS_TTL_MS)
})

// --- the shape of a model row ------------------------------------------------

test('a model row with neither effort field parses, and gains neither', () => {
  const haiku = REAL_MODELS[3]
  expect(haiku?.value).toBe('haiku')
  const parsed = modelOptionSchema.parse(haiku)
  // Optional, not defaulted: inventing `supportsEffort: false` would have the
  // picker claim knowledge of a model it has none of.
  expect('supportsEffort' in parsed).toBe(false)
  expect('supportedEffortLevels' in parsed).toBe(false)
  expect(parsed).toEqual(haiku)
})

test('a bracketed value survives the schema and the wire unchanged', async () => {
  probeBehaviour = () => Promise.resolve(REAL_MODELS)
  const text = await (await GET()).text()
  const body = JSON.parse(text)

  const opus = body.models.find((m: { value: string }) => m.value === 'opus[1m]')
  expect(opus).toBeDefined()
  expect(opus.value).toBe('opus[1m]')
  expect(opus.resolvedModel).toBe('claude-opus-5-5[1m]')
  // No escaping, no stripping, no re-encoding on the way out.
  expect(text).toContain('"value":"opus[1m]"')
  expect(modelOptionSchema.parse(opus).value).toBe('opus[1m]')
  // And the whole live body is what the route promised.
  expect(modelsResponseSchema.safeParse(body).success).toBe(true)
})

test('the built-in fallback list is itself a valid response body', async () => {
  probeBehaviour = () => Promise.reject(new Error('nope'))
  const body = await (await GET()).json()
  const parsed = modelsResponseSchema.safeParse(body)
  expect(parsed.success).toBe(true)
  expect(body.models.length).toBeGreaterThan(0)
  expect(new Date(body.fetchedAt).toISOString()).toBe(body.fetchedAt)
})
