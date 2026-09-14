// What "this docker request" targets: the project's own repo/ checkout, or —
// when a caller names a session — that session's independent git worktree.
// Every other module in this feature reads `DockerScope.path` and never
// resolves a worktree path itself; this is the one place that decision is
// made, so it is the one place a change to how a session's worktree is found
// has to be reviewed.

import { getProject } from '@/features/projects/service'
import { getSessionLocation } from '@/features/sessions/service'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { dirExists } from '@/lib/git'
import { assertInsideProjects, projectRepo, projectWorktree } from '@/lib/paths'
import type { DockerScopeRef } from './names'

export interface DockerScope extends DockerScopeRef {
  projectId: string
  /** The directory every -f, every cwd and detection resolve against. */
  path: string
}

/**
 * Resolve which checkout a docker request targets.
 *
 * `sessionId` absent means repo scope, and repo scope never stats: that is
 * the same "no filesystem check before detection runs" behaviour this feature
 * has always had, and it has to stay true or a freshly created project (whose
 * repo/ clone may still be running) would start failing docker requests it
 * used to just answer with `hasCompose: false`.
 *
 * A session id that does not exist, and one that exists but names a session
 * of a *different* project, answer with byte-identical 404s — the same
 * discipline `getDockerOperation` and the container-ownership check already
 * use elsewhere in this feature, so this endpoint cannot be used to enumerate
 * which session ids exist on the box.
 */
export async function resolveDockerScope(
  projectId: string,
  sessionId?: string,
): Promise<DockerScope> {
  const project = await getProject(projectId) // 404s on an unknown project

  if (sessionId === undefined) {
    return { projectId, slug: project.slug, sessionId: null, path: projectRepo(project.slug) }
  }

  const session = await getSessionLocation(sessionId) // throws notFound('Session')
  if (session.projectId !== projectId) {
    // Byte-identical to the 404 above — see this function's own header.
    throw notFound('Session')
  }
  if (session.worktreePath === null) {
    throw badRequest(
      'This session shares the project checkout; it has no worktree of its own to run docker in',
    )
  }

  // Derived, not read off the row: createSession (sessions/service.ts) sets
  // `worktreePath` to exactly this, so the two are equal by construction — the
  // column is only ever the "is this session isolated" flag, never the source
  // of truth for where its worktree lives. If a guard breach ever made them
  // disagree, that would be an invariant violation, not a client error — the
  // same discipline `resolveDetected` (docker/service.ts) already applies to a
  // detected basename, so this is allowed to throw a plain Error (500) rather
  // than a handled AppError.
  const path = assertInsideProjects(projectWorktree(project.slug, session.id))

  if (!(await dirExists(path))) {
    throw conflict('The worktree for this session is no longer on disk')
  }

  return { projectId, slug: project.slug, sessionId: session.id, path }
}
