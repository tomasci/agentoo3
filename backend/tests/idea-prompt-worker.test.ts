// The one-shot idea-to-prompt generation: features/ideas/prompt-service.ts.
//
// The SDK is faked exactly as session-recovery.test.ts fakes it — see that
// file's own notes on why `mock.module` swaps a module for the whole test
// run, not just this file, and why the db and queue fakes below only ever
// answer the shapes this code path actually builds.

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

const PROMPT_ID = 'prompt-1'

function freshRow(): Row {
  return {
    id: PROMPT_ID,
    ideaId: 'idea-1',
    kind: 'initial',
    sourceDigest: '# An idea\n\n**Requirement.** Ship the thing.\n',
    generatedTitle: null,
    generatedText: null,
    assumptions: null,
    model: null,
    costUsd: null,
    status: 'pending',
    error: null,
    createdAt: new Date(),
    completedAt: null,
  }
}

/** The one row this fake's `db` holds. Reset between tests. */
let row: Row = freshRow()

/** What the SDK's `query()` does when called, set per test. */
let turnBehaviour: (options: Record<string, unknown>) => AsyncIterable<unknown> = () => empty()

async function* empty(): AsyncIterable<unknown> {}

/**
 * Every call `query()` was made with. A generation calls it at most once —
 * several of the tests below exist specifically to prove that — so asserting
 * on `queryCalls[0]` is the norm, not `queryCalls.at(-1)`.
 */
let queryCalls: { prompt: string; options: Record<string, unknown> }[] = []

const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

// Drizzle's builders chain in a fixed order; this fake only answers the two
// shapes prompt-service.ts actually builds: a `select().from().where().limit()`
// read of the row, and an `update().set().where()` write to it.
const db = {
  select: () => ({
    from: (t: unknown) => ({
      where: () => ({
        limit: async () => (table(t) === 'idea_prompts' ? [row] : []),
      }),
    }),
  }),
  update: (t: unknown) => ({
    set: (payload: Row) => ({
      where: async () => {
        if (table(t) !== 'idea_prompts') return
        dbWrites.push(payload)
        row = { ...row, ...payload }
      },
    }),
  }),
}

/**
 * Every payload written to the row, in order. Reset between tests.
 *
 * `row` alone cannot answer "was this finalised twice?" — a second write of
 * the same status is invisible in the merged result. That question is worth
 * asking now that prompt-service.ts finalises a captured result from two
 * places (after the loop, and from the catch when the SDK threw past it): a
 * row landing on `ready` and then being overwritten as `failed` would be a
 * far worse bug than the one that arrangement fixes.
 */
let dbWrites: Row[] = []

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

// Nothing here may reach Anthropic. `query` is the only thing this module
// calls from the SDK at runtime — everything else it takes from the package
// is a type, erased at build time, so the fake need not export anything else.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(params)
    return turnBehaviour(params.options)
  },
}))

// `hasClaudeCredential` is toggled per test by re-registering this mock, not
// by mutating a captured variable a getter reads — a getter's return value is
// read once, when the factory runs, and frozen from then on (verified against
// bun's actual mock.module behaviour, not assumed); re-calling `mock.module`
// with a new factory is what actually changes what every binding to this
// module — including the one prompt-service.ts already holds — sees next.
// `env` itself (the parsed object) is forwarded unchanged throughout, since
// features/ideas/prompt-service.ts and library/idea-prompt.ts both read real
// fields off it (LIBRARY_DIR, IDEA_PROMPT_MAX_BUDGET_USD, ...) that have
// nothing to do with what this file is testing.
const realEnv = (await import(`${B}/env.ts`)) as {
  env: {
    IDEA_PROMPT_MAX_TURNS: number
    IDEA_PROMPT_MAX_BUDGET_USD: number
    IDEA_PROMPT_TIMEOUT_MS: number
  }
  hasClaudeCredential: boolean
}
function setCredential(has: boolean) {
  mock.module(`${B}/env.ts`, () => ({ ...realEnv, hasClaudeCredential: has }))
}
setCredential(true)

const { runIdeaPrompt } = await import(`${B}/features/ideas/prompt-service.ts`)
const { IDEA_PROMPT_INSTRUCTION_FALLBACK } = await import(`${B}/library/idea-prompt.ts`)

