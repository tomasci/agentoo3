// Runs queue/learning-schedule.worker.ts's own scenarios (the reconcile loop,
// and the trigger handler's windowEnd resolution) in a fresh process — the
// identical reason tests/learning-db-child.ts and
// tests/session-concurrency-bullmq-child.ts both run in one: "the shared
// test process has bullmq and ioredis mocked by other files; only a fresh
// process gets the real ones" (learning-db-child.ts's own words). A unit-level
// version of these two scenarios (mocking '@/queue/index.ts' directly rather
// than the packages underneath it) was tried first and passed alone, but
// failed in the full suite — some other file's own mock.module('@/queue/
// index.ts', ...), registered with a key set that predates this round's
// LEARNING_DAILY_SCHEDULER_ID, ends up "the active one" by the time this
// file's own import resolves, and there is no reliable way to out-order that
// from inside the shared process. Faking bullmq/ioredis instead — so the
// REAL '@/queue/index.ts' loads, with every real export this round added —
// sidesteps the whole problem.
//
// '@/db/client', '@/features/learning/runs' and '@/features/learning/
// schedule' are faked directly (no real Postgres needed): this is a fast,
// deterministic orchestration test, not an integration test of those modules'
// own SQL — real-Postgres coverage of createLearningRun and the schedule
// setting already exists in tests/learning-db-child.ts and tests/
// learning-schedule.test.ts.

import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-x' }
    }
    async upsertJobScheduler() {}
    async removeJobScheduler() {}
    async setGlobalConcurrency() {}
    async getJob() {
      return undefined
    }
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

// --- a fake db, for the trigger handler's own same-windowEnd dedupe check --

let existingRunForWindow: { id: string } | undefined
const dbSelectCalls: unknown[] = []

mock.module(`${SRC}/db/client.ts`, () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbSelectCalls.push(true)
            return existingRunForWindow ? [existingRunForWindow] : []
          },
        }),
      }),
    }),
  },
  closeDb: async () => {},
}))

// --- a fake createLearningRun, so the trigger scenarios never touch Postgres

type CreateLearningRunCall = { trigger: string; windowEnd: Date }
const createLearningRunCalls: CreateLearningRunCall[] = []
let createLearningRunAnswer: () => unknown = () => ({ run: { id: 'new-run', status: 'queued' } })

mock.module(`${SRC}/features/learning/runs.ts`, () => ({
  createLearningRun: async (args: CreateLearningRunCall) => {
    createLearningRunCalls.push(args)
    return createLearningRunAnswer()
  },
}))

// --- the real schedule module, with only getLearningSchedule overridden ----

const realSchedule = (await import(`${SRC}/features/learning/schedule.ts`)) as Record<
  string,
  unknown
>
let scheduleAnswer: { enabled: boolean; time: string; timezone: string } = {
  enabled: true,
  time: '04:00',
  timezone: 'UTC',
}
mock.module(`${SRC}/features/learning/schedule.ts`, () => ({
  ...realSchedule,
  getLearningSchedule: async () => ({ value: scheduleAnswer, source: 'default' }),
}))

const { latestOccurrenceAtOrBefore } = realSchedule as {
  latestOccurrenceAtOrBefore: (s: unknown, at: Date) => Date | null
}
const { scheduledWindowEnd, handleLearningScheduleTrigger, reconcileLearningSchedule } =
  await import(`${SRC}/queue/learning-schedule.worker.ts`)

const facts: Record<string, unknown> = {}

function resetTriggerFakes() {
  existingRunForWindow = undefined
  dbSelectCalls.length = 0
  createLearningRunCalls.length = 0
  createLearningRunAnswer = () => ({ run: { id: 'new-run', status: 'queued' } })
  scheduleAnswer = { enabled: true, time: '00:00', timezone: 'UTC' }
}

// --- scheduledWindowEnd (pure) ------------------------------------------------

function pureScenarios() {
  const now = new Date('2026-01-02T12:00:00.000Z')
  const prevMillis = new Date('2026-01-02T01:00:00.000Z').getTime()
  const timestamp = new Date('2026-01-02T00:59:00.000Z').getTime()
  facts.pure = {
    prevMillisWins: scheduledWindowEnd({ prevMillis }, now).toISOString(),
    timestampPlusDelay: scheduledWindowEnd({ timestamp, delay: 60_000 }, now).toISOString(),
    neitherFallsBackToNow: scheduledWindowEnd({}, now).getTime() === now.getTime(),
    prevMillisWinsOverTimestamp: scheduledWindowEnd(
      { prevMillis, timestamp: 0, delay: 999 },
      now,
    ).toISOString(),
  }
}

