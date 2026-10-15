// The database-level guard against bulk wipes (migration 0015) and the FK
// indexes that keep a legitimate project delete fast (migration 0014),
// against a real Postgres from pg-cluster.ts.
//
// Two databases in the same temp cluster, with the same schema:
// - `marked`: the cluster's main database, marked agentoo.disposable_test_db
//   = 'on', so the guard steps aside, as it does for every other test file's
//   resets.
// - `guarded`: pg-cluster.ts's guarded database, marked 'guarded' instead.
//   Still a throwaway database (a DB child may run against it), but the guard
//   triggers honour only 'on', so they are live here, as in production.
// The triggers read the marker from the database's own settings, not from
// the connection, so there is no per-connection way to switch between the
// two; that is tested below too.
//
// The app's own delete paths (deleteProject, deleteSession, deleteIdea,
// deleteAutomation, the attachments cleanup's single-row delete, an unscoped
// db.delete on each guarded table through the app's client) run in
// bulk-delete-guard-db-child.ts against `guarded`; see its header.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import postgres from 'postgres'
import { DISPOSABLE_DB_SETTING } from './disposable-db-guard'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP = `/tmp/agentoo-bulk-delete-guard-test-${process.pid}`

/** Every table the guard sits on. */
const GUARDED = [
  'projects',
  'sessions',
  'messages',
  'session_files',
  'ideas',
  'automations',
] as const
type Counts = Record<(typeof GUARDED)[number], number>

let cluster: Cluster | undefined
let guardedUrl = ''
let marked: postgres.Sql | undefined
let guarded: postgres.Sql | undefined
let childFacts: Record<string, Record<string, unknown>> = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'), { guardedDatabase: true })
    if (!cluster.guardedConnectionString) throw new Error('no guarded database')
    guardedUrl = cluster.guardedConnectionString
    marked = postgres(cluster.connectionString, { max: 2, onnotice: () => {} })
    guarded = postgres(guardedUrl, { max: 2, onnotice: () => {} })

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/bulk-delete-guard-db-child.ts')], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: guardedUrl,
        // Never dialled: the child fakes ioredis and bullmq.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: `${TEMP}/projects`,
        ATTACHMENTS_DIR: `${TEMP}/attachments`,
        LIBRARY_DIR: `${TEMP}/library`,
        BACKUPS_DIR: `${TEMP}/backups`,
        DOCKER_ENABLED: 'false',
        EDITOR_ENABLED: 'false',
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
    const at = stdout.indexOf('__FACTS__')
    if (code !== 0 || at === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      childFacts = JSON.parse(stdout.slice(at + '__FACTS__'.length).trim())
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await marked?.end({ timeout: 5 })
  await guarded?.end({ timeout: 5 })
  await cluster?.stop()
  await Bun.$`rm -rf ${TEMP}`.quiet().nothrow()
})

/** Skipped, loudly, only when the box has no Postgres server installed. */
const dbTest = hasPostgres ? test : test.skip

const db = (which: 'marked' | 'guarded'): postgres.Sql => {
  const sql = which === 'marked' ? marked : guarded
  if (!sql) throw new Error(`no ${which} connection (setupError: ${setupError})`)
  return sql
}

const fact = (key: string): Record<string, unknown> => {
  const value = childFacts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value
}

