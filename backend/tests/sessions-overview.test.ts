// The System tab's sessions dashboard, against a real Postgres: the two new
// columns (settled_at, seen_at), the DTO's settledAt/seenAt/unchecked, POST
// /sessions/{id}/seen, GET /sessions/overview, and every real status write
// that is supposed to stamp settled_at. See sessions-overview-db-child.ts for
// the fixture behind each fact, and why it runs in a child process (the
// `@/env` first-import-wins constraint pg-cluster.ts's own header explains).
//
// Also checks migration 0008 on its own: applied to a database that already
// has a session in it, it must leave that row's two new columns null (no
// backfill).

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const MIGRATIONS = join(BACKEND, 'src/db/migrations')
const TEMP_PROJECTS = `/tmp/agentoo-sessions-overview-test-projects-${process.pid}`

type Facts = Record<string, Record<string, unknown>>
type Http = { status: number; body: Record<string, unknown> }

let cluster: Cluster | undefined
let preCluster: Cluster | undefined
let preDir: string | undefined
let facts: Facts = {}
let setupError = ''
let migrationFacts: Record<string, unknown> = {}
let migrationError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(MIGRATIONS)
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/sessions-overview-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        // Deliberately dead, and never dialled: the child fakes ioredis and
        // bullmq. `@/env` still insists on a value.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: TEMP_PROJECTS,
        ATTACHMENTS_DIR: `/tmp/agentoo-sessions-overview-test-attachments-${process.pid}`,
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

  // Migration 0008 applied on top of a database that already holds a session.
  try {
    const all = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()
    const target = all.find((n) => n.startsWith('0008_'))
    if (!target) throw new Error('no 0008_*.sql migration')
    preDir = await mkdtemp(join(tmpdir(), 'agentoo-pre-0008-'))
    for (const name of all.filter((n) => n < target)) {
      await copyFile(join(MIGRATIONS, name), join(preDir, name))
    }
    preCluster = await startTempCluster(preDir)
    const sql = postgres(preCluster.connectionString, { max: 1, onnotice: () => {} })
    try {
      const [project] = await sql`
        insert into projects (name, slug, source, status)
        values ('pre', 'pre', 'empty', 'ready') returning id`
      await sql`
        insert into sessions (project_id, status, updated_at)
        values (${project?.id}, 'completed', now() - interval '1 hour')`
      const migration = await readFile(join(MIGRATIONS, target), 'utf8')
      await sql.unsafe(migration)
      const rows = await sql`select settled_at, seen_at from sessions`
      const columns = await sql`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_name = 'sessions' and column_name in ('settled_at', 'seen_at')
        order by column_name`
      migrationFacts = {
        file: target,
        hasUpdate: /\bupdate\b/i.test(migration),
        rows: rows.map((r) => ({ settledAt: r.settled_at, seenAt: r.seen_at })),
        columns: columns.map((c) => ({ ...c })),
      }
    } finally {
      await sql.end()
    }
  } catch (error) {
    migrationError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await preCluster?.stop()
  if (preDir) await rm(preDir, { recursive: true, force: true })
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

/** settledAt landed inside the wall-clock bracket of the write that set it. */
const landedBetween = (f: Record<string, unknown>, before = 'before', after = 'after') => {
  const at = f.settledAtMs as number | null
  expect(at).not.toBeNull()
  expect(at as number).toBeGreaterThanOrEqual(f[before] as number)
  expect(at as number).toBeLessThanOrEqual(f[after] as number)
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the sessions-overview scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'caps',
    'dtoShape',
    'overview',
    'overviewValidation',
    'reconciler',
    'recover',
    'seen',
    'truthTable',
    'workerCompleted',
    'workerDrained',
    'workerFailed',
    'workerInterrupted',
    'workerOverBudget',
  ])
})

// --- migration ------------------------------------------------------------------

