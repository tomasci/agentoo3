// The project-automations HTTP contract against a real Postgres — see
// automations-routes-db-child.ts for the fixture behind each fact below, and
// pg-cluster.ts for why this runs in a child process. Run history is produced
// by the real sweep firing into real sessions, not by inserting rows by hand.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP_PROJECTS = `/tmp/agentoo-automations-routes-test-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-automations-routes-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/automations-routes-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: TEMP_PROJECTS,
        ATTACHMENTS_DIR: TEMP_ATTACHMENTS,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
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
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
  await rm(TEMP_ATTACHMENTS, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

// biome-ignore lint/suspicious/noExplicitAny: facts are free-form JSON from the child
const fact = (key: string): any => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  if (typeof value.thrown === 'string') throw new Error(`scenario "${key}" threw: ${value.thrown}`)
  return value
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the automation route scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'createAccepts',
    'createRejects',
    'deleteHttp',
    'notFound',
    'patchRejects',
    'preview',
    'runs',
  ])
})

// --- create validation ---------------------------------------------------------

const rejected: [string, string][] = [
  ['sixFieldCron', 'cron'],
  ['atDaily', 'cron'],
  ['everyMinute', 'cron'],
  ['twoMinuteApart', 'cron'],
  ['feb30', 'cron'],
  ['emptyCron', 'cron'],
  ['unknownTimezone', 'timezone'],
  ['emptyName', 'name'],
  ['blankName', 'name'],
  ['controlCharName', 'name'],
  ['newlineName', 'name'],
  ['emptyPrompt', 'prompt'],
  ['blankPrompt', 'prompt'],
  ['missingOrchestrator', 'orchestrator'],
  ['blankOrchestrator', 'orchestrator'],
]

for (const [key, field] of rejected) {
  dbTest(`POST /projects/{id}/automations rejects ${key} with a 400 naming ${field}`, () => {
    const c = fact('createRejects').cases[key]
    expect(c.status).toBe(400)
    expect(c.error).toBe('Validation failed')
    expect(c.issues.map((i: { path: string }) => i.path)).toContain(field)
  })
}

dbTest('a rejected create stores nothing', () => {
  expect(fact('createRejects').storedCount).toBe(0)
})

dbTest('*/5 * * * * is accepted at the 5-minute floor and scheduled on a 5-minute mark', () => {
  const f = fact('createAccepts')
  expect(f.status).toBe(201)
  expect(f.name).toBe('Every five')
  expect(f.cron).toBe('*/5 * * * *')
  expect(f.timezone).toBe('UTC')
  expect(f.paused).toBe(false)
  expect(f.orchestrator).toBe('coder')
  expect(f.baseBranch).toBe('main')
  expect(f.maxBudgetUsd).toBe(4)
  expect(f.lastRunAt).toBeNull()
  expect(f.runCount).toBe(0)
  expect(f.nextRunAtOnFiveMinuteMark).toBe(true)
  expect(f.nextRunAtAfterRequest).toBe(true)
  expect(f.nextRunAtWithinFiveMinutes).toBe(true)
})

dbTest("GET /projects/{id}/automations lists a project's automations oldest first", () => {
  const f = fact('createAccepts')
  expect(f.secondStatus).toBe(201)
  expect(f.listStatus).toBe(200)
  expect(f.listNames).toEqual(['Every five', 'second'])
})

// --- 404 ------------------------------------------------------------------------------

dbTest('an unknown project or automation is a 404 on every route', () => {
  const f = fact('notFound')
  expect(f.listUnknownProject).toBe(404)
  expect(f.createUnknownProject).toBe(404)
  expect(f.getUnknown).toBe(404)
  expect(f.patchUnknown).toBe(404)
  expect(f.deleteUnknown).toBe(404)
  expect(f.runsUnknown).toBe(404)
  expect(f.notFoundError).toBe('Automation not found')
})

dbTest('a non-uuid automation id is a 400, not a 404 or 500', () => {
  expect(fact('notFound').getNotAUuid).toBe(400)
})

// --- PATCH validation ---------------------------------------------------------

dbTest(
  'PATCH rejects bad input, including a cron or timezone checked against the stored other half',
  () => {
    const f = fact('patchRejects')
    expect(f.statuses).toEqual({
      empty: 400,
      cronOnlyTooFrequent: 400,
      cronOnlyFeb30: 400,
      cronOnlySixField: 400,
      timezoneOnlyUnknown: 400,
      pairTooFrequent: 400,
      emptyName: 400,
      controlCharName: 400,
      blankPrompt: 400,
      blankOrchestrator: 400,
    })
    expect(f.cronAfter).toBe('0 9 * * *')
    expect(f.timezoneAfter).toBe('UTC')
    expect(f.nameAfter).toBe('Daily digest')
    expect(f.nextRunAtUnchanged).toBe(true)
  },
)

