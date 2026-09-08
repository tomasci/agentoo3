// Operator-editable instruction files, exposed as a small registry rather than
// a free-form "read any file under LIBRARY_DIR/prompts" API.
//
// A prompt file is a fixed-name singleton — never listed as a collection,
// never assigned to a project, never materialised into a plugin directory —
// unlike the two real library kinds (agents, skills). Routing it through the
// library's create/rename/delete-by-name machinery would mean threading "not
// this kind" guards through materialise, renameItem and setProjectLibrary for
// no reason: this file is the whole surface a prompt needs, singleton and all.
//
// KNOWN_PROMPTS is what makes that hold. A name is only ever looked up here —
// never handed to the filesystem on its own — so a second known prompt is a
// one-line addition, and an unregistered name 404s before promptPath() (the
// library's own outside-the-root guard, library/index.ts) is even reached.

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import matter from 'gray-matter'
import { badRequest, notFound } from '@/lib/errors'
import { ensureDir } from '@/lib/git'
import { logger } from '@/lib/logger'
import { PROMPTS_DIR, promptPath } from '@/library'
import { IDEA_PROMPT_INSTRUCTION_FALLBACK } from '@/library/idea-prompt'
import { checkLibraryName } from '@/library/types'
import type { PromptDto, UpdatePromptInput } from './schema'

const KNOWN_PROMPTS: Record<string, { fallback: string }> = {
  'idea-to-prompt': { fallback: IDEA_PROMPT_INSTRUCTION_FALLBACK },
}

/** A 400 naming the rule beats a 500 from promptPath's path guard. */
function assertName(name: string): void {
  const check = checkLibraryName(name)
  if (!check.ok) throw badRequest(check.reason ?? 'Invalid name')
}

function knownOrThrow(name: string): { fallback: string } {
  const known = KNOWN_PROMPTS[name]
  if (!known) throw notFound('Prompt')
  return known
}

/**
 * The saved file's content, or undefined if there is nothing usable to show —
 * absent, unreadable, or blank all count as "nothing saved" here, mirroring
 * loadIdeaPromptInstruction exactly: the point of `source` is to tell the
 * operator which text a real generation call would actually run on, so this
 * has to fall back in precisely the same cases that loader does, or the UI
 * could show `source: 'file'` for a file the loader itself ignores.
 */
async function readSavedPrompt(path: string): Promise<string | undefined> {
  try {
    await stat(path)
  } catch {
    return undefined
  }

  try {
    const content = matter(await readFile(path, 'utf8')).content.trim()
    return content.length > 0 ? content : undefined
  } catch (error) {
    logger.warn(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function getPrompt(name: string): Promise<PromptDto> {
  assertName(name)
  const { fallback } = knownOrThrow(name)

  const path = promptPath(name)
  const saved = await readSavedPrompt(path)
  return saved === undefined
    ? { name, body: fallback, path, source: 'default' }
    : { name, body: saved, path, source: 'file' }
}

export async function updatePrompt(name: string, input: UpdatePromptInput): Promise<PromptDto> {
  assertName(name)
  knownOrThrow(name)

  await ensureDir(PROMPTS_DIR())
  await writeFile(promptPath(name), `${input.body}\n`, 'utf8')
  logger.info(`Updated prompt ${name}`)
  return getPrompt(name)
}

/** Deletes the file rather than writing the default back into it, so the
 * default stays a single source of truth (the fallback constant) instead of a
 * copy that can drift from it. */
export async function resetPrompt(name: string): Promise<PromptDto> {
  assertName(name)
  knownOrThrow(name)

  await rm(promptPath(name), { force: true })
  logger.info(`Reset prompt ${name} to its built-in default`)
  return getPrompt(name)
}
