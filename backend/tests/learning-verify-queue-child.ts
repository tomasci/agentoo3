// Child process for learning-verify-queue.test.ts: REAL BullMQ on a REAL
// redis-server, a real Postgres, and the real session-run worker
// (startSessionRunWorker) — only the Claude Agent SDK is mocked. Prints
// `__FACTS__<json>`.
//
// How a real 'turn' job is made to hold the only slot: the session it names
// is queued, and this child holds `LOCK TABLE sessions IN EXCLUSIVE MODE` in
// a separate connection, so runTurn's claim UPDATE (session-run.worker.ts
// claimTurn) blocks inside the job. SELECTs (what the learning engine does on
// sessions) are still allowed under that lock mode. Releasing it after
// flipping the session to 'idle' makes the claim find nothing and the turn
// return normally.

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { mock } from 'bun:test'
import '@hono/zod-openapi'

const SRC = new URL('../src', import.meta.url).pathname

type QueryParams = { prompt: string; options: Record<string, unknown> }
const sdkCalls: { at: number; prompt: string }[] = []
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: QueryParams) => {
    sdkCalls.push({ at: Date.now(), prompt: params.prompt })
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ suggestions: [] }), total_cost_usd: 0.01 }
    })()
  },
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const { eq } = await import('drizzle-orm')
const { default: postgres } = await import('postgres')
const { Queue, Worker } = await import('bullmq')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { learningRuns, messages, projects, sessions, systemSettings } = await import(`${SRC}/db/schema.ts`)
const queueIndex = await import(`${SRC}/queue/index.ts`)
const { sessionRunQueue, learningScheduleQueue, enqueueLearningRun, enqueueSessionRun, redisConnection, LEARNING_DAILY_SCHEDULER_ID } = queueIndex
const { reconcileLearningSchedule, handleLearningScheduleTrigger } = await import(`${SRC}/queue/learning-schedule.worker.ts`)
const { setLearningSchedule, nextRunAt, DEFAULT_LEARNING_SCHEDULE } = await import(`${SRC}/features/learning/schedule.ts`)
const { createLearningRun } = await import(`${SRC}/features/learning/runs.ts`)
const { reconcileStaleLearningRuns } = await import(`${SRC}/features/learning/stale.ts`)
const { startSessionRunWorker } = await import(`${SRC}/queue/session-run.worker.ts`)
const { env } = await import(`${SRC}/env.ts`)

const facts: Record<string, unknown> = {}
const DAY = 86_400_000

async function until(pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return true
    await Bun.sleep(25)
  }
  return false
}
async function runRow(id: string) {
  const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, id)).limit(1)
  return row
}
async function settleActive() {
  for (const status of ['queued', 'running'] as const) {
    await db.update(learningRuns).set({ status: 'failed', error: 'settled by test', finishedAt: new Date() }).where(eq(learningRuns.status, status))
  }
}

// --- A. the scheduler on real Redis matches the saved setting ---------------

async function schedulerScenario() {
  const q = learningScheduleQueue
  const t0 = new Date()
  const a1 = await reconcileLearningSchedule(q, undefined)
  const s1 = await q.getJobScheduler(LEARNING_DAILY_SCHEDULER_ID)
  const delayed1 = await q.getDelayedCount()
  const waiting1 = await q.getWaitingCount()

  await setLearningSchedule({ enabled: true, time: '05:30', timezone: 'Asia/Jerusalem' })
  const t1 = new Date()
  const a2 = await reconcileLearningSchedule(q, a1)
  const s2 = await q.getJobScheduler(LEARNING_DAILY_SCHEDULER_ID)
  const delayed2 = await q.getDelayedCount()
  const delayedJobs2 = await q.getDelayed()

  await setLearningSchedule({ enabled: false, time: '05:30', timezone: 'Asia/Jerusalem' })
  const a3 = await reconcileLearningSchedule(q, a2)
  const s3 = await q.getJobScheduler(LEARNING_DAILY_SCHEDULER_ID)
  const delayed3 = await q.getDelayedCount()
  const waiting3 = await q.getWaitingCount()

  await setLearningSchedule(null)
  await reconcileLearningSchedule(q, a3)
  const s4 = await q.getJobScheduler(LEARNING_DAILY_SCHEDULER_ID)

  facts.scheduler = {
    s1: s1 && { pattern: s1.pattern, tz: s1.tz, next: s1.next },
    expectedNext1: nextRunAt(DEFAULT_LEARNING_SCHEDULE, t0)?.getTime(),
    delayed1,
    waiting1,
    s2: s2 && { pattern: s2.pattern, tz: s2.tz, next: s2.next },
    expectedNext2: nextRunAt({ enabled: true, time: '05:30', timezone: 'Asia/Jerusalem' }, t1)?.getTime(),
    delayed2,
    delayedJobNames2: delayedJobs2.map((j) => j.name),
    s3: s3 ?? null,
    delayed3,
    waiting3,
    s4: s4 && { pattern: s4.pattern, tz: s4.tz },
  }
  await q.removeJobScheduler(LEARNING_DAILY_SCHEDULER_ID)
}

