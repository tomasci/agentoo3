import { rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { checkAdoptPath } from '@/lib/adopt-path'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectRepo, projectRoot, toSlug } from '@/lib/paths'
import { checkRemoteUrl } from '@/lib/remote-url'
import { enqueueProjectSetup } from '@/queue'
import type { CreateProjectInput, ProjectDto, UpdateProjectInput } from './schema'

type ProjectRow = typeof projects.$inferSelect

export function toDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    source: row.source,
    remoteUrl: row.remoteUrl,
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
  if (input.existingPath) {
    // Must exist now, or the user gets a 'ready' project pointing at nothing.
    const check = await checkAdoptPath(input.existingPath)
    if (!check.ok) throw badRequest(check.reason ?? 'Invalid path')
    // Hand the worker the resolved realpath, not the raw input.
    adoptPath = check.resolved
  }

  const slug = await uniqueSlug(input.name)

  const [row] = await db
    .insert(projects)
    .values({
      name: input.name,
      slug,
      source: adoptPath ? 'existing' : 'clone',
      remoteUrl: input.remoteUrl ?? null,
      sshKeyId: input.sshKeyId ?? null,
      status: 'pending',
    })
    .returning()

  if (!row) throw new Error('Insert returned no row')

  // The clone can fail on auth and take a while, so it never happens inline.
  await enqueueProjectSetup({ projectId: row.id, existingPath: adoptPath })
  logger.info(`Project ${row.slug} created (${row.source}), setup queued`)

  return toDto(row)
}

/**
 * Change a project's remote or ssh key after the fact.
 *
 * Both are things you discover you got wrong only when a clone fails: the repo
 * needed a key, or the key was the wrong one, or the remote should have been
 * https. Requiring the project to be deleted and recreated to fix that would be
 * hostile.
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

  const [updated] = await db
    .update(projects)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.remoteUrl !== undefined && { remoteUrl: input.remoteUrl }),
      ...(input.sshKeyId !== undefined && { sshKeyId: input.sshKeyId }),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning()

  if (!updated) throw new Error('Update returned no row')
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
      logger.warn(`Project ${row.slug} adopted an external directory; not deleting files`)
    } else {
      const target = assertInsideProjects(projectRoot(row.slug))
      await rm(target, { recursive: true, force: true })
      logger.info(`Removed ${target}`)
    }
  }

  await db.delete(projects).where(eq(projects.id, id))
}
