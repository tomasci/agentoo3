// Scheduled Postgres backups against a real Postgres: the scenarios run once,
// in db-backup-db-child.ts, against a database on a server this file initdb's
// into /tmp and throws away afterwards (pg-cluster.ts's startTempServer).
// The database is set up the way production's is: migrated by `bun run
// db:migrate`, not by pg-cluster.ts's psql run of the files, so it has
// drizzle's own migrations table, and so do the dumps taken of it, which is
// what README's step 3 relies on after a restore. It is marked 'guarded', as
// pg-cluster.ts's guarded database is, not 'on': disposable enough for the
// child's own guard, but the bulk-delete guard triggers from migration 0015
// are as live as in production, both in the database that is dumped and in
// the one restored over. The child takes real dumps through
// runDbBackup; this file then reads them back with pg_restore, and restores
// the newest one with the exact command README.md's "Backups" gives (as the
// superuser, --clean --if-exists --single-transaction, the file on stdin):
// into a brand-new server, and over the populated database it was taken
// from, followed there by README's step 3, `bun run db:migrate`. A dump from
// before 0014 and 0015, restored over a database that has them, is
// migrate-after-restore.test.ts's: there db:migrate has the triggers to put
// back. Nothing here can reach the deployment's own database or backups.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { DISPOSABLE_DB_SETTING, DISPOSABLE_GUARDED_VALUE } from './disposable-db-guard'
import { postgresBinDir, startTempServer, type TempServer } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const BACKUPS_DIR = `/tmp/agentoo-db-backup-test-backups-${process.pid}`
const CAPTURE_DIR = `/tmp/agentoo-db-backup-test-capture-${process.pid}`
// Characters that need percent-encoding in a URL, to prove the decode too.
const PASSWORD = `s3cr3t:p@ss/${process.pid}`

type Facts = Record<string, Record<string, unknown>>

/** Holds the source database, `guarded_test`. */
let server: TempServer | undefined
let fresh: TempServer | undefined
let facts: Facts = {}
/** Everything the child logged (warnings and errors: LOG_LEVEL 1). */
let childOutput = ''
let setupError = ''
let port = ''
/** The guarded database: dumped from, and restored over. */
let sourceUrl = ''
let seeded: Record<string, number> = {}

const bin = postgresBinDir()
const hasPostgres = Boolean(bin)

const GUARDED = ['projects', 'sessions', 'messages'] as const
/** Every trigger migration 0015 creates, read from the file itself. */
const GUARD_TRIGGERS = [
  ...readFileSync(join(BACKEND, 'src/db/migrations/0015_bulk_delete_guard.sql'), 'utf8').matchAll(
    /CREATE (?:OR REPLACE )?TRIGGER (\w+)/g,
  ),
]
  .map((m) => m[1] as string)
  .sort()
/** Every migration there is, so every one a current dump has recorded. */
const MIGRATION_COUNT = (
  JSON.parse(readFileSync(join(BACKEND, 'src/db/migrations/meta/_journal.json'), 'utf8')) as {
    entries: unknown[]
  }
).entries.length