// --- B. BullMQ's own prevMillis is the scheduled instant, even processed late

async function prevMillisScenario() {
  await settleActive()
  const name = `verify-prev-${randomUUID().slice(0, 8)}`
  const q = new Queue(name, { connection: redisConnection() })
  await q.upsertJobScheduler('probe', { pattern: '*/2 * * * * *' }, { name: 'trigger', data: { reason: 'scheduled' } })
  await Bun.sleep(3500) // nothing consumes it yet: the next trigger is processed late
  const seen: { prevMillis?: number; processedAt: number }[] = []
  const worker = new Worker(
    name,
    async (job) => {
      const opts = job.opts as { prevMillis?: number; timestamp?: number; delay?: number }
      seen.push({ prevMillis: opts.prevMillis, processedAt: Date.now() })
      await handleLearningScheduleTrigger(opts)
    },
    { connection: redisConnection(), concurrency: 1 },
  )
  await until(() => seen.length >= 1, 10_000)
  await q.removeJobScheduler('probe')
  await worker.close()
  await q.obliterate({ force: true }).catch(() => {})
  await q.close()
  const first = seen[0]
  const [row] = first?.prevMillis
    ? await db.select().from(learningRuns).where(eq(learningRuns.windowEnd, new Date(first.prevMillis)))
    : []
  facts.prevMillis = {
    seen: seen.length,
    prevMillis: first?.prevMillis,
    alignedTo2s: first?.prevMillis !== undefined && first.prevMillis % 2000 === 0,
    lateByMs: first?.prevMillis !== undefined ? first.processedAt - first.prevMillis : null,
    rowTrigger: row?.trigger,
    rowWindowEndMs: row?.windowEnd.getTime(),
    rowWindowStartMs: row?.windowStart.getTime(),
    rowId: row?.id,
  }
}

// --- C. lost-job sweep against the real queue --------------------------------

async function lostJobScenario() {
  const runId = (facts.prevMillis as { rowId?: string }).rowId
  if (!runId) throw new Error('lostJob: no queued run from the prevMillis scenario')
  const job = await sessionRunQueue.getJob(`learning-${runId}`)
  const stateBefore = await job?.getState()
  const jobName = job?.name
  await reconcileStaleLearningRuns(new Date())
  const afterWaiting = (await runRow(runId))?.status
  await job?.remove()
  await reconcileStaleLearningRuns(new Date())
  const afterRemoved = await runRow(runId)
  facts.lostJob = { stateBefore, jobName, afterWaiting, afterRemoved: afterRemoved?.status, error: afterRemoved?.error }
}

// --- E. the same run enqueued twice is one job --------------------------------

async function duplicateEnqueueScenario() {
  const fakeId = randomUUID()
  const before = await sessionRunQueue.getWaitingCount()
  await enqueueLearningRun({ learningRunId: fakeId })
  await enqueueLearningRun({ learningRunId: fakeId })
  const after = await sessionRunQueue.getWaitingCount()
  await (await sessionRunQueue.getJob(`learning-${fakeId}`))?.remove()
  facts.duplicateEnqueue = { added: after - before }
}

// --- D. the real worker: a turn holding the only slot holds the learning run

async function newProject(name: string) {
  const [row] = await db.insert(projects).values({ name, slug: `${name}-${randomUUID().slice(0, 6)}`, source: 'existing', status: 'ready' }).returning()
  return row.id as string
}

