import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { messages, projects, sessions } from '@/db/schema'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { publishControl, publishSessionEvent } from '@/lib/events'
import {
  addWorktree,
  currentBranch,
  dirExists,
  ensureDir,
  isGitRepo,
  removeWorktree,
  trackUpstream,
} from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectRepo, projectRoot, projectWorktree } from '@/lib/paths'
import { VERSION } from '@/lib/version'
import { enqueueSessionRun } from '@/queue'
import type {
  CreateSessionInput,
  SessionDto,
  SessionExport,
  SessionMessageDto,
  UpdateSessionInput,
} from './schema'

type MessageRow = typeof messages.$inferSelect

function toMessageDto(row: MessageRow): SessionMessageDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type,
    parentToolUseId: row.parentToolUseId,
    title: row.title,
    pending: row.pending,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  }
}

type SessionRow = typeof sessions.$inferSelect

function toDto(
  row: SessionRow,
  repoPath: string,
  messageCount: number,
  pendingPrompts = 0,
): SessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    orchestrator: row.orchestrator,
    worktreePath: row.worktreePath,
    branch: row.branch,
    // A session without a worktree still has to run somewhere.
    workingDir: row.worktreePath ?? repoPath,
    isolated: row.worktreePath !== null,
    sdkSessionId: row.sdkSessionId,
    maxBudgetUsd: row.maxBudgetUsd,
    lastError: row.lastError,
    messageCount,
    totalCostUsd: row.totalCostUsd,
    pendingPrompts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function requireProject(projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw notFound('Project')
  return project
}

/** Pending prompt counts, so the UI can say how many messages are waiting. */
async function pendingFor(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await db
    .select({ sessionId: messages.sessionId, n: count() })
    .from(messages)
    .where(and(inArray(messages.sessionId, sessionIds), eq(messages.pending, true)))
    .groupBy(messages.sessionId)
  return new Map(rows.map((r) => [r.sessionId, Number(r.n)]))
}

async function countsFor(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await db
    .select({ sessionId: messages.sessionId, n: count() })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
    .groupBy(messages.sessionId)
  return new Map(rows.map((r) => [r.sessionId, Number(r.n)]))
}

export async function listSessions(projectId: string): Promise<SessionDto[]> {
  const project = await requireProject(projectId)
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.createdAt))
  const ids = rows.map((r) => r.id)
  const [counts, pending] = await Promise.all([countsFor(ids), pendingFor(ids)])
  const repo = projectRepo(project.slug)
  return rows.map((r) => toDto(r, repo, counts.get(r.id) ?? 0, pending.get(r.id) ?? 0))
}

export async function getSession(id: string): Promise<SessionDto> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
  if (!row) throw notFound('Session')
  const project = await requireProject(row.projectId)
  const [counts, pending] = await Promise.all([countsFor([row.id]), pendingFor([row.id])])
  return toDto(row, projectRepo(project.slug), counts.get(row.id) ?? 0, pending.get(row.id) ?? 0)
}

/** Short, readable, and unique enough for a branch name. */
const branchFor = (sessionId: string) => `agentoo/s-${sessionId.slice(0, 8)}`

/**
 * Start a session, on its own git worktree where that is possible.
 *
 * A worktree is what lets two sessions work on the same project at once without
 * fighting over the working tree.
 *
 * It is attempted whenever the project is a git repository, including one with
 * no commits: git 2.48+ infers `--orphan` there and produces a perfectly usable
 * checkout, so refusing on an unborn HEAD would deny isolation to a new project
 * for no reason. Older git does fail that case, which is why the result is
 * checked rather than assumed — the fallback is to share the checkout, reported
 * as isolated=false because it changes whether concurrent sessions are safe.
 */
