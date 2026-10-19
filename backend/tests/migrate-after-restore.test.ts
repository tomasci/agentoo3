// Migrations 0014 and 0015 can run again over a database that already has
// part of them, the way production runs them: `bun run db:migrate` as the
// non-superuser role that owns the database (scripts/68-setup-backend.sh).
//
// The case that needs it: a dump taken before 0014 restored with
// `pg_restore --clean --if-exists` (README "Backups") over a database that
// has 0014 and 0015. --clean drops and re-creates every table in the dump,
// and with them 0015's triggers and 0014's indexes, but leaves 0015's
// functions, which the dump does not know about. drizzle's migrations table
// comes back from the dump saying 0013, so the next db:migrate runs 0014 and
// 0015 again, in one transaction. With a plain CREATE FUNCTION that failed on
// "function agentoo_bulk_delete_allowed already exists" and took 0014 down
// with it.
//
// The "upgrade" is 0014 and 0015 only, by a journal that stops at 0015, however
// many migrations have been added since. That is what makes this the scenario it
// documents: a later migration that adds a table with a foreign key into
// `sessions` (0016's session_compactions) cannot be part of it, because a
// `pg_restore --clean` of a dump that does not know that table cannot drop
// `sessions` out from under it. Such a restore fails — safely, whole, under
// --single-transaction — which is why README "Backups" has the dropdb path for
// restoring over a database newer than the dump. Whatever came after 0015 is
// applied by the last db:migrate below, over the restored database, which is
// exactly where it would be applied in production.
//
// All of it on a temp server from pg-cluster.ts, with its own role and
// databases; nothing here reaches the deployment's database.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { postgresBinDir, startTempServer, type TempServer } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const MIGRATIONS = join(BACKEND, 'src/db/migrations')
const TEMP = `/tmp/agentoo-migrate-after-restore-${process.pid}`
/** Like production's: LOGIN, nothing else; it owns the databases it migrates. */
const APP_ROLE = 'agentoo_app'

interface JournalEntry {
  idx: number
  tag: string
  when: number
}
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[]
}
const BEFORE_0014 = journal.entries.filter((e) => e.idx < 14)
/** Everything up to and including the bulk-delete guard: what "the upgrade" is. */
const THROUGH_0015 = journal.entries.filter((e) => e.idx <= 15)
const LAST_MIGRATION = journal.entries.at(-1)?.tag as string

/** What 0014 and 0015 create, read from the files themselves. */
const sql0014 = readFileSync(join(MIGRATIONS, '0014_fk_cascade_indexes.sql'), 'utf8')
const sql0015 = readFileSync(join(MIGRATIONS, '0015_bulk_delete_guard.sql'), 'utf8')
const INDEXES_0014 = [...sql0014.matchAll(/CREATE INDEX (?:IF NOT EXISTS )?"(\w+)"/g)]
  .map((m) => m[1] as string)
  .sort()
const TRIGGERS_0015 = [...sql0015.matchAll(/CREATE (?:OR REPLACE )?TRIGGER (\w+)/g)]
  .map((m) => m[1] as string)
  .sort()
const FUNCTIONS_0015 = [...sql0015.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)/g)]
  .map((m) => m[1] as string)
  .sort()

interface Run {
  code: number | null
  output: string
}

interface State {
  migrations: number
  lastMigration: string
  triggers: string[]
  functions: string[]
  indexes: string[]
  rows: Record<string, number>
}

let server: TempServer | undefined
let setupError = ''
const runs: Record<string, Run> = {}
const states: Record<string, State> = {}
let seeded: Record<string, number> = {}
let unscopedDelete: string | null = null

const hasPostgres = Boolean(postgresBinDir())

async function exec(cmd: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd: BACKEND,
    // Only what each command needs: never this process's own DATABASE_URL or
    // PG* settings.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, output: `${stdout}\n${stderr}`.trim() }
}

function requireServer(): TempServer {
  if (!server) throw new Error(`no server (setupError: ${setupError})`)
  return server
}

