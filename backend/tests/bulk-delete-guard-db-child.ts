// The app's own delete paths against the bulk-delete guard from migration
// 0015, on a real Postgres. Run by bulk-delete-guard.test.ts, never directly;
// the child/parent split is the usual one (`@/env` parses DATABASE_URL once,
// at first import).
//
// The parent hands this child its temp cluster's guarded database
// (pg-cluster.ts, guardedDatabase): marked agentoo.disposable_test_db =
// 'guarded', which assertDisposableTestDb accepts, so the child may run at
// all, but which the guard triggers do not step aside for. Every connection
// the app's own pool opens therefore gets production's behaviour: the guard
// is live for everything below.
//
// What it proves:
// - the incident's statement, an unscoped delete through the app's own
//   client, and the same on every other guarded table (sessions, messages,
//   session_files, ideas, automations), is refused and deletes nothing.
// - deleteProject on one project with 4 sessions, 20k messages, 8 attachments,
//   2 ideas and 2 automations succeeds, cascades fully, leaves a second
//   project untouched, and is fast (the FK indexes from migration 0014). The
//   messages and session_files triggers see all four sessions in one
//   statement here, which is the case their "still exists" rule is for.
// - the app's single-row deletes still work: deleteIdea, deleteAutomation,
//   and the attachments cleanup's delete of one session_files row
//   (deleteAnomalyById on a dangling_row).
// - deleteSession on one session with 5k messages and 2 attachments succeeds.

import { mock } from 'bun:test'
import { assertDisposableTestDb } from './disposable-db-guard'

// Before anything below can reach DATABASE_URL: refuse to run unless it is a
// throwaway cluster from pg-cluster.ts (see disposable-db-guard.ts).
await assertDisposableTestDb()

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job' }
    }
    async upsertJobScheduler() {}
    async setGlobalConcurrency() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
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

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {},
  }),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const { sql } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { automations, ideas, messages, projects, sessionFiles, sessions } = await import(
  '@/db/schema'
)
const { deleteProject } = await import('@/features/projects/service')
const { deleteSession } = await import('@/features/sessions/service')
const { deleteIdea } = await import('@/features/ideas/service')
const { deleteAutomation } = await import('@/features/automations/service')
const { deleteAnomalyById } = await import('@/features/attachments/service')

const SESSIONS_PER_PROJECT = 4
const MESSAGES_PER_SESSION = 5_000
const FILES_PER_SESSION = 2

type Row = Record<string, unknown>

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[]
}

async function one<T extends Row>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await rows<T>(query)
  if (!row) throw new Error('query returned no row')
  return row
}

/** The statement's error, with the trigger's own message (drizzle wraps the
 * driver's error and puts it on `cause`), or null when it succeeded. */
async function failureOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    return [error, cause]
      .filter(Boolean)
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join(' | ')
  }
}

/** One project with SESSIONS_PER_PROJECT sessions of MESSAGES_PER_SESSION
 * messages and FILES_PER_SESSION attachments each, two ideas and two
 * automations, shaped like real history: every tenth message is an
 * auto-continuation of the one before it (messages.continues_message_id), an
 * idea run and an automation run each point at one of its messages, and one
 * message links an attachment. Those are the ON DELETE SET NULL foreign keys
 * that, unindexed, turned the production wipe into a four-hour statement. */