// --- schedule preview ------------------------------------------------------------

dbTest('schedule-preview answers an unschedulable cron with 200 valid:false and a reason', () => {
  const f = fact('preview')
  for (const key of ['tooFrequent', 'garbage', 'atDaily']) {
    expect(f[key].status).toBe(200)
    expect(f[key].body.valid).toBe(false)
    expect(typeof f[key].body.error).toBe('string')
    expect(f[key].body.error.length).toBeGreaterThan(0)
    expect(f[key].body.nextRuns).toEqual([])
  }
})

dbTest(
  'schedule-preview answers a good cron with `count` future ISO instants in its timezone',
  () => {
    const f = fact('preview')
    expect(f.goodStatus).toBe(200)
    expect(f.goodValid).toBe(true)
    expect(f.goodError).toBeNull()
    expect(f.goodRuns).toHaveLength(3)
    expect(f.goodRunsAreIso).toBe(true)
    // 09:00 in Asia/Kolkata is 03:30 UTC.
    expect(f.goodRunsAllAt0330Z).toBe(true)
    expect(f.goodRunsFirstAfterNow).toBe(true)
    expect(f.goodRunsOneDayApart).toEqual([86_400_000, 86_400_000])
    expect(f.defaultCount).toBe(5)
  },
)

// --- run history -------------------------------------------------------------------

dbTest('runs are listed newest scheduled occurrence first', () => {
  const f = fact('runs')
  expect(f.allStatus).toBe(200)
  expect(f.allScheduledFor).toEqual([
    '2026-03-02T12:00:00.000Z',
    '2026-03-02T11:00:00.000Z',
    '2026-03-02T10:00:00.000Z',
  ])
  expect(f.allStatuses).toEqual(['dispatched', 'dispatched', 'dispatched'])
  expect(f.allPrompts).toEqual([
    'Summarise yesterday',
    'Summarise yesterday',
    'Summarise yesterday',
  ])
  expect(f.dtoRunCount).toBe(3)
  expect(f.dtoLastRunAt).toBe('2026-03-02T12:00:00.000Z')
})

dbTest('runs honour `limit`, and refuse one out of range', () => {
  const f = fact('runs')
  expect(f.limitedStatus).toBe(200)
  expect(f.limitedScheduledFor).toEqual(['2026-03-02T12:00:00.000Z', '2026-03-02T11:00:00.000Z'])
  expect(f.limitZero).toBe(400)
  expect(f.limitTooBig).toBe(400)
  expect(f.limitNotNumber).toBe(400)
})

dbTest('a run carries its session summary {id,title,status,totalCostUsd,unchecked}', () => {
  const f = fact('runs')
  expect(f.firstSessionKeys).toEqual(['id', 'status', 'title', 'totalCostUsd', 'unchecked'])
  expect(f.firstSessionIdMatches).toBe(true)
  expect(f.firstSession.title).toBe('Hourly · 2026-03-02 12:00')
  expect(f.firstSession.status).toBe('queued')
  expect(f.firstSession.totalCostUsd).toBe(0)
  expect(f.firstSession.unchecked).toBe(false)
  // A settled, never-seen session reads back as unchecked, with its cost.
  expect(f.settled.title).toBe('Hourly · 2026-03-02 10:00')
  expect(f.settled.status).toBe('completed')
  expect(f.settled.totalCostUsd).toBe(1.25)
  expect(f.settled.unchecked).toBe(true)
})

dbTest("deleting a run's session keeps the run, with sessionId and session both null", () => {
  const f = fact('runs')
  expect(f.runCountAfterSessionDelete).toBe(3)
  expect(f.runRowsInDb).toBe(3)
  expect(f.deletedSessionRun.sessionId).toBeNull()
  expect(f.deletedSessionRun.session).toBeNull()
  expect(f.deletedSessionRun.status).toBe('dispatched')
})

// --- DELETE ----------------------------------------------------------------------------

dbTest('DELETE /automations/{id} answers 204, then 404 on every later read or delete', () => {
  const f = fact('deleteHttp')
  expect(f.deleteStatus).toBe(204)
  expect(f.deleteBody).toBeNull()
  expect(f.secondDeleteStatus).toBe(404)
  expect(f.getStatus).toBe(404)
  expect(f.listLength).toBe(0)
})
