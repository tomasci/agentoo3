import { realpath } from 'node:fs/promises'
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

// --- attachments ----------------------------------------------------------

/**
 * Canonical dashed UUID shape, checked before a session or idea id is ever
 * handed to `join()`. This repo already has a scar for skipping this exact
 * step — `library/index.ts:18`'s `insideLibrary` exists because a path built
 * from an unchecked name became an arbitrary file write and an `rm -rf` of an
 * arbitrary directory. A validated UUID cannot contain a separator or `..`,
 * so everything derived from it below is safe by construction rather than by
 * a prefix check applied after the fact. Shared by both id kinds below —
 * they are the same shape, and a second regex literal would just be one more
 * place to keep in sync with this comment.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertSessionId(sessionId: string): string {
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`Refusing to use "${sessionId}" as a session id: not a UUID`)
  }
  return sessionId
}

function assertIdeaId(ideaId: string): string {
  if (!UUID_RE.test(ideaId)) {
    throw new Error(`Refusing to use "${ideaId}" as an idea id: not a UUID`)
  }
  return ideaId
}

/**
 * Root of one session's attachments, sharded two levels deep by the session
 * id's own hex digits so a deployment with thousands of sessions never puts
 * thousands of entries in one directory: `sessions/<aa>/<bb>/<session-id>`.
 * The leaf keeps the full dashed id — the shard prefix only fans out the
 * tree, it is not the identity.
 */
export function sessionAttachmentsDir(sessionId: string): string {
  assertSessionId(sessionId)
  const hex = sessionId.toLowerCase().replace(/-/g, '')
  const aa = hex.slice(0, 2)
  const bb = hex.slice(2, 4)
  return join(env.ATTACHMENTS_DIR, 'sessions', aa, bb, sessionId)
}

/** Where a session's uploaded files actually live, and the only directory an
 * agent is ever granted (see `additionalDirectories` in runner-options.ts) —
 * never the storage root, and never the session dir above it. */
export function sessionUploadsDir(sessionId: string): string {
  return join(sessionAttachmentsDir(sessionId), 'uploads')
}

/** The generated index an agent can re-read after context compaction. */
export function attachmentsManifestPath(sessionId: string): string {
  return join(sessionUploadsDir(sessionId), 'ATTACHMENTS.md')
}

/**
 * Root of one idea's uploaded assets — the second storage root, sharded
 * exactly like `sessionAttachmentsDir` above (`ideas/<aa>/<bb>/<idea-id>`).
 * An idea has no session until handoff, so its files need a home entirely
 * independent of `sessions/`; `attachIdeaAssetsToSession` (see
 * features/ideas/files.ts) is what later copies them into one.
 */
export function ideaAttachmentsDir(ideaId: string): string {
  assertIdeaId(ideaId)
  const hex = ideaId.toLowerCase().replace(/-/g, '')
  const aa = hex.slice(0, 2)
  const bb = hex.slice(2, 4)
  return join(env.ATTACHMENTS_DIR, 'ideas', aa, bb, ideaId)
}

/** Where an idea's uploaded assets actually live. No agent is ever granted
 * this directly — an idea has no session to run an agent in — so, unlike
 * `sessionUploadsDir`, nothing outside storage.ts and features/ideas/files.ts
 * needs to resolve this. Kept alongside it anyway, not inlined, for the same
 * reason `sessionUploadsDir` isn't: one place decides where a root's uploads
 * live. */
export function ideaUploadsDir(ideaId: string): string {
  return join(ideaAttachmentsDir(ideaId), 'uploads')
}

/**
 * Reject a directory that escapes ATTACHMENTS_DIR, symlinks included.
 *
 * Unlike `assertInsideProjects`, this resolves symlinks (`realpath`) rather
 * than only comparing resolved-but-unfollowed paths: the session id above is
 * already validated as a UUID, which rules out `..` and separators by
 * construction, so the remaining risk this guards against is a symlink
 * planted somewhere in the sharded tree — say, a shard directory replaced by
 * one pointing outside ATTACHMENTS_DIR — rather than attacker-controlled path
 * text. Called after the directory exists (mkdir happens first), since
 * `realpath` throws on a path that is not there yet.
 */
export async function assertInsideAttachments(path: string): Promise<string> {
  const root = resolve(env.ATTACHMENTS_DIR)
  const realRoot = await realpath(root).catch(() => root)
  const real = await realpath(path)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`Refusing to operate on ${real}, which is outside ${realRoot}`)
  }
  return real
}
