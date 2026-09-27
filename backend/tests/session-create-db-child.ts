// Runs every database-backed session-creation scenario once, against the
// throwaway cluster its parent (session-create.test.ts) started, and prints
// what happened as JSON — same shape as idea-reorder-db-child.ts, which this
// mirrors: the child gathers facts, every assertion lives in the parent.
//
// Real Postgres and a real git repo are what make "no worktree created" an
// honest assertion rather than a vacuous one: every project fixture below is
// actually a git repository with a commit, so createSession has a real branch
// it *could* cut a worktree from. A plain directory (the fixture every other
// db-child in this directory uses, since createSession merely needs
// projectRepo(slug) to exist) would make that check pass for free — isGitRepo
// would already be false, so no worktree was ever going to be attempted,
// orchestrator or not.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

// --- fakes, registered before anything imports the modules that use them ---

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

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { projects, sessions } = await import('@/db/schema')
const { createSession } = await import('@/features/sessions/service')
const { dirExists, git } = await import('@/lib/git')
const { projectRepo, projectRoot } = await import('@/lib/paths')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { sessionsRouter } = await import('@/features/sessions/routes')

// Mounted exactly the way app.ts mounts it for real (createApp() itself is
// not booted here — same reasoning as ideas-routes-db-child.ts's own comment):
// a real route, the real OpenAPI validation hook, and a real database.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', sessionsRouter)

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

/** A real, non-bare git repo with one commit on `main` — see this file's own
 * header for why a plain directory would not do. */
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

const worktreesDirExists = async (slug: string) => dirExists(`${projectRoot(slug)}/worktrees`)

const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]

const postJson = (path: string, body: unknown) =>
  app.request(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const patchJson = (path: string, body: unknown) =>
  app.request(`/api${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

async function main() {
  // --- HTTP: orchestrator missing entirely leaves nothing behind -------------
  {
    const project = await newProject('missing')
    const res = await postJson(`/projects/${project.id}/sessions`, { title: 'no orchestrator' })
    const body = (await res.json()) as { error?: string; issues?: { path: string }[] }
    facts.httpMissing = {
      status: res.status,
      error: body.error,
      issuePaths: body.issues?.map((i) => i.path),
      rowCount: await sessionCount(project.id),
      worktreesDirCreated: await worktreesDirExists(project.slug),
    }
  }

  // --- HTTP: orchestrator "" is the same as missing it ------------------------
  {
    const project = await newProject('blank')
    const res = await postJson(`/projects/${project.id}/sessions`, { orchestrator: '' })
    const body = (await res.json()) as { error?: string }
    facts.httpBlank = {
      status: res.status,
      error: body.error,
      rowCount: await sessionCount(project.id),
      worktreesDirCreated: await worktreesDirExists(project.slug),
    }
  }

  // --- HTTP: a real orchestrator creates the session and persists it ---------
  {
    const project = await newProject('valid')
    const res = await postJson(`/projects/${project.id}/sessions`, {
      title: 'has an orchestrator',
      orchestrator: 'coder',
    })
    const body = (await res.json()) as {
      id: string
      orchestrator?: string | null
      isolated?: boolean
    }
    const row = body.id ? await sessionRow(body.id) : undefined
    facts.httpValid = {
      status: res.status,
      orchestratorInResponse: body.orchestrator,
      orchestratorInRow: row?.orchestrator,
      isolated: body.isolated,
      worktreePathSet: Boolean(row?.worktreePath),
    }
  }

  // --- service-level guard: an internal caller that skips zod entirely -------
  //
  // createSessionSchema already refuses this at the HTTP boundary; this
  // exercises createSession's own guard directly (decision 2 in the brief),
  // the way features/ideas/handoff.ts's resolveSession calls it — a caller
  // that never goes through the schema at all.
  {
    const project = await newProject('service-guard')
    let threw = ''
    try {
      await createSession(project.id, { orchestrator: '' })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    facts.serviceGuard = {
      threw,
      rowCount: await sessionCount(project.id),
      worktreesDirCreated: await worktreesDirExists(project.slug),
    }
  }

  // --- PATCH: clearing the orchestrator is refused ----------------------------
  {
    const project = await newProject('patch-clear')
    const created = await createSession(project.id, { orchestrator: 'coder' })
    const res = await patchJson(`/sessions/${created.id}`, { orchestrator: null })
    const row = await sessionRow(created.id)
    facts.patchClear = {
      status: res.status,
      orchestratorAfter: row?.orchestrator,
    }
  }

  // --- PATCH: swapping to another orchestrator still works --------------------
  {
    const project = await newProject('patch-swap')
    const created = await createSession(project.id, { orchestrator: 'coder' })
    const res = await patchJson(`/sessions/${created.id}`, { orchestrator: 'reviewer' })
    const body = (await res.json()) as { orchestrator?: string | null }
    const row = await sessionRow(created.id)
    facts.patchSwap = {
      status: res.status,
      orchestratorInResponse: body.orchestrator,
      orchestratorInRow: row?.orchestrator,
    }
  }

  // --- PATCH: whitespace-only is refused exactly like null --------------------
  //
  // zod's bare min(1) let "   " through (length 3), so without the schema's
  // own .trim() this would have been a 200 that quietly gave the session an
  // orchestrator sendMessage's `!session.orchestrator` guard treats as set.
  {
    const project = await newProject('patch-whitespace')
    const created = await createSession(project.id, { orchestrator: 'coder' })
    const res = await patchJson(`/sessions/${created.id}`, { orchestrator: '   ' })
    const row = await sessionRow(created.id)
    facts.patchWhitespace = {
      status: res.status,
      orchestratorAfter: row?.orchestrator,
    }
  }

  // --- create: surrounding whitespace is trimmed before it is persisted -------
  {
    const project = await newProject('create-trimmed')
    const res = await postJson(`/projects/${project.id}/sessions`, { orchestrator: '  lead  ' })
    const body = (await res.json()) as { id: string; orchestrator?: string | null }
    const row = body.id ? await sessionRow(body.id) : undefined
    facts.createTrimmed = {
      status: res.status,
      orchestratorInResponse: body.orchestrator,
      orchestratorInRow: row?.orchestrator,
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
