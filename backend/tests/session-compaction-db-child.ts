// Runs every database-backed compaction scenario once, against the throwaway
// cluster its parent (session-compaction.test.ts) started, and prints what
// happened as JSON — the same child/parent split as session-create-db-child.ts:
// the child gathers facts, every assertion lives in the parent.
//
// Real: Postgres, the migrations, the sessions router with the real validation
// hook, createSession on real git repositories (so "cut from the source's
// branch" and "the new branch is gone" are checked against git itself), and
// runSessionCompaction. Faked: the SDK, BullMQ, ioredis and the event bus —
// nothing here reaches Anthropic or Redis — and the summarizer, which is
// injected through runSessionCompaction's own `deps` seam.
//
// What the central scenarios snapshot is the SOURCE session, every column and
// every message, with `xmin`: an UPDATE that wrote the same values back would
// still change it, so "untouched" means no write at all, not no visible change.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { assertDisposableTestDb } from './disposable-db-guard'

// Before anything below can reach DATABASE_URL: refuse to run unless it is a
// throwaway cluster from pg-cluster.ts (see disposable-db-guard.ts).
await assertDisposableTestDb()

// --- fakes, registered before anything imports the modules that use them ---

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {})(),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

/** Every job added to any queue, and a switch for one queue's add() failing. */
const enqueued: { queue: string; name: string; data: unknown }[] = []
let failCompactionEnqueue = false

mock.module('bullmq', () => ({
  Queue: class {
    constructor(readonly name: string) {}
    async add(name: string, data: unknown) {
      if (failCompactionEnqueue && this.name === 'session-compaction') {
        throw new Error('Connection is closed.')
      }
      enqueued.push({ queue: this.name, name, data })
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

const B = new URL('../src', import.meta.url).pathname

/** What was published, so "the context message was announced" is checkable. */
const published: { sessionId: string; kind: string; seq?: number; type?: string }[] = []
const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async (event: {
    sessionId: string
    kind: string
    seq?: number
    message?: { type: string }
  }) => {
    published.push({
      sessionId: event.sessionId,
      kind: event.kind,
      seq: event.seq,
      type: event.message?.type,
    })
  },
  subscribeControl: () => () => {},
}))

const { eq, sql } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { messageFiles, messages, projects, sessionCompactions, sessionFiles, sessions } = await import(
  '@/db/schema'
)
const { runSessionCompaction } = await import('@/features/sessions/compaction')
const { createSession, listSessions, sendMessage } = await import(
  '@/features/sessions/service'
)
const { git } = await import('@/lib/git')
const { projectRepo, projectRoot } = await import('@/lib/paths')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { sessionsRouter } = await import('@/features/sessions/routes')

// Mounted the way app.ts mounts it for real, minus the rest of the app.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', sessionsRouter)

const facts: Record<string, unknown> = {}

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms)

// --- fixtures ----------------------------------------------------------------

/** A project whose repo is a real git repository with one commit on `main`,
 * or (with `git: false`) a plain directory, which makes sessions share it. */
async function newProject(name: string, opts: { git?: boolean; status?: 'ready' | 'cloning' } = {}) {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: opts.status ?? 'ready' })
    .returning()
  if (!row) throw new Error('no project row')

  const repo = projectRepo(slug)
  if (opts.git === false) {
    await mkdir(repo, { recursive: true })
  } else {
    const init = await git(['init', '-q', '-b', 'main', repo])
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
    const commit = await commitIn(repo, ['--allow-empty', '-qm', 'first'])
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
  }
  return { id: row.id, slug }
}

const commitIn = (cwd: string, args: string[]) =>
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', ...args], cwd)

/**
 * A finished session with a conversation, every column that a stray write could
 * disturb set to something non-default: a title, a budget, a spent cost, a
 * settled-and-seen pair, an SDK id, and a few messages. On a git project it has
 * its own worktree and branch, with one commit on that branch that `main` does
 * not have.
 */
