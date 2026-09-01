import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import { agentFrontmatterSchema, type LibraryAgent, type LibrarySkill } from './types'

const AGENTS_DIR = () => join(env.LIBRARY_DIR, 'agents')
const SKILLS_DIR = () => join(env.LIBRARY_DIR, 'skills')

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
      const { data } = matter(await readFile(skillFile, 'utf8'))
      skills.push({
        name: typeof data.name === 'string' ? data.name : entry.name,
        description: typeof data.description === 'string' ? data.description : '',
        path,
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