/** A pool of its own, for tests that leave state on a connection. */
async function withPool<T>(url: string, run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

interface Seeded {
  projects: string[]
  sessions: string[]
}

/** Two projects, each with two sessions of three messages and two
 * attachments, two ideas and two automations, on a fresh slug prefix so tests
 * never depend on one another's rows. */
async function seed(prefix: string, which: 'marked' | 'guarded' = 'guarded'): Promise<Seeded> {
  const sql = db(which)
  const projects = await sql<{ id: string }[]>`
    insert into projects (name, slug, source, status)
    values (${`${prefix}-a`}, ${`${prefix}-a`}, 'empty', 'ready'),
           (${`${prefix}-b`}, ${`${prefix}-b`}, 'empty', 'ready')
    returning id`
  const ids = projects.map((p) => p.id)
  const sessions = await sql<{ id: string }[]>`
    insert into sessions (project_id)
    select p from unnest(${ids}::uuid[]) p, generate_series(1, 2)
    returning id`
  const sessionIds = sessions.map((s) => s.id)
  await sql`
    insert into messages (session_id, seq, type, payload)
    select s, g, 'user', '{}'::jsonb from unnest(${sessionIds}::uuid[]) s,
      generate_series(1, 3) g`
  await sql`
    insert into session_files (session_id, original_filename, stored_name, mime_type, size_bytes, checksum)
    select s, 'f' || g, 'x-f' || g, 'text/plain', 1, 'c' || g
    from unnest(${sessionIds}::uuid[]) s, generate_series(1, 2) g`
  await sql`
    insert into ideas (project_id, title, board_position)
    select p, 'idea ' || g, g from unnest(${ids}::uuid[]) p, generate_series(1, 2) g`
  await sql`
    insert into automations (project_id, name, prompt, cron, timezone, orchestrator)
    select p, 'automation ' || g, 'p', '0 3 * * *', 'UTC', 'orchestrator'
    from unnest(${ids}::uuid[]) p, generate_series(1, 2) g`
  return { projects: ids, sessions: sessionIds }
}

async function counts(which: 'marked' | 'guarded' = 'guarded'): Promise<Counts> {
  const [row] = await db(which)<Counts[]>`
    select (select count(*)::int from projects) as projects,
           (select count(*)::int from sessions) as sessions,
           (select count(*)::int from messages) as messages,
           (select count(*)::int from session_files) as session_files,
           (select count(*)::int from ideas) as ideas,
           (select count(*)::int from automations) as automations`
  if (!row) throw new Error('no counts')
  return row
}

/** `before`, less what deleting one seeded project's worth removes. */
function lessProjects(before: Counts, n: number): Counts {
  return {
    projects: before.projects - n,
    sessions: before.sessions - 2 * n,
    messages: before.messages - 6 * n,
    session_files: before.session_files - 4 * n,
    ideas: before.ideas - 2 * n,
    automations: before.automations - 2 * n,
  }
}

/** The statement's error message, or null when it succeeded. */
async function failureOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the bulk-delete guard scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
})

dbTest('the guarded database has the guard live, the marked one has it off', async () => {
  const settings = await db('marked')<{ datname: string; setconfig: string[] }[]>`
    select d.datname, s.setconfig
    from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
    where s.setrole = 0 order by 1`
  expect(settings).toEqual([
    { datname: 'attachments_test', setconfig: [`${DISPOSABLE_DB_SETTING}=on`] },
    { datname: 'guarded_test', setconfig: [`${DISPOSABLE_DB_SETTING}=guarded`] },
  ])
  const [m] = await db('marked')`select public.agentoo_bulk_delete_allowed() as allowed`
  const [g] = await db('guarded')`select public.agentoo_bulk_delete_allowed() as allowed`
  expect(m?.allowed).toBe(true)
  expect(g?.allowed).toBe(false)
  // The child's own pool, on the guarded database.
  expect(fact('connection')).toEqual({ allowed: false, setting: 'guarded' })
})

// --- the app's own delete paths, guard live ----------------------------------

const FULL = {
  projects: 1,
  sessions: 4,
  messages: 20_000,
  continuations: 4 * 500,
  sessionFiles: 8,
  ideas: 2,
  ideaRunsLinked: 1,
  automations: 2,
  automationRunsLinked: 1,
  messageFiles: 1,
}

dbTest(
  "unscoped deletes through the app's own client are refused on every guarded table, and delete nothing",
  () => {
    const f = fact('unscoped') as {
      errors: Record<string, string | null>
      victim: Record<string, number>
      bystander: Record<string, number>
    }
    expect(f.errors.projects).toContain(
      'bulk-delete guard: refusing to delete 2 projects in one statement',
    )
    expect(f.errors.sessions).toContain(
      'refusing to delete sessions of 2 projects in one statement',
    )
    expect(f.errors.messages).toContain(
      'refusing to delete messages of 8 sessions in one statement',
    )
    expect(f.errors.sessionFiles).toContain(
      'refusing to delete session_files of 8 sessions in one statement',
    )
    expect(f.errors.ideas).toContain('refusing to delete ideas of 2 projects in one statement')
    expect(f.errors.automations).toContain(
      'refusing to delete automations of 2 projects in one statement',
    )
    expect(f.victim).toEqual(FULL)
    expect(f.bystander).toEqual(FULL)
  },
)

