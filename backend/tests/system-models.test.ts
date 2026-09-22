// The live/fallback model list: features/system/models.ts.
//
// The SDK is faked exactly as idea-prompt-worker.test.ts fakes it — see that
// file's own notes on why `mock.module` swaps a module for the whole test
// run, not just this file, and why `hasClaudeCredential` is toggled by
// re-registering the `@/env` mock rather than by mutating a captured
// variable a getter would only read once. Here that toggle exists for one
// purpose only: proving the probe is attempted even when it reads false —
// models.ts deliberately does not gate on it (see that module's own header
// comment for why).

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import './setup-env'
// Side-effect only: registers zod's `.openapi()` extension (extendZodWithOpenApi,
// called at this package's own module top level) before schema.ts is imported
// below. schema.ts itself imports plain `z` from 'zod' and relies on some
// earlier import in the graph — normally routes.ts — having patched it first;
// this file never imports routes.ts, so without this line `z.enum(...).openapi`
// is undefined and schema.ts throws on load.
import '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

/** Every call `query()` was made with, so a test can assert dedup counts. */
let queryCalls: { options: Record<string, unknown> }[] = []
/** How many times the fake query's `close()` was invoked — the subprocess
 * this module must never leak one of per probe. */
let closeCalls = 0
/** What the fake `supportedModels()` control request resolves (or rejects)
 * with, set per test. */
let probeBehaviour: () => Promise<unknown> = () => Promise.resolve([])

/** The one true fake — every test that does not swap it out for something
 * else (only the query()-throws test below does) restores this in
 * `afterEach`. */
function defaultSdkFactory() {
  return {
    query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
      queryCalls.push({ options: params.options })
      return {
        supportedModels: () => probeBehaviour(),
        close: () => {
          closeCalls++
        },
      }
    },
  }
}

// Nothing here may reach Anthropic. `query` is the only thing models.ts calls
// from the SDK at runtime — everything else it takes from the package is a
// type, erased at build time, so the fake need not export anything else.
mock.module('@anthropic-ai/claude-agent-sdk', defaultSdkFactory)

const realEnv = (await import(`${B}/env.ts`)) as { env: unknown; hasClaudeCredential: boolean }
function setCredential(has: boolean) {
  mock.module(`${B}/env.ts`, () => ({ ...realEnv, hasClaudeCredential: has }))
}
setCredential(true)

const { getModels, resetModelsCacheForTests } = await import(`${B}/features/system/models.ts`)
const { FALLBACK_MODELS } = await import(`${B}/library/models.ts`)
const { modelsResponseSchema } = await import(`${B}/features/system/schema.ts`)

afterEach(() => {
  resetModelsCacheForTests()
  queryCalls = []
  closeCalls = 0
  probeBehaviour = () => Promise.resolve([])
  setCredential(true)
  mock.module('@anthropic-ai/claude-agent-sdk', defaultSdkFactory)
})

// Restores the real module for whatever test file runs after this one — see
// idea-prompt-worker.test.ts's identical `afterAll` for why this can
// otherwise leak into a later file's suite.
afterAll(() => {
  mock.module(`${B}/env.ts`, () => realEnv)
})

const LIVE_MODELS = [
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5, live from the SDK' },
]

/** Every malformed-probe test asserts this: whatever getModels() answers
 * with must satisfy the same schema the route publishes, because nothing in
 * @hono/zod-openapi checks a handler's return value against it — that check
 * has to happen here, at the boundary, or not at all. */
function expectValidResponse(result: unknown) {
  const parsed = modelsResponseSchema.safeParse(result)
  expect(parsed.success).toBe(true)
}

// --- no credential env var: the probe is attempted anyway --------------------

test('no ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN: the probe still runs, not just the fallback', async () => {
  setCredential(false)
  probeBehaviour = () => Promise.resolve(LIVE_MODELS)

  const result = await getModels()

  // The point of the fix: a box authenticated through ~/.claude alone (no
  // env var) must still see the real list, not be stuck on the fallback.
  expect(queryCalls).toHaveLength(1)
  expect(result.source).toBe('live')
  expect(result.models).toEqual(LIVE_MODELS)
})

test('no credential env var and a failed probe still falls back cleanly', async () => {
  setCredential(false)
  probeBehaviour = () => Promise.reject(new Error('Claude Code process exited with code 1'))

  const result = await getModels()

  expect(queryCalls).toHaveLength(1)
  expect(result.source).toBe('fallback')
  expect(result.models).toEqual(FALLBACK_MODELS)
})

// --- the TTL cache -----------------------------------------------------------

test('a cached live result is returned without a second probe', async () => {
  probeBehaviour = () => Promise.resolve(LIVE_MODELS)

  const first = await getModels()
  expect(first.source).toBe('live')
  expect(first.models).toEqual(LIVE_MODELS)
  expect(queryCalls).toHaveLength(1)

  const second = await getModels()
  expect(second).toEqual(first)
  // The point of the cache: a second call inside the TTL must not spawn
  // another CLI subprocess.
  expect(queryCalls).toHaveLength(1)
})

// --- inFlight dedup -----------------------------------------------------------