async function newSource(project: { id: string; slug: string }, title = 'Source work') {
  const created = await createSession(project.id, {
    title,
    orchestrator: 'coder',
    maxBudgetUsd: 7,
  })
  if (created.worktreePath) {
    await writeFile(join(created.worktreePath, 'work.txt'), 'work from the source session\n')
    const add = await git(['add', 'work.txt'], created.worktreePath)
    if (!add.ok) throw new Error(`git add failed: ${add.stderr}`)
    const commit = await commitIn(created.worktreePath, ['-qm', 'source work'])
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
  }
  await db
    .update(sessions)
    .set({
      sdkSessionId: `sdk-${created.id}`,
      totalCostUsd: 1.25,
      nextSeq: 3,
      status: 'completed',
      seenAt: ago(5 * MIN),
      settledAt: ago(6 * MIN),
      lastError: 'earlier hiccup',
    })
    .where(eq(sessions.id, created.id))
  const inserted = await db.insert(messages).values([
    { sessionId: created.id, seq: 0, type: 'prompt', payload: { text: 'add the thing' } },
    {
      sessionId: created.id,
      seq: 1,
      type: 'assistant',
      title: 'orchestrator: on it',
      payload: { message: { content: [{ type: 'text', text: 'on it' }] } },
    },
    { sessionId: created.id, seq: 2, type: 'result', payload: { result: 'done', is_error: false } },
  ]).returning()
  // An attachment on the source, and its link to the prompt that carried it:
  // rows keyed to the source outside `sessions` and `messages`, which a stray
  // cascade or cleanup would be the thing to disturb.
  const prompt = inserted.find((m) => m.seq === 0)
  const [file] = await db
    .insert(sessionFiles)
    .values({
      sessionId: created.id,
      originalFilename: 'spec.md',
      storedName: `${randomUUID()}.md`,
      mimeType: 'text/markdown',
      sizeBytes: 12,
      checksum: randomUUID(),
      lineCount: 1,
      announcedSeq: 0,
    })
    .returning()
  if (!prompt || !file) throw new Error('no source prompt or file row')
  await db
    .insert(messageFiles)
    .values({ messageId: prompt.id, fileId: file.id, originalFilename: 'spec.md' })
  const row = await sessionRow(created.id)
  if (!row) throw new Error('no source row')
  return row
}

const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]

const compactionRow = async (id: string) =>
  (await db.select().from(sessionCompactions).where(eq(sessionCompactions.id, id)).limit(1))[0]

const projectSessionIds = async (projectId: string) =>
  (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId)))
    .map((r) => r.id)
    .sort()

/**
 * Every column of the session row, of each of its messages, of each of its
 * session_files and of each message_files link to those messages, all with
 * xmin; plus the git state the source owns on disk — its branch tip, its
 * worktree's HEAD and its uncommitted state — which a cleanup that guessed the
 * wrong branch or worktree would be what changes.
 */
async function snapshot(sessionId: string) {
  const s = await db.execute(
    sql`select xmin::text as xmin, to_jsonb(s) as row from sessions s where s.id = ${sessionId}`,
  )
  const m = await db.execute(
    sql`select xmin::text as xmin, to_jsonb(m) as row from messages m where m.session_id = ${sessionId} order by m.seq`,
  )
  const f = await db.execute(
    sql`select xmin::text as xmin, to_jsonb(f) as row from session_files f where f.session_id = ${sessionId} order by f.id`,
  )
  const l = await db.execute(
    sql`select l.xmin::text as xmin, to_jsonb(l) as row from message_files l join messages m on m.id = l.message_id where m.session_id = ${sessionId} order by l.id`,
  )
  const row = await sessionRow(sessionId)
  const repo = row ? projectRepo((await projectOf(row.projectId)).slug) : null
  const branchTip =
    row?.branch && repo
      ? (await git(['rev-parse', '--verify', '-q', `refs/heads/${row.branch}`], repo)).stdout
      : null
  const worktree = row?.worktreePath
    ? {
        exists: await Bun.file(join(row.worktreePath, '.git')).exists(),
        head: (await git(['rev-parse', 'HEAD'], row.worktreePath)).stdout,
        status: (await git(['status', '--porcelain'], row.worktreePath)).stdout,
      }
    : null
  return {
    session: Array.from(s),
    messages: Array.from(m),
    files: Array.from(f),
    messageFiles: Array.from(l),
    git: { branchTip, worktree },
  }
}

const projectOf = async (id: string) => {
  const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!p) throw new Error(`no project ${id}`)
  return p
}

/** The source as the project's sessions list shows it (messageCount,
 * lastMessageAt, updatedAt and the rest), plus the order of every session. */
