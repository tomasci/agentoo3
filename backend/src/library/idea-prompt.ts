import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { env } from '@/env'
import { logger } from '@/lib/logger'

// The operator-editable instruction that turns a serialized idea (see
// features/ideas/serialize.ts) into a single development prompt for an
// orchestrator session. Modelled on loadOrchestratorMethod in
// library/orchestrator-prompt.ts: read fresh per call, never cached, so an
// operator editing the file on disk takes effect on the very next generation
// rather than the next restart of the process that holds it.
//
// One deliberate difference from that precedent. loadOrchestratorMethod
// returns '' when its file is absent, because an operator who deleted the
// shared method has opted out of it — an orchestrator still runs fine
// without it, just without that shared craft layered in. There is no
// equivalent opt-out here. An idea with no instruction is not a leaner
// version of this feature; it is a one-shot call with an empty system
// prompt, which produces whatever a model invents unguided — output
// indistinguishable in shape from a considered one, handed straight into a
// session as if it had been. So absent, unreadable, AND blank all fall back
// to a complete built-in default instead of ''.
//
// That default also has to carry every existing installation, not just a
// fresh one. scripts/68-setup-backend.sh only seeds library.example into
// LIBRARY_DIR when agents/, skills/ AND prompts/ are all empty on that box —
// so on any deployment that already has a library (every one this feature
// ships to, since it ships after the initial install),
// prompts/idea-to-prompt.md added to library.example never actually lands
// there. That makes IDEA_PROMPT_INSTRUCTION_FALLBACK below not a stub for
// tests but the thing that makes this feature work at all until an operator
// chooses to add the file themselves.

/** Where the editable instruction lives, relative to `LIBRARY_DIR`. */
export const IDEA_PROMPT_PATH = join('prompts', 'idea-to-prompt.md')

/**
 * A complete, usable instruction — not a stub — kept byte-identical in
 * substance to `library.example/prompts/idea-to-prompt.md` on purpose: this
 * is what every existing installation actually runs on, since the seed step
 * described above never reaches them. Edit one, edit the other.
 */
export const IDEA_PROMPT_INSTRUCTION_FALLBACK = `
You are turning one idea from a project's canvas into a single development prompt for an orchestrator agent, and the two of you never meet. It runs with none of this conversation, no view of the canvas the user built, and no way to come back and ask what a note meant — whatever you hand it in \`prompt\` is the whole of what it knows about the work, plus whatever it can discover on its own once it starts reading the project. Write for that agent, not for the person who built the canvas.

## Requirement and thought are not the same word

The document below is already ordered — ungrouped material first, then each of the user's groups under its own heading — and every block is labelled with what kind of thing it is. A block marked "Requirement" is something the finished work must satisfy; treat it as a constraint on the result, not a suggestion. A "Note" or an "Example" is context that can shape how the work gets done without being a rule it must obey, and a "Link" is something worth reading before starting, not necessarily something to implement. Keep that distinction alive in the prompt you write: an orchestrator that cannot tell a hard requirement from a passing thought will happily satisfy the thought and miss the requirement, and there is nobody left to catch it.

Any attached file appears by its filename in the document, sometimes on its own and sometimes referenced by a block. Carry that filename into the prompt exactly as given. A prompt that describes an image without naming it hands the orchestrator a session where the file exists on disk and nothing in its instructions says to open it.

## Resolve every open question yourself

This canvas will leave things unsettled — a note gesturing at two directions without picking one, a requirement silent on which library or pattern to use, a group that assumes a piece the canvas never actually built. You get one pass at this material and no way to ask the user what they meant, and the orchestrator you are writing for is in the same position: it works headless, alone, and a question left in the prompt is a session that hangs waiting for an answer nobody is coming to give. So do not leave the question in the prompt. Read the whole canvas, pick the option that best fits everything else the user wrote, and write the prompt as an instruction to build that — not as a menu, and not as a question wearing a period.

Every time you decide something the user did not spell out, put it in \`assumptions\` as its own sentence, written for the user reading it back later on their idea card rather than for yourself: "Assumed the export button belongs in the existing toolbar next to Save" tells them what you chose and lets them correct it if you chose wrong. A prompt with no assumptions recorded should mean the canvas genuinely left nothing open, not that the choices went unlogged.

## Write the whole brief, not a pointer to one

\`prompt\` has to stand on its own. State the goal in your own words instead of gesturing back at "the idea above" — there is no above once this leaves your hands. Fold the requirements in as things the work must satisfy, the notes and examples in as context worth knowing, and the linked material and named files in as things worth reading before writing any code. A thin canvas does not earn a thin prompt: three sentences of raw material still deserve a complete instruction, including what "done" looks like, because the orchestrator will not get a second pass at the user for the parts you left out.

If what you are given also carries a prompt already sent, a summary of what a session did with it, and new comments the user added since, you are writing the next message into that same session rather than starting one — fold the new feedback into a clear instruction for what changes now, treating anything the digest says is already done as settled rather than asking for it again, and keep deciding rather than asking exactly as above.

## title names the session, to a person skimming a list

\`title\` becomes the name the user sees for the session this prompt starts, sitting in a list beside every other session they have running. Make it short, specific to what this idea actually is, and legible out of context — tightening the idea's own title is usually right where that title is short; inventing a better one is usually right where it is not.
`.trim()

/**
 * The model's structured answer to a one-shot idea-to-prompt (or follow-up)
 * call. Parsed here rather than cast, so a change in what the model actually
 * returns fails at this boundary instead of surfacing three layers deeper as
 * a malformed session prompt.
 */
export const ideaPromptAnswerSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  assumptions: z.array(z.string()),
})
export type IdeaPromptAnswer = z.infer<typeof ideaPromptAnswerSchema>

/**
 * The instruction, as the operator currently has it.
 *
 * stat() first so a missing file is reported once and distinctly from a read
 * failure; read per call rather than cached — see the header above for why
 * absent, unreadable and blank all resolve to the same fallback instead of
 * ''.
 */
export async function loadIdeaPromptInstruction(): Promise<string> {
  const path = join(env.LIBRARY_DIR, IDEA_PROMPT_PATH)
  try {
    await stat(path)
  } catch {
    logger.warn(`No idea-to-prompt instruction at ${path} — using the built-in default`)
    return IDEA_PROMPT_INSTRUCTION_FALLBACK
  }

  let content: string
  try {
    // Tolerate frontmatter, same as loadOrchestratorMethod, so the file can
    // carry metadata later without it leaking into what the model reads.
    content = matter(await readFile(path, 'utf8')).content.trim()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`Could not read ${path}: ${reason} — using the built-in default`)
    return IDEA_PROMPT_INSTRUCTION_FALLBACK
  }

  if (content.length === 0) {
    logger.warn(`Idea-to-prompt instruction at ${path} is blank — using the built-in default`)
    return IDEA_PROMPT_INSTRUCTION_FALLBACK
  }

  return content
}