afterEach(() => {
  row = freshRow()
  dbWrites = []
  queryCalls = []
  turnBehaviour = () => empty()
  setCredential(true)
})

// Restores the real module for whatever test file runs after this one — see
// the note above the mock.module call above for why this can otherwise leak.
afterAll(() => {
  mock.module(`${B}/env.ts`, () => realEnv)
})

const validAnswer = {
  title: 'Ship the export button',
  prompt: 'Add an export button to the toolbar.',
  assumptions: ['Assumed the button belongs next to Save.'],
}

function successStream(
  answer: unknown,
  opts: { model?: string; totalCostUsd?: number; isError?: boolean } = {},
) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', model: opts.model ?? 'claude-sonnet-5' }
    yield {
      type: 'result',
      subtype: 'success',
      is_error: opts.isError ?? false,
      result: JSON.stringify(answer),
      total_cost_usd: opts.totalCostUsd ?? 0.03,
    }
  })()
}

// --- what is asked of the SDK --------------------------------------------

test('query() is called exactly once, tool-less, with room for more than one turn', async () => {
  turnBehaviour = () => successStream(validAnswer)
  await runIdeaPrompt(PROMPT_ID)

  expect(queryCalls).toHaveLength(1)
  const { options } = queryCalls[0] as (typeof queryCalls)[number]
  expect(options.settingSources).toEqual([])
  expect(options.tools).toEqual([])
  // Whatever the operator configured reaches the SDK — not a number pinned
  // here. This asserted 1, which is a single API round-trip and is what made
  // every generation fail with "Reached maximum number of turns (1)" before
  // it could answer. Two things have to hold: the knob is what is passed, and
  // it leaves room for the structured-output retry one round-trip cannot fit.
  expect(options.maxTurns).toBe(realEnv.env.IDEA_PROMPT_MAX_TURNS)
  expect(options.maxTurns as number).toBeGreaterThan(1)
  expect(typeof options.maxBudgetUsd).toBe('number')
  expect(options.abortController).toBeInstanceOf(AbortController)
  expect(options.persistSession).toBe(false)
  expect(options.systemPrompt).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)
  expect(options.outputFormat).toEqual({
    type: 'json_schema',
    schema: expect.any(Object),
  })
})

test("the prompt body is the row's sourceDigest, verbatim", async () => {
  turnBehaviour = () => successStream(validAnswer)
  await runIdeaPrompt(PROMPT_ID)
  expect(queryCalls[0]?.prompt).toBe(row.sourceDigest)
})

test('the subprocess env carries no database or queue credential', async () => {
  turnBehaviour = () => successStream(validAnswer)
  await runIdeaPrompt(PROMPT_ID)

  const passedEnv = queryCalls[0]?.options.env as Record<string, unknown>
  expect(passedEnv).toBeDefined()
  expect('DATABASE_URL' in passedEnv).toBe(false)
  expect('REDIS_URL' in passedEnv).toBe(false)
  // What it does carry, so the negative assertions above aren't hiding an
  // env that is simply empty and would trivially pass them.
  expect(passedEnv.PATH).toBe(process.env.PATH)
})

// --- a clean answer --------------------------------------------------------

test('a valid answer lands the row on ready, with a prompt, a model and a cost', async () => {
  turnBehaviour = () => successStream(validAnswer, { model: 'claude-opus-4-8', totalCostUsd: 0.12 })
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('ready')
  expect(row.generatedTitle).toBe(validAnswer.title)
  expect(row.generatedText).toBe(validAnswer.prompt)
  expect(row.generatedText).not.toBe('')
  expect(row.assumptions).toEqual(validAnswer.assumptions)
  expect(row.model).toBe('claude-opus-4-8')
  expect(typeof row.costUsd).toBe('number')
  expect(row.costUsd).toBe(0.12)
  expect(row.completedAt).toBeInstanceOf(Date)
  expect(row.error).toBeNull()
  // The control for the same assertion on the success-from-catch test below.
  expect(dbWrites).toHaveLength(1)
})

// --- a malformed answer ------------------------------------------------------

