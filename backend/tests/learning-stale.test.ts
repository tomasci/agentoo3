// features/learning/stale.ts: the two stale-run predicates that keep a dead
// worker or a lost BullMQ job from blocking every future learning run forever
// (learning_runs_single_active_key allows at most one queued/running row).
//
// A fake `db` and a fake `sessionRunQueue`, in the same table-dispatch style
// tests/idea-prompt-worker.test.ts and tests/turn-outcome.test.ts already use
// for a unit-level test of orchestration around a query: given the rows a
// SELECT answers, does the code correctly claim and fail the right ones, call
// the queue the right number of times, and never throw. The fake cannot
// evaluate a real SQL WHERE (join conditions, timestamp comparisons) — only a
// real Postgres could — so each scenario tells the fake directly which rows
// the real predicate *would* have matched, the same limitation
// session-recovery.test.ts's own header documents for its identical kind of
// fake.
//
// `reconcileStaleLearningRuns` always runs its two predicates in a fixed
// order — heartbeats, then lost jobs — so the fake's `select` answers the
// first call with whatever this scenario populated as "would match the
// heartbeat predicate" and the second with "would match the lost-job one".

import { afterEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

/** Rows the heartbeat predicate's own SELECT would have matched, this test. */
let heartbeatCandidates: Row[] = []
/** Rows the lost-job predicate's own SELECT would have matched, this test. */
let lostJobCandidates: Row[] = []
let selectCallIndex = 0

/** Every `db.update(learning_runs)` patch actually applied, keyed by row id. */
const updates: Record<string, Row> = {}

const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

const db = {
  select: () => ({
    from: (t: unknown) => ({
      where: () => {
        if (table(t) !== 'learning_runs') return Promise.resolve([])
        const rows = selectCallIndex === 0 ? heartbeatCandidates : lostJobCandidates
        selectCallIndex++
        return Promise.resolve(rows)
      },
    }),
  }),
  update: (t: unknown) => ({
    set: (patch: Row) => ({
      where: () => ({
        returning: async () => {
          if (table(t) !== 'learning_runs') return []
          // The conditional UPDATE's own WHERE (id = X AND status = 'running'
          // | 'queued') is faked as "the row this call targets is whichever
          // one this test said is still live" — set per scenario below.
          const pool = [...heartbeatCandidates, ...lostJobCandidates]
          const row = pool.find((r) => r.id === currentRowId)
          if (!row) return []
          updates[row.id as string] = patch
          return [{ id: row.id }]
        },
      }),
    }),
  }),
}

/** Which row id the next claiming UPDATE resolves against — see the comment
 * above; each scenario below touches at most one row at a time. */
let currentRowId = ''

// features/learning/stale.ts imports HEARTBEAT_INTERVAL_MS from
// queue/session-run.worker.ts, which (via features/attachments/service.ts)
// statically imports several more names off '@/queue' — a mock answering
// only `sessionRunQueue` makes Bun refuse the whole module with "Export
// named ... not found", the identical trap tests/turn-outcome.test.ts's own
// comprehensive stand-in already works around. Listed in full for the same
// reason that file's own copy is.
type JobState =
  | 'completed'
  | 'failed'
  | 'active'
  | 'waiting'
  | 'delayed'
  | 'waiting-children'
  | 'prioritized'
let jobAnswer: { exists: boolean; state?: JobState } = { exists: false }
let jobLookupThrows = false
const getJobCalls: string[] = []

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  QUEUE_LEARNING_SCHEDULE: 'learning-schedule',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {
    getJob: async (jobId: string) => {
      getJobCalls.push(jobId)
      if (jobLookupThrows) throw new Error('redis unreachable (simulated)')
      if (!jobAnswer.exists) return undefined
      return { getState: async () => jobAnswer.state }
    },
  },
  attachmentsGcQueue: { getJobs: async () => [], getJobScheduler: async () => undefined },
  turnEndedQueue: {},
  turnReconcileQueue: {},
  learningScheduleQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  enqueueTurnEnded: async () => ({}),
  enqueueTurnReconcile: async () => ({}),
  enqueueLearningRun: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
  ensureTurnReconcileSchedule: async () => {},
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
}))

const { reconcileStaleLearningRuns } = await import(`${B}/features/learning/stale.ts`)