async function seedProject(slug: string): Promise<string> {
  const { id } = await one<{ id: string }>(sql`
    insert into projects (name, slug, source, status)
    values (${slug}, ${slug}, 'empty', 'ready') returning id`)
  await db.execute(sql`
    insert into sessions (project_id, status)
    select ${id}, 'completed' from generate_series(1, ${SESSIONS_PER_PROJECT})`)
  await db.execute(sql`
    insert into messages (session_id, seq, type, payload)
    select s.id, g, 'assistant', jsonb_build_object('text', repeat(md5(g::text), 8))
    from sessions s, generate_series(1, ${MESSAGES_PER_SESSION}) g
    where s.project_id = ${id}`)
  await db.execute(sql`
    update messages m set continues_message_id = prev.id
    from messages prev, sessions s
    where s.project_id = ${id} and m.session_id = s.id and prev.session_id = m.session_id
      and prev.seq = m.seq - 1 and m.seq % 10 = 0`)
  await db.execute(sql`
    insert into session_files (session_id, original_filename, stored_name, mime_type, size_bytes, checksum)
    select s.id, 'f' || g || '.txt', 'x-f' || g || '.txt', 'text/plain', 1, 'c' || g
    from sessions s, generate_series(1, ${FILES_PER_SESSION}) g
    where s.project_id = ${id}`)
  const { sessionId, messageId } = await one<{ sessionId: string; messageId: string }>(sql`
    select m.session_id as "sessionId", m.id as "messageId"
    from messages m join sessions s on s.id = m.session_id
    where s.project_id = ${id} order by m.seq, m.session_id limit 1`)
  const { ideaId } = await one<{ ideaId: string }>(sql`
    insert into ideas (project_id, title, board_position, session_id)
    values (${id}, 'idea', 1, ${sessionId}) returning id as "ideaId"`)
  await db.execute(sql`
    insert into ideas (project_id, title, board_position) values (${id}, 'spare', 2)`)
  await db.execute(sql`
    insert into idea_runs (idea_id, kind, session_id, prompt_message_id)
    values (${ideaId}, 'initial', ${sessionId}, ${messageId})`)
  const { automationId } = await one<{ automationId: string }>(sql`
    insert into automations (project_id, name, prompt, cron, timezone, orchestrator)
    values (${id}, 'nightly', 'p', '0 3 * * *', 'UTC', 'orchestrator') returning id as "automationId"`)
  await db.execute(sql`
    insert into automations (project_id, name, prompt, cron, timezone, orchestrator)
    values (${id}, 'spare', 'p', '0 4 * * *', 'UTC', 'orchestrator')`)
  await db.execute(sql`
    insert into automation_runs (automation_id, session_id, prompt_message_id, scheduled_for, prompt)
    values (${automationId}, ${sessionId}, ${messageId}, now(), 'p')`)
  const { fileId } = await one<{ fileId: string }>(sql`
    select id as "fileId" from session_files where session_id = ${sessionId}
    order by checksum limit 1`)
  await db.execute(sql`
    insert into message_files (message_id, file_id, original_filename)
    values (${messageId}, ${fileId}, 'f1.txt')`)
  return id
}

/** Everything that hangs off one project, by table. */
async function footprint(projectId: string): Promise<Record<string, number>> {
  const row = await one<Record<string, string>>(sql`
    select
      (select count(*) from projects where id = ${projectId}) as projects,
      (select count(*) from sessions where project_id = ${projectId}) as sessions,
      (select count(*) from messages m join sessions s on s.id = m.session_id
        where s.project_id = ${projectId}) as messages,
      (select count(*) from messages m join sessions s on s.id = m.session_id
        where s.project_id = ${projectId} and m.continues_message_id is not null) as continuations,
      (select count(*) from session_files f join sessions s on s.id = f.session_id
        where s.project_id = ${projectId}) as "sessionFiles",
      (select count(*) from ideas where project_id = ${projectId}) as ideas,
      (select count(*) from idea_runs r join ideas i on i.id = r.idea_id
        where i.project_id = ${projectId} and r.prompt_message_id is not null) as "ideaRunsLinked",
      (select count(*) from automations where project_id = ${projectId}) as automations,
      (select count(*) from automation_runs r join automations a on a.id = r.automation_id
        where a.project_id = ${projectId} and r.prompt_message_id is not null) as "automationRunsLinked",
      (select count(*) from message_files f join messages m on m.id = f.message_id
        join sessions s on s.id = m.session_id where s.project_id = ${projectId}) as "messageFiles"`)
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
}

const facts: Record<string, unknown> = {}

