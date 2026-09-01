import { join, resolve, sep } from 'node:path'
import { env } from '@/env'

/** Directory name for a project. Stable, filesystem-safe, derived from the name. */
export function toSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'project'
}

/** Root of a project: contains repo/ and worktrees/. */
export function projectRoot(slug: string): string {
  return join(env.PROJECTS_DIR, slug)
}

/** The checkout Claude works in for sessions with no worktree of their own. */
export function projectRepo(slug: string): string {
  return join(projectRoot(slug), 'repo')
}

/** Per-session git worktree. */
export function projectWorktree(slug: string, sessionId: string): string {
  return join(projectRoot(slug), 'worktrees', sessionId)
}

/** Symlink farm of selected agents/skills, loaded as a plugin. Outside repo/. */
export function projectPlugin(slug: string): string {
  return join(projectRoot(slug), 'plugin')
}

/**
 * Reject a path that escapes PROJECTS_DIR.
 *
 * Project names come from the UI, so a name like `../../etc` must not be able to
 * place a directory outside the projects root.
 */
export function assertInsideProjects(path: string): string {
  const root = resolve(env.PROJECTS_DIR)
  const target = resolve(path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to operate on ${target}, which is outside ${root}`)
  }
  return target
}
