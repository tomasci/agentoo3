// The backup job's registration (queue/index.ts's ensureDbBackupSchedule and
// enqueueDbBackup) and its processor (queue/db-backup.worker.ts), with
// bullmq and ioredis faked so the REAL queue/index.ts loads, and runDbBackup
// stubbed: what gets registered with BullMQ, when, and how each kind of
// result becomes a job outcome. The backup itself is db-backup-db.test.ts's.
//
// Its own process (run-isolated.ts) because it replaces bullmq, ioredis and
// features/backups/service.ts wholesale, which the shared test process must
// never see — the same reason learning-schedule-worker-db-child.ts gives.

import { expect, mock, test } from 'bun:test'
import './setup-env'
import { CronExpressionParser } from 'cron-parser'

const B = new URL('../src', import.meta.url).pathname

interface Call {
  queue: string
  method: string
  args: unknown[]
}
const calls: Call[] = []
const queueOptions: Record<string, { defaultJobOptions?: Record<string, unknown> }> = {}
const workers: {
  name: string
  processor: (job: { data: unknown }) => Promise<unknown>
  opts: Record<string, unknown>
}[] = []

class FakeUnrecoverableError extends Error {}

mock.module('bullmq', () => ({
  Queue: class {
    name: string
    constructor(name: string, opts: { defaultJobOptions?: Record<string, unknown> }) {
      this.name = name
      queueOptions[name] = opts
    }
    async add(...args: unknown[]) {
      calls.push({ queue: this.name, method: 'add', args })
      return { id: 'job-x' }
    }
    async upsertJobScheduler(...args: unknown[]) {
      calls.push({ queue: this.name, method: 'upsertJobScheduler', args })
    }
    async removeJobScheduler(...args: unknown[]) {
      calls.push({ queue: this.name, method: 'removeJobScheduler', args })
    }
    async setGlobalConcurrency() {}
    async getJob() {
      return undefined
    }
    async close() {}
  },
  Worker: class {
    constructor(
      name: string,
      processor: (job: { data: unknown }) => Promise<unknown>,
      opts: Record<string, unknown>,
    ) {
      workers.push({ name, processor, opts })
    }
    on() {
      return this
    }
    async close() {}
  },
  UnrecoverableError: FakeUnrecoverableError,
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

let nextResult: Record<string, unknown> = { status: 'created' }
const runCalls: unknown[] = []
mock.module(`${B}/features/backups/service.ts`, () => ({
  runDbBackup: async (opts: unknown) => {
    runCalls.push(opts)
    return nextResult
  },
}))

const queue = await import(`${B}/queue/index.ts`)
const { processDbBackupJob, startDbBackupWorker } = await import(
  `${B}/queue/db-backup.worker.ts`
)

const backupCalls = () => calls.filter((c) => c.queue === 'db-backup')

test('enabled: one daily job scheduler, 02:30 UTC, by a fixed id', async () => {
  calls.length = 0
  await queue.ensureDbBackupSchedule(true)
  expect(backupCalls()).toEqual([
    {
      queue: 'db-backup',
      method: 'upsertJobScheduler',
      args: [
        'db-backup-daily',
        { pattern: '30 2 * * *', tz: 'UTC' },
        { name: 'backup', data: { reason: 'scheduled' } },
      ],
    },
  ])
})

test('the pattern fires once a day at 02:30 UTC, clear of the 01:00 learning run', () => {
  const cron = CronExpressionParser.parse(queue.DB_BACKUP_CRON, {
    currentDate: new Date('2026-10-15T00:00:00Z'),
    tz: 'UTC',
  })
  const fires = [cron.next(), cron.next(), cron.next()].map((d) => d.toDate().toISOString())
  expect(fires).toEqual([
    '2026-10-15T02:30:00.000Z',
    '2026-10-16T02:30:00.000Z',
    '2026-10-17T02:30:00.000Z',
  ])
})

test('re-registering on every boot upserts the same id rather than adding a second', async () => {
  calls.length = 0
  await queue.ensureDbBackupSchedule(true)
  await queue.ensureDbBackupSchedule(true)
  const ids = backupCalls().map((c) => c.args[0])
  expect(ids).toEqual(['db-backup-daily', 'db-backup-daily'])
  expect(backupCalls().every((c) => c.method === 'upsertJobScheduler')).toBe(true)
})

test('disabled: the scheduler is removed, not upserted', async () => {
  calls.length = 0
  await queue.ensureDbBackupSchedule(false)
  expect(backupCalls()).toEqual([
    { queue: 'db-backup', method: 'removeJobScheduler', args: ['db-backup-daily'] },
  ])
})

test("the default follows BACKUPS_ENABLED (on unless it's set otherwise)", async () => {
  calls.length = 0
  await queue.ensureDbBackupSchedule()
  expect(backupCalls().map((c) => c.method)).toEqual(['upsertJobScheduler'])
})

test("the worker's boot catch-up is a 'boot' job on the same queue", async () => {
  calls.length = 0
  await queue.enqueueDbBackup({ reason: 'boot' })
  expect(backupCalls()).toEqual([{ queue: 'db-backup', method: 'add', args: ['backup', { reason: 'boot' }] }])
})

test('a failed backup is retried, with backoff', () => {
  const options = queueOptions['db-backup']?.defaultJobOptions
  expect(options?.attempts).toBe(3)
  expect(options?.backoff).toEqual({ type: 'exponential', delay: 300_000 })
})

test('the worker consumes db-backup one job at a time and runs the job it is given', async () => {
  startDbBackupWorker()
  const worker = workers.find((w) => w.name === 'db-backup')
  expect(worker?.opts.concurrency).toBe(1)
  runCalls.length = 0
  nextResult = { status: 'created', path: '/b/agentoo-x.dump' }
  expect(await worker?.processor({ data: { reason: 'scheduled' } })).toEqual(nextResult)
  expect(runCalls).toEqual([{ reason: 'scheduled' }])
})

test('disabled: a job that still arrives is skipped without a dump', async () => {
  runCalls.length = 0
  expect(await processDbBackupJob({ reason: 'scheduled' }, false)).toMatchObject({
    status: 'skipped',
  })
  expect(runCalls).toEqual([])
})

test('a skipped run completes the job', async () => {
  nextResult = { status: 'skipped', reason: 'fresh' }
  expect(await processDbBackupJob({ reason: 'boot' }, true)).toEqual(nextResult)
})

test('a failure no retry can fix is unrecoverable; any other failure is retried', async () => {
  // A disk too full for a dump among them: it needs an operator, not a retry.
  for (const kind of ['missing-binary', 'version-mismatch', 'insufficient-space']) {
    nextResult = { status: 'failed', kind, error: `${kind} message` }
    const error = await processDbBackupJob({ reason: 'scheduled' }, true).catch((e: Error) => e)
    expect(error).toBeInstanceOf(FakeUnrecoverableError)
    expect((error as Error).message).toBe(`${kind} message`)
  }
  for (const kind of ['pg_dump-failed', 'timeout', 'other']) {
    nextResult = { status: 'failed', kind, error: `${kind} message` }
    const error = await processDbBackupJob({ reason: 'scheduled' }, true).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(FakeUnrecoverableError)
  }
})
