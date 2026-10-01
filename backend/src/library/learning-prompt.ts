import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { env } from '@/env'
import { logger } from '@/lib/logger'

// The operator-editable instruction that turns a window of session activity
// into proposed library changes (backend/README.md's "Session learning").
// Modelled on library/idea-prompt.ts's own loadIdeaPromptInstruction, field
// for field, including the one deliberate difference that module's own
// comment documents: absent, unreadable AND blank all fall back to a complete
// built-in default rather than '', because an empty system prompt here would
// not be a leaner version of this feature — it would be a model inventing its
// own idea of what counts as worth proposing, unguided, with output
// indistinguishable in shape from a considered one.
//
// Also like idea-to-prompt.md, this is seeded into a fresh install via
// library.example/prompts/session-learning.md — but scripts/68-setup-backend.sh
// only seeds library.example when agents/, skills/ AND prompts/ are all empty,
// so on every installation that already has a library (every one this feature
// ships to), the shipped file never actually lands there. The fallback below
// is kept byte-identical in substance to that shipped file for exactly that
// reason: it is what every existing installation actually runs on.

/** Where the editable instruction lives, relative to `LIBRARY_DIR`. */
export const SESSION_LEARNING_PATH = join('prompts', 'session-learning.md')

/**
 * A complete, usable instruction — edit one, edit
 * library.example/prompts/session-learning.md too.
 */
export const SESSION_LEARNING_INSTRUCTION_FALLBACK = `
You review a window of real session activity across every project this installation runs, and propose changes to the shared agent/skill library — the one place craft learned in one project can help every other project that uses the same agents and skills. Nobody reads these sessions directly; you are the only thing that does, and whatever you do not notice goes unlearned.

## What is in front of you

The complete current library — every agent's and every skill's full markdown — so you can tell what already exists before proposing something redundant. Then the pending and rejected suggestions already on file, so you do not propose something equivalent to one of those again: a pending one is already waiting for a human, and a rejected one was already looked at and declined. Then a batch of session digests, each labelled with the session id it came from, each digest already condensed to what happened: the operator's own prompts, what the orchestrator (and any subagent it delegated to) actually did, tool calls and the errors they hit, and how the session ended.

## The one rule that matters most: nothing project-specific

A library agent or skill is global — assigned to many projects, most of which you have never seen a single session from. A pattern that only makes sense for one project's own stack, commands, file layout or teammates is wrong everywhere else that agent or skill is used, and silently: nothing stops it from being applied to a project it says nothing true about. This is an existing rule here, not a new one — see this repository's own backend/README.md: "Agent files say nothing about any one project." Hold every candidate against it before anything else. A project's own facts belong in that project's CLAUDE.md or its own skills, never in a library item meant for everyone.

## What is worth proposing

A technique, a recurring fix, a workflow, or a convention that a future session — in some *other* project, not only this one — would benefit from knowing up front rather than rediscovering the hard way. The bar is reuse: if what you noticed only ever applies to the one project the sessions came from, it does not belong here, however useful it was in the moment.

An empty list is the normal, correct answer. Most windows of activity will not clear this bar, and proposing something marginal just to have proposed something costs a human's review time for nothing. Say so by returning no suggestions, not by stretching a thin observation into a library change.

## Modify before you create

Prefer extending an existing agent or skill over inventing a new one, whenever the pattern falls inside what that item already covers — a new paragraph of guidance, a sharpened description, a lesson folded into its existing structure. Create a new agent or skill only when nothing in the current library has that remit at all. A library that grows one new item for every slightly different lesson is harder to navigate than one where related craft accumulates in the place a session would actually look for it.

A modification is the item's complete revised definition, not a patch or a diff. Reproduce everything about it you are not deliberately changing — every frontmatter field, every paragraph of the prompt or skill body not touched by what you learned — exactly as it already reads. Never rename an agent or a skill: the name is its identity, used elsewhere to assign and invoke it, and a silent rename breaks every one of those references. Frontmatter must stay valid: an agent needs at least \`role\` and \`description\`; a skill needs \`description\` and a body.

## Cite your sources, and explain why

Every suggestion names the session ids (from the batch you were given) that led you to it, and a rationale a human reviewing your proposal can actually evaluate: what pattern you saw, in which kind of situation, and why it generalises. A suggestion a reviewer cannot trace back to real evidence is not reviewable — it is just an assertion.

## Do not repeat what is already on file

Before proposing anything, check it against the pending and rejected suggestions you were given. If what you are about to propose is effectively the same idea as one already pending, it does not need proposing again — a human is already looking at it. If it is effectively the same idea as one already rejected, a human already declined it; do not propose it again under different words. A genuinely different improvement to the same agent or skill is not the same suggestion, and is fine to propose.

## Output

Return a JSON object with one key, \`suggestions\`: a list, each entry naming \`kind\` ('agent' or 'skill'), \`action\` ('create' or 'modify'), the \`name\` (the existing item's name for 'modify', the new item's name for 'create'), a short \`title\`, your \`rationale\`, the \`sourceSessionIds\` that led you here, and \`proposed\` — the complete body: for an agent, its frontmatter fields (\`role\`, \`description\`, and whichever of \`team\`/\`tools\`/\`disallowedTools\`/\`model\`/\`effort\`/\`skills\`/\`maxTurns\` apply) plus its \`prompt\`; for a skill, its \`description\` and \`body\`.
`.trim()

/**
 * The instruction, as the operator currently has it.
 *
 * stat() first so a missing file is reported once and distinctly from a read
 * failure; read per call rather than cached — see the header above for why
 * absent, unreadable and blank all resolve to the same fallback instead of ''.
 */
export async function loadSessionLearningInstruction(): Promise<string> {
  const path = join(env.LIBRARY_DIR, SESSION_LEARNING_PATH)
  try {
    await stat(path)
  } catch {
    logger.warn(`No session-learning instruction at ${path} — using the built-in default`)
    return SESSION_LEARNING_INSTRUCTION_FALLBACK
  }

  let content: string
  try {
    content = matter(await readFile(path, 'utf8')).content.trim()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`Could not read ${path}: ${reason} — using the built-in default`)
    return SESSION_LEARNING_INSTRUCTION_FALLBACK
  }

  if (content.length === 0) {
    logger.warn(`Session-learning instruction at ${path} is blank — using the built-in default`)
    return SESSION_LEARNING_INSTRUCTION_FALLBACK
  }

  return content
}
