// Every child that connects to Postgres refuses to run against a database
// that is not one of pg-cluster.ts's disposable test clusters, and touches
// nothing on the way out. See disposable-db-guard.ts for why.
//
// The proof is the real thing: a temp cluster seeded with rows, its
// disposable marker stripped (so it looks like any real database), then every
// tests/*-child.ts except the few in NOT_DB_CHILDREN spawned against it the
// way a person or an agent would run one by hand. Each must exit with the
// guard's own status and message, and every table must read back exactly as
// seeded. A new child that forgets the guard fails here, unless it is added
// to NOT_DB_CHILDREN with a reason.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  DISPOSABLE_DB_SETTING,
  DISPOSABLE_GUARDED_VALUE,
  DISPOSABLE_VALUE,
  REFUSAL_EXIT_CODE,
  REFUSAL_MESSAGE,
} from './disposable-db-guard'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TESTS = join(BACKEND, 'tests')
const TEMP = `/tmp/agentoo-disposable-db-guard-test-${process.pid}`

/** Children that never open a Postgres connection, and why each is safe to
 * run by hand without the guard. Every other *-child.ts must refuse. */
const NOT_DB_CHILDREN: Record<string, string> = {
  'env-files-materialize-child.ts': 'never imports @/db/client; only materializes files on disk',
  'env-files-materialize-edges-child.ts':
    'never imports @/db/client; only materializes files on disk',
  'learning-queue-bullmq-child.ts': 'BullMQ against a temp redis-server; never imports @/db/client',
  'learning-schedule-worker-db-child.ts':
    'replaces @/db/client with mock.module before anything imports the real one',
  'plugin-atomicity-child.ts': 'replaces @/db/client with mock.module before anything imports it',
  'runner-options-env-child.ts':
    'fakes every service optionsFor reads through, as runner-options-mcp-child.ts does',
  'runner-options-mcp-child.ts': 'fakes every service optionsFor reads through; no @/db/client',
  'runner-options-turn-mode-child.ts':
    'fakes every service optionsFor reads through, as runner-options-mcp-child.ts does',
  'system-ports-verify-child.ts':
    'imports setup-env.ts first, which overwrites DATABASE_URL with an unreachable dummy',
}

const children = readdirSync(TESTS)
  .filter((name) => name.endsWith('-child.ts'))
  .sort()
const dbChildren = children.filter((name) => !(name in NOT_DB_CHILDREN))

let cluster: Cluster | undefined
let setupError = ''
let unmarkedUrl = ''
let seeded: Record<string, string> = {}

const hasPostgres = Boolean(postgresBinDir())

/** md5 of every row of every table in public, keyed by table: any insert,
 * update or delete by a child would change one of them. */
