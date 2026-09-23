// The editor-op queue's 'reap' job (design section 5b) — the second half of
// this feature's cleanup story alongside sessions/service.ts's inline,
// best-effort removal on delete. This is what catches everything that inline
// removal cannot: a project deleted outright (which skips deleteSession
// entirely), a worker that died mid-start leaving an orphaned container, or a
// runtime directory left behind by either.
//
// Runs on the same `editor-op` queue, at the same concurrency: 1, as every
// 'start' job — the design's own reason is that this is what keeps a start
// and a reap sweep from ever racing each other over the same container.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type DockerCli, realDockerCli } from '@/features/docker/cli'
import { inspectContainersRaw } from '@/features/docker/inspect'
import { resolveDockerScope } from '@/features/docker/scope'
import { getSessionLocation } from '@/features/sessions/service'
import { AppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { editorRuntimeRoot } from '@/lib/paths'
import { listThisInstallEditorContainerIds, removeEditorContainer } from './container'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a still-running editor container should be removed, and why —
 * split out from `runEditorReap` so the decision (which touches no I/O of its
 * own beyond the two lookups already required) can be exercised per-container
 * without a fake docker daemon in play.
 *
 * A non-AppError from either lookup (Postgres unreachable, most plausibly) is
 * NOT a reason to remove: it is indistinguishable from "we cannot currently
 * tell", and removing a container over a transient outage would be far more
 * destructive than leaving a legitimate one running an extra 5 minutes. An
 * AppError, by contrast, is a definitive answer from the system of record —
 * 404 (session or project gone), 400 (no longer isolated), 409 (worktree gone
 * from disk) all mean this container's worktree no longer exists to serve.
 */
async function whyRemoveRunningContainer(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    return 'missing or malformed com.agentoo.editor.session label'
  }
  const session = await getSessionLocation(sessionId) // throws notFound (AppError) if gone
  await resolveDockerScope(session.projectId, sessionId) // throws 400/404/409 if the scope is gone
  return null
}

export async function runEditorReap(
  reason: 'scheduled' | 'boot',
  cli: DockerCli = realDockerCli,
): Promise<void> {
  logger.debug(`Editor reap (${reason}) starting`)

  // Scoped to THIS install (container.ts's own editorInstallId) -- this box's
  // one docker daemon is shared by more than one agentoo install (a
  // production checkout plus per-worktree dev/test copies), and a container
  // carrying a different install's `com.agentoo.editor.install` label, or no
  // install label at all, must never even be inspected here, let alone
  // removed for a session this install's own database has never heard of.
  const ids = await listThisInstallEditorContainerIds(cli)
  const containers = await inspectContainersRaw(ids, cli)

  let removed = 0
  const liveSessionIds = new Set<string>()

  for (const raw of containers) {
    const labels = raw.Config?.Labels ?? {}
    const name = (raw.Name ?? raw.Id).replace(/^\//, '')
    const sessionId = labels['com.agentoo.editor.session']
    const status = raw.State?.Status

    let reasonToRemove: string | null = null
    if (status !== 'running') {
      reasonToRemove = `state is ${status ?? 'unknown'}, not running`
    } else {
      try {
        reasonToRemove = await whyRemoveRunningContainer(sessionId)
      } catch (error) {
        if (error instanceof AppError) {
          reasonToRemove = error.message
        } else {
          // Cannot currently tell (e.g. the database is down) — skip, never remove.
          logger.warn(`Editor reap: skipping ${name}, could not verify its scope: ${String(error)}`)
          if (sessionId) liveSessionIds.add(sessionId)
          continue
        }
      }
    }

    if (reasonToRemove) {
      logger.info(`Editor reap: removing ${name} (${reasonToRemove})`)
      const result = await removeEditorContainer(name, cli)
      if (result.ok) removed += 1
      else logger.warn(`Editor reap: could not remove ${name}: ${result.stderr}`)
    } else if (sessionId) {
      liveSessionIds.add(sessionId)
    }
  }

  await reapOrphanRuntimeDirs(liveSessionIds)

  logger.debug(`Editor reap (${reason}) done: ${removed} container(s) removed`)
}

/** Every `${PROJECTS_DIR}/.editor/<sessionId>` directory with no surviving
 * editor container (of any label-carrying state — a container mid-`starting`
 * still owns its runtime dir) is orphaned socket-directory litter, most often
 * left behind by a worker that died between creating it and finishing the
 * start, or by a session/project deleted outright. */
async function reapOrphanRuntimeDirs(liveSessionIds: Set<string>): Promise<void> {
  const root = editorRuntimeRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return // no runtime root at all yet — nothing to reap
  }

  for (const entry of entries) {
    if (!SESSION_ID_RE.test(entry) || liveSessionIds.has(entry)) continue
    const dir = join(root, entry)
    try {
      await rm(dir, { recursive: true, force: true })
      logger.info(`Editor reap: removed orphan runtime dir ${dir}`)
    } catch (error) {
      logger.warn(`Editor reap: could not remove orphan runtime dir ${dir}: ${String(error)}`)
    }
  }
}
