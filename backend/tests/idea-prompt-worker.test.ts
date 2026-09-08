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
        if (table(t) === 'idea_prompts') row = { ...row, ...payload }
      },
    }),
  }),
}

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
const realEnv = (await import(`${B}/env.ts`)) as { env: unknown; hasClaudeCredential: boolean }
function setCredential(has: boolean) {
  mock.module(`${B}/env.ts`, () => ({ ...realEnv, hasClaudeCredential: has }))
}
setCredential(true)

const { runIdeaPrompt } = await import(`${B}/features/ideas/prompt-service.ts`)
const { IDEA_PROMPT_INSTRUCTION_FALLBACK } = await import(`${B}/library/idea-prompt.ts`)

afterEach(() => {
  row = freshRow()
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

test('query() is called exactly once, tool-less and single-turn', async () => {
  turnBehaviour = () => successStream(validAnswer)
  await runIdeaPrompt(PROMPT_ID)

  expect(queryCalls).toHaveLength(1)
  const { options } = queryCalls[0] as (typeof queryCalls)[number]
  expect(options.settingSources).toEqual([])
  expect(options.tools).toEqual([])
  expect(options.maxTurns).toBe(1)
  expect(typeof options.maxBudgetUsd).toBe('number')
  expect(options.abortController).toBeInstanceOf(AbortController)
  expect(options.persistSession).toBe(false)
  expect(options.systemPrompt).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)
  expect(options.outputFormat).toEqual({
    type: 'json_schema',
    schema: expect.any(Object),
  })
})

test('the prompt body is the row\'s sourceDigest, verbatim', async () => {
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