test('an answer missing a required field fails with a descriptive error', async () => {
  turnBehaviour = () => successStream({ title: 'Only a title' })
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('did not match the expected shape')
})

test('an answer that is not JSON at all fails with a descriptive error', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'not json',
        total_cost_usd: 0.01,
      }
    })()
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('not valid JSON')
})

test('a result that stopped early (over budget) fails with the subtype named', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1 }
    })()
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('error_max_budget_usd')
})

// --- the SDK's own early stops ---------------------------------------------
//
// The shape every test below reproduces is the one behind the reported bug,
// and it is not obvious from the SDK's surface. Verified in
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs rather than assumed:
// Query.readMessages records the error result as `lastErrorResultText` AND
// enqueues that same `result` message to this consumer, and the stream it
// enqueues onto drains its queue before it ever reports an error — so the
// `for await` in prompt-service.ts does receive the result, and only throws
// `Claude Code returned an error result: <errors joined>` while advancing to
// the message after it. Which is why none of prompt-service.ts's post-loop
// checks run for any of these, and the catch block is what has to name the
// condition. Before that block could read `lastResult`, every one of these
// collapsed into the same opaque `Generation failed: …` string.

/**
 * An error `result` message, then the SDK's own throw on the next pull —
 * i.e. the real ordering described above, not a throw instead of a result.
 *
 * `errors` is omitted entirely when none is given, because that is the shape
 * that actually matters: the SDK's type declares the field as always present,
 * so anything that trusts the declaration and calls `result.errors.join()`
 * throws a TypeError from inside the catch block — where nothing is left to
 * catch it, and the row is left `pending` for BullMQ to redeliver.
 */
function earlyStopStream(
  subtype: string,
  opts: { errors?: string[]; stopReason?: string | null; totalCostUsd?: number } = {},
) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
    yield {
      type: 'result',
      subtype,
      is_error: true,
      stop_reason: opts.stopReason ?? null,
      total_cost_usd: opts.totalCostUsd ?? 0.02,
      ...(opts.errors === undefined ? {} : { errors: opts.errors }),
    }
    throw new Error(`Claude Code returned an error result: ${(opts.errors ?? []).join('; ')}`)
    // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
    yield undefined
  })()
}