/** `bun run db:migrate` as production runs it: as the app role, with only
 * DATABASE_URL set. `config` swaps in another drizzle config. */
function dbMigrate(database: string, config?: string): Promise<Run> {
  const s = requireServer()
  return exec(['bun', 'run', 'db:migrate', ...(config ? ['--config', config] : [])], {
    DATABASE_URL: s.url(database, APP_ROLE),
  })
}

function psqlAsApp(database: string, args: string[]): Promise<Run> {
  const s = requireServer()
  return exec([
    join(s.bin, 'psql'),
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    s.url(database, APP_ROLE),
    ...args,
  ])
}

async function stateOf(database: string): Promise<State> {
  const sql = postgres(requireServer().url(database), { max: 1, onnotice: () => {} })
  try {
    const [m] = await sql<{ n: number; last: string | null }[]>`
      select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`
    const triggers = await sql<{ name: string }[]>`
      select tgname as name from pg_trigger where not tgisinternal order by 1`
    const functions = await sql<{ name: string }[]>`
      select proname as name from pg_proc
      where pronamespace = 'public'::regnamespace and proname like 'agentoo%' order by 1`
    const indexes = await sql<{ name: string }[]>`
      select indexname as name from pg_indexes
      where schemaname = 'public' and indexname in ${sql(INDEXES_0014)} order by 1`
    const rows: Record<string, number> = {}
    for (const table of ['projects', 'sessions', 'messages']) {
      const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`)
      rows[table] = row?.n ?? -1
    }
    const lastWhen = Number(m?.last)
    return {
      migrations: m?.n ?? 0,
      lastMigration: journal.entries.find((e) => e.when === lastWhen)?.tag ?? String(m?.last),
      triggers: triggers.map((t) => t.name),
      functions: functions.map((f) => f.name),
      indexes: indexes.map((i) => i.name),
      rows,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The installer's setup (scripts/60-install-postgres.sh): a database owned by
 * the app role, which may create in public; pgvector by the superuser, when
 * this box has it, since the dump then carries it too. */
async function createAppDatabase(admin: postgres.Sql, name: string): Promise<void> {
  const s = requireServer()
  await admin.unsafe(`create database ${name} owner ${APP_ROLE}`)
  const sql = postgres(s.url(name), { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`grant all on schema public to ${APP_ROLE}`)
    const [vector] = await sql`select 1 from pg_available_extensions where name = 'vector'`
    if (vector) await sql`create extension if not exists vector`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (hasPostgres) {
  try {
    server = await startTempServer()
    const s = server
    await rm(TEMP, { recursive: true, force: true })
    await mkdir(TEMP, { recursive: true })

    const admin = postgres(s.url('postgres'), { max: 1, onnotice: () => {} })
    try {
      await admin.unsafe(`create role ${APP_ROLE} login`)
      await createAppDatabase(admin, 'agentoo')
      await createAppDatabase(admin, 'agentoo_fresh')
    } finally {
      await admin.end({ timeout: 5 })
    }

    // 1. A fresh database, every migration in one go.
    runs.fresh = await dbMigrate('agentoo_fresh')
    states.fresh = await stateOf('agentoo_fresh')
    // ...and 0014 and 0015 straight over themselves, in one transaction.
    runs.rerunInPlace = await psqlAsApp('agentoo_fresh', [
      '-1',
      '-f',
      join(MIGRATIONS, '0014_fk_cascade_indexes.sql'),
      '-f',
      join(MIGRATIONS, '0015_bulk_delete_guard.sql'),
    ])
    states.rerunInPlace = await stateOf('agentoo_fresh')

    // 2. The database as it was before 0014: migrated by drizzle-kit itself,
    // from a copy of the migrations folder whose journal stops at 0013.
    const upTo0013 = join(TEMP, 'migrations-0013')
    await mkdir(join(upTo0013, 'meta'), { recursive: true })
    for (const entry of BEFORE_0014) {
      await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(upTo0013, `${entry.tag}.sql`))
    }
    await writeFile(
      join(upTo0013, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: BEFORE_0014 }, null, 2),
    )
    const config = join(TEMP, 'drizzle-0013.config.json')
    await writeFile(
      config,
      JSON.stringify({
        dialect: 'postgresql',
        out: upTo0013,
        dbCredentials: { url: s.url('agentoo', APP_ROLE) },
      }),
    )
    runs.upTo0013 = await dbMigrate('agentoo', config)

    // The same, for the upgrade: a copy of the folder that stops at 0015.
    const upTo0015 = join(TEMP, 'migrations-0015')
    await mkdir(join(upTo0015, 'meta'), { recursive: true })
    for (const entry of THROUGH_0015) {
      await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(upTo0015, `${entry.tag}.sql`))
    }
    await writeFile(
      join(upTo0015, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: THROUGH_0015 }, null, 2),
    )
    const config0015 = join(TEMP, 'drizzle-0015.config.json')
    await writeFile(
      config0015,
      JSON.stringify({
        dialect: 'postgresql',
        out: upTo0015,
        dbCredentials: { url: s.url('agentoo', APP_ROLE) },
      }),
    )

    const app = postgres(s.url('agentoo', APP_ROLE), { max: 1, onnotice: () => {} })
    try {
      const projects = await app<{ id: string }[]>`
        insert into projects (name, slug, source, status)
        values ('restore-a', 'restore-a', 'empty', 'ready'), ('restore-b', 'restore-b', 'empty', 'ready')
        returning id`
      const sessions = await app<{ id: string }[]>`
        insert into sessions (project_id)
        select p from unnest(${projects.map((p) => p.id)}::uuid[]) p, generate_series(1, 2)
        returning id`
      await app`
        insert into messages (session_id, seq, type, payload)
        select s, g, 'user', '{}'::jsonb
        from unnest(${sessions.map((x) => x.id)}::uuid[]) s, generate_series(1, 3) g`
    } finally {
      await app.end({ timeout: 5 })
    }
    states.at0013 = await stateOf('agentoo')
    seeded = states.at0013.rows

    // 3. The backup, as the backup job takes it: as the app role.
    const dump = join(TEMP, 'pre-0014.dump')
    runs.dump = await exec([
      join(s.bin, 'pg_dump'),
      '--format=custom',
      `--file=${dump}`,
      '-d',
      s.url('agentoo', APP_ROLE),
    ])

    // 4. The upgrade that applies 0014 and 0015.
    runs.upgrade = await dbMigrate('agentoo', config0015)
    states.upgraded = await stateOf('agentoo')

    // 5. The restore, as README "Backups" has an operator run it: as the
    // superuser, --clean --if-exists --single-transaction.
    runs.restore = await exec([
      join(s.bin, 'pg_restore'),
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--exit-on-error',
      '-d',
      s.url('agentoo'),
      dump,
    ])
    states.restored = await stateOf('agentoo')

    // 6. And the db:migrate that used to fail: every migration there is, so also
    // whatever came after 0015.
    runs.after = await dbMigrate('agentoo')
    states.after = await stateOf('agentoo')

    const check = postgres(s.url('agentoo', APP_ROLE), { max: 1, onnotice: () => {} })
    try {
      unscopedDelete = await check`delete from projects`.then(
        () => null,
        (error: Error) => error.message,
      )
    } finally {
      await check.end({ timeout: 5 })
    }
    states.final = await stateOf('agentoo')
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await server?.stop()
  await rm(TEMP, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed. */
const dbTest = hasPostgres ? test : test.skip

const ok = (name: string) => expect(runs[name]).toMatchObject({ code: 0 })

const state = (name: string): State => {
  const value = states[name]
  if (!value) throw new Error(`no "${name}" state (setupError: ${setupError})`)
  return value
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the migrate-after-restore scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
})

test('what 0014 and 0015 create was read from the files', () => {
  expect(INDEXES_0014.length).toBe(7)
  expect(TRIGGERS_0015.length).toBe(12)
  expect(FUNCTIONS_0015.length).toBe(5)
  // Nothing in either file that a second run would trip over.
  for (const text of [sql0014, sql0015]) {
    const statements = text
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE (OR REPLACE (FUNCTION|TRIGGER)|INDEX IF NOT EXISTS) /)
    }
  }
})

dbTest('the role that migrates is no superuser, and owns its databases', async () => {
  const sql = postgres(requireServer().url('postgres'), { max: 1, onnotice: () => {} })
  try {
    const roles = await sql`
      select r.rolsuper, r.rolcreaterole, r.rolcreatedb, array_agg(d.datname order by d.datname) as owns
      from pg_roles r join pg_database d on d.datdba = r.oid
      where r.rolname = ${APP_ROLE} group by 1, 2, 3`
    expect(roles).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        owns: ['agentoo', 'agentoo_fresh'],
      },
    ])
  } finally {
    await sql.end({ timeout: 5 })
  }
})

dbTest('nor can it switch the guard off for its whole database, or for itself', async () => {
  // 0015's header: the app role's only way past the guard is the setting it
  // can put on its own transaction or connection. A database- or role-level
  // default of either parameter, which would hold for every connection after,
  // is the superuser's alone.
  for (const statement of [
    `alter database agentoo set agentoo.disposable_test_db = 'on'`,
    `alter database agentoo set agentoo.allow_bulk_delete = 'on'`,
    `alter role ${APP_ROLE} set agentoo.allow_bulk_delete = 'on'`,
    `alter role ${APP_ROLE} in database agentoo set agentoo.disposable_test_db = 'on'`,
  ]) {
    const result = await psqlAsApp('agentoo', ['-c', statement])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('permission denied to set parameter')
  }
})

dbTest('a fresh database migrates every migration as its non-superuser owner', () => {
  ok('fresh')
  expect(state('fresh')).toMatchObject({
    migrations: journal.entries.length,
    lastMigration: LAST_MIGRATION,
    triggers: TRIGGERS_0015,
    functions: FUNCTIONS_0015,
    indexes: INDEXES_0014,
  })
})

dbTest('0014 and 0015 run again over themselves, in one transaction, as the owner', () => {
  ok('rerunInPlace')
  expect(state('rerunInPlace')).toEqual(state('fresh'))
})

dbTest('the setup: up to 0013 by drizzle-kit, a dump, then 0014 and 0015', () => {
  ok('upTo0013')
  expect(state('at0013')).toMatchObject({
    migrations: BEFORE_0014.length,
    lastMigration: BEFORE_0014.at(-1)?.tag,
    triggers: [],
    functions: [],
    indexes: [],
  })
  expect(seeded).toEqual({ projects: 2, sessions: 4, messages: 12 })
  ok('dump')
  ok('upgrade')
  expect(state('upgraded')).toMatchObject({
    migrations: THROUGH_0015.length,
    lastMigration: '0015_bulk_delete_guard',
    triggers: TRIGGERS_0015,
    functions: FUNCTIONS_0015,
    indexes: INDEXES_0014,
  })
})

dbTest(
  'pg_restore --clean --if-exists of that dump drops the triggers and indexes, keeps the functions, and rewinds drizzle to 0013',
  () => {
    // The precondition: if a restore stopped leaving the functions behind,
    // the next test would pass without proving anything.
    ok('restore')
    expect(state('restored')).toEqual({
      migrations: BEFORE_0014.length,
      lastMigration: BEFORE_0014.at(-1)?.tag as string,
      triggers: [],
      functions: FUNCTIONS_0015,
      indexes: [],
      rows: seeded,
    })
  },
)

dbTest('db:migrate after that restore succeeds, and the triggers and indexes are back', () => {
  ok('after')
  expect(state('after')).toEqual({
    migrations: journal.entries.length,
    lastMigration: LAST_MIGRATION,
    triggers: TRIGGERS_0015,
    functions: FUNCTIONS_0015,
    indexes: INDEXES_0014,
    rows: seeded,
  })
})

dbTest('and the guard is live on the restored data', () => {
  expect(unscopedDelete).toContain(
    'bulk-delete guard: refusing to delete 2 projects in one statement',
  )
  expect(state('final').rows).toEqual(seeded)
})
