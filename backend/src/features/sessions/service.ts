import { and, count, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { messages, projects, sessions } from '@/db/schema'
import { keyPathFor } from '@/features/ssh-keys/service'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { publishControl, publishSessionEvent } from '@/lib/events'
import {
  addWorktree,
  dirExists,
  ensureDir,
  isGitRepo,
  removeWorktree,
  revParse,
  trackUpstream,
} from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectRepo, projectRoot, projectWorktree } from '@/lib/paths'
import { gitSshCommand } from '@/lib/ssh'
import { VERSION } from '@/lib/version'
import { enqueueSessionRun } from '@/queue'
import type { BaseBranchPlan } from './base-branch'
import { planBaseBranch } from './base-branch'
import type {
  CreateSessionInput,
  SessionDto,
  SessionExport,
  SessionMessageDto,
  SessionMessagePageDto,
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
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    baseNote: row.baseNote,
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
 *
 * Which branch that worktree is cut from is resolved by planBaseBranch before
 * any of this runs, and has to be: a branch that resolves to nothing at all is
 * a 400, and that has to happen before the session row exists, not after.
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

  const isRepo = await isGitRepo(repo)
  if (input.baseBranch && !isRepo) {
    throw badRequest('This project is not a git repository; there is no branch to start from')
  }

  let plan: BaseBranchPlan = { ok: true, branch: null, startPoint: null }
  if (isRepo) {
    // Resolved the same way queue/project-setup.worker.ts resolves it for
    // configureRepoSsh: without this, fetchBranch authenticates with no key
    // at all, which fails every time for a private repo with a project key
    // and reads as a permanently degraded feature rather than an occasional one.
    const keyPath = await keyPathFor(project.sshKeyId)
    plan = await planBaseBranch(
      repo,
      { override: input.baseBranch, projectDefault: project.defaultBranch },
      { sshCommand: keyPath ? gitSshCommand(keyPath) : undefined },
    )
    if (!plan.ok) throw badRequest(plan.reason)
  }

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

  if (isRepo) {
    const path = projectWorktree(project.slug, row.id)
    const name = branchFor(row.id)
    await ensureDir(`${projectRoot(project.slug)}/worktrees`)

    const result = await addWorktree(repo, path, name, plan.startPoint ?? undefined)
    if (result.ok) {
      // Point the new branch at whatever it was cut from, so `git pull` inside
      // the session has a tracking ref instead of stopping with "no tracking
      // information for the current branch". Cutting from a remote-tracking
      // start point already sets this via git's own autoSetupMerge, but a
      // local-ref or bare-HEAD start point does not, so this always runs
      // rather than only on the paths that need it.
      if (plan.branch) {
        const tracked = await trackUpstream(path, 'origin', plan.branch)
        if (!tracked.ok) {
          // Normal for a project with no remote, or before the first fetch.
          logger.debug(`No upstream for ${name}: ${tracked.stderr}`)
        }
      }
      await db
        .update(sessions)
        .set({
          worktreePath: path,
          branch: name,
          baseBranch: plan.branch,
          baseSha: (await revParse(path, 'HEAD')) ?? null,
          baseNote: plan.note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, row.id))
      logger.info(`Session ${row.id} on worktree ${path} (${name})`)
    } else {
      // Do not fail the session over it: sharing the checkout still works. On
      // older git this is the unborn-HEAD case; otherwise it is usually a stale
      // worktree registration. The base-branch columns stay null: a baseBranch
      // on a session that ended up sharing the checkout would claim a worktree
      // that does not exist actually runs from it.
      logger.warn(`Could not create a worktree for session ${row.id}: ${result.stderr}`)
      await db
        .update(sessions)
        .set({
          // result.stderr is raw process output.
          lastError: sanitizeForDb(`Worktree unavailable: ${result.stderr}`),
          updatedAt: new Date(),
        })
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
      payload: sanitizeForDb({ text }),
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

/** Backward page size when a bounded mode is given without an explicit `limit`. */
const DEFAULT_PAGE_SIZE = 100

/**
 * A page of a session's transcript, always ascending by seq — a client never
 * has to re-sort depending on which cursor it asked with.
 *
 * Three modes, chosen by which of `after`/`before`/`limit` showed up:
 *
 * - `after` (or neither cursor and no `limit`): unbounded, exactly what
 *   listMessages itself returns. A client that already holds a prefix asks
 *   for what follows it; `limit` does not apply — "after" already means
 *   "unbounded" — so it is ignored rather than silently truncating a
 *   reconnecting client's catch-up.
 * - `before`: the backward page a scrollback UI wants once it already has a
 *   seq to anchor on — the newest slice below one it has not seen yet.
 * - `limit` alone, with neither cursor: the newest `limit` messages. This is
 *   the initial-load case: opening a session has no seq to anchor on yet, only
 *   how many messages it wants, so it cannot use `before` — and unbounded
 *   `after` would defeat the entire point of paginating. Without this mode
 *   `limit` would be a parameter callers can set that this function silently
 *   ignores, which is worse than not having it.
 *
 * Both bounded modes share one query, `ORDER BY seq DESC LIMIT limit + 1`
 * (index-friendly off messages_session_seq_key, the same index `after` uses),
 * differing only in whether a `seq < before` condition is present, and both
 * reverse before returning so the wire format is ascending regardless of which
 * cursor asked for it. The extra row is how hasOlder is known from the one
 * query that already ran, rather than a second COUNT(*) racing against it.
 *
 * `after` and `before` point in opposite directions on one cursor; there is no
 * coherent meaning for both at once, so combining them is refused up front,
 * before the session lookup even runs.
 */
export async function listMessagePage(
  sessionId: string,
  opts: { after?: number; before?: number; limit?: number },
): Promise<SessionMessagePageDto> {
  if (opts.after !== undefined && opts.before !== undefined) {
    throw badRequest('after and before are opposite directions; send only one')
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!session) throw notFound('Session')

  const bounded =
    opts.before !== undefined || (opts.after === undefined && opts.limit !== undefined)
  if (bounded) {
    const limit = opts.limit ?? DEFAULT_PAGE_SIZE
    const rows = await db
      .select()
      .from(messages)
      .where(
        opts.before !== undefined
          ? and(eq(messages.sessionId, sessionId), lt(messages.seq, opts.before))
          : eq(messages.sessionId, sessionId),
      )
      .orderBy(desc(messages.seq))
      .limit(limit + 1)

    const hasOlder = rows.length > limit
    const page = rows.slice(0, limit).reverse()
    return { messages: page.map(toMessageDto), hasOlder }
  }

  // Unbounded: `after` mode itself, or neither cursor and no `limit` at all —
  // the original whole-transcript contract, preserved exactly.
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, opts.after ?? -1)))
    .orderBy(messages.seq)
  return { messages: rows.map(toMessageDto), hasOlder: false }
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
 * the UI already shows. baseBranch, baseSha and baseNote are left out: the
 * session block here is an exact, tested field set (see
 * session-export.test.ts's "carries exactly the documented fields"), so
 * widening it is a decision made deliberately per field, not a side effect of
 * adding a column. Per-message id/sessionId are dropped the same way:
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
