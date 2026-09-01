import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projectLibraryItems, projects } from '@/db/schema'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { ensureDir } from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectPlugin } from '@/lib/paths'
import {
  AGENTS_DIR,
  agentPath,
  agentToMarkdown,
  getAgent,
  listAgents,
  listSkills,
  SKILLS_DIR,
  skillDir,
  skillToMarkdown,
} from '@/library'
import { checkLibraryName } from '@/library/types'
import type {
  AgentDto,
  CreateAgentInput,
  CreateSkillInput,
  ProjectLibraryDto,
  SkillDto,
  UpdateAgentInput,
  UpdateSkillInput,
} from './schema'

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

// --- agents -------------------------------------------------------------------

/** A 400 naming the rule beats a 500 from the path guard below it. */
function assertName(name: string): void {
  const check = checkLibraryName(name)
  if (!check.ok) throw badRequest(check.reason ?? 'Invalid name')
}

export async function getAgentOrThrow(name: string): Promise<AgentDto> {
  assertName(name)
  const agent = await getAgent(name)
  if (!agent) throw notFound('Agent')
  return agent
}

export async function createAgent(input: CreateAgentInput): Promise<AgentDto> {
  assertName(input.name)

  await ensureDir(AGENTS_DIR())
  const path = agentPath(input.name)
  if (await exists(path)) throw conflict(`An agent named "${input.name}" already exists`)

  const { name, ...rest } = input
  await writeFile(path, agentToMarkdown(rest), 'utf8')
  logger.info(`Created agent ${name}`)
  return getAgentOrThrow(name)
}

export async function updateAgent(name: string, input: UpdateAgentInput): Promise<AgentDto> {
  assertName(name)
  const path = agentPath(name)
  if (!(await exists(path))) throw notFound('Agent')
  await writeFile(path, agentToMarkdown(input), 'utf8')
  logger.info(`Updated agent ${name}`)
  return getAgentOrThrow(name)
}

export async function deleteAgent(name: string): Promise<void> {
  assertName(name)
  const path = agentPath(name)
  if (!(await exists(path))) throw notFound('Agent')

  await rm(path, { force: true })
  // Assignments would otherwise leave broken symlinks in every project that
  // used it, and the SDK would report a plugin that half-loads.
  await unassignEverywhere('agent', name)
  logger.info(`Deleted agent ${name}`)
}

// --- skills -------------------------------------------------------------------

export async function getSkillOrThrow(name: string): Promise<SkillDto> {
  assertName(name)
  const skill = (await listSkills()).find((s) => s.name === name)
  if (!skill) throw notFound('Skill')
  return skill
}

export async function createSkill(input: CreateSkillInput): Promise<SkillDto> {
  assertName(input.name)

  const dir = skillDir(input.name)
  if (await exists(join(dir, 'SKILL.md'))) {
    throw conflict(`A skill named "${input.name}" already exists`)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    skillToMarkdown(input.name, input.description, input.body),
    'utf8',
  )
  logger.info(`Created skill ${input.name}`)
  return getSkillOrThrow(input.name)
}

export async function updateSkill(name: string, input: UpdateSkillInput): Promise<SkillDto> {
  assertName(name)
  const file = join(skillDir(name), 'SKILL.md')
  if (!(await exists(file))) throw notFound('Skill')
  await writeFile(file, skillToMarkdown(name, input.description, input.body), 'utf8')
  logger.info(`Updated skill ${name}`)
  return getSkillOrThrow(name)
}

export async function deleteSkill(name: string): Promise<void> {
  assertName(name)
  const dir = skillDir(name)
  if (!(await exists(join(dir, 'SKILL.md')))) throw notFound('Skill')

  // The directory *is* the skill, so bundled resources go with it. The UI warns
  // and lists them first.
  await rm(dir, { recursive: true, force: true })
  await unassignEverywhere('skill', name)
  logger.info(`Deleted skill ${name}`)
}

// --- per-project assignment ---------------------------------------------------
//
// Assignment writes symlinks into projects/<slug>/plugin/, which sits beside the
// repo rather than inside it, so the project's working tree is never dirtied.
// The library file stays the single source of truth: editing an agent changes it
// for every project that uses it, which is the whole point of a global library.