dbTest('migration 0008 adds nullable timestamptz columns and backfills nothing', () => {
  expect(migrationError).toBe('')
  expect(migrationFacts.hasUpdate).toBe(false)
  expect(migrationFacts.columns).toEqual([
    {
      column_name: 'seen_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      column_name: 'settled_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
  ])
  // A completed session that existed before the migration keeps both null.
  expect(migrationFacts.rows).toEqual([{ settledAt: null, seenAt: null }])
})

// --- DTO shape ----------------------------------------------------------------

dbTest('a freshly created session carries settledAt/seenAt null and unchecked false', () => {
  const f = fact('dtoShape')
  expect(f.createStatus).toBe(201)
  expect(f.createHasKeys).toBe(true)
  expect(f.create).toEqual({ settledAt: null, seenAt: null, unchecked: false })
})

dbTest('list, get and patch all carry the same settledAt/seenAt/unchecked', () => {
  const f = fact('dtoShape')
  const expected = { settledAt: f.rowSettledAt, seenAt: null, unchecked: true }
  expect(f.rowSettledAt).toEqual(expect.any(String))
  expect(f.listStatus).toBe(200)
  expect(f.list).toEqual(expected)
  expect(f.get).toEqual(expected)
  expect(f.patchStatus).toBe(200)
  expect(f.patch).toEqual(expected)
})

// --- the unchecked rule -----------------------------------------------------------

const truth = (name: string) =>
  (fact('truthTable') as Record<string, Record<string, boolean>>)[name] as Record<string, boolean>

const expectUnchecked = (name: string, unchecked: boolean) => {
  const t = truth(name)
  expect(t).toBeDefined()
  expect(t.get).toBe(unchecked)
  expect(t.list).toBe(unchecked)
  expect(t.inOverviewUnchecked).toBe(unchecked)
}

dbTest('a session that never settled (legacy row) is not unchecked', () => {
  expectUnchecked('legacyNeverSettled', false)
})
dbTest('seen but never settled is not unchecked', () => {
  expectUnchecked('seenNeverSettled', false)
})
dbTest('completed, failed, interrupted and settled-idle sessions never seen are unchecked', () => {
  expectUnchecked('completedUnseen', true)
  expectUnchecked('failedUnseen', true)
  expectUnchecked('interruptedUnseen', true)
  expectUnchecked('idleSettledUnseen', true)
})
dbTest('seen before the last settle is still unchecked', () => {
  expectUnchecked('seenBeforeSettled', true)
})
dbTest('seen after the last settle is not unchecked', () => {
  expectUnchecked('seenAfterSettled', false)
})
dbTest('seenAt exactly equal to settledAt is not unchecked (strict <)', () => {
  expectUnchecked('seenEqualsSettled', false)
})
dbTest('running and queued are never unchecked, even with settledAt set and never seen', () => {
  expectUnchecked('runningSettledUnseen', false)
  expectUnchecked('queuedSettledUnseen', false)
  expect(truth('runningSettledUnseen').inOverviewRunning).toBe(true)
  expect(truth('queuedSettledUnseen').inOverviewRunning).toBe(true)
})

// --- overview -------------------------------------------------------------------

type WindowFacts = {
  window: string
  keys: string[]
  running: string[]
  unchecked: string[]
  recent: string[]
  runningSortedByUpdatedAt: boolean
  uncheckedSortedBySettledAt: boolean
  recentSortedByUpdatedAt: boolean
  allRunningAreRunningOrQueued: boolean
  allUncheckedFlagged: boolean
}
const win = (w: string) =>
  (fact('overview').windows as Record<string, WindowFacts>)[w] as WindowFacts

dbTest('overview returns running, unchecked, recent and window; window defaults to 1d', () => {
  for (const w of ['default', '1d', '3d', '7d']) {
    expect(win(w).keys).toEqual(['recent', 'running', 'unchecked', 'window'])
  }
  expect(win('default').window).toBe('1d')
  expect(win('1d').window).toBe('1d')
  expect(win('3d').window).toBe('3d')
  expect(win('7d').window).toBe('7d')
  expect(win('default').recent).toEqual(win('1d').recent)
})

dbTest('running lists running and queued sessions by updatedAt desc, ignoring window', () => {
  for (const w of ['1d', '3d', '7d']) {
    expect(win(w).running).toEqual(['runningFresh', 'queuedOld', 'runningOld'])
    expect(win(w).runningSortedByUpdatedAt).toBe(true)
    expect(win(w).allRunningAreRunningOrQueued).toBe(true)
  }
})

dbTest('unchecked is ordered by settledAt desc and ignores window', () => {
  for (const w of ['1d', '3d', '7d']) {
    // u2 settled after u1 even though u1 was updated more recently.
    expect(win(w).unchecked).toEqual(['u2', 'u1', 'settled40h', 'settled8d'])
    expect(win(w).uncheckedSortedBySettledAt).toBe(true)
    expect(win(w).allUncheckedFlagged).toBe(true)
  }
})

dbTest('a session settled 40h ago is unchecked at 1d but only recent at 3d and 7d', () => {
  expect(win('1d').unchecked).toContain('settled40h')
  expect(win('1d').recent).not.toContain('settled40h')
  expect(win('3d').recent).toContain('settled40h')
  expect(win('7d').recent).toContain('settled40h')
})

dbTest('recent is bounded by window, any status, by updatedAt desc, overlapping other lists', () => {
  expect(win('1d').recent).toEqual(['runningFresh', 'u1', 'u2'])
  expect(win('3d').recent).toEqual(['runningFresh', 'u1', 'u2', 'settled40h'])
  expect(win('7d').recent).toEqual(['runningFresh', 'u1', 'u2', 'settled40h', 'seen5d'])
  for (const w of ['1d', '3d', '7d']) {
    expect(win(w).recentSortedByUpdatedAt).toBe(true)
    // Updated 8-10 days ago: never recent, whatever else they are.
    expect(win(w).recent).not.toContain('settled8d')
    expect(win(w).recent).not.toContain('runningOld')
    expect(win(w).recent).not.toContain('queuedOld')
  }
})

dbTest('every overview item is a full Session DTO plus its own projectName', () => {
  const f = fact('overview')
  expect(f.itemHasDtoFields).toBe(true)
  expect(f.projectNames).toEqual({ queuedOld: 'Alpha', u1: 'Gamma', u2: 'Alpha' })
})

dbTest('an invalid window is a 400 with the standard validation envelope', () => {
  const bad = fact('overviewValidation').bad as Record<string, Http>
  for (const q of ['?window=2d', '?window=', '?window=1D', '?window=30d', '?window=all']) {
    const res = bad[q] as Http
    expect({ q, status: res.status }).toEqual({ q, status: 400 })
    expect(res.body.error).toBe('Validation failed')
    const issues = res.body.issues as { path: string }[]
    expect(issues.map((i) => i.path)).toContain('window')
  }
})

dbTest('/sessions/overview is not captured by /sessions/{id}', () => {
  const f = fact('overviewValidation')
  expect(f.overviewStatus).toBe(200)
  // ...while /sessions/{id} really does validate its id, so a capture would show.
  expect((f.nonUuidSessionId as Http).status).toBe(400)
  expect((f.unknownSessionId as Http).status).toBe(404)
})

dbTest('recent is capped at 200 rows, the newest ones', () => {
  const f = fact('caps')
  expect(f.inWindowCount as number).toBeGreaterThan(200)
  expect(f.recentLength).toBe(200)
  expect(f.recentUnique).toBe(200)
  expect(f.minReturnedUpdatedAt as number).toBeGreaterThanOrEqual(f.maxLeftOutUpdatedAt as number)
})

dbTest('running and unchecked are not capped', () => {
  const f = fact('caps')
  expect(f.dbRunningCount as number).toBeGreaterThan(200)
  expect(f.runningLength).toBe(f.dbRunningCount)
  expect(f.dbUncheckedCount as number).toBeGreaterThan(200)
  expect(f.uncheckedLength).toBe(f.dbUncheckedCount)
})

// --- POST /sessions/{id}/seen -----------------------------------------------------

dbTest('seen returns 200 with the updated DTO: seenAt now, unchecked false', () => {
  const f = fact('seen')
  expect(f.before).toEqual({ unchecked: true, updatedAt: expect.any(String) })
  expect(f.inUncheckedBefore).toBe(true)
  expect(f.firstStatus).toBe(200)
  const first = f.first as Record<string, unknown>
  expect(first.unchecked).toBe(false)
  expect(f.firstSeenAtMs as number).toBeGreaterThanOrEqual(f.t0 as number)
  expect(f.firstSeenAtMs as number).toBeLessThanOrEqual(f.t1 as number)
  expect(f.inUncheckedAfter).toBe(false)
})

dbTest('seen does not change updatedAt (response, GET, or row)', () => {
  const f = fact('seen')
  const updatedAt = (f.before as Record<string, unknown>).updatedAt
  expect((f.first as Record<string, unknown>).updatedAt).toBe(updatedAt)
  expect((f.second as Record<string, unknown>).updatedAt).toBe(updatedAt)
  expect((f.afterGet as Record<string, unknown>).updatedAt).toBe(updatedAt)
  expect(f.rowUpdatedAtAfterFirst).toBe(f.rowUpdatedAtBefore)
  expect(f.rowUpdatedAtAfterSecond).toBe(f.rowUpdatedAtBefore)
})

dbTest('seen leaves status and settledAt alone', () => {
  const f = fact('seen')
  expect(f.rowStatusAfter).toBe('completed')
  expect(f.rowSettledAtAfter).toBe((f.first as Record<string, unknown>).settledAt)
})

dbTest('seen is idempotent', () => {
  const f = fact('seen')
  expect(f.secondStatus).toBe(200)
  expect((f.second as Record<string, unknown>).unchecked).toBe(false)
  expect((f.afterGet as Record<string, unknown>).unchecked).toBe(false)
})

dbTest('seen on an unknown id is a 404 with the error envelope', () => {
  const res = fact('seen').unknown as Http
  expect(res.status).toBe(404)
  expect(res.body.error).toEqual(expect.any(String))
})

dbTest('seen on a malformed id is a 400', () => {
  expect((fact('seen').nonUuid as Http).status).toBe(400)
})

dbTest('seen on a never-settled or a running session is fine and stays not-unchecked', () => {
  const f = fact('seen')
  expect(f.neverSettled).toEqual({ status: 200, unchecked: false, settledAt: null, seenAtSet: true })
  expect(f.running).toEqual({ status: 200, unchecked: false })
})

// --- rule 2: settledAt from the real status writers ----------------------------------

dbTest('sendMessage moving a session to queued does not set settledAt', () => {
  const f = fact('workerCompleted')
  expect(f.afterSendStatus).toBe('queued')
  expect(f.afterSendSettledAt).toBeNull()
})

dbTest('claiming a turn (-> running) does not touch settledAt', () => {
  const f = fact('workerCompleted')
  expect(f.mid).toEqual({ status: 'running', settledAt: null, unchecked: false })
  // Second turn, after a first settle: claim keeps the first settledAt as-is.
  expect(f.secondAfterSendStatus).toBe('queued')
  expect(f.secondAfterSendSettledAt).toBe(f.firstSettledAtIso)
  expect(f.mid2).toEqual({ status: 'running', settledAt: f.firstSettledAtIso, unchecked: false })
})

dbTest('runTurn -> completed sets settledAt to now and the session becomes unchecked', () => {
  const f = fact('workerCompleted')
  expect(f.status).toBe('completed')
  landedBetween(f)
  expect(f.unchecked).toBe(true)
})

dbTest('seen after settle clears it; settling again afterwards makes it unchecked again', () => {
  const f = fact('workerCompleted')
  expect(f.seenStatus).toBe(200)
  expect(f.seenUnchecked).toBe(false)
  expect(f.secondStatus).toBe('completed')
  expect(f.secondSettledAtMs as number).toBeGreaterThanOrEqual(f.secondBefore as number)
  expect(f.secondSettledAtMs as number).toBeLessThanOrEqual(f.secondAfter as number)
  expect(f.secondSettledAtMs as number).toBeGreaterThan(f.seenAtMs as number)
  expect(f.secondUnchecked).toBe(true)
})

dbTest('runTurn -> failed (the SDK stream threw) sets settledAt', () => {
  const f = fact('workerFailed')
  expect(f.status).toBe('failed')
  landedBetween(f)
  expect(f.unchecked).toBe(true)
})

dbTest('runTurn -> failed (over budget) sets settledAt', () => {
  const f = fact('workerOverBudget')
  expect(f.status).toBe('failed')
  landedBetween(f)
})

dbTest('runTurn -> interrupted sets settledAt', () => {
  const f = fact('workerInterrupted')
  expect(f.status).toBe('interrupted')
  landedBetween(f)
  expect(f.unchecked).toBe(true)
})

dbTest('runTurn draining into the next turn (-> queued) leaves the previous settledAt alone', () => {
  const f = fact('workerDrained')
  expect(f.status).toBe('queued')
  expect(f.settledAt).toBe(f.old)
  expect(f.unchecked).toBe(false)
})

dbTest('recover: continuing (-> queued) keeps settledAt; giving up (-> failed) sets it', () => {
  const f = fact('recover')
  expect(f.continued).toEqual([
    { outcome: 'continued', status: 'queued', settledAt: f.old },
    { outcome: 'continued', status: 'queued', settledAt: f.old },
    { outcome: 'continued', status: 'queued', settledAt: f.old },
  ])
  expect(f.last).toBe('gave_up')
  expect(f.status).toBe('failed')
  landedBetween(f)
})

dbTest('the stranded-turn reconciler sets settledAt when it fails a turn', () => {
  const f = fact('reconciler')
  expect(f.recovered).toBe(1)
  const s = f.stranded as Record<string, unknown>
  expect(s.status).toBe('failed')
  landedBetween({ ...s, before: f.before, after: f.after })
  expect(s.unchecked).toBe(true)
  expect(s.inOverviewUnchecked).toBe(true)
})

dbTest('...and leaves a healthy running turn (and its settledAt) alone', () => {
  const f = fact('reconciler')
  expect(f.healthy).toEqual({ status: 'running', settledAt: null })
})
