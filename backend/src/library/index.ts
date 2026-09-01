import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import { agentFrontmatterSchema, type LibraryAgent, type LibrarySkill } from './types'

export const AGENTS_DIR = () => join(env.LIBRARY_DIR, 'agents')
export const SKILLS_DIR = () => join(env.LIBRARY_DIR, 'skills')

/**
 * Build a path inside a library directory, refusing anything that escapes it.
 *
 * The check lives here rather than only at the API boundary because this is the
 * one place every caller passes through. Validation on create alone was not
 * enough: the routes that take a name as a *path parameter* skipped it, which
 * made `PUT /library/agents/../../../../etc/cron.d/x` an arbitrary file write
 * and the skill delete an `rm -rf` of an arbitrary directory. Callers still
 * validate the name for a good error message; this makes the unsafe operation
 * impossible regardless of who forgets.
 */
function insideLibrary(dir: string, child: string): string {
  const root = resolve(dir)
  const target = resolve(join(root, child))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to touch ${target}, which is outside ${root}`)
  }
  return target
}

export const agentPath = (name: string) => insideLibrary(AGENTS_DIR(), `${name}.md`)
export const skillDir = (name: string) => insideLibrary(SKILLS_DIR(), name)

/** A one-line reason, rather than a wall of Zod issue JSON in the log. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Every agent in the library. A malformed file is reported and skipped, not fatal. */
export async function listAgents(): Promise<LibraryAgent[]> {
  const dir = AGENTS_DIR()
  if (!(await exists(dir))) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const agents: LibraryAgent[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(dir, entry.name)
    try {
      const raw = await readFile(path, 'utf8')
      const { data, content } = matter(raw)
      const fm = agentFrontmatterSchema.parse(data)
      agents.push({
        ...fm,
        // Frontmatter `name` wins; otherwise the filename is the name.
        name: fm.name ?? basename(entry.name, '.md'),
        prompt: content.trim(),
        path,
      })
    } catch (error) {
      logger.warn(`Skipping ${path} — ${describeError(error)}`)
    }
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every skill in the library. A skill is a directory containing SKILL.md. */
export async function listSkills(): Promise<LibrarySkill[]> {
  const dir = SKILLS_DIR()
  if (!(await exists(dir))) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const skills: LibrarySkill[] = []

  for (const entry of entries) {
    // A symlinked skill reports as a symlink, not a directory.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    const skillFile = join(path, 'SKILL.md')
    if (!(await exists(skillFile))) continue
    try {
      const { data, content } = matter(await readFile(skillFile, 'utf8'))
      const siblings = (await readdir(path, { withFileTypes: true }))
        .filter((f) => f.isFile() && f.name !== 'SKILL.md')
        .map((f) => f.name)
        .sort()
      skills.push({
        name: typeof data.name === 'string' ? data.name : entry.name,
        description: typeof data.description === 'string' ? data.description : '',
        body: content.trim(),
        path,
        extraFiles: siblings,
      })
    } catch (error) {
      logger.warn(
        `Skipping ${skillFile}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getAgent(name: string): Promise<LibraryAgent | undefined> {
  const agents = await listAgents()
  return agents.find((a) => a.name === name)
}

export const orchestrators = (agents: LibraryAgent[]) =>
  agents.filter((a) => a.role === 'orchestrator')
export const subagents = (agents: LibraryAgent[]) => agents.filter((a) => a.role === 'subagent')

// --- writing ------------------------------------------------------------------

/**
 * Serialise an agent back to markdown.
 *
 * gray-matter's stringify is used rather than hand-rolled YAML so a description
 * containing a colon, or a prompt containing `---`, cannot corrupt the file.
 * `name` is deliberately not written: the filename is the name, and storing it
 * twice invites the two to disagree.
 */
export function agentToMarkdown(agent: Omit<LibraryAgent, 'path' | 'name'>): string {
  const { prompt, ...frontmatter } = agent
  // Drop empty optionals so the file stays readable rather than accumulating
  // `tools: null` noise.
  const data = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null),
  )
  return matter.stringify(`\n${prompt.trim()}\n`, data)
}

export function skillToMarkdown(name: string, description: string, body: string): string {
  return matter.stringify(`\n${body.trim()}\n`, { name, description })
}
