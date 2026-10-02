// queue/learning-schedule.worker.ts: the pure windowEnd resolution, the
// trigger handler (prevMillis / timestamp+delay / the current-schedule
// fallback, the same-windowEnd skip, and the conflict skip), and the
// reconcile loop (upsert on change, no re-upsert when unchanged, remove on
// disable, re-upsert on re-enable). See learning-schedule-worker-db-child.ts
// for why this runs in a child process.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let facts: Facts = {}
let setupError = ''

const childEnv: Record<string, string | undefined> = {
  ...process.env,
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  LOG_LEVEL: '1',
}

const child = Bun.spawn(['bun', join(BACKEND, 'tests/learning-schedule-worker-db-child.ts')], {
  cwd: BACKEND,
  env: childEnv,
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
  const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
  setupError = `child exited ${code}: ${failure}`
} else {
  facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
}

afterAll(() => {})

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(5)
})

// --- scheduledWindowEnd (pure) ------------------------------------------------

test('prevMillis is the primary source', () => {
  expect(fact('pure').prevMillisWins).toBe('2026-01-02T01:00:00.000Z')
})

test('timestamp + delay is the fallback when prevMillis is absent', () => {
  expect(fact('pure').timestampPlusDelay).toBe('2026-01-02T01:00:00.000Z')
})

test('neither field usable falls back to the given "now"', () => {
  expect(fact('pure').neitherFallsBackToNow).toBe(true)
})

test('prevMillis wins even when timestamp/delay are also present', () => {
  expect(fact('pure').prevMillisWinsOverTimestamp).toBe('2026-01-02T01:00:00.000Z')
})

// --- handleLearningScheduleTrigger --------------------------------------------

test('windowEnd comes from opts.prevMillis, even when processed long after the fact', () => {
  const f = fact('triggerPrevMillis')
  expect(f.calls).toBe(1)
  expect(f.trigger).toBe('scheduled')
  expect(f.windowEnd).toBe('2026-01-02T01:00:00.000Z')
})

test('windowEnd comes from opts.timestamp + opts.delay when prevMillis is absent', () => {
  expect(fact('triggerTimestampDelay').windowEnd).toBe('2026-01-02T01:00:00.000Z')
})

test('windowEnd falls back to the current schedule\'s latest occurrence when neither opts field is usable', () => {
  const f = fact('triggerFallback')
  expect(f.calls).toBe(1)
  expect(f.isMidnightUtc).toBe(true)
  expect(f.notInTheFuture).toBe(true)
  expect(f.matchesPureHelper).toBe(true)
})

test('a scheduled run with the same windowEnd already on file is skipped, not duplicated', () => {
  const f = fact('triggerSameWindowEndSkip')
  expect(f.selectCalls).toBe(1)
  expect(f.createCalls).toBe(0)
})

test('a conflict (a run already active) is logged and skipped, not thrown', () => {
  const f = fact('triggerConflictSkip')
  expect(f.threw).toBe(false)
  expect(f.createCalls).toBe(1)
})

// --- reconcileLearningSchedule ------------------------------------------------

test('the first reconcile always applies, even though it matches the built-in default', () => {
  const f = fact('reconcileFirstAlwaysApplies')
  expect(f.calls).toEqual(['upsert'])
  expect(f.applied).toEqual({ enabled: true, pattern: '0 4 * * *', timezone: 'UTC' })
})

test('a second reconcile with an unchanged schedule does not re-upsert', () => {
  const f = fact('reconcileUnchangedNoReupsert')
  expect(f.calls).toEqual(['upsert'])
  expect(f.same).toBe(true)
})

test('a changed time re-upserts', () => {
  const f = fact('reconcileChangedTimeReupserts')
  expect(f.calls).toEqual(['upsert', 'upsert'])
  expect(f.pattern).toBe('0 5 * * *')
})

test('disabling removes the job scheduler, and re-enabling upserts again', () => {
  const f = fact('reconcileDisableThenReenable')
  expect(f.calls).toEqual(['upsert', 'remove', 'upsert'])
})