async function counts(url: string): Promise<Record<string, number>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const out: Record<string, number> = {}
    for (const table of GUARDED) {
      const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`)
      out[table] = row?.n ?? -1
    }
    return out
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function run(
  cmd: string[],
  opts: { stdinFile?: string; cwd?: string; env?: Record<string, string> } = {},
) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    // Only PATH, and what a caller names: never this process's DATABASE_URL
    // or any PG* setting.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env },
    stdin: opts.stdinFile ? Bun.file(opts.stdinFile) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

/** README.md's restore command, as the superuser, the dump fed on stdin. */
const restore = (url: string, file: string) =>
  run(
    [
      join(bin as string, 'pg_restore'),
      '--clean',
      '--if-exists',
      '--single-transaction',
      '-d',
      url,
    ],
    { stdinFile: file },
  )

/** The guard triggers present, and whether an unscoped delete is refused. */
async function guardState(url: string): Promise<{ triggers: string[]; refused: string }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const triggers = await sql<{ tgname: string }[]>`
      select tgname from pg_trigger where not tgisinternal and tgname like '%_guard' order by 1`
    const error = await sql`delete from projects`.catch((e: Error) => e)
    return { triggers: triggers.map((t) => t.tgname), refused: String(error) }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** How many migrations drizzle's own table says were applied. */
async function migrationsApplied(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`
    return row?.n ?? -1
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (hasPostgres) {
  try {
    server = await startTempServer()
    await server.psql('postgres', ['-c', 'create database guarded_test'])
    sourceUrl = server.url('guarded_test')
    port = String(server.port)
    const migrated = await run(['bun', 'run', 'db:migrate'], {
      cwd: BACKEND,
      env: { HOME: process.env.HOME ?? '', DATABASE_URL: sourceUrl },
    })
    if (migrated.code !== 0) {
      throw new Error(`db:migrate failed (${migrated.code}): ${migrated.stdout}${migrated.stderr}`)
    }
    // After migrating, as pg-cluster.ts does: no migration runs with it set.
    await server.psql('postgres', [
      '-c',
      `alter database guarded_test set ${DISPOSABLE_DB_SETTING} = '${DISPOSABLE_GUARDED_VALUE}'`,
    ])

    // Something worth restoring: two projects, two sessions each, three
    // messages per session.
    const sql = postgres(sourceUrl, { max: 1, onnotice: () => {} })
    try {
      const projects = await sql<{ id: string }[]>`
        insert into projects (name, slug, source, status)
        values ('backup-a', 'backup-a', 'empty', 'ready'), ('backup-b', 'backup-b', 'empty', 'ready')
        returning id`
      const sessions = await sql<{ id: string }[]>`
        insert into sessions (project_id)
        select p from unnest(${projects.map((p) => p.id)}::uuid[]) p, generate_series(1, 2)
        returning id`
      await sql`
        insert into messages (session_id, seq, type, payload)
        select s, g, 'user', '{}'::jsonb
        from unnest(${sessions.map((s) => s.id)}::uuid[]) s, generate_series(1, 3) g`
    } finally {
      await sql.end({ timeout: 5 })
    }
    seeded = await counts(sourceUrl)

    // The same database, with a password in the URL: trust auth ignores it,
    // but runDbBackup still has to hand it to pg_dump, and not on argv.
    const withPassword = sourceUrl.replace(
      'postgres://tester@',
      `postgres://tester:${encodeURIComponent(PASSWORD)}@`,
    )
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/db-backup-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: withPassword,
        BACKUPS_DIR,
        BACKUP_RETENTION_COUNT: '2',
        // Deliberately dead: nothing in the child goes through the queue.
        REDIS_URL: 'redis://127.0.0.1:1',
        LOG_LEVEL: '1',
        REAL_PG_DUMP: join(bin as string, 'pg_dump'),
        CAPTURE_DIR,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    childOutput = `${stdout}\n${stderr}`
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
  await server?.stop()
  await fresh?.stop()
  await rm(BACKUPS_DIR, { recursive: true, force: true })
  await rm(CAPTURE_DIR, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

const newestBackup = (): string => {
  const files = fact<{ files: string[] }>('bootStale').files.filter((n) => n.endsWith('.dump'))
  const newest = files.sort().at(-1)
  if (!newest) throw new Error('no backup on disk')
  return join(BACKUPS_DIR, newest)
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the backup scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThanOrEqual(6)
})

// --- the dump ---------------------------------------------------------------

dbTest('a real dump is produced, named for its UTC start time, with nothing left over', () => {
  const f = fact<{
    result: { status: string; bytes: number }
    files: string[]
    name: string
    nameParses: boolean
  }>('first')
  expect(f.result.status).toBe('created')
  expect(f.result.bytes).toBeGreaterThan(1000)
  expect(f.nameParses).toBe(true)
  expect(f.files).toEqual([f.name])
})

dbTest('the dump is 0600 and its directory 0700', () => {
  const f = fact<{ fileMode: number; dirMode: number }>('first')
  expect(f.fileMode).toBe(0o600)
  expect(f.dirMode).toBe(0o700)
})

dbTest('pg_restore --list reads the dump, and it holds the app tables', async () => {
  const file = newestBackup()
  const listed = await run([join(bin as string, 'pg_restore'), '--list', file])
  expect(listed.stderr).toBe('')
  expect(listed.code).toBe(0)
  for (const table of GUARDED) expect(listed.stdout).toContain(`TABLE DATA public ${table} `)
  expect(listed.stdout).toContain('TRIGGER public projects projects_bulk_delete_guard')
  // What tells db:migrate, after a restore, which migrations the dump has.
  expect(listed.stdout).toContain('TABLE DATA drizzle __drizzle_migrations ')
})

dbTest("pg_dump's argv never contains the password; its environment does, as PGPASSWORD", () => {
  const { calls } = fact<{ calls: { cmdline: string; env: string }[] }>('spawned')
  const dumps = calls.filter((c) => c.cmdline.includes('--format=custom'))
  // first + two concurrent + the boot catch-up, plus a --version call each.
  expect(dumps.length).toBe(4)
  expect(calls.length).toBe(8)
  for (const call of calls) {
    expect(call.cmdline).not.toContain(PASSWORD)
    expect(call.cmdline).not.toContain(encodeURIComponent(PASSWORD))
    expect(call.cmdline).not.toContain('postgres://')
    expect(call.cmdline).not.toContain('tester')
    expect(call.env).toContain(`PGPASSWORD=${PASSWORD}\n`)
    expect(call.env).toContain(`PGHOST=127.0.0.1\n`)
    expect(call.env).toContain(`PGPORT=${port}\n`)
    expect(call.env).toContain('PGUSER=tester\n')
    expect(call.env).toContain('PGDATABASE=guarded_test\n')
    expect(call.env).not.toContain('DATABASE_URL=')
    expect(call.env).not.toContain('REDIS_URL=')
  }
  for (const dump of dumps) {
    const argv = dump.cmdline.split('\n').filter(Boolean).slice(2) // drop "/bin/sh <wrapper>"
    expect(argv[0]).toBe('--format=custom')
    expect(argv[1]).toBe('--no-password')
    expect(argv[2]).toMatch(/^--file=.*\/agentoo-\d{8}T\d{6}Z\.dump\.partial$/)
    expect(argv).toHaveLength(3)
  }
})

// --- concurrency, freshness, retention ----------------------------------------

dbTest('two backups started together run one after the other, never overlapping', () => {
  const f = fact<{ statuses: string[]; calls: { start: number; end: number }[] }>('concurrent')
  expect(f.statuses).toEqual(['created', 'created'])
  // The first scenario's dump, then these two.
  expect(f.calls).toHaveLength(3)
  for (let i = 1; i < f.calls.length; i++) {
    const previous = f.calls[i - 1]
    const current = f.calls[i]
    expect(previous?.end).toBeGreaterThan(0)
    expect(current?.start).toBeGreaterThanOrEqual(previous?.end ?? Number.POSITIVE_INFINITY)
  }
})

dbTest('retention keeps the newest N (2 here) once a new backup has succeeded', () => {
  const first = fact<{ name: string }>('first')
  const f = fact<{ files: string[]; deletedByLast: string[] }>('concurrent')
  expect(f.files).toHaveLength(2)
  expect(f.files).not.toContain(first.name)
  expect(f.deletedByLast).toEqual([first.name])
})

dbTest('on boot, and on the daily tick, a fresh backup on disk means no new dump', () => {
  const f = fact<{
    boot: { status: string; reason: string }
    scheduled: { status: string }
    newDumpCalls: number
  }>('freshSkips')
  expect(f.boot.status).toBe('skipped')
  expect(f.boot.reason).toContain('old')
  expect(f.scheduled.status).toBe('skipped')
  expect(f.newDumpCalls).toBe(0)
})

dbTest('a partial a crashed run left is removed by the next run, even one that then skips', () => {
  const f = fact<{
    boot: { status: string }
    orphan: string
    foreign: string
    afterBoot: string[]
  }>('freshSkips')
  expect(f.boot.status).toBe('skipped')
  expect(f.afterBoot).not.toContain(f.orphan)
  // Not one of our names: left alone.
  expect(f.afterBoot).toContain(f.foreign)
  expect(f.afterBoot.filter((n) => n.endsWith('.partial'))).toEqual([f.foreign])
  expect(childOutput).toContain(`a crashed run left behind: ${f.orphan}`)
})

for (const reason of ['scheduled', 'boot'] as const) {
  dbTest(`a backup named a year in the future does not make the ${reason} run skip: it writes a real dump`, async () => {
    const f = fact<{
      result: { status: string; bytes: number; deleted: string[] }
      future: string
      old: string[]
      files: string[]
      written: string
      header: string
      futureIntact: boolean
    }>(`skew-${reason}`)
    expect(f.result.status).toBe('created')
    expect(f.result.bytes).toBeGreaterThan(1000)
    expect(f.header).toBe('PGDMP')
    const listed = await run([
      join(bin as string, 'pg_restore'),
      '--list',
      join(CAPTURE_DIR, `skew-${reason}`, f.written),
    ])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('TABLE DATA public projects ')
    // Retention (keep 1 here) counted only the real backups: the days-old
    // ones went, the dump just taken and the future-named file stayed.
    expect(f.result.deleted.sort()).toEqual(f.old.sort())
    expect(f.files).toEqual([f.future, f.written].sort())
    expect(f.futureIntact).toBe(true)
    // And said so, naming the file and how far ahead it is.
    const warning = childOutput
      .split('\n')
      .find((line) => line.includes(`Database backup (${reason}): ${f.future} is named `))
    expect(warning).toMatch(/is named 36[45]\.\d days ahead of this host's clock/)
  })
}

dbTest('on boot, a newest backup over a day old means a new dump', () => {
  const f = fact<{ result: { status: string; deleted: string[] }; files: string[] }>('bootStale')
  expect(f.result.status).toBe('created')
  expect(f.result.deleted).toHaveLength(1)
  expect(f.files).toHaveLength(2)
})

// --- failures ---------------------------------------------------------------

dbTest('pg_dump older than the server fails with a clear message and writes nothing', () => {
  const f = fact<{ result: { status: string; kind: string; error: string }; unchanged: boolean }>(
    'tooOld',
  )
  expect(f.result.status).toBe('failed')
  expect(f.result.kind).toBe('version-mismatch')
  expect(f.result.error).toContain('pg_dump 9 is older than the PostgreSQL server')
  expect(f.result.error).toMatch(/postgresql-client-\d+/)
  expect(f.unchanged).toBe(true)
})

dbTest('a missing pg_dump is a returned failure, not a crash, and writes nothing', () => {
  const f = fact<{ result: { status: string; kind: string; error: string }; unchanged: boolean }>(
    'missing',
  )
  expect(f.result.status).toBe('failed')
  expect(f.result.kind).toBe('missing-binary')
  expect(f.unchanged).toBe(true)
})

dbTest('a disk too full for the dump: refused before pg_dump starts, loudly, and nothing written', () => {
  type Failed = { status: string; kind: string; error: string }
  const f = fact<{
    full: Failed
    empty: Failed
    newest: string
    unchanged: boolean
    emptyFiles: string[]
    newDumpCalls: number
  }>('space')
  for (const result of [f.full, f.empty]) {
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('insufficient-space')
    expect(result.error).toContain('on top of the 10.0 GiB that must stay free')
  }
  // The estimate: the newest backup on disk, or with none, the database.
  expect(f.full.error).toContain(`the size of ${f.newest}`)
  expect(f.empty.error).toContain('the size of the database itself')
  expect(f.unchanged).toBe(true)
  expect(f.emptyFiles).toEqual([])
  expect(f.newDumpCalls).toBe(0)
  expect(childOutput).toContain('DATABASE BACKUP FAILED (manual): not enough free space')
})

// --- restoring it -------------------------------------------------------------

dbTest(
  "the dump restores into a brand-new server's empty database, rows and live guard included",
  async () => {
    fresh = await startTempServer()
    await fresh.psql('postgres', ['-c', 'create database agentoo'])
    const restored = await restore(fresh.url('agentoo'), newestBackup())
    expect(restored.stderr).toBe('')
    expect(restored.code).toBe(0)
    expect(await counts(fresh.url('agentoo'))).toEqual(seeded)

    // pg_dump without --create carries no ALTER DATABASE settings, so no
    // disposable marker came along: the guard is live here.
    const guard = await guardState(fresh.url('agentoo'))
    expect(guard.triggers).toEqual(GUARD_TRIGGERS)
    expect(guard.refused).toContain('bulk-delete guard')
  },
)

dbTest(
  '--clean --if-exists over the populated database it came from, with the guard live throughout',
  async () => {
    // A change made after the backup, which the restore rolls back.
    const before = postgres(sourceUrl, { max: 1, onnotice: () => {} })
    try {
      await before`insert into projects (name, slug, source, status) values ('after-backup', 'after-backup', 'empty', 'ready')`
    } finally {
      await before.end({ timeout: 5 })
    }
    expect((await counts(sourceUrl)).projects).toBe((seeded.projects ?? 0) + 1)
    // Live before the restore: --clean has to get past it, which it does
    // because DROP TABLE fires no DELETE or TRUNCATE trigger.
    expect((await guardState(sourceUrl)).refused).toContain('bulk-delete guard')

    const restored = await restore(sourceUrl, newestBackup())
    expect(restored.stderr).toBe('')
    expect(restored.code).toBe(0)
    expect(await counts(sourceUrl)).toEqual(seeded)

    // And the triggers came back with the tables.
    const guard = await guardState(sourceUrl)
    expect(guard.triggers).toEqual(GUARD_TRIGGERS)
    expect(guard.refused).toContain('bulk-delete guard')
  },
)

dbTest(
  'then db:migrate, step 3: nothing left to apply, rows intact, the guard still live',
  async () => {
    // The dump is of the current version, so drizzle's table came back from it
    // already listing every migration.
    expect(await migrationsApplied(sourceUrl)).toBe(MIGRATION_COUNT)
    const migrated = await run(['bun', 'run', 'db:migrate'], {
      cwd: BACKEND,
      env: { HOME: process.env.HOME ?? '', DATABASE_URL: sourceUrl },
    })
    expect(migrated).toMatchObject({ code: 0 })
    expect(await migrationsApplied(sourceUrl)).toBe(MIGRATION_COUNT)
    expect(await counts(sourceUrl)).toEqual(seeded)

    const guard = await guardState(sourceUrl)
    expect(guard.triggers).toEqual(GUARD_TRIGGERS)
    expect(guard.refused).toContain('bulk-delete guard')
  },
)
