// features/learning/model-call.ts's runOneShotQuery: both the ordinary
// return path and the catch block treat an `is_error: true` result the same
// way (D-item 8 in the defect log) — a `subtype: 'success'` result the SDK
// still flags `is_error: true` (seen in practice for an invalid credential)
// must read as that failure, never as "the model's answer was not valid
// JSON", which is what the catch path used to report when the SDK threw
// right after delivering exactly this kind of result (mirroring
// prompt-service.ts's own documented "the SDK can throw on the very next
// pull after already delivering a perfectly good result message").

import { afterEach, expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

let turnBehaviour: () => AsyncIterable<unknown> = () => empty()
async function* empty(): AsyncIterable<unknown> {}
/** What the last `query` call was handed, for the option-forwarding tests below. */
let lastQueryOptions: Record<string, unknown> = {}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    lastQueryOptions = args.options
    return turnBehaviour()
  },
}))

const { runOneShotQuery } = await import(`${B}/features/learning/model-call.ts`)

afterEach(() => {
  turnBehaviour = () => empty()
})

const AUTH_FAILURE_TEXT = 'Failed to authenticate. API Error: 401 Invalid bearer token'

function authFailureResult() {
  return { type: 'result', subtype: 'success', is_error: true, result: AUTH_FAILURE_TEXT, total_cost_usd: 0 }
}

test('an is_error result returned normally fails with the SDK\'s own message, not a JSON parse error', async () => {
  turnBehaviour = async function* () {
    yield authFailureResult()
  }
  const result = await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
  })
  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.reason).toBe(AUTH_FAILURE_TEXT)
})

test('an is_error result that the SDK then throws past fails with the same message, not "not valid JSON"', async () => {
  // Exactly the shape the task describes: the SDK yields the is_error result
  // and then throws on the very next pull, before the generator's `return`
  // (and thus runOneShotQuery's own `for await`) ever completes normally.
  turnBehaviour = async function* () {
    yield authFailureResult()
    throw new Error('stream ended unexpectedly')
  }
  const result = await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
  })
  expect(result.ok).toBe(false)
  const reason = result.ok ? undefined : result.reason
  expect(reason).toBe(AUTH_FAILURE_TEXT)
  expect(reason).not.toContain('not valid JSON')
})

test('a genuinely malformed JSON answer (no is_error) still reports the JSON parse failure', async () => {
  turnBehaviour = async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: 'not json', total_cost_usd: 0.01 }
    throw new Error('stream ended unexpectedly')
  }
  const result = await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
  })
  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.reason).toContain('Model answer was not valid JSON')
})

test("engine.ts's own prefix composes into the task's exact message shape", async () => {
  turnBehaviour = async function* () {
    yield authFailureResult()
    throw new Error('stream ended unexpectedly')
  }
  const result = await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
  })
  const reason = result.ok ? '' : result.reason
  expect(`review call failed: ${reason}`).toBe(
    'review call failed: Failed to authenticate. API Error: 401 Invalid bearer token',
  )
})

// --- per-call overrides ---------------------------------------------------------
//
// Session compaction makes the same call with its own timeout, budget and model
// (SESSION_COMPACTION_*), so it must not be governed by LEARNING_*. Without any
// override this function is exactly what it was.

const okAnswer = async function* () {
  yield { type: 'result', subtype: 'success', is_error: false, result: '{}', total_cost_usd: 0 }
}

test('with no overrides it is governed by LEARNING_*, as before', async () => {
  turnBehaviour = okAnswer
  await runOneShotQuery({ systemPrompt: 'x', prompt: 'y', outputJsonSchema: { type: 'object' } })

  const { env } = await import(`${B}/env.ts`)
  expect(lastQueryOptions.maxBudgetUsd).toBe(env.LEARNING_CALL_BUDGET_USD)
  expect(lastQueryOptions.maxTurns).toBe(env.LEARNING_MAX_TURNS)
  expect('model' in lastQueryOptions).toBe(env.LEARNING_MODEL !== undefined)
})

test('a budget and a model override replace the learning ones, and the rest is untouched', async () => {
  turnBehaviour = okAnswer
  await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
    overrides: { maxBudgetUsd: 17, model: 'some-model' },
  })

  const { env } = await import(`${B}/env.ts`)
  expect(lastQueryOptions.maxBudgetUsd).toBe(17)
  expect(lastQueryOptions.model).toBe('some-model')
  expect(lastQueryOptions.maxTurns).toBe(env.LEARNING_MAX_TURNS)
  expect(lastQueryOptions.tools).toEqual([])
  expect(lastQueryOptions.persistSession).toBe(false)
})

test('model: null sends no model at all, which is not the same as omitting it', async () => {
  turnBehaviour = okAnswer
  await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
    overrides: { model: null },
  })
  expect('model' in lastQueryOptions).toBe(false)
})

test('a timeout override aborts the call at that deadline and names it', async () => {
  turnBehaviour = () =>
    (async function* () {
      await new Promise<void>((_, reject) => {
        ;(lastQueryOptions.abortController as AbortController).signal.addEventListener(
          'abort',
          () => reject(new Error('Operation aborted')),
        )
      })
      yield undefined
    })()

  const started = Date.now()
  const result = await runOneShotQuery({
    systemPrompt: 'x',
    prompt: 'y',
    outputJsonSchema: { type: 'object' },
    overrides: { timeoutMs: 40 },
  })

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.reason).toContain('40ms timeout')
  expect(Date.now() - started).toBeLessThan(5_000)
})