const listed = async (projectId: string, sessionId: string) => {
  const all = await listSessions(projectId)
  return { dto: all.find((x) => x.id === sessionId), order: all.map((x) => x.id) }
}

const branchesOf = async (slug: string) =>
  (await git(['branch', '--list', 'agentoo/*', '--format=%(refname:short)'], projectRepo(slug))).stdout
    .split('\n')
    .filter(Boolean)
    .sort()

const worktreesOf = async (slug: string) =>
  (await readdir(join(projectRoot(slug), 'worktrees')).catch(() => [] as string[])).sort()

async function http(method: string, path: string) {
  const res = await app.request(`/api${path}`, { method })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body: body as Record<string, unknown> }
}

/** A summarizer that always succeeds, remembering what it was asked. */
const summarizeCalls: string[] = []
const succeeding = (
  over: { summary?: string; costUsd?: number; method?: 'sdk_compact' | 'transcript_summary' } = {},
) => ({
  summarize: async (source: { id: string }) => {
    summarizeCalls.push(source.id)
    return {
      ok: true as const,
      method: over.method ?? ('sdk_compact' as const),
      summary: over.summary ?? 'SUMMARY TEXT',
      costUsd: over.costUsd ?? 0.4321,
    }
  },
})
const failing = (reason: string, costUsd: number) => ({
  summarize: async (source: { id: string }) => {
    summarizeCalls.push(source.id)
    return { ok: false as const, reason, costUsd }
  },
})