// --- handleLearningScheduleTrigger -------------------------------------------

async function triggerScenarios() {
  resetTriggerFakes()
  const prevMillis = new Date('2026-01-02T01:00:00.000Z').getTime()
  await handleLearningScheduleTrigger({ prevMillis })
  facts.triggerPrevMillis = {
    calls: createLearningRunCalls.length,
    trigger: createLearningRunCalls[0]?.trigger,
    windowEnd: createLearningRunCalls[0]?.windowEnd.toISOString(),
  }

  resetTriggerFakes()
  const timestamp = new Date('2026-01-02T00:59:00.000Z').getTime()
  await handleLearningScheduleTrigger({ timestamp, delay: 60_000 })
  facts.triggerTimestampDelay = { windowEnd: createLearningRunCalls[0]?.windowEnd.toISOString() }

  resetTriggerFakes()
  await handleLearningScheduleTrigger({})
  const fallbackWindowEnd = createLearningRunCalls[0]?.windowEnd as Date
  const expected = latestOccurrenceAtOrBefore(scheduleAnswer, new Date())
  facts.triggerFallback = {
    calls: createLearningRunCalls.length,
    isMidnightUtc:
      fallbackWindowEnd.getUTCHours() === 0 &&
      fallbackWindowEnd.getUTCMinutes() === 0 &&
      fallbackWindowEnd.getUTCSeconds() === 0 &&
      fallbackWindowEnd.getUTCMilliseconds() === 0,
    notInTheFuture: fallbackWindowEnd.getTime() <= Date.now(),
    matchesPureHelper: fallbackWindowEnd.getTime() === expected?.getTime(),
  }

  resetTriggerFakes()
  existingRunForWindow = { id: 'already-there' }
  await handleLearningScheduleTrigger({ prevMillis })
  facts.triggerSameWindowEndSkip = {
    selectCalls: dbSelectCalls.length,
    createCalls: createLearningRunCalls.length,
  }

  resetTriggerFakes()
  createLearningRunAnswer = () => ({ conflict: { id: 'active-run', status: 'running' } })
  let threw = false
  try {
    await handleLearningScheduleTrigger({ prevMillis })
  } catch {
    threw = true
  }
  facts.triggerConflictSkip = { threw, createCalls: createLearningRunCalls.length }
}

// --- reconcileLearningSchedule ------------------------------------------------

type Call = { kind: 'upsert' | 'remove' }
function fakeQueue(calls: Call[]) {
  return {
    upsertJobScheduler: async () => {
      calls.push({ kind: 'upsert' })
    },
    removeJobScheduler: async () => {
      calls.push({ kind: 'remove' })
    },
  }
}

async function reconcileScenarios() {
  scheduleAnswer = { enabled: true, time: '04:00', timezone: 'UTC' }

  // First reconcile always applies.
  {
    const calls: Call[] = []
    const queue = fakeQueue(calls)
    const applied = await reconcileLearningSchedule(queue, undefined)
    facts.reconcileFirstAlwaysApplies = {
      calls: calls.map((c) => c.kind),
      applied,
    }

    // Unchanged: no re-upsert.
    const second = await reconcileLearningSchedule(queue, applied)
    facts.reconcileUnchangedNoReupsert = { calls: calls.map((c) => c.kind), same: second === applied }
  }

  // A changed time re-upserts.
  {
    const calls: Call[] = []
    const queue = fakeQueue(calls)
    const first = await reconcileLearningSchedule(queue, undefined)
    scheduleAnswer = { ...scheduleAnswer, time: '05:00' }
    const second = await reconcileLearningSchedule(queue, first)
    facts.reconcileChangedTimeReupserts = { calls: calls.map((c) => c.kind), pattern: second.pattern }
    scheduleAnswer = { ...scheduleAnswer, time: '04:00' }
  }

  // Disabling removes instead of upserting; re-enabling upserts again.
  {
    const calls: Call[] = []
    const queue = fakeQueue(calls)
    let last = await reconcileLearningSchedule(queue, undefined)
    scheduleAnswer = { ...scheduleAnswer, enabled: false }
    last = await reconcileLearningSchedule(queue, last)
    scheduleAnswer = { ...scheduleAnswer, enabled: true }
    await reconcileLearningSchedule(queue, last)
    facts.reconcileDisableThenReenable = { calls: calls.map((c) => c.kind) }
  }
}

async function main() {
  pureScenarios()
  await triggerScenarios()
  await reconcileScenarios()
  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    process.exit(1)
  })