async function tableDigests(url: string): Promise<Record<string, string>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const tables = await sql<{ name: string }[]>`
      select tablename as name from pg_tables where schemaname = 'public' order by 1`
    const out: Record<string, string> = {}
    for (const { name } of tables) {
      const [row] = await sql.unsafe<{ digest: string | null; n: number }[]>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest,
                count(*)::int as n
         from public."${name}" t`,
      )
      out[name] = `${row?.n}:${row?.digest}`
    }
    return out
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const sql = postgres(cluster.connectionString, { max: 1, onnotice: () => {} })
    try {
      // A bit of everything the children's own resets and fixtures touch.
      const projects = await sql<{ id: string }[]>`
        insert into projects (name, slug, source, status)
        values ('keep-a', 'keep-a', 'empty', 'ready'), ('keep-b', 'keep-b', 'empty', 'ready')
        returning id`
      const sessions = await sql<{ id: string }[]>`
        insert into sessions (project_id)
        select p from unnest(${projects.map((p) => p.id)}::uuid[]) p, generate_series(1, 2)
        returning id`
      await sql`
        insert into messages (session_id, seq, type, payload)
        select s, g, 'user', '{}'::jsonb
        from unnest(${sessions.map((s) => s.id)}::uuid[]) s, generate_series(1, 3) g`
      await sql`
        insert into system_settings (key, value)
        values ('max_concurrent_sessions', '3'::jsonb), ('notifications_read_through', '"2026-01-01"'::jsonb)`
      await sql`
        insert into library_suggestions (kind, action, name, title, rationale, proposed)
        values ('agent', 'create', 'keep', 'keep', 'keep', '{}'::jsonb)`

      // Strip the marker: from here on this is just a database.
      await sql.unsafe(`alter database attachments_test reset ${DISPOSABLE_DB_SETTING}`)
    } finally {
      await sql.end({ timeout: 5 })
    }
    unmarkedUrl = cluster.connectionString
    seeded = await tableDigests(unmarkedUrl)
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await Bun.$`rm -rf ${TEMP}`.quiet().nothrow()
})

const dbTest = hasPostgres ? test : test.skip

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a script the way someone would by hand, with DATABASE_URL set. */
async function runWith(args: string[], databaseUrl: string | undefined): Promise<Run> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    // Whatever else `@/env` insists on, so a child gets as far as its guard.
    REDIS_URL: 'redis://127.0.0.1:1',
    PROJECTS_DIR: `${TEMP}/projects`,
    ATTACHMENTS_DIR: `${TEMP}/attachments`,
    LIBRARY_DIR: `${TEMP}/library`,
    CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
    DOCKER_ENABLED: 'false',
    EDITOR_ENABLED: 'false',
    LOG_LEVEL: '1',
  }
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl
  const proc = Bun.spawn(['bun', ...args], { cwd: BACKEND, env, stdout: 'pipe', stderr: 'pipe' })
  const killer = setTimeout(() => proc.kill('SIGKILL'), 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stdout, stderr }
}

const GUARD = join(TESTS, 'disposable-db-guard.ts')
const probe = (url: string | undefined) =>
  runWith(
    [
      '-e',
      `const { assertDisposableTestDb } = await import(${JSON.stringify(GUARD)}); ` +
        "await assertDisposableTestDb(); console.log('guard passed')",
    ],
    url,
  )

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the DB-child guard scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
})

test('NOT_DB_CHILDREN names only children that exist', () => {
  expect(Object.keys(NOT_DB_CHILDREN).filter((name) => !children.includes(name))).toEqual([])
})

dbTest(
  'every DB child refuses a database without the marker, and changes nothing',
  async () => {
    expect(dbChildren.length).toBeGreaterThanOrEqual(30)
    const results: { child: string; code: number | null; refused: boolean; tail: string }[] = []
    const queue = [...dbChildren]
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let child = queue.shift(); child; child = queue.shift()) {
          const run = await runWith([join(TESTS, child)], unmarkedUrl)
          results.push({
            child,
            code: run.code,
            refused: run.code === REFUSAL_EXIT_CODE && run.stderr.includes(REFUSAL_MESSAGE),
            tail: (run.stderr || run.stdout).slice(-600),
          })
        }
      }),
    )
    expect(results.filter((r) => !r.refused)).toEqual([])
    expect(results.length).toBe(dbChildren.length)
    expect(await tableDigests(unmarkedUrl)).toEqual(seeded)
  },
  300_000,
)

/** A new empty database in the cluster, marked with `value` (or not at all). */
async function databaseMarked(name: string, value: string | undefined): Promise<string> {
  if (!cluster) throw new Error(setupError)
  const admin = postgres(cluster.connectionString, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database ${name}`)
    if (value !== undefined) {
      await admin.unsafe(`alter database ${name} set ${DISPOSABLE_DB_SETTING} = '${value}'`)
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
  return unmarkedUrl.replace(/\/attachments_test$/, `/${name}`)
}

dbTest("the guard passes a database marked 'on'", async () => {
  const run = await probe(await databaseMarked('guard_marked', DISPOSABLE_VALUE))
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('guard passed')
})

dbTest(
  "the guard passes a database marked 'guarded' (pg-cluster.ts's guarded database)",
  async () => {
    const run = await probe(await databaseMarked('guard_guarded', DISPOSABLE_GUARDED_VALUE))
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('guard passed')
  },
)

dbTest('the guard refuses a database marked with any other value', async () => {
  const run = await probe(await databaseMarked('guard_off', 'off'))
  expect(run.code).toBe(REFUSAL_EXIT_CODE)
  expect(run.stderr).toContain(REFUSAL_MESSAGE)
})

dbTest('a connection cannot fake the marker with a startup parameter', async () => {
  // current_setting() would say 'on' on this connection; the guard reads the
  // database's own setting instead.
  const run = await probe(`${unmarkedUrl}?${DISPOSABLE_DB_SETTING}=on`)
  expect(run.code).toBe(REFUSAL_EXIT_CODE)
  expect(run.stderr).toContain(REFUSAL_MESSAGE)
})

test('the guard refuses when DATABASE_URL is unset or unreachable', async () => {
  const unset = await probe(undefined)
  expect(unset.code).toBe(REFUSAL_EXIT_CODE)
  expect(unset.stderr).toContain(`${REFUSAL_MESSAGE} (DATABASE_URL is not set)`)

  const unreachable = await probe('postgres://nobody@127.0.0.1:1/nothing')
  expect(unreachable.code).toBe(REFUSAL_EXIT_CODE)
  expect(unreachable.stderr).toContain(`${REFUSAL_MESSAGE} (could not check 127.0.0.1:1/nothing`)
})
