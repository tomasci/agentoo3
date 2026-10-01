// The admin-configurable max_concurrent_sessions setting, against a real
// Postgres: validation through the real app, the absent-means-default model,
// persistence across reads, malformed stored rows, and the plumbing from a
// stored row to the numbers session-concurrency.ts hands BullMQ.
//
// The child (system-settings-db-child.ts) runs twice against one throwaway
// cluster: once with WORKER_CONCURRENCY removed from its environment, so the
// built-in default is what it reports, and once with WORKER_CONCURRENCY=5, so
// the default is shown to follow env rather than being a second constant.
// See pg-cluster.ts for why a child process at all. The child gathers facts;
// every assertion lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let envFacts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

async function runChild(mode: 'full' | 'envDefault', workerConcurrency?: string): Promise<Facts> {
  if (!cluster) throw new Error('no cluster')
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: cluster.connectionString,
    // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
    REDIS_URL: 'redis://127.0.0.1:1',
    PROJECTS_DIR: `/tmp/agentoo-settings-test-projects-${process.pid}`,
    ATTACHMENTS_DIR: `/tmp/agentoo-settings-test-attachments-${process.pid}`,
    CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
    LOG_LEVEL: '1',
    SETTINGS_CHILD_MODE: mode,
  }
  // Removed, not overridden, for the default run: a box that runs agentoo
  // has WORKER_CONCURRENCY set in its own environment, which would otherwise
  // be inherited and reported back as "the default".
  delete childEnv.WORKER_CONCURRENCY
  if (workerConcurrency !== undefined) childEnv.WORKER_CONCURRENCY = workerConcurrency

  const child = Bun.spawn(['bun', join(BACKEND, 'tests/system-settings-db-child.ts')], {
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
    throw new Error(`child (${mode}) exited ${code}: ${failure}`)
  }
  return JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
}

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    facts = await runChild('full')
    envFacts = await runChild('envDefault', '5')
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const factIn =
  (source: () => Facts) =>
  <T = Record<string, unknown>>(key: string): T => {
    const value = source()[key]
    if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
    return value as T
  }
const fact = factIn(() => facts)
const envFact = factIn(() => envFacts)

type Res = { status: number; body: Record<string, unknown> }
type Settings = { maxConcurrentSessions: { value: number; source: string; defaultValue: number } }

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the settings scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(15)
  expect(Object.keys(envFacts).length).toBeGreaterThan(0)
})

// --- 1. validation ---------------------------------------------------------

const invalidCases: [name: string, path: string, message: string][] = [
  ['zero', 'maxConcurrentSessions', 'Must be at least 1'],
  ['negative', 'maxConcurrentSessions', 'Must be at least 1'],
  ['fraction', 'maxConcurrentSessions', 'Must be a whole number'],
  ['string', 'maxConcurrentSessions', 'Must be a whole number'],
  ['boolean', 'maxConcurrentSessions', 'Must be a whole number'],
  ['tooHigh', 'maxConcurrentSessions', 'Must be at most 64'],
  ['empty', '', 'Nothing to update'],
  ['unknownKeyOnly', '', 'Nothing to update'],
]

for (const [name, path, message] of invalidCases) {
  dbTest(`PATCH ${name} is a 400 with issue {path: "${path}", message: "${message}"}`, () => {
    const f = fact<Record<string, { status: number; body: unknown }>>('invalid')[name]
    expect(f?.status).toBe(400)
    expect(f?.body).toEqual({ error: 'Validation failed', issues: [{ path, message }] })
  })

  dbTest(`PATCH ${name} leaves the stored override exactly as it was`, () => {
    const f = fact<Record<string, { storedAfter: unknown; getAfter: Settings }>>('invalid')[name]
    expect(f?.storedAfter).toEqual({ value: 7 })
    expect(f?.getAfter.maxConcurrentSessions).toEqual({
      value: 7,
      source: 'override',
      defaultValue: 2,
    })
  })
}