afterEach(() => {
  heartbeatCandidates = []
  lostJobCandidates = []
  selectCallIndex = 0
  currentRowId = ''
  jobAnswer = { exists: false }
  jobLookupThrows = false
  getJobCalls.length = 0
  for (const key of Object.keys(updates)) delete updates[key]
})

// --- heartbeat staleness ------------------------------------------------------

test('a running run the heartbeat predicate matches is claimed and marked failed', async () => {
  heartbeatCandidates = [{ id: 'run-1' }]
  currentRowId = 'run-1'

  const result = await reconcileStaleLearningRuns()
  expect(result.staleHeartbeats).toBe(1)
  expect(result.lostJobs).toBe(0)
  expect(updates['run-1']?.status).toBe('failed')
  expect(typeof updates['run-1']?.error).toBe('string')
  expect(updates['run-1']?.finishedAt).toBeInstanceOf(Date)
})

test('no row matches the heartbeat predicate: nothing is touched', async () => {
  const result = await reconcileStaleLearningRuns()
  expect(result.staleHeartbeats).toBe(0)
  expect(Object.keys(updates)).toEqual([])
})

test('a heartbeat-stale row already claimed by someone else (conditional UPDATE finds nothing) is not counted', async () => {
  heartbeatCandidates = [{ id: 'run-2' }]
  currentRowId = 'nobody-matches-this-id'

  const result = await reconcileStaleLearningRuns()
  expect(result.staleHeartbeats).toBe(0)
})

// --- lost queue job ------------------------------------------------------------

test('a queued run whose BullMQ job no longer exists is marked failed', async () => {
  lostJobCandidates = [{ id: 'run-3' }]
  currentRowId = 'run-3'
  jobAnswer = { exists: false }

  const result = await reconcileStaleLearningRuns()
  expect(result.lostJobs).toBe(1)
  expect(getJobCalls).toEqual(['learning-run-3'])
  expect(updates['run-3']?.status).toBe('failed')
})

test('a queued run whose job already completed (without ever being claimed) is marked failed', async () => {
  lostJobCandidates = [{ id: 'run-4' }]
  currentRowId = 'run-4'
  jobAnswer = { exists: true, state: 'completed' }

  const result = await reconcileStaleLearningRuns()
  expect(result.lostJobs).toBe(1)
})

test('a queued run whose job already failed is marked failed', async () => {
  lostJobCandidates = [{ id: 'run-4b' }]
  currentRowId = 'run-4b'
  jobAnswer = { exists: true, state: 'failed' }

  const result = await reconcileStaleLearningRuns()
  expect(result.lostJobs).toBe(1)
})

for (const state of ['waiting', 'delayed', 'active', 'waiting-children', 'prioritized'] as const) {
  test(`a queued run whose job is still '${state}' is left alone`, async () => {
    lostJobCandidates = [{ id: `run-${state}` }]
    currentRowId = `run-${state}`
    jobAnswer = { exists: true, state }

    const result = await reconcileStaleLearningRuns()
    expect(result.lostJobs).toBe(0)
    expect(updates[`run-${state}`]).toBeUndefined()
  })
}

test('no row matches the lost-job predicate: nothing is touched, and the queue is never consulted', async () => {
  const result = await reconcileStaleLearningRuns()
  expect(result.lostJobs).toBe(0)
  expect(getJobCalls).toEqual([])
})

test('a Redis failure while checking one row is logged and leaves that row untouched, not thrown', async () => {
  lostJobCandidates = [{ id: 'run-5' }]
  currentRowId = 'run-5'
  jobLookupThrows = true

  const result = await reconcileStaleLearningRuns()
  expect(result.lostJobs).toBe(0)
  expect(updates['run-5']).toBeUndefined()
})

test('both predicates run together and their counts are independent', async () => {
  heartbeatCandidates = [{ id: 'both-heartbeat' }]
  lostJobCandidates = [{ id: 'both-lostjob' }]
  jobAnswer = { exists: false }

  // This fake claims only one row per call (`currentRowId`); run the sweep
  // twice, once per row, to confirm both predicates independently contribute
  // to the combined result across a sweep.
  currentRowId = 'both-heartbeat'
  const first = await reconcileStaleLearningRuns()
  expect(first.staleHeartbeats).toBe(1)

  selectCallIndex = 0
  currentRowId = 'both-lostjob'
  const second = await reconcileStaleLearningRuns()
  expect(second.lostJobs).toBe(1)
})