dbTest(
  'deleteProject deletes one project of 20k messages, its files, ideas and automations, and cascades fully',
  () => {
    const f = fact('deleteProject') as {
      before: Record<string, Record<string, number>>
      victim: Record<string, number>
      bystander: Record<string, number>
    }
    expect(f.before.victim).toEqual(FULL)
    expect(f.before.bystander).toEqual(FULL)
    expect(f.victim).toEqual(Object.fromEntries(Object.keys(FULL).map((k) => [k, 0])))
    expect(f.bystander).toEqual(FULL)
  },
)

dbTest('deleteProject on 20k messages takes well under the minutes it took unindexed', () => {
  // About half a second on the dev box; the same delete against migrations
  // 0000-0013 (no index behind messages.continues_message_id) took 166s.
  // The bound is loose on purpose: it is here to catch a missing index, not
  // to benchmark.
  const { ms } = fact('deleteProject') as { ms: number }
  console.log(`deleteProject, 20k messages over 4 sessions: ${ms}ms`)
  expect(ms).toBeLessThan(15_000)
})

dbTest(
  "the app's single-row deletes still work: deleteIdea, deleteAutomation, one session_files row",
  () => {
    const f = fact('singleRow') as {
      errors: Record<string, string | null>
      remaining: Record<string, string>
      before: Record<string, number>
      after: Record<string, number>
    }
    expect(f.errors).toEqual({ deleteIdea: null, deleteAutomation: null, deleteAnomalyById: null })
    expect(f.remaining).toEqual({ idea: '0', automation: '0', sessionFile: '0' })
    expect(f.before).toEqual(FULL)
    expect(f.after).toEqual({
      ...FULL,
      ideas: FULL.ideas - 1,
      automations: FULL.automations - 1,
      sessionFiles: FULL.sessionFiles - 1,
    })
  },
)

dbTest('deleteSession deletes one session, its messages and its files', () => {
  const f = fact('deleteSession') as {
    remaining: Record<string, string>
    bystander: Record<string, number>
  }
  expect(f.remaining).toEqual({ session: '0', messages: '0', sessionFiles: '0' })
  expect(f.bystander.sessions).toBe(3)
  expect(f.bystander.messages).toBe(15_000)
  // 8, less the one the single-row test above deleted, less this session's 2.
  expect(f.bystander.sessionFiles).toBe(5)
})

// --- statements a person or a script might type, guard live ------------------

dbTest('an unscoped delete from projects raises and deletes nothing', async () => {
  await seed('unscoped')
  const before = await counts()
  expect(before.projects).toBeGreaterThanOrEqual(2)
  const error = await failureOf(() => db('guarded')`delete from projects`)
  expect(error).toContain('bulk-delete guard: refusing to delete')
  expect(await counts()).toEqual(before)
})

dbTest('a delete of two named projects raises too', async () => {
  const { projects } = await seed('two-named')
  const before = await counts()
  const error = await failureOf(
    () => db('guarded')`delete from projects where id in ${db('guarded')(projects)}`,
  )
  expect(error).toContain('refusing to delete 2 projects in one statement')
  expect(await counts()).toEqual(before)
})

for (const table of ['sessions', 'ideas', 'automations'] as const) {
  dbTest(`${table}: one project at a time is allowed, across projects is not`, async () => {
    const { projects } = await seed(`per-project-${table}`)
    const before = await counts()
    for (const statement of [
      `delete from ${table}`,
      `delete from ${table} where project_id in ('${projects[0]}', '${projects[1]}')`,
    ]) {
      const across = await failureOf(() => db('guarded').unsafe(statement))
      expect(across).toContain(`refusing to delete ${table} of`)
      expect(await counts()).toEqual(before)
    }

    const one = await failureOf(() =>
      db('guarded').unsafe(`delete from ${table} where project_id = $1`, [projects[0] as string]),
    )
    expect(one).toBeNull()
    const after = await counts()
    expect(after[table]).toBe(before[table] - 2)
    if (table === 'sessions') {
      expect(after.messages).toBe(before.messages - 6)
      expect(after.session_files).toBe(before.session_files - 4)
    }
  })
}

