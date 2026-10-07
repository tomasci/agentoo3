import { rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { keyPathFor } from '@/features/ssh-keys/service'
import { resolveSource } from '@/lib/adopt-path'
import { AppError, badRequest, conflict, notFound } from '@/lib/errors'
import {
  configureRepoIdentity,
  configureRepoSsh,
  isConfigLockError,
  isGitRepo,
  isRepoRoot,
  readRepoIdentity,
  withRepoLock,
} from '@/lib/git'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectRepo, projectRoot, toSlug } from '@/lib/paths'
import { checkRemoteUrl } from '@/lib/remote-url'
import { gitSshCommand } from '@/lib/ssh'
import { enqueueProjectSetup } from '@/queue'
import type {
  CreateProjectInput,
  GitIdentityInput,
  GitIdentityStateDto,
  ProjectDto,
  UpdateProjectInput,
} from './schema'

type ProjectRow = typeof projects.$inferSelect

export function toDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    source: row.source,
    remoteUrl: row.remoteUrl,
    sourceName: row.sourceName,
    sshKeyId: row.sshKeyId,
    defaultBranch: row.defaultBranch,
    status: row.status,
    lastError: row.lastError,
    recoveryCommands: row.recoveryCommands ?? null,
    path: projectRepo(row.slug),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listProjects(): Promise<ProjectDto[]> {
  const rows = await db.select().from(projects).orderBy(projects.createdAt)
  return rows.map(toDto)
}

export async function getProject(id: string): Promise<ProjectDto> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw notFound('Project')
  return toDto(row)
}

/** Unique directory name: agentoo, agentoo-2, agentoo-3, ... */
async function uniqueSlug(name: string): Promise<string> {
  const base = toSlug(name)
  const taken = new Set(
    (await db.select({ slug: projects.slug }).from(projects)).map((r) => r.slug),
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw conflict('Could not allocate a directory name for this project')
}

export async function createProject(input: CreateProjectInput): Promise<ProjectDto> {
  // Validate before any I/O. `git clone` runs commands for some URL shapes and
  // this endpoint has no authentication, so bad input must not reach the
  // database, let alone a worker.
  if (input.remoteUrl) {
    const check = checkRemoteUrl(input.remoteUrl)
    if (!check.ok) throw badRequest(check.reason ?? 'Invalid remote URL')
  }

  let adoptPath: string | undefined
  if (input.sourceName) {
    // Must exist now, or the user gets a 'ready' project pointing at nothing.
    const check = await resolveSource(input.sourceName)
    if (!check.ok) throw badRequest(check.reason ?? 'Invalid folder')

    // One project per folder: two projects sharing a directory would have their
    // agents writing over each other.
    const [taken] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.sourceName, input.sourceName))
      .limit(1)
    if (taken)
      throw conflict(`"${input.sourceName}" is already used by the project "${taken.name}"`)

    // The worker re-resolves from sourceName; this only proves it exists now.
    adoptPath = check.resolved
  }

  const slug = await uniqueSlug(input.name)

  const [row] = await db
    .insert(projects)
    .values({
      name: input.name,
      slug,
      source: input.empty ? 'empty' : adoptPath ? 'existing' : 'clone',
      remoteUrl: input.remoteUrl ?? null,
      sourceName: input.sourceName ?? null,
      sshKeyId: input.sshKeyId ?? null,
      status: 'pending',
    })
    .returning()

  if (!row) throw new Error('Insert returned no row')

  // The clone can fail on auth and take a while, so it never happens inline.
  await enqueueProjectSetup({ projectId: row.id })
  logger.info(`Project ${row.slug} created (${row.source}), setup queued`)

  return toDto(row)
}

/**
 * Change a project's remote, ssh key or default branch after the fact.
 *
 * The first two are things you discover you got wrong only when a clone
 * fails: the repo needed a key, or the key was the wrong one, or the remote
 * should have been https. Requiring the project to be deleted and recreated
 * to fix that would be hostile. defaultBranch is here because it was set
 * automatically at setup time from whatever the checkout happened to be on —
 * right for most projects, but a project that develops on a branch other
 * than the one it was cloned on needs a way to say so explicitly.
 */
export async function updateProject(id: string, input: UpdateProjectInput): Promise<ProjectDto> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw notFound('Project')

  if (input.remoteUrl) {
    const check = checkRemoteUrl(input.remoteUrl)
    if (!check.ok) throw badRequest(check.reason ?? 'Invalid remote URL')
    if (row.source === 'existing') {
      throw badRequest('This project adopted a directory; it has no remote to change')
    }
  }

  // Syntax only, deliberately: a branch may not exist on disk yet (an empty
  // project with nothing committed, or a name reserved for later), and this
  // is a settings save, not a network call. Whether it actually resolves is
  // checked where it has to actually work — at session creation.

  const [updated] = await db
    .update(projects)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.remoteUrl !== undefined && { remoteUrl: input.remoteUrl }),
      ...(input.sshKeyId !== undefined && { sshKeyId: input.sshKeyId }),
      ...(input.defaultBranch !== undefined && { defaultBranch: input.defaultBranch }),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning()

  if (!updated) throw new Error('Update returned no row')

  // Changing the key has to reach the repository config, or the old key stays
  // in effect for every git command run inside a session.
  if (input.sshKeyId !== undefined) {
    const repo = projectRepo(updated.slug)
    if (await isGitRepo(repo)) {
      const keyPath = await keyPathFor(updated.sshKeyId)
      const configured = await configureRepoSsh(repo, keyPath ? gitSshCommand(keyPath) : undefined)
      if (!configured.ok) {
        logger.warn(`Could not update core.sshCommand for ${updated.slug}: ${configured.stderr}`)
      }
    }
  }

  logger.info(`Project ${updated.slug} updated`)
  return toDto(updated)
}