test('concurrent callers dedup onto exactly one probe', async () => {
  let resolveProbe: (models: unknown[]) => void = () => {}
  probeBehaviour = () => new Promise((resolve) => (resolveProbe = resolve))

  // Array literals evaluate left to right, synchronously, before `Promise.all`
  // ever awaits — so all three calls have already reached (and reused) the
  // same `inFlight` promise by the time this line finishes, well before the
  // probe below resolves.
  const calls = [getModels(), getModels(), getModels()]
  expect(queryCalls).toHaveLength(1)

  resolveProbe(LIVE_MODELS)
  const [r1, r2, r3] = await Promise.all(calls)

  expect(r1).toEqual(r2)
  expect(r2).toEqual(r3)
  expect(queryCalls).toHaveLength(1)
})

// --- a failed or hung probe still answers, and never leaks the subprocess ----

test('a failed probe falls back to the built-in list instead of rejecting', async () => {
  probeBehaviour = () => Promise.reject(new Error('Claude Code process exited with code 1'))

  const result = await getModels()

  expect(result.source).toBe('fallback')
  expect(result.models).toEqual(FALLBACK_MODELS)
  expect(closeCalls).toBe(1)
})

test('a successful probe closes the query too, not only a failed one', async () => {
  probeBehaviour = () => Promise.resolve(LIVE_MODELS)
  await getModels()
  expect(closeCalls).toBe(1)
})

test('a query() that throws synchronously still clears its timeout — no leaked timer', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // Tracked by the timer *id* setTimeout hands back, not by a bare call
  // count: this process's logger (consola) clears timeouts of its own on
  // every call, including the logger.warn() the catch below makes, so a
  // plain "clearTimeout was called exactly once" assertion is a false
  // positive/negative generator — it would pass or fail depending on
  // consola's own unrelated internals rather than on this module's bug.
  // Tying the assertion to the specific id probeModels() armed is what
  // isolates the two.
  const armedIds: unknown[] = []
  const clearedIds: unknown[] = []
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    const id = realSetTimeout(fn, ms)
    armedIds.push(id)
    return id
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    clearedIds.push(id)
    return realClearTimeout(id)
  }) as typeof clearTimeout

  // The shape this is standing in for: the SDK cannot spawn the CLI at all
  // (missing binary, bad pathToClaudeCodeExecutable) and `query()` itself
  // throws before returning a `Query` — so there is no `q` for an inner
  // finally to hang a clear off, which is exactly the gap the fix closes.
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: () => {
      throw new Error('Claude Code executable not found')
    },
  }))

  try {
    const result = await getModels()
    expect(result.source).toBe('fallback')
    expect(result.models).toEqual(FALLBACK_MODELS)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  expect(armedIds).toHaveLength(1)
  expect(clearedIds).toContain(armedIds[0])
})

// --- a malformed probe result: validated at the boundary, never trusted ------
//
// supportedModels() is `(await this.initialization).models` in the SDK
// itself — nothing stops a CLI build from resolving that to something that
// is not a well-formed ModelOption[], and @hono/zod-openapi only validates
// requests, never what a handler returns. Every case below must still
// satisfy modelsResponseSchema, and must not throw past getModels().

test('supportedModels() resolving null falls back wholesale', async () => {
  probeBehaviour = () => Promise.resolve(null)
  const result = await getModels()

  expect(result.source).toBe('fallback')
  expect(result.models).toEqual(FALLBACK_MODELS)
  expectValidResponse(result)
})

test('supportedModels() resolving undefined falls back wholesale', async () => {
  probeBehaviour = () => Promise.resolve(undefined)
  const result = await getModels()

  expect(result.source).toBe('fallback')
  expect(result.models).toEqual(FALLBACK_MODELS)
  expectValidResponse(result)
})

test('supportedModels() resolving a bare string (not an array) falls back wholesale', async () => {
  probeBehaviour = () => Promise.resolve('sonnet')
  const result = await getModels()

  expect(result.source).toBe('fallback')
  expect(result.models).toEqual(FALLBACK_MODELS)
  expectValidResponse(result)
})

test('an array where every entry is malformed stays "live", but with none of them', async () => {
  // Not an empty array from the SDK — a non-empty one where nothing in it
  // parses. Reported as a live, empty list rather than a fallback: the
  // top-level shape (an array) is exactly what was expected, so this is not
  // the "cannot even tell this is a list" failure the cases above are.
  probeBehaviour = () =>
    Promise.resolve([
      { value: 1, displayName: null, description: [], supportedEffortLevels: ['turbo'] },
    ])
  const result = await getModels()

  expect(result.source).toBe('live')
  expect(result.models).toEqual([])
  expectValidResponse(result)
})

test('a mixed array keeps the well-formed entries and drops only the bad one', async () => {
  const good = { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient' }
  const bad = { value: 'opus', displayName: 'Opus' } // missing `description`
  probeBehaviour = () => Promise.resolve([good, bad])
  const result = await getModels()

  expect(result.source).toBe('live')
  expect(result.models).toEqual([good])
  expectValidResponse(result)
})

test('a well-formed entry with only the optional fields present still passes through', async () => {
  const rich = {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus with 1M context',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  }
  probeBehaviour = () => Promise.resolve([rich])
  const result = await getModels()

  expect(result.source).toBe('live')
  expect(result.models).toEqual([rich])
  expectValidResponse(result)
})