for (const table of ['messages', 'session_files'] as const) {
  dbTest(`${table}: one session at a time is allowed, across sessions is not`, async () => {
    const { sessions } = await seed(`per-session-${table}`)
    const before = await counts()
    const sameRowOfEach = table === 'messages' ? 'seq = 1' : "checksum = 'c1'"
    for (const statement of [
      `delete from ${table}`,
      `delete from ${table} where ${sameRowOfEach}`,
    ]) {
      const across = await failureOf(() => db('guarded').unsafe(statement))
      expect(across).toContain(`refusing to delete ${table} of`)
      expect(await counts()).toEqual(before)
    }

    const one = await failureOf(() =>
      db('guarded').unsafe(`delete from ${table} where session_id = $1`, [sessions[0] as string]),
    )
    expect(one).toBeNull()
    expect((await counts())[table]).toBe(before[table] - (table === 'messages' ? 3 : 2))
  })
}

dbTest(
  'deleting one project cascades over several sessions in one statement, and is allowed',
  async () => {
    // The case the messages and session_files triggers' "session still
    // exists" rule is for: Postgres collects the rows of every session this
    // one statement's cascade deletes into a single transition table, so a
    // plain "more than one session_id" rule would refuse every project with
    // two sessions.
    const { projects } = await seed('cascade')
    const before = await counts()
    const error = await failureOf(
      () => db('guarded')`delete from projects where id = ${projects[0] as string}`,
    )
    expect(error).toBeNull()
    expect(await counts()).toEqual(lessProjects(before, 1))
  },
)

dbTest('TRUNCATE of any guarded table raises, CASCADE or not', async () => {
  await seed('truncate')
  const before = await counts()
  for (const statement of [
    'truncate projects cascade',
    'truncate sessions cascade',
    'truncate messages cascade',
    'truncate session_files cascade',
    'truncate ideas cascade',
    'truncate automations cascade',
    // No CASCADE: every table referencing the guarded one named instead.
    'truncate messages, message_files, idea_runs, automation_runs',
    'truncate session_files, message_files',
    'truncate automations, automation_runs',
  ]) {
    const error = await failureOf(() => db('guarded').unsafe(statement))
    expect(error).toContain('bulk-delete guard: refusing to TRUNCATE')
  }
  expect(await counts()).toEqual(before)
})

// --- the one escape hatch: agentoo.allow_bulk_delete --------------------------

dbTest(
  "the escape hatch: SET LOCAL agentoo.allow_bulk_delete = 'on' for one transaction",
  async () => {
    const { projects, sessions } = await seed('escape')
    const before = await counts()
    const deleted = await db('guarded').begin(async (tx) => {
      await tx`set local agentoo.allow_bulk_delete = 'on'`
      // Across parents on every guarded table, each refused without the hatch.
      const out: Record<string, number> = {}
      out.messages = (
        await tx`delete from messages where session_id in ${tx(sessions)} and seq = 1`
      ).count
      out.session_files = (
        await tx`delete from session_files where session_id in ${tx(sessions)} and checksum = 'c1'`
      ).count
      out.ideas = (
        await tx`delete from ideas where project_id in ${tx(projects)} and board_position = 1`
      ).count
      out.automations = (
        await tx`delete from automations where project_id in ${tx(projects)} and name = 'automation 1'`
      ).count
      out.projects = (await tx`delete from projects where id in ${tx(projects)}`).count
      return out
    })
    expect(deleted).toEqual({
      messages: 4,
      session_files: 4,
      ideas: 2,
      automations: 2,
      projects: 2,
    })
    expect(await counts()).toEqual(lessProjects(before, 2))

    // SET LOCAL ended with that transaction, so the next statement on the very
    // same pool is guarded again.
    const { projects: next } = await seed('escape-after')
    const error = await failureOf(
      () => db('guarded')`delete from projects where id in ${db('guarded')(next)}`,
    )
    expect(error).toContain('refusing to delete 2 projects in one statement')
  },
)