test('a run that hits the turn limit fails naming IDEA_PROMPT_MAX_TURNS', async () => {
  // The exact shape of the reported bug, down to the SDK's own wording.
  turnBehaviour = () =>
    earlyStopStream('error_max_turns', {
      errors: [`Reached maximum number of turns (${realEnv.env.IDEA_PROMPT_MAX_TURNS})`],
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  // The knob, by name and current value: an operator reading this row should
  // not have to open prompt-service.ts to find out what to raise.
  expect(reason).toContain('IDEA_PROMPT_MAX_TURNS')
  expect(reason).toContain(String(realEnv.env.IDEA_PROMPT_MAX_TURNS))
  expect(reason).toContain('error_max_turns')
  expect(reason).toContain('Reached maximum number of turns')
  // Not the generic catch-all, which is the whole point of the change.
  expect(reason).not.toContain('Generation failed:')
  expect(row.completedAt).toBeInstanceOf(Date)
})

test('a run that hits the budget ceiling fails naming IDEA_PROMPT_MAX_BUDGET_USD', async () => {
  turnBehaviour = () =>
    earlyStopStream('error_max_budget_usd', {
      errors: ['Exceeded max budget'],
      totalCostUsd: realEnv.env.IDEA_PROMPT_MAX_BUDGET_USD,
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('IDEA_PROMPT_MAX_BUDGET_USD')
  expect(reason).toContain(String(realEnv.env.IDEA_PROMPT_MAX_BUDGET_USD))
  expect(reason).toContain('error_max_budget_usd')
  expect(reason).toContain('Exceeded max budget')
  // The wrong knob named is worse than none: it sends the operator to raise a
  // limit that was never the one in the way.
  expect(reason).not.toContain('IDEA_PROMPT_MAX_TURNS')
  expect(reason).not.toContain('Generation failed:')
})

test('an error result with no errors field at all is described, not thrown over', async () => {
  turnBehaviour = () => earlyStopStream('error_max_turns')
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('IDEA_PROMPT_MAX_TURNS')
  expect(reason).toContain('no detail given')
  expect(reason).not.toContain('undefined')
})

test('an empty errors array falls back to the SDK stop_reason', async () => {
  turnBehaviour = () =>
    earlyStopStream('error_during_execution', {
      errors: [],
      stopReason: 'model_context_window_exceeded',
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('error_during_execution')
  expect(reason).toContain('model_context_window_exceeded')
  expect(reason).not.toContain('Generation failed:')
})

test('a structured-output give-up names the subtype and the SDK detail', async () => {
  turnBehaviour = () =>
    earlyStopStream('error_max_structured_output_retries', {
      errors: ['Output did not validate against the requested schema'],
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('error_max_structured_output_retries')
  expect(reason).toContain('Output did not validate against the requested schema')
  expect(reason).not.toContain('Generation failed:')
})

test('a subtype this module has never heard of still produces a legible reason', async () => {
  // SDKMessage's own doc calls this union open. An unknown subtype must not
  // fall out of describeResultError into the generic string.
  turnBehaviour = () =>
    earlyStopStream('error_something_the_sdk_added_later', { errors: ['who knows'] })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('error_something_the_sdk_added_later')
  expect(reason).toContain('who knows')
})

test('a throw with no result message ever received falls back to the generic reason', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
      throw new Error('Claude Code process exited with code 1. stderr: boom')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('Generation failed:')
  expect(reason).toContain('exited with code 1')
  // Nothing was captured, so nothing may be claimed: naming a limit here
  // would be a guess dressed up as a diagnosis.
  expect(reason).not.toContain('IDEA_PROMPT_MAX_TURNS')
  expect(reason).not.toContain('IDEA_PROMPT_MAX_BUDGET_USD')
  expect(reason).not.toContain('aborted')
  expect(row.completedAt).toBeInstanceOf(Date)
})

test('a stream that ends cleanly without any result message fails with its own reason', async () => {
  turnBehaviour = () => empty()
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('no result message')
})

test('a success-subtype result flagged is_error fails as an API error', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Overloaded',
        total_cost_usd: 0.01,
      }
    })()
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('API error')
  expect(String(row.error)).toContain('Overloaded')
  expect(row.generatedText).toBeNull()
})

// --- a result the SDK threw past ---------------------------------------------
//
// The same delivered-then-thrown ordering as the section above, but with a
// perfectly good answer in the result. The CLI process exits after every
// single-prompt run (SDKResultMessage's own doc says so), and when that exit
// is non-zero the transport's `getProcessExitError` turns it into a throw the
// consumer sees on the pull after the result — SIGTERM during a deploy, a
// crash on shutdown, a non-zero code after the answer was already emitted.
// The answer has been produced and billed by then; discarding it costs the
// money twice, since the row's only recovery is a regenerate.

/** A result message, then a throw on the next pull — the CLI exiting badly. */
function resultThenExitStream(
  result: Record<string, unknown>,
  opts: { model?: string; exitMessage?: string } = {},
) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', model: opts.model ?? 'claude-sonnet-5' }
    yield result
    throw new Error(opts.exitMessage ?? 'Claude Code process exited with code 143')
    // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
    yield undefined
  })()
}

test('a valid answer the CLI then exits non-zero over is stored, not discarded', async () => {
  turnBehaviour = () =>
    resultThenExitStream(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(validAnswer),
        total_cost_usd: 0.07,
      },
      { model: 'claude-opus-4-8' },
    )
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('ready')
  expect(row.generatedTitle).toBe(validAnswer.title)
  expect(row.generatedText).toBe(validAnswer.prompt)
  expect(row.assumptions).toEqual(validAnswer.assumptions)
  expect(row.model).toBe('claude-opus-4-8')
  expect(row.costUsd).toBe(0.07)
  expect(row.completedAt).toBeInstanceOf(Date)
  expect(row.error).toBeNull()
})

test('a result finalised after the loop is not finalised again by the catch', async () => {
  // Both exits now run the same finaliser. The one thing that must not happen
  // is both of them running: a row written `ready` and then overwritten by a
  // catch that ran anyway would be worse than the discarded answer above.
  turnBehaviour = () =>
    resultThenExitStream({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(validAnswer),
      total_cost_usd: 0.07,
    })
  await runIdeaPrompt(PROMPT_ID)

  expect(dbWrites).toHaveLength(1)
  expect(dbWrites[0]?.status).toBe('ready')
})