try {
  facts.connection = await one<{ allowed: boolean; setting: string | null }>(sql`
    select public.agentoo_bulk_delete_allowed() as allowed,
           current_setting('agentoo.disposable_test_db', true) as setting`)

  const victim = await seedProject('victim')
  const bystander = await seedProject('bystander')
  const before = { victim: await footprint(victim), bystander: await footprint(bystander) }

  // The incident's statement, and its equivalent on every other guarded
  // table, through the app's own client.
  const unscoped: Record<string, string | null> = {}
  unscoped.projects = await failureOf(() => db.delete(projects))
  unscoped.sessions = await failureOf(() => db.delete(sessions))
  unscoped.messages = await failureOf(() => db.delete(messages))
  unscoped.sessionFiles = await failureOf(() => db.delete(sessionFiles))
  unscoped.ideas = await failureOf(() => db.delete(ideas))
  unscoped.automations = await failureOf(() => db.delete(automations))
  facts.unscoped = {
    errors: unscoped,
    victim: await footprint(victim),
    bystander: await footprint(bystander),
  }

  const started = performance.now()
  await deleteProject(victim, false)
  const deleteProjectMs = Math.round(performance.now() - started)
  facts.deleteProject = {
    ms: deleteProjectMs,
    before,
    victim: await footprint(victim),
    bystander: await footprint(bystander),
  }

  // The app's single-row deletes on the guarded tables that have them.
  const { spareIdea } = await one<{ spareIdea: string }>(sql`
    select id as "spareIdea" from ideas where project_id = ${bystander} and title = 'spare'`)
  const { spareAutomation } = await one<{ spareAutomation: string }>(sql`
    select id as "spareAutomation" from automations where project_id = ${bystander} and name = 'spare'`)
  // A session_files row whose blob is not on disk (none are, here) is what
  // the attachments check records as a dangling_row; deleting that anomaly
  // deletes the one row, by id.
  const { danglingFile, danglingSession } = await one<{
    danglingFile: string
    danglingSession: string
  }>(sql`
    select f.id as "danglingFile", f.session_id as "danglingSession"
    from session_files f join sessions s on s.id = f.session_id
    where s.project_id = ${bystander}
      and not exists (select 1 from message_files mf where mf.file_id = f.id)
    order by f.id limit 1`)
  const { anomalyId } = await one<{ anomalyId: string }>(sql`
    insert into storage_anomalies (class, session_id, file_id, detail)
    values ('dangling_row', ${danglingSession}, ${danglingFile}, 'blob missing')
    returning id as "anomalyId"`)
  const singleBefore = await footprint(bystander)
  const errors = {
    deleteIdea: await failureOf(() => deleteIdea(spareIdea)),
    deleteAutomation: await failureOf(() => deleteAutomation(spareAutomation)),
    deleteAnomalyById: await failureOf(async () => {
      const result = await deleteAnomalyById(anomalyId)
      if (result.outcome !== 'deleted') {
        throw new Error(`outcome ${result.outcome}: ${result.error ?? ''}`)
      }
    }),
  }
  facts.singleRow = {
    errors,
    remaining: await one<Record<string, string>>(sql`
      select
        (select count(*) from ideas where id = ${spareIdea}) as idea,
        (select count(*) from automations where id = ${spareAutomation}) as automation,
        (select count(*) from session_files where id = ${danglingFile}) as "sessionFile"`),
    before: singleBefore,
    after: await footprint(bystander),
  }

  const { sessionId } = await one<{ sessionId: string }>(sql`
    select id as "sessionId" from sessions where project_id = ${bystander}
      and id <> ${danglingSession}
    order by id limit 1`)
  const sessionStarted = performance.now()
  await deleteSession(sessionId)
  facts.deleteSession = {
    ms: Math.round(performance.now() - sessionStarted),
    remaining: await one<Record<string, string>>(sql`
      select
        (select count(*) from sessions where id = ${sessionId}) as session,
        (select count(*) from messages where session_id = ${sessionId}) as messages,
        (select count(*) from session_files where session_id = ${sessionId}) as "sessionFiles"`),
    bystander: await footprint(bystander),
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
} catch (error) {
  console.log(`__ERROR__${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
} finally {
  await closeDb()
}