dbTest('PATCH 1e308 is a 400 that names the ceiling, and changes nothing', () => {
  // Two issues, not one: zod also refuses a number past MAX_SAFE_INTEGER as
  // "not an int". Either way it is a 400 on the right path.
  const f =
    fact<Record<string, { status: number; body: { issues: unknown[] }; storedAfter: unknown }>>(
      'invalid',
    ).huge
  expect(f?.status).toBe(400)
  expect(f?.body.issues).toContainEqual({
    path: 'maxConcurrentSessions',
    message: 'Must be at most 64',
  })
  expect(f?.storedAfter).toEqual({ value: 7 })
})

for (const name of ['array', 'object', 'bodyIsArray', 'bodyIsNull']) {
  dbTest(`PATCH ${name} is a 400 in the standard envelope and changes nothing`, () => {
    const f =
      fact<Record<string, { status: number; body: Record<string, unknown>; storedAfter: unknown }>>(
        'invalid',
      )[name]
    expect(f?.status).toBe(400)
    expect(f?.body.error).toBe('Validation failed')
    expect(Array.isArray(f?.body.issues)).toBe(true)
    expect(f?.storedAfter).toEqual({ value: 7 })
  })
}

dbTest('a rejected PATCH with nothing stored does not create a row', () => {
  const f = fact('invalidOnEmpty')
  expect(f.status).toBe(400)
  expect(f.storedAfter).toBeNull()
})

dbTest('a PATCH with no body at all is a 400 and changes nothing', () => {
  const f = fact('noBody')
  expect(f.storedAfter).toEqual({ value: 7 })
  // The schema's own "Nothing to update" refine exists to make an empty
  // PATCH a 400 rather than a silent no-op.
  expect(f.status).toBe(400)
})

dbTest('an out-of-range value sent as text/plain is refused, never written', () => {
  const f = fact('textPlainInvalid')
  expect(f.storedAfter).toEqual({ value: 7 })
  expect(f.status).toBe(400)
})

dbTest(
  'a valid value sent as text/plain is either applied or refused, never a silent 200 no-op',
  () => {
    const f = fact<{ status: number; storedAfter: unknown }>('textPlainValid')
    const applied =
      f.status === 200 && JSON.stringify(f.storedAfter) === JSON.stringify({ value: 3 })
    const refused =
      f.status >= 400 && JSON.stringify(f.storedAfter) === JSON.stringify({ value: 7 })
    expect({ status: f.status, storedAfter: f.storedAfter, ok: applied || refused }).toMatchObject({
      ok: true,
    })
  },
)

for (const value of [1, 3, 64]) {
  dbTest(`PATCH ${value} is a 200 override, and a following GET agrees`, () => {
    const f =
      fact<
        Record<
          string,
          { patch: Res; get: Res; stored: unknown; jsonbType: string; effective: number }
        >
      >('valid')[String(value)]
    const expected = { maxConcurrentSessions: { value, source: 'override', defaultValue: 2 } }
    expect(f?.patch.status).toBe(200)
    expect(f?.patch.body).toEqual(expected)
    expect(f?.get.status).toBe(200)
    expect(f?.get.body).toEqual(expected)
    expect(f?.stored).toEqual({ value })
    expect(f?.jsonbType).toBe('number')
    expect(f?.effective).toBe(value)
  })
}

dbTest('PATCH null resets to the default and deletes the row', () => {
  const f = fact<{ patch: Res; stored: unknown; get: Res }>('reset')
  expect(f.patch.status).toBe(200)
  expect(f.patch.body).toEqual({
    maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
  })
  expect(f.stored).toBeNull()
  expect(f.get.body).toEqual(f.patch.body)
})

dbTest('PATCH null with nothing saved is still a 200 default', () => {
  const f = fact<{ patch: Res }>('resetWhenUnset')
  expect(f.patch.status).toBe(200)
  expect(f.patch.body).toEqual({
    maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
  })
})

dbTest('saving a value equal to the default still reports an override', () => {
  const f = fact<{ patch: Res }>('equalToDefault')
  expect(f.patch.body).toEqual({
    maxConcurrentSessions: { value: 2, source: 'override', defaultValue: 2 },
  })
})