export async function createSession(
  projectId: string,
  input: CreateSessionInput,
): Promise<SessionDto> {
  const project = await requireProject(projectId)
  if (project.status !== 'ready') {
    throw conflict(`Project is "${project.status}"; it has to finish setup first`)
  }

  const repo = projectRepo(project.slug)
  if (!(await dirExists(repo))) throw badRequest(`${repo} is missing`)

  const [row] = await db
    .insert(sessions)
    .values({
      projectId,
      title: input.title ?? null,
      orchestrator: input.orchestrator ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      status: 'idle',
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')

  let worktreePath: string | null = null
  let branch: string | null = null

  if (await isGitRepo(repo)) {
    const path = projectWorktree(project.slug, row.id)
    const name = branchFor(row.id)
    await ensureDir(`${projectRoot(project.slug)}/worktrees`)

    const result = await addWorktree(repo, path, name)
    if (result.ok) {
      worktreePath = path
      branch = name

      // Point the new branch at whatever it was cut from, so `git pull` inside
      // the session has a tracking ref instead of stopping with "no tracking
      // information for the current branch".
      const base = await currentBranch(repo)
      if (base) {
        const tracked = await trackUpstream(path, 'origin', base)
        if (!tracked.ok) {
          // Normal for a project with no remote, or before the first fetch.
          logger.debug(`No upstream for ${name}: ${tracked.stderr}`)
        }
      }
      await db
        .update(sessions)
        .set({ worktreePath, branch, updatedAt: new Date() })
        .where(eq(sessions.id, row.id))
      logger.info(`Session ${row.id} on worktree ${path} (${name})`)
    } else {
      // Do not fail the session over it: sharing the checkout still works. On
      // older git this is the unborn-HEAD case; otherwise it is usually a stale
      // worktree registration.
      logger.warn(`Could not create a worktree for session ${row.id}: ${result.stderr}`)
      await db
        .update(sessions)
        .set({ lastError: `Worktree unavailable: ${result.stderr}`, updatedAt: new Date() })
        .where(eq(sessions.id, row.id))
    }
  } else {
    logger.info(`Session ${row.id} shares ${repo} (not a git repository)`)
  }

  return getSession(row.id)
}

export async function updateSession(id: string, input: UpdateSessionInput): Promise<SessionDto> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
  if (!row) throw notFound('Session')

  await db
    .update(sessions)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.orchestrator !== undefined && { orchestrator: input.orchestrator }),
      ...(input.maxBudgetUsd !== undefined && { maxBudgetUsd: input.maxBudgetUsd }),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, id))

  return getSession(id)
}

/**
 * Delete a session and remove its worktree.
 *
 * The branch is deliberately left behind: it holds whatever the agent did, and
 * deleting a session should not silently discard work. Messages go with the
 * session through the cascade.
 */
export async function deleteSession(id: string): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
  if (!row) throw notFound('Session')
  if (row.status === 'running') {
    throw conflict('Session is running; interrupt it before deleting')
  }

  const project = await requireProject(row.projectId)

  if (row.worktreePath) {
    const result = await removeWorktree(projectRepo(project.slug), row.worktreePath)
    if (!result.ok) {
      logger.warn(`Could not remove worktree ${row.worktreePath}: ${result.stderr}`)
    } else {
      logger.info(`Removed worktree ${row.worktreePath}; branch ${row.branch} kept`)
    }
  }

  await db.delete(sessions).where(eq(sessions.id, id))
}

// --- running ------------------------------------------------------------------

/**
 * Append a prompt and make sure a turn is coming.
 *
 * The message is always recorded. Whether it starts a turn now or waits depends
 * on the session: a conditional update moves an idle session to 'queued', and a
 * busy one simply leaves the row pending for the running turn to pick up when it
 * finishes. That is why this never rejects a message for being too early.
 */
