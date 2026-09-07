import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
import { ensurePluginManifest } from '@/queue/plugin-manifest'
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
  if (!(await exists(agentPath(name)))) throw notFound('Agent')

  const finalName =
    input.name && input.name !== name ? await renameItem('agent', name, input.name) : name
  await writeFile(agentPath(finalName), agentToMarkdown(input), 'utf8')
  logger.info(`Updated agent ${finalName}`)
  return getAgentOrThrow(finalName)
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
  if (!(await exists(join(skillDir(name), 'SKILL.md')))) throw notFound('Skill')

  const finalName =
    input.name && input.name !== name ? await renameItem('skill', name, input.name) : name
  await writeFile(
    join(skillDir(finalName), 'SKILL.md'),
    // The name lives in the frontmatter too for skills, so it has to follow.
    skillToMarkdown(finalName, input.description, input.body),
    'utf8',
  )
  logger.info(`Updated skill ${finalName}`)
  return getSkillOrThrow(finalName)
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

/**
 * Copy a library item into a project's plugin directory.
 *
 * These used to be symlinks, which read better — one source of truth, no
 * copies to keep in step — but Claude Code does not load a symlinked agent
 * *file*. Verified against the bundled CLI: with `scout.md` as a real file the
 * session reports `agentoo:scout` among its agents; replace it with a symlink to
 * the identical file and it silently disappears. Symlinked skill *directories*
 * do load, so the behaviour is asymmetric, but copying both keeps one rule
 * rather than two and a surprise later.
 *
 * The library file stays the source of truth. Nothing edits these copies: they
 * are rebuilt from the library by syncProjectPlugin, which runs when the
 * selection changes and again as a session starts, so a centrally edited agent
 * reaches every project on its next run.
 *
 * An agent publishes by rename, a skill by rm-then-cp, because the two
 * targets are different kinds of filesystem object and only one of them can
 * be replaced atomically:
 *
 * - An agent target is a single file, so it copies to a temp name in the same
 *   `agents/` directory and rename()s over the target. rename() replaces an
 *   existing file atomically, so a concurrent reader — another session's turn
 *   whose own syncProjectPlugin call lands mid-write — sees either the whole
 *   old file or the whole new one, never a moment with none at all. That gap
 *   is exactly what plain rm-then-cp used to expose, harmlessly while at most
 *   one turn ever ran at a time, live now that turns in one project can
 *   overlap.
 * - A skill target is a directory, and rename(2) fails with ENOTEMPTY over an
 *   existing non-empty directory, so there is no equivalent atomic swap here.
 *   This keeps rm-then-cp; syncProjectPlugin below serializes calls per slug
 *   so at least two overlapping syncs in this process cannot interleave their
 *   rm and cp against the same directory. See the comment there for what that
 *   does and does not cover.
 */
async function materialise(slug: string, kind: 'agent' | 'skill', name: string) {
  const target = pluginTarget(slug, kind, name)
  const dir = join(projectPlugin(slug), kind === 'agent' ? 'agents' : 'skills')
  await ensureDir(dir)

  if (kind === 'skill') {
    await rm(target, { force: true, recursive: true })
    await cp(librarySource(kind, name), target, { recursive: true })
    return
  }

  const tempPath = join(dir, `.tmp-${randomUUID()}-${name}.md`)
  try {
    await cp(librarySource(kind, name), tempPath)
    await rename(tempPath, target)
  } catch (error) {
    // A failed copy must not leave a stray temp file for the next sync — or a
    // person browsing the plugin directory by hand — to trip over.
    await rm(tempPath, { force: true })
    throw error
  }
}

async function unlinkItem(slug: string, kind: 'agent' | 'skill', name: string) {
  await rm(pluginTarget(slug, kind, name), { force: true, recursive: true })
}

/**
 * Rebuild a project's plugin directory from the library and the current
 * selection, and drop anything no longer selected.
 *
 * Cheap — a handful of small markdown files — and it makes the directory a
 * derived artefact rather than state to keep in step by hand. Anything that
 * drifted (a failed copy, a hand-edited file, an item renamed underneath us)
 * is corrected on the next run rather than persisting.
 */
async function runProjectPluginSync(slug: string, projectId: string): Promise<void> {
  await ensurePluginManifest(slug)

  const rows = await db
    .select({ kind: projectLibraryItems.kind, name: projectLibraryItems.name })
    .from(projectLibraryItems)
    .where(eq(projectLibraryItems.projectId, projectId))

  // Orchestrators are never materialised, however they were assigned. The SDK
  // offers every agent in the plugin directory as a delegation target, so
  // copying the lead's own file put `agentoo:orchestrator` in the session's
  // agent list — a copy of itself to hand work to, with only the spawn-depth
  // cap between that and a loop. An orchestrator reaches its session as
  // `systemPrompt`, composed from the library copy in `optionsFor`, so it needs
  // nothing here in order to run.
  const orchestratorNames = new Set(
    (await listAgents()).filter((a) => a.role === 'orchestrator').map((a) => a.name),
  )

  for (const kind of ['agent', 'skill'] as const) {
    const dir = join(projectPlugin(slug), kind === 'agent' ? 'agents' : 'skills')
    await ensureDir(dir)

    const wanted = new Set(
      rows
        .filter((r) => r.kind === kind && !(kind === 'agent' && orchestratorNames.has(r.name)))
        .map((r) => r.name),
    )
    const present = await readdir(dir).catch(() => [] as string[])

    for (const entry of present) {
      // A `.tmp-` name is another materialise() call's in-flight publish —
      // this sync's own next loop, below, or a concurrent setProjectLibrary /
      // renameItem call that (unlike syncProjectPlugin itself) is not queued
      // against this one — never a stale item to prune. Sweeping it here
      // would delete that write's source out from under its own rename(),
      // turning the crash-safety materialise() relies on into a spurious
      // ENOENT instead.
      if (entry.startsWith('.tmp-')) continue
      const name = kind === 'agent' ? entry.replace(/\.md$/, '') : entry
      if (!wanted.has(name)) await rm(join(dir, entry), { force: true, recursive: true })
    }

    for (const name of wanted) {
      // A selection pointing at something no longer in the library should not
      // fail the session; skip it and let the rest load.
      try {
        await materialise(slug, kind, name)
      } catch (error) {
        logger.warn(`Could not copy ${kind} "${name}" into ${slug}: ${String(error)}`)
      }
    }
  }
}