dbTest('an unknown key next to a valid one is ignored, and the valid one applies', () => {
  const f = fact<{ patch: Res; stored: unknown }>('validPlusUnknown')
  expect(f.patch.status).toBe(200)
  expect(f.stored).toEqual({ value: 4 })
})

dbTest('a second save replaces the first rather than adding a row', () => {
  const f = fact<{ stored: unknown; rows: number; get: Settings }>('overwrite')
  expect(f.stored).toEqual({ value: 5 })
  expect(f.rows).toBe(1)
  expect(f.get.maxConcurrentSessions.value).toBe(5)
})

dbTest('re-saving the same value bumps updated_at', () => {
  expect(fact('updatedAt').moved).toBe(true)
})

// --- 2. default and persistence --------------------------------------------

dbTest('with no row and WORKER_CONCURRENCY unset, GET reports the built-in default of 2', () => {
  const f = fact<{ envWorkerConcurrency: number; get: Res; effective: number }>('envDefault')
  expect(f.envWorkerConcurrency).toBe(2)
  expect(f.get.status).toBe(200)
  expect(f.get.body).toEqual({
    maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
  })
  expect(f.effective).toBe(2)
})

dbTest('with WORKER_CONCURRENCY=5, the default follows env', () => {
  const f = envFact<{ envWorkerConcurrency: number; get: Res; effective: number }>('envDefault')
  expect(f.envWorkerConcurrency).toBe(5)
  expect(f.get.body).toEqual({
    maxConcurrentSessions: { value: 5, source: 'default', defaultValue: 5 },
  })
  expect(f.effective).toBe(5)
})

dbTest('with WORKER_CONCURRENCY=5, a reset lands on 5, not on 2', () => {
  const f = envFact<{ patch: Res }>('envDefaultReset')
  expect(f.patch.body).toEqual({
    maxConcurrentSessions: { value: 5, source: 'default', defaultValue: 5 },
  })
})

dbTest('with WORKER_CONCURRENCY=5 and no row, enforcement is global 5 / local 6', () => {
  const f = envFact('envDefaultEnforcement')
  expect(f.applied).toBe(5)
  expect(f.globals).toEqual([5])
  expect(f.local).toBe(6)
})

dbTest('the effective value is read from the database on every call, not cached', () => {
  const f = fact('persistence')
  expect(f.afterSave).toBe(3)
  // Written by SQL alone, behind the process's back.
  expect(f.afterExternalWrite).toBe(9)
  expect(f.afterExternalDelete).toBe(2)
})

const malformedNames = [
  'string',
  'zero',
  'negative',
  'fraction',
  'tooHigh',
  'jsonNull',
  'object',
  'array',
  'boolean',
]
for (const name of malformedNames) {
  dbTest(`a malformed stored row (${name}) is treated as unset, with a warning`, () => {
    const f =
      fact<
        Record<
          string,
          {
            get: Res
            effective: number
            warnings: string[]
            enforcement: { applied: number; local: number; globals: number[] }
          }
        >
      >('malformed')[name]
    expect(f?.get.status).toBe(200)
    expect(f?.get.body).toEqual({
      maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
    })
    expect(f?.effective).toBe(2)
    expect(f?.warnings.some((w) => w.includes('max_concurrent_sessions'))).toBe(true)
    expect(f?.enforcement).toEqual({ applied: 2, local: 3, globals: [2] })
  })
}

dbTest('a malformed row is replaced by a valid save and removed by a reset', () => {
  const f = fact<{ save: Res; reset: Res; storedAfterReset: unknown }>('overMalformed')
  expect(f.save.status).toBe(200)
  expect(f.save.body).toEqual({
    maxConcurrentSessions: { value: 4, source: 'override', defaultValue: 2 },
  })
  expect(f.reset.status).toBe(200)
  expect(f.storedAfterReset).toBeNull()
})