const pluginTarget = (slug: string, kind: 'agent' | 'skill', name: string) =>
  kind === 'agent'
    ? join(projectPlugin(slug), 'agents', `${name}.md`)
    : join(projectPlugin(slug), 'skills', name)

const librarySource = (kind: 'agent' | 'skill', name: string) =>
  kind === 'agent' ? agentPath(name) : skillDir(name)

async function linkItem(slug: string, kind: 'agent' | 'skill', name: string) {
  const target = pluginTarget(slug, kind, name)
  await ensureDir(join(projectPlugin(slug), kind === 'agent' ? 'agents' : 'skills'))
  await rm(target, { force: true, recursive: true })
  const { symlink } = await import('node:fs/promises')
  await symlink(librarySource(kind, name), target, kind === 'agent' ? 'file' : 'dir')
}

async function unlinkItem(slug: string, kind: 'agent' | 'skill', name: string) {
  await rm(pluginTarget(slug, kind, name), { force: true, recursive: true })
}

export async function getProjectLibrary(projectId: string): Promise<ProjectLibraryDto> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw notFound('Project')

  const rows = await db
    .select()
    .from(projectLibraryItems)
    .where(eq(projectLibraryItems.projectId, projectId))

  return {
    agents: rows
      .filter((r) => r.kind === 'agent')
      .map((r) => r.name)
      .sort(),
    skills: rows
      .filter((r) => r.kind === 'skill')
      .map((r) => r.name)
      .sort(),
  }
}

export async function setProjectLibrary(
  projectId: string,
  input: { agents: string[]; skills: string[] },
): Promise<ProjectLibraryDto> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw notFound('Project')

  // Assigning something that is not in the library would produce a dangling
  // symlink, so the names are checked against what actually exists.
  const knownAgents = new Set((await listAgents()).map((a) => a.name))
  const knownSkills = new Set((await listSkills()).map((s) => s.name))
  const missing = [
    ...input.agents.filter((n) => !knownAgents.has(n)).map((n) => `agent "${n}"`),
    ...input.skills.filter((n) => !knownSkills.has(n)).map((n) => `skill "${n}"`),
  ]
  if (missing.length > 0) throw badRequest(`Not in the library: ${missing.join(', ')}`)

  const current = await getProjectLibrary(projectId)

  const diff = (kind: 'agent' | 'skill', next: string[], prev: string[]) => ({
    added: next.filter((n) => !prev.includes(n)),
    removed: prev.filter((n) => !next.includes(n)),
    kind,
  })
  const changes = [
    diff('agent', input.agents, current.agents),
    diff('skill', input.skills, current.skills),
  ]

  for (const { kind, added, removed } of changes) {
    for (const name of added) {
      await linkItem(project.slug, kind, name)
      await db.insert(projectLibraryItems).values({ projectId, kind, name }).onConflictDoNothing()
    }
    for (const name of removed) {
      await unlinkItem(project.slug, kind, name)
      await db
        .delete(projectLibraryItems)
        .where(
          and(
            eq(projectLibraryItems.projectId, projectId),
            eq(projectLibraryItems.kind, kind),
            eq(projectLibraryItems.name, name),
          ),
        )
    }
  }

  logger.info(`Project ${project.slug} library updated`)
  return getProjectLibrary(projectId)
}

/** Remove an item from every project that used it, symlinks included. */
async function unassignEverywhere(kind: 'agent' | 'skill', name: string): Promise<void> {
  const rows = await db
    .select({ projectId: projectLibraryItems.projectId, slug: projects.slug })
    .from(projectLibraryItems)
    .innerJoin(projects, eq(projects.id, projectLibraryItems.projectId))
    .where(and(eq(projectLibraryItems.kind, kind), eq(projectLibraryItems.name, name)))

  for (const row of rows) {
    await unlinkItem(row.slug, kind, name)
  }
  await db
    .delete(projectLibraryItems)
    .where(and(eq(projectLibraryItems.kind, kind), eq(projectLibraryItems.name, name)))

  if (rows.length > 0) logger.info(`Unassigned ${kind} ${name} from ${rows.length} project(s)`)
}

/** How many projects use each item, for the library list. */
export async function usageCounts(): Promise<Map<string, number>> {
  const rows = await db.select().from(projectLibraryItems)
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.kind}:${row.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export { readdir, SKILLS_DIR }