export async function sendMessage(sessionId: string, text: string): Promise<SessionMessageDto> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!session) throw notFound('Session')

  const project = await requireProject(session.projectId)
  if (project.status !== 'ready') {
    throw conflict(`Project is "${project.status}"; it has to finish setup first`)
  }
  if (!session.orchestrator) {
    throw badRequest('This session has no orchestrator. Choose one before sending a message.')
  }

  const [seqRow] = await db
    .update(sessions)
    .set({ nextSeq: sql`${sessions.nextSeq} + 1`, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning({ seq: sessions.nextSeq })
  if (!seqRow) throw notFound('Session')

  const [row] = await db
    .insert(messages)
    .values({
      sessionId,
      seq: seqRow.seq - 1,
      type: 'prompt',
      pending: true,
      title: null,
      payload: { text },
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')

  await publishSessionEvent({ kind: 'message', sessionId, seq: row.seq, message: row })

  // Start a turn only if nothing is already running. The running turn drains
  // whatever accumulated behind it.
  const [started] = await db
    .update(sessions)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        inArray(sessions.status, ['idle', 'completed', 'failed', 'interrupted']),
      ),
    )
    .returning()

  if (started) {
    await enqueueSessionRun({ sessionId })
    await publishSessionEvent({ kind: 'status', sessionId, status: 'queued' })
  }

  return toMessageDto(row)
}

/** Ask a running turn to stop. The worker holds the AbortController, not us. */
export async function interruptSession(sessionId: string): Promise<SessionDto> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!session) throw notFound('Session')
  if (session.status !== 'running' && session.status !== 'queued') {
    throw conflict(`Session is "${session.status}", not running`)
  }
  await publishControl(sessionId, { kind: 'interrupt' })
  logger.info(`Requested an interrupt for session ${sessionId}`)
  return getSession(sessionId)
}

export async function listMessages(sessionId: string, after = -1): Promise<SessionMessageDto[]> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!session) throw notFound('Session')

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, after)))
    .orderBy(messages.seq)

  return rows.map(toMessageDto)
}

// --- export ---------------------------------------------------------------

/**
 * Assemble the full transcript as a self-contained document.
 *
 * sdkSessionId, worktreePath and workingDir are left out on purpose: the first
 * is an Agent SDK resume handle that means nothing off the host that produced
 * it and points at on-disk state the recipient does not have, and the other
 * two are absolute server paths that would leak PROJECTS_DIR and the project
 * slug into a file people paste into issues. branch stays — it is a git ref
 * the UI already shows. Per-message id/sessionId are dropped the same way:
 * the row uuid identifies nothing outside this database, sessionId only
 * repeats session.id, and seq is already the stable identity within the
 * export. Built field-by-field rather than by spreading the DTOs, because a
 * spread would silently let any of this back in the next time a field is
 * added upstream.
 */
export async function exportSession(id: string): Promise<SessionExport> {
  const session = await getSession(id)
  const project = await requireProject(session.projectId)
  const transcript = await listMessages(id)

  return {
    kind: 'agentoo.session-export',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    generator: { app: 'agentoo', version: VERSION },
    session: {
      id: session.id,
      projectId: session.projectId,
      projectName: project.name,
      title: session.title,
      status: session.status,
      orchestrator: session.orchestrator,
      branch: session.branch,
      isolated: session.isolated,
      maxBudgetUsd: session.maxBudgetUsd,
      totalCostUsd: session.totalCostUsd,
      lastError: session.lastError,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messages: transcript.map((m) => ({
      seq: m.seq,
      type: m.type,
      parentToolUseId: m.parentToolUseId,
      title: m.title,
      pending: m.pending,
      createdAt: m.createdAt,
      // Verbatim: extended thinking, tool_use/tool_result blocks and the
      // result message's cost/usage all live inside this payload rather than
      // as columns, so this is the only thing that satisfies "all prompts,
      // thinking, answers and tool activity". Do not reshape it.
      payload: m.payload,
    })),
  }
}

/**
 * `agentoo-session-<slug>-<id8>.json`, always matching /^[a-z0-9-]+\.json$/ so
 * the Content-Disposition header needs no quoting escape and no RFC 5987
 * filename*.
 *
 * Deliberately not `toSlug` from `@/lib/paths`: its `slug || 'project'`
 * fallback is right for a directory name but wrong here. A Cyrillic title (the
 * app ships an `ru` locale, so this happens) strips to empty under NFKD and
 * would produce `agentoo-session-project-<id8>.json`, naming the wrong noun —
 * so an empty stem here just drops out of the filename instead.
 */
export function sessionExportFileName(session: { id: string; title: string | null }): string {
  const stem = (session.title ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  const id8 = session.id.slice(0, 8).toLowerCase()
  return stem ? `agentoo-session-${stem}-${id8}.json` : `agentoo-session-${id8}.json`
}