/**
 * In-flight syncs, keyed by project slug, each chained onto the previous
 * rather than left to run alongside it.
 *
 * `runProjectPluginSync` is now called at the start of every turn
 * (runner-options.ts), and its plugin directory is shared by every session in
 * the project — raising the machine-wide concurrency cap above 1 means two
 * turns in the same project can call it at the same time. Chaining here
 * closes that for the skill-directory case, where `materialise` above cannot
 * publish atomically and two overlapping rm-then-cp passes on the same
 * directory could otherwise interleave.
 *
 * This closes only the window between two syncs racing *in this process* —
 * the chain lives in memory, so a second worker process running the same
 * project's sync at the same time is not covered (there is exactly one
 * worker process today).
 *
 * It does not touch a different window at all: turn A's sync rewriting a
 * skill directory while turn B's Claude Code process, already running and
 * having read that directory when its own turn started, lazily reads a skill
 * file out of it minutes later. Nothing here serializes a sync against a
 * session that is mid-turn, only against another sync — and a per-process
 * lock could not fix that even if it tried, since the reader on the other
 * side is a live CLI subprocess with no sync of its own to queue behind. The
 * structural fix is a plugin directory per session instead of per project, so
 * there is no directory left for a sync to rewrite out from under a running
 * one — a path-contract change with a real per-session disk cost, deliberately
 * deferred until there is a concrete reason to pay it: evidence of an agent or
 * skill actually going missing mid-turn, not just this analysis.
 */
const pluginSyncChains = new Map<string, Promise<void>>()

export function syncProjectPlugin(slug: string, projectId: string): Promise<void> {
  const previous = pluginSyncChains.get(slug) ?? Promise.resolve()
  // The previous call's own failure is swallowed here so it cannot stop this
  // one from running — this is a serialization queue, not a shared outcome.
  // The caller of *this* call still observes its own failure, through the
  // rejection of `next` returned below.
  const next = previous.catch(() => {}).then(() => runProjectPluginSync(slug, projectId))
  pluginSyncChains.set(slug, next)
  // Drop the entry once this call settles, but only if it is still the tail —
  // a call already chained onto `next` owns the map slot now, and clearing it
  // out from under that call would let a later, unrelated caller start a
  // fresh chain and run alongside the queued one instead of after it.
  next
    .catch(() => {})
    .finally(() => {
      if (pluginSyncChains.get(slug) === next) pluginSyncChains.delete(slug)
    })
  return next
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
      await materialise(project.slug, kind, name)
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

/**
 * Rename a library item, moving the file and following it everywhere.
 *
 * The name is the filename, so a rename is a move — and every project using the
 * item holds a symlink whose *target is the old absolute path* and whose own
 * filename is the old name. Both have to be rebuilt, or the rename would leave
 * a trail of dangling links and the SDK would report a plugin that half-loads.
 */
async function renameItem(kind: 'agent' | 'skill', from: string, to: string): Promise<string> {
  assertName(to)

  const fromPath = kind === 'agent' ? agentPath(from) : skillDir(from)
  const toPath = kind === 'agent' ? agentPath(to) : skillDir(to)

  const taken = kind === 'agent' ? await exists(toPath) : await exists(join(toPath, 'SKILL.md'))
  if (taken) throw conflict(`A ${kind} named "${to}" already exists`)

  await rename(fromPath, toPath)

  // Re-point every project that used it, then rename the rows.
  const users = await db
    .select({ projectId: projectLibraryItems.projectId, slug: projects.slug })
    .from(projectLibraryItems)
    .innerJoin(projects, eq(projects.id, projectLibraryItems.projectId))
    .where(and(eq(projectLibraryItems.kind, kind), eq(projectLibraryItems.name, from)))

  for (const user of users) {
    await unlinkItem(user.slug, kind, from)
    await materialise(user.slug, kind, to)
  }

  await db
    .update(projectLibraryItems)
    .set({ name: to })
    .where(and(eq(projectLibraryItems.kind, kind), eq(projectLibraryItems.name, from)))

  logger.info(`Renamed ${kind} ${from} -> ${to}, refreshed in ${users.length} project(s)`)
  return to
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
