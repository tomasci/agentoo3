// Turn-outcome truthfulness, end to end, against a real Postgres.
//
// turn-outcome.test.ts already asserts the same mapping, but through a hand-
// written two-field literal (`{ type, subtype, is_error }`) and a faked `db`
// whose `where()` cannot execute a predicate. Both are the author's own
// fixture choice: if the shape the SDK really emits differed, or if the row
// `endTurn`'s guarded UPDATE writes did not actually land the way the fake
// pretends, neither would notice. This file removes both degrees of freedom.
// Every result below is a genuine `SDKResultMessage` — the SDK's own exported
// union, every required field present — and every outcome is read back out of
// Postgres with a real SELECT after a real `runTurn`, not out of a fake's
// in-memory array.
//
// What is still faked, and why: the SDK's `query` (nothing here may reach
// Anthropic), `runner-options` (it shells out to git in a project checkout,
// which is a different subsystem's problem), the event bus and BullMQ (Redis
// is not running). The database, the turn machinery, `completionOutcome`,
// `endTurn`'s guarded UPDATE and `setStatus` are all real.
//
// The child gathers facts; every assertion lives in turn-outcome-truth.test.ts.

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { mock } from 'bun:test'
import type { SDKMessage, SDKResultError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

// --- fakes, registered before anything imports the modules that use them -----

/** What the next `query()` yields, set per case below. */
let stream: SDKMessage[] = []

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const message of stream) yield message
    })(),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

const B = new URL('../src', import.meta.url).pathname

// Redis is not running: publishing swallows its own errors, but
// subscribeControl calls `.subscribe()` on the connection outright.
const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async () => {},
  subscribeControl: () => () => {},
}))

mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  optionsFor: async () => ({ cwd: tmpdir() }),
}))

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { messages, projects, sessions } = await import('@/db/schema')
const { sendMessage } = await import('@/features/sessions/service')
const { runTurn } = await import('@/queue/session-run.worker')

const facts: Record<string, unknown> = {}
const PROJECT_ID = randomUUID()

// --- the SDK's real result shapes, built here rather than approximated -------
//
// Typed as `SDKResultMessage`, so a field the SDK requires and this omits is a
// compile error rather than a fixture that quietly stops resembling reality.

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  server_tool_use: null,
  service_tier: null,
} as unknown as SDKResultMessage['usage']

function success(isError: boolean, text: string): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: isError,
    num_turns: 1,
    result: text,
    stop_reason: isError ? 'error' : 'end_turn',
    total_cost_usd: 0.01,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'sdk-session-1',
  }
}

/**
 * An error result, exactly as the SDK declares it — `is_error` included.
 *
 * That field is the ordering subtlety this whole file exists to pin down: a
 * real `error_max_turns` result carries `is_error: true` as well, so a
 * mapping that checked `is_error` first would report every turn-limit stop as
 * an API error and the two would never be told apart again.
 */
function errorResult(subtype: SDKResultError['subtype'], isError = true): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 4200,
    duration_api_ms: 3900,
    is_error: isError,
    num_turns: 12,
    stop_reason: null,
    total_cost_usd: 0.42,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: randomUUID(),
    session_id: 'sdk-session-1',
  }
}

// --- fixtures -----------------------------------------------------------------

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({
      projectId: PROJECT_ID,
      status: 'idle',
      orchestrator: 'orchestrator',
      // Non-null, so claimTurn's sibling predicate is satisfied outright and
      // these cases never block one another.
      worktreePath: `/tmp/agentoo-turn-outcome-wt-${randomUUID()}`,
    })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

/** One whole turn: a real send, a real claim, a real run, then the row. */
async function turnFor(result: SDKResultMessage | undefined) {
  const sessionId = await newSession()
  const prompt = await sendMessage(sessionId, 'do the thing')
  stream = result ? [result] : []
  await runTurn({ sessionId })

  const [promptRow] = await db.select().from(messages).where(eq(messages.id, prompt.id))
  const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
  return {
    turnOutcome: promptRow?.turnOutcome,
    turnEnded: promptRow?.turnEndedAt !== null && promptRow?.turnEndedAt !== undefined,
    turnDetail: promptRow?.turnDetail,
    pending: promptRow?.pending,
    sessionStatus: sessionRow?.status,
    sessionLastError: sessionRow?.lastError,
  }
}

async function main() {
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: 'demo', slug: 'demo', source: 'empty', status: 'ready' })

  // The four claims, each driven through a whole turn.
  facts.cleanSuccess = await turnFor(success(false, 'all done'))
  facts.maxTurns = await turnFor(errorResult('error_max_turns'))
  facts.apiError = await turnFor(success(true, 'Overloaded'))
  facts.executionError = await turnFor(errorResult('error_during_execution'))

  // Two more, to prove the mapping discriminates rather than lumping:
  // another error_* subtype the SDK declares, and the budget stop the cascade
  // catches *before* completionOutcome ever runs (the one error_* that must
  // NOT read as a completed session).
  facts.structuredOutputRetries = await turnFor(errorResult('error_max_structured_output_retries'))
  facts.overBudget = await turnFor(errorResult('error_max_budget_usd'))

  // The same error_during_execution with is_error flipped to false. Only
  // this shape reaches the stopped_execution_error branch at all — which is
  // the finding: SDKResultError declares is_error as a required field, and
  // session-run.worker.ts's own docblock states ("verified against the real
  // shape") that an error result carries it true.
  facts.executionErrorNotFlagged = await turnFor(errorResult('error_during_execution', false))

  // And a turn whose stream ends without any result at all.
  facts.noResult = await turnFor(undefined)

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
