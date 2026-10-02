// queue/session-run.worker.ts's own dispatch: a `'learning'`-named job runs
// the learning engine, any other name (`'turn'`, in practice) runs an
// ordinary session turn — both off the one BullMQ Worker this queue has, per
// this round's own hard requirement that no separate queue or worker may
// execute the analysis.
//
// `runTurn` itself is already exercised at length by session-recovery.test.ts
// and turn-outcome.test.ts; this file only has to prove *routing*, not
// re-verify a turn's own business logic. The `'turn'` case below proves
// routing by making the very first thing `runTurn` touches (its claim, a
// `db.update` call) throw a marker error the instant it is reached, and
// asserting dispatch's returned promise rejects with exactly that marker —
// which could only happen if execution actually reached `runTurn`, not the
// learning engine.

import { expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

class ReachedRunTurn extends Error {}

/** A `db` whose very first touch (any `.update(...)`, which is exactly what
 * `claimTurn` does first) proves `runTurn` was reached. */
const dbThrowsOnFirstUpdate = {
  update: () => {
    throw new ReachedRunTurn('runTurn reached its own claim')
  },
}

mock.module(`${B}/db/client.ts`, () => ({ db: dbThrowsOnFirstUpdate, closeDb: async () => {} }))

// session-run.worker.ts's own top-level imports from this module construct
// real BullMQ Queue/ioredis connections unless it is mocked here too — not
// otherwise reached by either scenario below (the 'turn' case throws at the
// very first claim, before anything here would be used; the 'learning' case
// never touches it at all). Mirrors tests/turn-outcome.test.ts's own
// `mock.module('@/queue/index.ts', ...)` stand-in for the identical reason.
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  QUEUE_LEARNING_SCHEDULE: 'learning-schedule',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
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

let learningCalls: unknown[] = []
mock.module(`${B}/features/learning/engine.ts`, () => ({
  runLearning: async (data: unknown) => {
    learningCalls.push(data)
  },
}))

const { dispatchSessionRunJob } = await import(`${B}/queue/session-run.worker.ts`)

test("job.name 'learning' runs features/learning/engine.ts's runLearning, not runTurn", async () => {
  await dispatchSessionRunJob({ name: 'learning', data: { learningRunId: 'run-1' } })
  expect(learningCalls).toEqual([{ learningRunId: 'run-1' }])
})

test("any other job.name ('turn') runs an ordinary session turn, not the learning engine", async () => {
  learningCalls = []
  let rejected: unknown
  try {
    await dispatchSessionRunJob({ name: 'turn', data: { sessionId: 'sess-1' } })
  } catch (error) {
    rejected = error
  }
  expect(rejected).toBeInstanceOf(ReachedRunTurn)
  // And definitely not routed to the learning engine.
  expect(learningCalls).toEqual([])
})