async function capScenario(cap: number, label: string) {
  await settleActive()
  await db
    .insert(systemSettings)
    .values({ key: 'max_concurrent_sessions', value: cap, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: cap, updatedAt: new Date() } })
  const applied = await until(async () => (await sessionRunQueue.getGlobalConcurrency()) === cap, 15_000)

  const projectId = await newProject(`cap-${label}`)
  const [turnSession] = await db.insert(sessions).values({ projectId, title: 'blocked turn', status: 'queued' }).returning()
  const [windowSession] = await db.insert(sessions).values({ projectId, title: 'learning input', status: 'completed', createdAt: new Date(Date.now() - 60_000) }).returning()
  await db.insert(messages).values({ sessionId: windowSession.id, seq: 0, type: 'prompt', payload: { text: `CAP-${label}` } })

  const locker = postgres(env.DATABASE_URL, { max: 1 })
  let release!: () => void
  const released = new Promise<void>((r) => {
    release = r
  })
  let locked!: () => void
  const lockHeld = new Promise<void>((r) => {
    locked = r
  })
  const tx = locker.begin(async (sql) => {
    await sql`lock table sessions in exclusive mode`
    locked()
    await released
    await sql`update sessions set status = 'idle' where id = ${turnSession.id}`
  })
  await lockHeld

  const turnJob = await enqueueSessionRun({ sessionId: turnSession.id })
  const turnActive = await until(async () => (await turnJob.getState()) === 'active', 15_000)

  const callsBefore = sdkCalls.length
  const created = await createLearningRun({ trigger: 'manual', windowEnd: new Date() })
  if (!('run' in created)) throw new Error(`cap ${label}: conflict`)
  const runId = created.run.id
  const learningJob = await sessionRunQueue.getJob(`learning-${runId}`)

  let peakActive = 0
  const samples: string[] = []
  const sampleUntil = Date.now() + 3000
  while (Date.now() < sampleUntil) {
    peakActive = Math.max(peakActive, await sessionRunQueue.getActiveCount())
    samples.push(`${(await runRow(runId))?.status}/${await learningJob?.getState()}`)
    await Bun.sleep(100)
  }
  const statusWhileHeld = (await runRow(runId))?.status
  const jobStateWhileHeld = await learningJob?.getState()
  const sdkCallsWhileHeld = sdkCalls.length - callsBefore
  const turnStillActive = (await turnJob.getState()) === 'active'

  const releasedAt = Date.now()
  release()
  await tx
  await locker.end()

  const done = await until(async () => {
    peakActive = Math.max(peakActive, await sessionRunQueue.getActiveCount())
    const s = (await runRow(runId))?.status
    return s === 'completed' || s === 'failed'
  }, 20_000)
  const finalRow = await runRow(runId)
  const turnFinal = await until(async () => (await turnJob.getState()) === 'completed', 10_000)

  facts[`cap${label}`] = {
    cap,
    applied,
    turnActive,
    statusWhileHeld,
    jobStateWhileHeld,
    sdkCallsWhileHeld,
    turnStillActive,
    distinctSamples: [...new Set(samples)],
    peakActive,
    done,
    finalStatus: finalRow?.status,
    finalError: finalRow?.error,
    startedAfterRelease: finalRow?.startedAt ? finalRow.startedAt.getTime() >= releasedAt : null,
    sdkCallsTotal: sdkCalls.length - callsBefore,
    reviewSawWindowSession: sdkCalls.slice(callsBefore).some((c) => c.prompt.includes(`CAP-${label}`)),
    turnCompleted: turnFinal,
  }
}

async function main() {
  await mkdir(env.LIBRARY_DIR, { recursive: true })
  const steps: [string, () => Promise<void>][] = [
    ['scheduler', schedulerScenario],
    ['prevMillis', prevMillisScenario],
    ['lostJob', lostJobScenario],
    ['duplicateEnqueue', duplicateEnqueueScenario],
  ]
  const stepErrors: Record<string, string> = {}
  for (const [n, fn] of steps) {
    try {
      await fn()
    } catch (e) {
      stepErrors[n] = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }
  }
  const worker = startSessionRunWorker()
  facts.worker = { queueName: worker.name }
  for (const [cap, label] of [
    [1, 'One'],
    [2, 'Two'],
  ] as const) {
    try {
      await capScenario(cap, label)
    } catch (e) {
      stepErrors[`cap${label}`] = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }
  }
  facts.stepErrors = stepErrors
  await worker.close()
}

main()
  .then(async () => {
    console.log(`__FACTS__${JSON.stringify(facts)}`)
    await Promise.all([sessionRunQueue.close(), learningScheduleQueue.close()]).catch(() => {})
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    console.log(`__ERROR__${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