dbTest('the escape hatch lets a deliberate TRUNCATE through too', async () => {
  // Inside a transaction that is then rolled back, so the other tests' rows
  // survive it.
  await seed('escape-truncate')
  const before = await counts()
  const error = await failureOf(() =>
    db('guarded').begin(async (tx) => {
      await tx`set local agentoo.allow_bulk_delete = 'on'`
      await tx`truncate projects cascade`
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from projects`
      if (row?.n !== 0) throw new Error(`truncate left ${row?.n} projects`)
      throw new Error('roll back')
    }),
  )
  expect(error).toBe('roll back')
  expect(await counts()).toEqual(before)
})

dbTest(
  'a plain SET (not LOCAL) of allow_bulk_delete outlives its transaction: the whole connection is unguarded',
  async () => {
    // Why the migration says SET LOCAL: a plain SET holds for the rest of the
    // connection, so on a pool it is still on for whatever runs on that
    // connection next.
    await withPool(guardedUrl, async (sql) => {
      await sql`set agentoo.allow_bulk_delete = 'on'`
      const { projects } = await seed('plain-set')
      const before = await counts()
      const later = await failureOf(() => sql`delete from projects where id in ${sql(projects)}`)
      expect(later).toBeNull()
      expect(await counts()).toEqual(lessProjects(before, 2))

      await sql`reset agentoo.allow_bulk_delete`
      const { projects: next } = await seed('plain-set-after')
      const error = await failureOf(() => sql`delete from projects where id in ${sql(next)}`)
      expect(error).toContain('refusing to delete 2 projects in one statement')
    })
  },
)

// --- the disposable marker: the database's, never the connection's ------------

dbTest('a connection cannot fake the disposable marker on a database without it', async () => {
  const { projects } = await seed('fake-marker')
  const before = await counts()
  const refused = (error: string | null) =>
    expect(error).toContain('refusing to delete 2 projects in one statement')
  const victims = (sql: postgres.Sql) => sql`delete from projects where id in ${sql(projects)}`

  // SET LOCAL, in a transaction.
  refused(
    await failureOf(() =>
      db('guarded').begin(async (tx) => {
        await tx.unsafe(`set local ${DISPOSABLE_DB_SETTING} = 'on'`)
        await victims(tx)
      }),
    ),
  )
  // A plain SET, for the session.
  await withPool(guardedUrl, async (sql) => {
    await sql.unsafe(`set ${DISPOSABLE_DB_SETTING} = 'on'`)
    refused(await failureOf(() => victims(sql)))
  })
  // A startup parameter, as `?agentoo.disposable_test_db=on` in a URL sends.
  await withPool(`${guardedUrl}?${DISPOSABLE_DB_SETTING}=on`, async (sql) => {
    const [row] = await sql`select current_setting(${DISPOSABLE_DB_SETTING}, true) as v`
    expect(row?.v).toBe('on')
    refused(await failureOf(() => victims(sql)))
  })
  // A role's setting in this database: in pg_db_role_setting, but not the
  // database's own (setrole = 0) row.
  await db('guarded').unsafe(
    `alter role current_user in database guarded_test set ${DISPOSABLE_DB_SETTING} = 'on'`,
  )
  try {
    await withPool(guardedUrl, async (sql) => {
      refused(await failureOf(() => victims(sql)))
    })
  } finally {
    await db('guarded').unsafe(
      `alter role current_user in database guarded_test reset ${DISPOSABLE_DB_SETTING}`,
    )
  }
  expect(await counts()).toEqual(before)
})

dbTest('nor switch the guard back on in a marked database', async () => {
  // Which is why a test that wants the guard live uses the guarded database.
  const { projects } = await seed('marked-off', 'marked')
  const before = await counts('marked')
  await withPool(`${cluster?.connectionString}?${DISPOSABLE_DB_SETTING}=off`, async (sql) => {
    expect(await failureOf(() => sql`delete from projects where id in ${sql(projects)}`)).toBeNull()
  })
  expect(await counts('marked')).toEqual(lessProjects(before, 2))
})

dbTest(
  'ALTER DATABASE SET of the marker takes effect at once, on open connections too',
  async () => {
    const { projects } = await seed('alter-database')
    const before = await counts()
    await withPool(guardedUrl, async (sql) => {
      // Opened, and guarded, before the change.
      const [row] = await sql`select public.agentoo_bulk_delete_allowed() as allowed`
      expect(row?.allowed).toBe(false)
      await db('marked').unsafe(`alter database guarded_test set ${DISPOSABLE_DB_SETTING} = 'on'`)
      try {
        expect(
          await failureOf(() => sql`delete from projects where id in ${sql(projects)}`),
        ).toBeNull()
      } finally {
        await db('marked').unsafe(
          `alter database guarded_test set ${DISPOSABLE_DB_SETTING} = 'guarded'`,
        )
      }
      const [after] = await sql`select public.agentoo_bulk_delete_allowed() as allowed`
      expect(after?.allowed).toBe(false)
    })
    expect(await counts()).toEqual(lessProjects(before, 2))
  },
)

dbTest(
  'the disposable-test marker lets the suite reset with unscoped deletes and TRUNCATE',
  async () => {
    await seed('marker', 'marked')
    const sql = db('marked')
    // The shapes the DB children's own resets use.
    for (const table of [
      'session_files',
      'messages',
      'ideas',
      'automations',
      'sessions',
      'projects',
    ]) {
      expect(await failureOf(() => sql.unsafe(`delete from ${table}`))).toBeNull()
    }
    const empty = Object.fromEntries(GUARDED.map((t) => [t, 0]))
    expect(await counts('marked')).toEqual(empty)

    await seed('marker-truncate', 'marked')
    expect(await failureOf(() => sql`truncate projects cascade`)).toBeNull()
    expect(await counts('marked')).toEqual(empty)
  },
)

// --- the triggers themselves ----------------------------------------------------

dbTest('the guard sits on exactly the six tables, for DELETE and for TRUNCATE', async () => {
  const triggers = await db('guarded')<
    { table: string; name: string; fn: string; enabled: string }[]
  >`
    select t.tgrelid::regclass::text as table, t.tgname as name, p.proname as fn,
           t.tgenabled as enabled
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and p.proname like 'agentoo%'
    order by 1, 2`
  expect(triggers).toEqual([
    {
      table: 'automations',
      name: 'automations_bulk_delete_guard',
      fn: 'agentoo_guard_delete_per_project',
      enabled: 'O',
    },
    {
      table: 'automations',
      name: 'automations_truncate_guard',
      fn: 'agentoo_guard_truncate',
      enabled: 'O',
    },
    {
      table: 'ideas',
      name: 'ideas_bulk_delete_guard',
      fn: 'agentoo_guard_delete_per_project',
      enabled: 'O',
    },
    { table: 'ideas', name: 'ideas_truncate_guard', fn: 'agentoo_guard_truncate', enabled: 'O' },
    {
      table: 'messages',
      name: 'messages_bulk_delete_guard',
      fn: 'agentoo_guard_delete_per_session',
      enabled: 'O',
    },
    {
      table: 'messages',
      name: 'messages_truncate_guard',
      fn: 'agentoo_guard_truncate',
      enabled: 'O',
    },
    {
      table: 'projects',
      name: 'projects_bulk_delete_guard',
      fn: 'agentoo_guard_projects_delete',
      enabled: 'O',
    },
    {
      table: 'projects',
      name: 'projects_truncate_guard',
      fn: 'agentoo_guard_truncate',
      enabled: 'O',
    },
    {
      table: 'session_files',
      name: 'session_files_bulk_delete_guard',
      fn: 'agentoo_guard_delete_per_session',
      enabled: 'O',
    },
    {
      table: 'session_files',
      name: 'session_files_truncate_guard',
      fn: 'agentoo_guard_truncate',
      enabled: 'O',
    },
    {
      table: 'sessions',
      name: 'sessions_bulk_delete_guard',
      fn: 'agentoo_guard_delete_per_project',
      enabled: 'O',
    },
    {
      table: 'sessions',
      name: 'sessions_truncate_guard',
      fn: 'agentoo_guard_truncate',
      enabled: 'O',
    },
  ])
})

// --- indexes ------------------------------------------------------------------

dbTest('every ON DELETE foreign key has an index leading with its column', async () => {
  // Each ON DELETE CASCADE / SET NULL runs one `where <fk> = $1` per deleted
  // parent row. Without an index that is a full scan per row, which is what
  // made the production wipe take hours (messages.continues_message_id).
  //
  // The exceptions are tables that stay tiny, on parents the app deletes one
  // at a time if at all: projects.ssh_key_id (one row per project; ssh keys
  // are deleted one by one by hand), library_suggestions.run_id (learning
  // runs are never deleted), library_item_versions.suggestion_id (only a
  // rejected suggestion, which has no versions, is ever deleted).
  const unindexed = await db('marked')<{ fk: string }[]>`
    select c.conrelid::regclass::text || '.' || a.attname as fk
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.connamespace = 'public'::regnamespace
      and c.confdeltype in ('c', 'n', 'd')
      and not exists (
        select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
      )
    order by 1`
  expect(unindexed.map((r) => r.fk)).toEqual([
    'library_item_versions.suggestion_id',
    'library_suggestions.run_id',
    'projects.ssh_key_id',
  ])
})