// --- 3. enforcement plumbing (fake worker/queue, real Postgres) -------------

type Enforcement = { applied: number; local: number; globals: number[]; events: string[] }

dbTest('no row: global 2, local 3, local set before global', () => {
  const f = fact<Record<string, Enforcement>>('enforcement').noRow
  expect(f?.applied).toBe(2)
  expect(f?.globals).toEqual([2])
  expect(f?.local).toBe(3)
  expect(f?.events).toEqual(['local:3', 'global:2'])
})

dbTest('row 1: global 1, local 2', () => {
  // From a worker constructed at 2, the local number is already the target,
  // so only the global write happens.
  const f = fact<Record<string, Enforcement>>('enforcement').row1
  expect(f?.applied).toBe(1)
  expect(f?.globals).toEqual([1])
  expect(f?.local).toBe(2)
  expect(f?.events).toEqual(['global:1'])
})

dbTest('row 1 from a worker at 4: local lowered to 2 before global goes to 1', () => {
  const f = fact<Record<string, Enforcement>>('enforcement').row1FromFour
  expect(f?.local).toBe(2)
  expect(f?.events).toEqual(['local:2', 'global:1'])
})

dbTest('row 3: global 3, local 4, local set before global', () => {
  const f = fact<Record<string, Enforcement>>('enforcement').row3
  expect(f?.applied).toBe(3)
  expect(f?.globals).toEqual([3])
  expect(f?.local).toBe(4)
  expect(f?.events).toEqual(['local:4', 'global:3'])
})

dbTest(
  'successive ticks follow the setting up, down and back to default, re-asserting global each time',
  () => {
    const f = fact('followsChanges')
    expect(f.events).toEqual([
      'local:4',
      'global:3',
      // Unchanged: local untouched, global re-asserted.
      'global:3',
      'local:2',
      'global:1',
      'local:3',
      'global:2',
    ])
    expect(f.local).toBe(3)
  },
)

dbTest('a failed database read leaves the previously applied values alone', () => {
  const f = fact('dbFailure')
  expect(f.firstApplied).toBe(3)
  expect(f.eventsBefore).toEqual(['local:4', 'global:3'])
  expect(f.threw).toBe('')
  expect(f.failedApplied).toBe('undefined')
  expect(f.localAfterFailure).toBe(4)
  // Nothing at all happened on the failed tick, until the recovered one.
  expect(f.eventsAfter).toEqual(['local:4', 'global:3', 'global:3'])
  expect((f.warnings as string[]).some((w) => w.includes('max_concurrent_sessions'))).toBe(true)
  expect(f.recoveredApplied).toBe(3)
})

dbTest(
  'apply sets the local slots even when setGlobalConcurrency rejects, and rejects with it',
  () => {
    const f = fact('applyRejects')
    expect(f.local).toBe(6)
    expect(f.rejected).toContain('redis down')
  },
)

dbTest('the watcher ticks once immediately, on a 5s interval, unref()d', () => {
  const f = fact('watchOverlap')
  expect(f.refreshConstant).toBe(5000)
  expect(f.intervalMs).toBe(5000)
  expect(f.unrefCalled).toBe(true)
})

dbTest('a tick that arrives while the previous one is still in flight is skipped', () => {
  const f = fact('watchOverlap')
  // Two interval ticks fired while the first hung in setGlobalConcurrency.
  expect(f.callsWhileHung).toBe(1)
  // Once it settled, the next tick ran normally.
  expect(f.callsAfterRelease).toBe(2)
  expect(f.globals).toEqual([3, 3])
  expect(f.local).toBe(4)
})

dbTest('the stop function clears the interval it started', () => {
  expect(fact('watchOverlap').stopClearedHandle).toBe(true)
})

dbTest('a tick whose apply rejects is caught, logged, and does not wedge later ticks', () => {
  const f = fact('watchRejects')
  expect(f.unhandled).toEqual([])
  expect(f.calls).toBe(2)
  expect((f.warnings as string[]).filter((w) => w.includes('redis refused'))).toHaveLength(2)
})