async function main() {
  // --- the whole happy path, and what must stay untouched ------------------------
  {
    const project = await newProject('happy')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    const listedBefore = await listed(project.id, source.id)
    const sourceHead = (await git(['rev-parse', 'HEAD'], source.worktreePath as string)).stdout

    enqueued.length = 0
    const created = await http('POST', `/sessions/${source.id}/compactions`)
    const compactionId = created.body.id as string
    const enqueuedForIt = enqueued.filter((j) => j.queue === 'session-compaction')
    const afterCreate = await snapshot(source.id)

    summarizeCalls.length = 0
    await runSessionCompaction(compactionId, succeeding())
    const afterRun = await snapshot(source.id)

    const polled = await http('GET', `/sessions/${source.id}/compactions/${compactionId}`)
    const row = await compactionRow(compactionId)
    const ids = await projectSessionIds(project.id)
    const newId = row?.resultSessionId ?? ''
    const newSession = newId ? await sessionRow(newId) : undefined
    const newMessages = newId
      ? await db.select().from(messages).where(eq(messages.sessionId, newId)).orderBy(messages.seq)
      : []
    const newHead = newSession?.worktreePath
      ? (await git(['rev-parse', 'HEAD'], newSession.worktreePath)).stdout
      : null
    const carriedFile = newSession?.worktreePath
      ? await Bun.file(join(newSession.worktreePath, 'work.txt')).text()
      : null

    // A duplicate delivery of the same job must change nothing and spend nothing.
    const callsBeforeRedelivery = summarizeCalls.length
    await runSessionCompaction(compactionId, succeeding({ summary: 'SECOND', costUsd: 9 }))
    const afterRedelivery = await compactionRow(compactionId)

    // The first prompt in the new session must land at seq 1, not collide with
    // the context row at seq 0.
    let firstPromptSeq: number | string = -1
    if (newId) {
      try {
        firstPromptSeq = (await sendMessage(newId, 'continue the work')).seq
      } catch (error) {
        firstPromptSeq = `threw: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const afterFirstPrompt = newId ? await sessionRow(newId) : undefined
    // After everything that touched the new session — the redelivery, a prompt
    // sent into it — the source is still exactly as it was.
    const afterEverything = await snapshot(source.id)
    const listedAfter = await listed(project.id, source.id)

    facts.happy = {
      createStatus: created.status,
      createBody: created.body,
      enqueuedForIt,
      sourceId: source.id,
      sourceTitle: source.title,
      sourceBranch: source.branch,
      before,
      afterCreate,
      afterRun,
      pollStatus: polled.status,
      polled: polled.body,
      compaction: row ? { ...row } : null,
      redelivery: {
        summarizeCalls: summarizeCalls.length - callsBeforeRedelivery,
        status: afterRedelivery?.status,
        costUsd: afterRedelivery?.costUsd,
        resultSessionId: afterRedelivery?.resultSessionId,
      },
      projectSessionCount: ids.length,
      newSession: newSession
        ? {
            id: newSession.id,
            title: newSession.title,
            orchestrator: newSession.orchestrator,
            maxBudgetUsd: newSession.maxBudgetUsd,
            status: newSession.status,
            nextSeq: newSession.nextSeq,
            totalCostUsd: newSession.totalCostUsd,
            sdkSessionId: newSession.sdkSessionId,
            baseBranch: newSession.baseBranch,
            baseSha: newSession.baseSha,
            baseNote: newSession.baseNote,
            branch: newSession.branch,
            hasWorktree: Boolean(newSession.worktreePath),
            lastError: newSession.lastError,
          }
        : null,
      newMessages: newMessages.map((m) => ({
        seq: m.seq,
        type: m.type,
        pending: m.pending,
        title: m.title,
        payload: m.payload,
      })),
      sourceHead,
      newHead,
      carriedFile,
      published: published.filter((p) => p.sessionId === newId),
      firstPromptSeq,
      nextSeqAfterFirstPrompt: afterFirstPrompt?.nextSeq,
      afterEverything,
      listedBefore,
      listedAfter,
    }
  }

  // --- a second POST while one is active returns that one -------------------------
  {
    const project = await newProject('idempotent')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    enqueued.length = 0
    const first = await http('POST', `/sessions/${source.id}/compactions`)
    const second = await http('POST', `/sessions/${source.id}/compactions`)
    const afterRepeat = await snapshot(source.id)
    const queuedJobs = enqueued.filter((j) => j.queue === 'session-compaction').length

    // The same while it is running, not just pending.
    await db
      .update(sessionCompactions)
      .set({ status: 'running', startedAt: ago(MIN) })
      .where(eq(sessionCompactions.id, first.body.id as string))
    const whileRunning = await http('POST', `/sessions/${source.id}/compactions`)

    // Once it has finished, the next POST is a new compaction. Put back to
    // pending first: the worker only claims a pending row, and the row above
    // was moved to running by hand.
    await db
      .update(sessionCompactions)
      .set({ status: 'pending', startedAt: null })
      .where(eq(sessionCompactions.id, first.body.id as string))
    await runSessionCompaction(first.body.id as string, succeeding())
    const afterDone = await http('POST', `/sessions/${source.id}/compactions`)
    const rows = await db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.sourceSessionId, source.id))

    facts.idempotent = {
      firstStatus: first.status,
      secondStatus: second.status,
      firstId: first.body.id,
      secondId: second.body.id,
      queuedJobs,
      whileRunningStatus: whileRunning.status,
      whileRunningId: whileRunning.body.id,
      afterDoneStatus: afterDone.status,
      afterDoneId: afterDone.body.id,
      rowCount: rows.length,
      before,
      afterRepeat,
    }
  }

  // --- five POSTs at once: the race the partial unique index decides ------------------
  {
    const project = await newProject('concurrent')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    enqueued.length = 0
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => http('POST', `/sessions/${source.id}/compactions`)),
    )
    const rows = await db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.sourceSessionId, source.id))
    facts.concurrent = {
      statuses: answers.map((a) => a.status),
      distinctIds: [...new Set(answers.map((a) => a.body.id))].length,
      rowIds: rows.map((r) => r.id),
      firstId: answers[0]?.body.id,
      queuedJobs: enqueued.filter((j) => j.queue === 'session-compaction').length,
      before,
      after: await snapshot(source.id),
    }
  }

  // --- the requests that are refused -----------------------------------------------
  {
    const project = await newProject('refused')
    const queuedSource = await newSource(project, 'queued one')
    const runningSource = await newSource(project, 'running one')
    await db.update(sessions).set({ status: 'queued' }).where(eq(sessions.id, queuedSource.id))
    await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, runningSource.id))
    const queuedBefore = await snapshot(queuedSource.id)

    const notReady = await newProject('not-ready', { status: 'cloning' })
    // Insert straight in: createSession itself refuses a project that is not ready.
    const [notReadySession] = await db
      .insert(sessions)
      .values({ projectId: notReady.id, orchestrator: 'coder', status: 'idle' })
      .returning()

    const queuedRes = await http('POST', `/sessions/${queuedSource.id}/compactions`)
    const runningRes = await http('POST', `/sessions/${runningSource.id}/compactions`)
    const notReadyRes = await http('POST', `/sessions/${notReadySession?.id}/compactions`)
    const unknownRes = await http('POST', `/sessions/${randomUUID()}/compactions`)
    const malformedRes = await http('POST', '/sessions/not-a-uuid/compactions')

    // GET: a real compaction, asked for under the wrong session or not at all.
    const otherSource = await newSource(project, 'other')
    const made = await http('POST', `/sessions/${otherSource.id}/compactions`)
    const wrongSession = await http('GET', `/sessions/${queuedSource.id}/compactions/${made.body.id}`)
    const unknownCompaction = await http(
      'GET',
      `/sessions/${otherSource.id}/compactions/${randomUUID()}`,
    )
    const unknownBoth = await http('GET', `/sessions/${randomUUID()}/compactions/${made.body.id}`)
    const rightSession = await http('GET', `/sessions/${otherSource.id}/compactions/${made.body.id}`)
    const malformedGet = await http('GET', `/sessions/${otherSource.id}/compactions/nope`)

    const rowsFor = async (id: string) =>
      (await db.select().from(sessionCompactions).where(eq(sessionCompactions.sourceSessionId, id)))
        .length

    facts.refused = {
      queued: { status: queuedRes.status, error: queuedRes.body.error },
      running: { status: runningRes.status, error: runningRes.body.error },
      notReady: { status: notReadyRes.status, error: notReadyRes.body.error },
      unknown: unknownRes.status,
      malformed: malformedRes.status,
      rowsCreated: {
        queued: await rowsFor(queuedSource.id),
        running: await rowsFor(runningSource.id),
        notReady: await rowsFor(notReadySession?.id as string),
      },
      queuedUntouched: JSON.stringify(await snapshot(queuedSource.id)) === JSON.stringify(queuedBefore),
      get: {
        wrongSession: wrongSession.status,
        unknownCompaction: unknownCompaction.status,
        unknownBoth: unknownBoth.status,
        rightSession: rightSession.status,
        malformed: malformedGet.status,
      },
    }
  }

  // --- the summarizer says no -------------------------------------------------------
  {
    const project = await newProject('summarizer-fails')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    const sessionsBefore = await projectSessionIds(project.id)
    const branchesBefore = await branchesOf(project.slug)

    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(created.body.id as string, failing('model exploded', 0.07))

    const row = await compactionRow(created.body.id as string)
    facts.summarizerFails = {
      status: row?.status,
      error: row?.error,
      costUsd: row?.costUsd,
      resultSessionId: row?.resultSessionId,
      method: row?.method,
      finishedAtSet: Boolean(row?.finishedAt),
      sessionsBefore,
      sessionsAfter: await projectSessionIds(project.id),
      branchesBefore,
      branchesAfter: await branchesOf(project.slug),
      before,
      after: await snapshot(source.id),
    }

    // The slot is free again: failing released it, so another compaction can start.
    const again = await http('POST', `/sessions/${source.id}/compactions`)
    ;(facts.summarizerFails as Record<string, unknown>).retryStatus = again.status
    ;(facts.summarizerFails as Record<string, unknown>).retryIsNew =
      again.body.id !== created.body.id
  }

  // --- a failure after the new session exists ------------------------------------------
  {
    const project = await newProject('late-failure')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    const sessionsBefore = await projectSessionIds(project.id)
    const branchesBefore = await branchesOf(project.slug)
    const worktreesBefore = await worktreesOf(project.slug)

    // A real failure at the context-insert step, injected in the database
    // rather than through a code seam: the transaction must roll back whole, and
    // the session createSession already made must be removed with its branch.
    await db.execute(sql`
      create function fail_compact_context() returns trigger language plpgsql as $$
      begin raise exception 'injected: cannot insert compact_context'; end $$`)
    await db.execute(sql`
      create trigger fail_compact_context before insert on messages
      for each row when (new.type = 'compact_context')
      execute function fail_compact_context()`)

    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(created.body.id as string, succeeding({ costUsd: 0.5 }))

    await db.execute(sql`drop trigger fail_compact_context on messages`)
    await db.execute(sql`drop function fail_compact_context()`)

    const row = await compactionRow(created.body.id as string)
    facts.lateFailure = {
      status: row?.status,
      error: row?.error,
      costUsd: row?.costUsd,
      resultSessionId: row?.resultSessionId,
      method: row?.method,
      sessionsBefore,
      sessionsAfter: await projectSessionIds(project.id),
      branchesBefore,
      branchesAfter: await branchesOf(project.slug),
      worktreesBefore,
      worktreesAfter: await worktreesOf(project.slug),
      before,
      after: await snapshot(source.id),
    }
  }

  // --- the summarizer throws instead of answering ----------------------------------------
  {
    const project = await newProject('summarizer-throws')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    const sessionsBefore = await projectSessionIds(project.id)
    const branchesBefore = await branchesOf(project.slug)
    const worktreesBefore = await worktreesOf(project.slug)

    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(created.body.id as string, {
      summarize: async () => {
        throw new Error('summarizer blew up')
      },
    })

    const row = await compactionRow(created.body.id as string)
    facts.summarizerThrows = {
      status: row?.status,
      error: row?.error,
      costUsd: row?.costUsd,
      resultSessionId: row?.resultSessionId,
      method: row?.method,
      sessionsBefore,
      sessionsAfter: await projectSessionIds(project.id),
      branchesBefore,
      branchesAfter: await branchesOf(project.slug),
      worktreesBefore,
      worktreesAfter: await worktreesOf(project.slug),
      before,
      after: await snapshot(source.id),
    }
  }

  // --- createSession itself fails, after its row and worktree exist ------------------------
  {
    const project = await newProject('create-fails')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    const sessionsBefore = await projectSessionIds(project.id)
    const branchesBefore = await branchesOf(project.slug)
    const worktreesBefore = await worktreesOf(project.slug)
    const gitWorktreesBefore = (
      await git(['worktree', 'list', '--porcelain'], projectRepo(project.slug))
    ).stdout

    // The new session's row is inserted and `git worktree add` has run; the
    // update that records the worktree on the row is what fails. This is the
    // path onRowInserted exists for: createSession throws, and the caller has
    // only that callback to learn which session (and branch) to clean up.
    // Only a row gaining a worktree_path for the first time trips it, which the
    // source (already set, and never written) cannot.
    await db.execute(sql`
      create function fail_worktree_record() returns trigger language plpgsql as $$
      begin raise exception 'injected: cannot record the worktree'; end $$`)
    await db.execute(sql`
      create trigger fail_worktree_record before update on sessions
      for each row when (old.worktree_path is null and new.worktree_path is not null)
      execute function fail_worktree_record()`)

    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(created.body.id as string, succeeding({ costUsd: 0.3 }))

    await db.execute(sql`drop trigger fail_worktree_record on sessions`)
    await db.execute(sql`drop function fail_worktree_record()`)

    const row = await compactionRow(created.body.id as string)
    facts.createFails = {
      status: row?.status,
      error: row?.error,
      costUsd: row?.costUsd,
      resultSessionId: row?.resultSessionId,
      method: row?.method,
      sessionsBefore,
      sessionsAfter: await projectSessionIds(project.id),
      branchesBefore,
      branchesAfter: await branchesOf(project.slug),
      worktreesBefore,
      worktreesAfter: await worktreesOf(project.slug),
      gitWorktreesBefore,
      gitWorktreesAfter: (await git(['worktree', 'list', '--porcelain'], projectRepo(project.slug)))
        .stdout,
      before,
      after: await snapshot(source.id),
    }
  }

  // --- a worker that died ----------------------------------------------------------------
  {
    const project = await newProject('stale')
    const staleRunning = await newSource(project, 'stale running')
    const stalePending = await newSource(project, 'stale pending')

    const [runningRow] = await db
      .insert(sessionCompactions)
      .values({
        sourceSessionId: staleRunning.id,
        status: 'running',
        createdAt: ago(30 * MIN),
        startedAt: ago(25 * MIN),
      })
      .returning()
    const [pendingRow] = await db
      .insert(sessionCompactions)
      .values({ sourceSessionId: stalePending.id, status: 'pending', createdAt: ago(40 * MIN) })
      .returning()

    // A poll alone ends it.
    const polled = await http('GET', `/sessions/${staleRunning.id}/compactions/${runningRow?.id}`)
    // And so does the next POST, which then starts a fresh one.
    const posted = await http('POST', `/sessions/${stalePending.id}/compactions`)
    const oldPending = await compactionRow(pendingRow?.id as string)

    // A recent one, by contrast, is left alone.
    const fresh = await newSource(project, 'fresh running')
    const [freshRow] = await db
      .insert(sessionCompactions)
      .values({
        sourceSessionId: fresh.id,
        status: 'running',
        createdAt: ago(2 * MIN),
        startedAt: ago(MIN),
      })
      .returning()
    const freshPost = await http('POST', `/sessions/${fresh.id}/compactions`)

    // The late worker then finds its row already failed and does nothing.
    const callsBefore = summarizeCalls.length
    await runSessionCompaction(runningRow?.id as string, succeeding())

    facts.stale = {
      polledStatus: polled.status,
      polled: polled.body,
      postStatus: posted.status,
      postIsNew: posted.body.id !== pendingRow?.id,
      postBodyStatus: posted.body.status,
      oldPendingStatus: oldPending?.status,
      oldPendingError: oldPending?.error,
      freshStatus: freshPost.status,
      freshSameId: freshPost.body.id === freshRow?.id,
      freshBodyStatus: freshPost.body.status,
      lateWorkerSummarizeCalls: summarizeCalls.length - callsBefore,
      lateWorkerRow: (await compactionRow(runningRow?.id as string))?.status,
    }
  }

  // --- the queue is down -------------------------------------------------------------------
  {
    const project = await newProject('enqueue-down')
    const source = await newSource(project)
    const before = await snapshot(source.id)
    failCompactionEnqueue = true
    const down = await http('POST', `/sessions/${source.id}/compactions`)
    failCompactionEnqueue = false
    const rows = await db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.sourceSessionId, source.id))
    const retry = await http('POST', `/sessions/${source.id}/compactions`)
    facts.enqueueDown = {
      status: down.status,
      error: down.body.error,
      rows: rows.map((r) => ({ status: r.status, error: r.error })),
      retryStatus: retry.status,
      before,
      after: await snapshot(source.id),
    }
  }

  // --- no branch of its own: a project that is not a git repository ------------------------
  {
    const project = await newProject('plain', { git: false })
    const source = await newSource(project, 'x'.repeat(200))
    const before = await snapshot(source.id)
    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(
      created.body.id as string,
      succeeding({ method: 'transcript_summary' }),
    )
    const row = await compactionRow(created.body.id as string)
    const newSession = row?.resultSessionId ? await sessionRow(row.resultSessionId) : undefined
    const [context] = newSession
      ? await db.select().from(messages).where(eq(messages.sessionId, newSession.id))
      : []
    facts.plain = {
      status: row?.status,
      error: row?.error,
      method: row?.method,
      sourceBranch: source.branch,
      sourceWorktree: source.worktreePath,
      newTitle: newSession?.title,
      newBranch: newSession?.branch,
      newBaseBranch: newSession?.baseBranch,
      newWorktree: newSession?.worktreePath,
      payload: context?.payload,
      before,
      after: await snapshot(source.id),
    }
  }

  // --- the source's branch is gone -----------------------------------------------------------
  {
    const project = await newProject('branch-gone')
    const source = await newSource(project)
    // The branch the source recorded no longer exists as a ref.
    await db
      .update(sessions)
      .set({ branch: 'agentoo/s-deadbeef' })
      .where(eq(sessions.id, source.id))
    const before = await snapshot(source.id)
    const created = await http('POST', `/sessions/${source.id}/compactions`)
    await runSessionCompaction(created.body.id as string, succeeding())
    const row = await compactionRow(created.body.id as string)
    const newSession = row?.resultSessionId ? await sessionRow(row.resultSessionId) : undefined
    const [context] = newSession
      ? await db.select().from(messages).where(eq(messages.sessionId, newSession.id))
      : []
    facts.branchGone = {
      status: row?.status,
      error: row?.error,
      newBaseBranch: newSession?.baseBranch,
      newBranchIsOwn: newSession?.branch === `agentoo/s-${newSession?.id.slice(0, 8)}`,
      payload: context?.payload,
      before,
      after: await snapshot(source.id),
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
