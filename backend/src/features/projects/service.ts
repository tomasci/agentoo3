import { rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { dirExists } from '@/lib/git'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectRepo, projectRoot, toSlug } from '@/lib/paths'
import { enqueueProjectSetup } from '@/queue'
import type { CreateProjectInput, ProjectDto } from './schema'

type ProjectRow = typeof projects.$inferSelect

export function toDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    source: row.source,
    remoteUrl: row.remoteUrl,
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
  const slug = await uniqueSlug(input.name)

  if (input.existingPath) {
    // Adopting a directory: it has to be there before we record the project,
    // otherwise the user gets a 'ready' project pointing at nothing.
    if (!(await dirExists(input.existingPath))) {
      throw badRequest(`${input.existingPath} does not exist or is not a directory`)
    }
  }

  const [row] = await db
    .insert(projects)
    .values({
      name: input.name,
      slug,
      source: input.existingPath ? 'existing' : 'clone',
      remoteUrl: input.remoteUrl ?? null,
      status: 'pending',
    })
    .returning()

  if (!row) throw new Error('Insert returned no row')

  // The clone can fail on auth and take a while, so it never happens inline.
  await enqueueProjectSetup({ projectId: row.id, existingPath: input.existingPath })
  logger.info(`Project ${row.slug} created (${row.source}), setup queued`)

  return toDto(row)
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