/** "Check again, I did the manual steps" — re-queue setup for a stuck project. */
export async function retryProject(id: string): Promise<ProjectDto> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw notFound('Project')
  if (row.status === 'cloning') throw conflict('Setup is already running')

  const [updated] = await db
    .update(projects)
    .set({ status: 'pending', lastError: null, recoveryCommands: null, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning()
  if (!updated) throw new Error('Update returned no row')

  await enqueueProjectSetup({ projectId: id })
  logger.info(`Project ${row.slug} setup re-queued`)
  return toDto(updated)
}

export async function deleteProject(id: string, removeFiles: boolean): Promise<void> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw notFound('Project')

  if (removeFiles) {
    // Only ever delete inside PROJECTS_DIR. An adopted directory the user
    // created elsewhere is theirs, and is never touched.
    if (row.source === 'existing') {
      // The folder in SOURCES_DIR is the operator's; only our own scaffolding
      // under PROJECTS_DIR is ours to remove.
      logger.warn(`Project ${row.slug} adopted a source folder; leaving it in place`)
    } else {
      const target = assertInsideProjects(projectRoot(row.slug))
      await rm(target, { recursive: true, force: true })
      logger.info(`Removed ${target}`)
    }
  }

  await db.delete(projects).where(eq(projects.id, id))
}

// --- git identity ----------------------------------------------------------

async function requireProjectRow(id: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw notFound('Project')
  return row
}

/**
 * Whether there is a repository on disk this feature can actually act on.
 * `status !== 'ready'` covers a project still cloning, stuck in
 * `needs_manual`, or failed outright — all states where `repo/` may not exist
 * yet, may be empty, or may be mid-write from the setup worker, none of which
 * `readRepoIdentity`/`configureRepoIdentity` should be run against. `isRepoRoot`
 * on top of that covers the narrower cases of a `ready` project whose
 * adopted folder (a symlink the project does not own — see "existing"
 * projects in paths.ts) was later moved or deleted out from under it, or
 * whose `repo/` is a plain, non-git folder — never `isGitRepo`, whose
 * `--is-inside-work-tree` also answers true for a folder that merely sits
 * inside PROJECTS_DIR's own enclosing repository, which in a real install is
 * agentoo's own checkout: that gate would read as available and send a write
 * into agentoo's own `.git/config` rather than the project's. `isRepoRoot`
 * requires `repo/` to itself be the top of a work tree, which only a real
 * project repo (cloned, initialized, or adopted from an actual repo) is.
 */
async function repoAvailable(row: ProjectRow): Promise<boolean> {
  return row.status === 'ready' && (await isRepoRoot(projectRepo(row.slug)))
}

const unavailableIdentity: GitIdentityStateDto = {
  available: false,
  configPath: null,
  local: { name: null, email: null },
  effective: { name: null, email: null },
}

export async function getGitIdentity(projectId: string): Promise<GitIdentityStateDto> {
  const row = await requireProjectRow(projectId)
  if (!(await repoAvailable(row))) return unavailableIdentity

  return { available: true, ...(await readRepoIdentity(projectRepo(row.slug))) }
}

/**
 * Shared by set and clear below: both need the same "is there a repo to
 * write to" gate before touching git, and the same translation of whatever
 * `configureRepoIdentity` reports into the three outcomes a caller can act
 * on — success, "try again" (the config file is mid-write by something
 * else), or an error neither of those input-validation layers could have
 * caught.
 */
async function writeIdentity(
  projectId: string,
  identity: { name: string; email: string } | null,
): Promise<GitIdentityStateDto> {
  const row = await requireProjectRow(projectId)
  if (!(await repoAvailable(row))) {
    throw conflict('This project has no repository to set a git identity on right now')
  }

  const repo = projectRepo(row.slug)

  // Held across the write *and* the read-back below: without this, a second
  // request for the same repo (the concurrent-PUT race this whole function
  // exists to close) can land its own write in between this call's write and
  // its read, and this call would then answer with a state it never wrote.
  return withRepoLock(repo, async () => {
    const result = await configureRepoIdentity(repo, identity)
    if (!result.ok) {
      if (isConfigLockError(result)) {
        throw conflict('The repository config is locked by another process; try again')
      }
      // Not a shape this feature's own validation predicts — surfacing it
      // verbatim beats a generic message that hides what git actually said.
      throw new AppError(result.stderr || 'git config failed', 500)
    }

    logger.info(`Git identity ${identity ? 'set' : 'cleared'} for project ${row.slug}`)
    return { available: true, ...(await readRepoIdentity(repo)) }
  })
}

export async function setGitIdentity(
  projectId: string,
  input: GitIdentityInput,
): Promise<GitIdentityStateDto> {
  return writeIdentity(projectId, { name: input.name, email: input.email })
}

/** Idempotent: clearing an identity that is already clear is a plain 200,
 * same reasoning as `configureRepoIdentity`'s own exit-5 handling — there is
 * nothing for a second clear to fail on. */
export async function clearGitIdentity(projectId: string): Promise<GitIdentityStateDto> {
  return writeIdentity(projectId, null)
}
