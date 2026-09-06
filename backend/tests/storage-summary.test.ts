// Gap C: GET /api/storage/summary was missing the two fields the spec asks
// for — top-N largest sessions ("bytes per session distribution") and when
// the scheduled reconciliation next runs (ATTACHMENTS_GC_INTERVAL_MS was a
// backend env var nothing ever surfaced). This drives the real
// storageSummary() against a fake db and a fake BullMQ queue, so the actual
// query-building and the actual getJobScheduler() call are exercised.

import { expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const SESSION_C = '33333333-3333-4333-8333-333333333333'

/** Every session_files row still live — topSessionsByBytes groups these. */
const fileRows: Row[] = [
  { sessionId: SESSION_A, sizeBytes: 500 },
  { sessionId: SESSION_A, sizeBytes: 500 },
  { sessionId: SESSION_B, sizeBytes: 100 },
  { sessionId: SESSION_C, sizeBytes: 9000 },
]

const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

function select() {
  let t = ''
  let grouped = false
  const q = {
    from(x: unknown) {
      t = table(x)
      return q
    },
    where: () => q,
    groupBy: () => {
      grouped = true
      return q
    },
    orderBy: () => q,
    limit: async (n: number) => rows().slice(0, n),
    then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, err),
  }
  const rows = (): Row[] => {
    if (t === 'storage_anomalies') return [{ n: 3 }]
    if (t === 'session_files' && grouped) {
      const bySession = new Map<string, { sizeBytes: number; n: number }>()
      for (const row of fileRows) {
        const id = String(row.sessionId)
        const acc = bySession.get(id) ?? { sizeBytes: 0, n: 0 }
        acc.sizeBytes += row.sizeBytes as number
        acc.n += 1
        bySession.set(id, acc)
      }
      return [...bySession.entries()]
        .map(([sessionId, agg]) => ({ sessionId, bytes: agg.sizeBytes, n: agg.n }))
        .sort((a, b) => (b.bytes as number) - (a.bytes as number))
    }
    if (t === 'session_files') {
      const totalBytes = fileRows.reduce((sum, r) => sum + (r.sizeBytes as number), 0)
      const distinctSessions = new Set(fileRows.map((r) => r.sessionId)).size
      return [{ n: distinctSessions, bytes: totalBytes }]
    }
    return []
  }
  return q
}

mock.module(`${B}/db/client.ts`, () => ({ db: { select }, closeDb: async () => {} }))

let schedulerNext: number | undefined = Date.parse('2026-09-06T12:00:00.000Z')
let completedJobs: { data: { reason: string }; finishedOn: number }[] = [
  { data: { reason: 'scheduled' }, finishedOn: Date.parse('2026-09-05T00:00:00.000Z') },
  { data: { reason: 'cleanup' }, finishedOn: Date.parse('2026-09-04T00:00:00.000Z') },
]

mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: {
    getJobs: async () => completedJobs,
    getJobScheduler: async (id: string) =>
      id === 'attachments-gc-hourly' && schedulerNext !== undefined
        ? { key: id, name: 'gc', next: schedulerNext }
        : undefined,
  },
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
}))

const { storageSummary } = await import(`${B}/features/attachments/service.ts`)

test('topSessions is sorted largest-first and carries file counts', async () => {
  const summary = await storageSummary()
  expect(summary.topSessions).toEqual([
    { sessionId: SESSION_C, sizeBytes: 9000, fileCount: 1 },
    { sessionId: SESSION_A, sizeBytes: 1000, fileCount: 2 },
    { sessionId: SESSION_B, sizeBytes: 100, fileCount: 1 },
  ])
})

test('nextCheckAt comes from the job scheduler, not a derived lastCheckAt + interval', async () => {
  const summary = await storageSummary()
  expect(summary.nextCheckAt).toBe(new Date(schedulerNext as number).toISOString())
})

test('nextCheckAt is null when the schedule has not been registered yet', async () => {
  schedulerNext = undefined
  const summary = await storageSummary()
  expect(summary.nextCheckAt).toBeNull()
  schedulerNext = Date.parse('2026-09-06T12:00:00.000Z')
})

test('lastCheckAt and lastCleanupAt still come from completed-job history, unaffected by the new fields', async () => {
  const summary = await storageSummary()
  expect(summary.lastCheckAt).toBe(new Date(Date.parse('2026-09-05T00:00:00.000Z')).toISOString())
  expect(summary.lastCleanupAt).toBe(new Date(Date.parse('2026-09-04T00:00:00.000Z')).toISOString())
})

test('openAnomalies, totals and sessionCount are untouched by the new fields', async () => {
  const summary = await storageSummary()
  expect(summary.openAnomalies).toBe(3)
  expect(summary.totalBytes).toBe(10100)
  expect(summary.sessionCount).toBe(3)
})
