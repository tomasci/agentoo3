// Gathers facts for session-orchestrator-gaps.test.ts, against the throwaway
// cluster its parent started — same shape as session-create-db-child.ts: the
// child gathers facts, every assertion lives in the parent.
//
// Covers what session-create*.ts does not:
//   - a whitespace-only orchestrator ("   ", "\t\n "), which zod's min(1)
//     lets through, so only createSession's own trim guard can refuse it;
//   - a JSON null orchestrator;
//   - createSession called directly with the field missing or whitespace-only;
//   - a positive control on the very same kind of project, proving the
//     "no worktree" facts can actually come out true (a git repo with a
//     commit, where a valid create *does* make `worktrees/` and registers a
//     second worktree with git);
//   - a legacy session row inserted straight into the DB with
//     orchestrator NULL: list, GET, DELETE still work; sending a message 400s
//     naming the orchestrator and records nothing; PATCHing an orchestrator
//     onto it recovers it.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
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

// sendMessage's success path publishes; Redis is not running here.
mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { messages, projects, sessions } = await import('@/db/schema')
const { createSession } = await import('@/features/sessions/service')
const { dirExists, git } = await import('@/lib/git')
const { projectRepo, projectRoot } = await import('@/lib/paths')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { sessionsRouter } = await import('@/features/sessions/routes')

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', sessionsRouter)

const facts: Record<string, unknown> = {}

/** A real git repo with one commit — so a valid create really does cut a worktree. */
async function newProject(name: string): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  const repo = projectRepo(slug)
  const init = await git(['init', '-q', '-b', 'main', repo])
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  const commit = await git(
    ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'first'],
    repo,
  )
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
  return { id: row.id, slug }
}

const sessionCount = async (projectId: string) =>
  (await db.select().from(sessions).where(eq(sessions.projectId, projectId))).length

/** What git itself thinks: 1 = only the main checkout. */
const gitWorktreeCount = async (slug: string) => {
  const r = await git(['worktree', 'list', '--porcelain'], projectRepo(slug))
  if (!r.ok) throw new Error(`git worktree list failed: ${r.stderr}`)
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length
}

const nothingLeft = async (p: { id: string; slug: string }) => ({
  rowCount: await sessionCount(p.id),
  worktreesDirCreated: await dirExists(`${projectRoot(p.slug)}/worktrees`),
  gitWorktrees: await gitWorktreeCount(p.slug),
})

const request = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const readJson = async (res: Response): Promise<Record<string, unknown>> => {
  const text = await res.text()
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return { raw: text }
  }
}

async function main() {
  // --- HTTP create with orchestrators zod's min(1) does not catch ----------
  for (const [key, orchestrator] of [
    ['httpSpaces', '   '],
    ['httpTabsNewlines', '\t\n '],
    ['httpNull', null],
  ] as const) {
    const project = await newProject(key.toLowerCase())
    const res = await request('POST', `/projects/${project.id}/sessions`, {
      title: 'nope',
      orchestrator,
    })
    const body = await readJson(res)
    facts[key] = {
      status: res.status,
      bodyText: JSON.stringify(body),
      ...(await nothingLeft(project)),
    }
  }

  // --- positive control: same fixture, valid orchestrator ------------------
  {
    const project = await newProject('control')
    const before = await nothingLeft(project)
    const res = await request('POST', `/projects/${project.id}/sessions`, {
      orchestrator: 'coder',
    })
    const body = await readJson(res)
    facts.httpControl = {
      status: res.status,
      orchestrator: body.orchestrator,
      before,
      after: await nothingLeft(project),
    }
  }

  // --- createSession directly: missing / whitespace-only -------------------
  for (const [key, input] of [
    ['serviceMissing', {}],
    ['serviceSpaces', { orchestrator: '   ' }],
  ] as const) {
    const project = await newProject(key.toLowerCase())
    let threw = ''
    let status: unknown
    try {
      // Deliberately bypassing the type: this is the internal caller that
      // never went through zod.
      await createSession(project.id, input as unknown as { orchestrator: string })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
      status = (error as { status?: unknown }).status
    }
    facts[key] = { threw, status, ...(await nothingLeft(project)) }
  }

  // --- a legacy row with orchestrator NULL ---------------------------------
  {
    const project = await newProject('legacy')
    const [legacy] = await db
      .insert(sessions)
      .values({ projectId: project.id, title: 'legacy', orchestrator: null, status: 'idle' })
      .returning()
    if (!legacy) throw new Error('no legacy row')

    const list = await request('GET', `/projects/${project.id}/sessions`)
    const listBody = (await readJson(list)) as unknown as { id: string; orchestrator: unknown }[]
    const listed = Array.isArray(listBody) ? listBody.find((s) => s.id === legacy.id) : undefined

    const get = await request('GET', `/sessions/${legacy.id}`)
    const getBody = await readJson(get)

    const seqBefore = legacy.nextSeq
    const send = await request('POST', `/sessions/${legacy.id}/messages`, { text: 'hello' })
    const sendBody = await readJson(send)
    const [afterSend] = await db.select().from(sessions).where(eq(sessions.id, legacy.id))
    const messageRows = await db.select().from(messages).where(eq(messages.sessionId, legacy.id))

    facts.legacyRead = {
      listStatus: list.status,
      listedOrchestrator: listed ? listed.orchestrator : 'NOT LISTED',
      getStatus: get.status,
      getOrchestrator: getBody.orchestrator,
      getId: getBody.id,
    }
    facts.legacySend = {
      status: send.status,
      error: sendBody.error,
      messageRows: messageRows.length,
      nextSeqUnchanged: afterSend?.nextSeq === seqBefore,
      statusAfter: afterSend?.status,
    }

    const del = await request('DELETE', `/sessions/${legacy.id}`)
    const [gone] = await db.select().from(sessions).where(eq(sessions.id, legacy.id))
    const getAfter = await request('GET', `/sessions/${legacy.id}`)
    facts.legacyDelete = {
      status: del.status,
      rowGone: gone === undefined,
      getAfterStatus: getAfter.status,
    }
  }

  // --- a legacy row can be recovered by PATCHing an orchestrator onto it ---
  {
    const project = await newProject('legacy-fix')
    const [legacy] = await db
      .insert(sessions)
      .values({ projectId: project.id, title: 'legacy', orchestrator: null, status: 'idle' })
      .returning()
    if (!legacy) throw new Error('no legacy row')
    const patch = await request('PATCH', `/sessions/${legacy.id}`, { orchestrator: 'coder' })
    const patchBody = await readJson(patch)
    const send = await request('POST', `/sessions/${legacy.id}/messages`, { text: 'hello' })
    const messageRows = await db.select().from(messages).where(eq(messages.sessionId, legacy.id))
    facts.legacyRecover = {
      patchStatus: patch.status,
      patchOrchestrator: patchBody.orchestrator,
      sendStatus: send.status,
      messageRows: messageRows.length,
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