test('a malformed answer reaching the catch is stored as a failure, not thrown over', async () => {
  // The finaliser runs from inside a catch block here. Anything it throws has
  // nothing left to catch it, so the row would be left `pending` for BullMQ to
  // redeliver an already-billed call.
  turnBehaviour = () =>
    resultThenExitStream({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"title":"only a title"}',
      total_cost_usd: 0.09,
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('did not match the expected shape')
  expect(row.generatedText).toBeNull()
  // Malformed or not, the run was billed.
  expect(row.costUsd).toBe(0.09)
  expect(row.model).toBe('claude-sonnet-5')
  expect(dbWrites).toHaveLength(1)
})

test('answer text that is not JSON at all reaching the catch fails the same way', async () => {
  turnBehaviour = () =>
    resultThenExitStream({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'not json',
      total_cost_usd: 0.04,
    })
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('not valid JSON')
  expect(row.costUsd).toBe(0.04)
})

// --- what a billed failure records -------------------------------------------

test('a failure that had a result records the cost and model it reported', async () => {
  // An error_max_budget_usd run is by definition the most expensive kind
  // there is. Storing null cost for it made cost accounting over
  // idea_prompts undercount exactly the runs that spent the most.
  turnBehaviour = () =>
    earlyStopStream('error_max_budget_usd', {
      errors: ['Exceeded max budget'],
      totalCostUsd: realEnv.env.IDEA_PROMPT_MAX_BUDGET_USD,
    })
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(row.costUsd).toBe(realEnv.env.IDEA_PROMPT_MAX_BUDGET_USD)
  expect(row.model).toBe('claude-sonnet-5')
  expect(String(row.error)).toContain('IDEA_PROMPT_MAX_BUDGET_USD')
})

test('a failure with no result at all records no cost and no model', async () => {
  // The honest null: nothing was captured, so there is nothing to attribute.
  // Without this, a cost column filled in from somewhere else — a stale
  // variable, a default — would pass the test above just as well.
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
      throw new Error('Claude Code process exited with code 1')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(row.costUsd).toBeNull()
  expect(row.model).toBeNull()
})

// --- an abort ----------------------------------------------------------------

test('an aborted generation fails, naming the abort', async () => {
  turnBehaviour = (options) =>
    (async function* () {
      // Simulates the timeout firing mid-stream, without waiting out the real
      // IDEA_PROMPT_TIMEOUT_MS: the abort is the SDK's own signal, thrown from
      // inside the iteration, exactly as the real one would surface.
      ;(options.abortController as AbortController).abort()
      await Promise.resolve()
      throw new Error('The operation was aborted.')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(String(row.error)).toContain('aborted')
})

test('an ordinary thrown error fails too, without claiming it was an abort', async () => {
  turnBehaviour = () =>
    (async function* () {
      await Promise.resolve()
      throw new Error('Claude Code process exited with code 1')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()
  await runIdeaPrompt(PROMPT_ID)

  expect(row.status).toBe('failed')
  expect(String(row.error)).not.toContain('aborted')
  expect(String(row.error)).toContain('exited with code 1')
})

// --- the guards that must trip before anything is spent ----------------------

test('no credential fails the row without ever calling query()', async () => {
  setCredential(false)
  await runIdeaPrompt(PROMPT_ID)

  expect(queryCalls).toHaveLength(0)
  expect(row.status).toBe('failed')
  expect(row.error).toBe(
    'No Claude credential. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
  )
})

test('a row that is already ready is left alone, without calling query()', async () => {
  row = { ...freshRow(), status: 'ready', generatedText: 'already done' }
  await runIdeaPrompt(PROMPT_ID)

  expect(queryCalls).toHaveLength(0)
  expect(row.status).toBe('ready')
  expect(row.generatedText).toBe('already done')
})

test('a row that is already failed is left alone too', async () => {
  row = { ...freshRow(), status: 'failed', error: 'a previous run' }
  await runIdeaPrompt(PROMPT_ID)

  expect(queryCalls).toHaveLength(0)
  expect(row.error).toBe('a previous run')
})

test('an abort is told apart from an early stop even when a result arrived first', async () => {
  // A timeout can fire after the model already produced an error result. The
  // abort is what actually ended this run, so that is what the row has to
  // say — raising IDEA_PROMPT_MAX_TURNS would not have saved it.
  turnBehaviour = (options) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (6)'],
        stop_reason: null,
        total_cost_usd: 0.42,
      }
      ;(options.abortController as AbortController).abort()
      await Promise.resolve()
      throw new Error('Claude Code process aborted by user')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()
  await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()

  expect(row.status).toBe('failed')
  const reason = String(row.error)
  expect(reason).toContain('aborted')
  expect(reason).toContain(String(realEnv.env.IDEA_PROMPT_TIMEOUT_MS))
  expect(reason).not.toContain('IDEA_PROMPT_MAX_TURNS')
  // The deadline is why this run ended, but the spend the result already
  // reported happened all the same.
  expect(row.costUsd).toBe(0.42)
  expect(row.model).toBe('claude-sonnet-5')
})

// --- the invariant the queue depends on --------------------------------------

test('no failure path throws past the queue worker; each leaves a failed row and a reason', async () => {
  // queue/idea-prompt.worker.ts hands runIdeaPrompt straight to BullMQ. A
  // rejection there is a job failure — and the model call has already been
  // billed by the time any of these can happen — so every path below must
  // resolve, and must leave something an operator can read on the row.
  const paths: {
    name: string
    stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
  }[] = [
    {
      name: 'turn limit',
      stream: () =>
        earlyStopStream('error_max_turns', { errors: ['Reached maximum number of turns (6)'] }),
    },
    {
      name: 'budget ceiling',
      stream: () => earlyStopStream('error_max_budget_usd', { errors: ['Exceeded max budget'] }),
    },
    {
      name: 'error result with errors omitted',
      stream: () => earlyStopStream('error_max_budget_usd'),
    },
    {
      name: 'structured-output retries',
      stream: () => earlyStopStream('error_max_structured_output_retries'),
    },
    {
      name: 'during execution',
      stream: () => earlyStopStream('error_during_execution', { errors: ['internal'] }),
    },
    { name: 'unknown future subtype', stream: () => earlyStopStream('error_brand_new') },
    { name: 'no result message, stream ended', stream: () => empty() },
    {
      name: 'no result message, threw',
      stream: () =>
        (async function* () {
          throw new Error('Claude Code process exited with code 1')
          // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
          yield undefined
        })(),
    },
    {
      name: 'threw a non-Error',
      stream: () =>
        (async function* () {
          // A subprocess boundary: what comes back is not guaranteed to be
          // an Error instance, and String(error) is the fallback for it.
          throw 'a bare string'
          // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
          yield undefined
        })(),
    },
    {
      name: 'aborted',
      stream: (options) =>
        (async function* () {
          ;(options.abortController as AbortController).abort()
          await Promise.resolve()
          throw new Error('Claude Code process aborted by user')
          // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
          yield undefined
        })(),
    },
    { name: 'answer is not JSON', stream: () => successStream(undefined) },
    { name: 'answer misses a field', stream: () => successStream({ title: 'only a title' }) },
    {
      name: 'success subtype, is_error',
      stream: () => successStream(validAnswer, { isError: true }),
    },
  ]

  for (const path of paths) {
    row = freshRow()
    turnBehaviour = path.stream
    // Labelled through the asserted value, since bun's expect takes no
    // message argument — a bare `toBe('failed')` here would not say which of
    // the fourteen cases blew up.
    await expect(runIdeaPrompt(PROMPT_ID)).resolves.toBeUndefined()
    expect({ path: path.name, status: row.status }).toEqual({ path: path.name, status: 'failed' })
    expect({
      path: path.name,
      hasReason: typeof row.error === 'string' && row.error.length > 0,
    }).toEqual({
      path: path.name,
      hasReason: true,
    })
    expect({ path: path.name, completed: row.completedAt instanceof Date }).toEqual({
      path: path.name,
      completed: true,
    })
  }
})
