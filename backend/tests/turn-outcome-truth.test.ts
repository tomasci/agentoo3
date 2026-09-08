// Does a turn that stopped for a bad reason really stop recording itself as
// `completed`? Established against a real Postgres, from the SDK's own result
// type, rather than from a hand-written literal and a faked `db`.
//
// turn-outcome.test.ts asserts the same four mappings, but calls
// `completionOutcome` directly with `{ type, subtype, is_error }` — three
// fields out of a `SDKResultMessage`'s twenty — and reads the outcome back
// out of an in-memory array a fake `update()` wrote to. This file removes
// both: the child builds every result as a real `SDKResultMessage` (the SDK's
// exported union, every required field present, so a shape drift is a compile
// error), runs a whole `runTurn` including the real claim transaction and the
// real guarded `endTurn` UPDATE, and reads `messages.turn_outcome` and
// `sessions.status` back out of Postgres with a SELECT.
//
// The point of reading both columns is that they are supposed to disagree:
// session semantics deliberately did not change, so a turn that stopped on
// the turn limit or an API error records a truthful *turn* outcome while its
// *session* still reads `completed`.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const ATTACHMENTS_DIR = `/tmp/agentoo-turn-outcome-attachments-${process.pid}`
const PROJECTS_DIR = `/tmp/agentoo-turn-outcome-projects-${process.pid}`

type Turn = {
  turnOutcome?: string
  turnEnded?: boolean
  turnDetail?: string | null
  pending?: boolean
  sessionStatus?: string
  sessionLastError?: string | null
}

let cluster: Cluster | undefined
let facts: Record<string, Turn> = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/turn-outcome-truth-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        ATTACHMENTS_DIR,
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR,
        LOG_LEVEL: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-2000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Record<string, Turn>
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(ATTACHMENTS_DIR, { recursive: true, force: true })
  await rm(PROJECTS_DIR, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

const turn = (key: string): Turn => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" turn (setupError: ${setupError})`)
  return value
}

test('the turn-outcome scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the turn-outcome scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'apiError',
    'cleanSuccess',
    'executionError',
    'executionErrorNotFlagged',
    'maxTurns',
    'noResult',
    'overBudget',
    'structuredOutputRetries',
  ])
})

// --- the four claims -----------------------------------------------------------

dbTest('a genuine success records completed, and the session reads completed', () => {
  expect(turn('cleanSuccess')).toMatchObject({
    turnOutcome: 'completed',
    turnEnded: true,
    pending: false,
    sessionStatus: 'completed',
  })
})

dbTest('error_max_turns records stopped_turn_limit, despite also carrying is_error: true', () => {
  // The ordering subtlety, on the real shape rather than a three-field stub:
  // SDKResultError declares `is_error`, and a turn-limit stop sets it. A
  // mapping that read is_error first would call this stopped_api_error and a
  // board could never tell a limit from an outage again.
  expect(turn('maxTurns')).toMatchObject({
    turnOutcome: 'stopped_turn_limit',
    turnEnded: true,
  })
})

dbTest('a result with is_error: true records stopped_api_error', () => {
  // SDKResultSuccess's own doc: subtype "success" with is_error true carries
  // the error text when the turn ended on an API error.
  expect(turn('apiError')).toMatchObject({
    turnOutcome: 'stopped_api_error',
    turnEnded: true,
  })
})

dbTest('another error_* subtype records stopped_execution_error', () => {
  expect(turn('executionError')).toMatchObject({
    turnOutcome: 'stopped_execution_error',
    turnEnded: true,
  })
})

dbTest('the mapping is by prefix, not by a list of two subtypes', () => {
  // A fourth SDKResultError subtype the mapping has never seen by name.
  expect(turn('structuredOutputRetries').turnOutcome).toBe('stopped_execution_error')
})

dbTest('the only shape that reaches stopped_execution_error is an error result not flagged as one', () => {
  // Recorded to pin down exactly which input the branch needs — and therefore
  // why the two tests above fail. `SDKResultError.is_error` is a required
  // field and session-run.worker.ts's own docblock states, "verified against
  // the real shape", that an error result carries it true; an error_* subtype
  // with `is_error: false` is the one input that gets past the generic
  // api-error check, and it is not a shape the SDK is documented to emit.
  expect(turn('executionErrorNotFlagged').turnOutcome).toBe('stopped_execution_error')
})

// --- and the session status deliberately does not change ------------------------

dbTest('all four still leave the session reading completed', () => {
  // Session semantics did not change: only the turn now tells the truth.
  expect([
    turn('cleanSuccess').sessionStatus,
    turn('maxTurns').sessionStatus,
    turn('apiError').sessionStatus,
    turn('executionError').sessionStatus,
  ]).toEqual(['completed', 'completed', 'completed', 'completed'])
})

dbTest('none of the four leaves the prompt pending or the turn open', () => {
  for (const key of ['cleanSuccess', 'maxTurns', 'apiError', 'executionError']) {
    expect(turn(key).pending).toBe(false)
    expect(turn(key).turnEnded).toBe(true)
  }
})

// --- the two that must NOT be read the same way ---------------------------------

dbTest('error_max_budget_usd is caught before the mapping and fails the session', () => {
  // The one error_* the cascade handles ahead of completionOutcome: a session
  // that ran out of money must not read as one that finished the job.
  const f = turn('overBudget')
  expect(f.turnOutcome).toBe('stopped_over_budget')
  expect(f.sessionStatus).toBe('failed')
  expect(f.turnDetail).toContain('budget')
})

dbTest('a stream that ends with no result at all still records completed', () => {
  // Documented behaviour, not an accident: this is what branch g did before
  // the mapping existed, and it is what completionOutcome falls through to.
  expect(turn('noResult')).toMatchObject({
    turnOutcome: 'completed',
    turnEnded: true,
    sessionStatus: 'completed',
  })
})
