import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { env } from '@/env'
import { logger } from '@/lib/logger'

// Composition for `role: orchestrator` prompts. Four parts, three homes.
//
// The METHOD — how to run a team of agents — is a prompt, and prompts live in
// the library as markdown so they can be tuned with a commit instead of a
// deploy. It is not hardcoded here on purpose.
//
// The ROSTER is neither: it is a fact about this project, and only the platform
// knows it. Agents are global and reusable, assigned per project, so no agent
// file can name its teammates without being wrong for every project that made a
// different selection. Composed in from the assignment instead.
//
// The two INSTRUCTIONS below are hardcoded, because they are not craft the
// operator is meant to tune. They are the guarantees the platform makes about
// how a headless session behaves, and they are two paragraphs, not a doctrine.

/** Where the editable method lives, relative to `LIBRARY_DIR`. */
export const METHOD_PATH = join('prompts', 'orchestration-method.md')

// Claude Code adds a delegation instruction of its own ONLY under its
// `claude_code` system-prompt preset, so a custom prompt gets no policy at all.
//
// Anthropic documents a general-purpose instruction for this slot that pushes the
// model AWAY from delegating (see the Opus 5 prompting guide). We invert it on
// purpose: that text is written for an agent doing the work itself, where a
// subagent is overhead. An orchestrator's whole job is routing work to
// specialists, and a reluctant orchestrator is just a slow single agent. Cost is
// held by the caps below instead — the lever that does not argue with the role.
export const DELEGATION_INSTRUCTION = `You are an orchestrator: delegating is your job, not a fallback. Route the execution of the work — investigation, implementation, testing, documentation — to the specialists available to you, and send independent pieces in a single turn so they run in parallel. Spend your own tool calls on reading enough to plan and on verifying what comes back, not on doing a specialist's work for them. A subagent starts with a fresh context and sees nothing of this conversation, so each brief must be self-contained: the goal, the paths, the decisions already made, what "done" means in checkable terms, and what belongs to another agent.`

// A session here runs headless on a server, frequently with no human watching,
// so a question is not a pause — it is a hang that burns the session.
//
// The failure this guards against is not asking, though; it is an agent treating
// a missing secret as permission to stop. A credential it was not given blocks
// running and verifying the work, almost never building it, and those are very
// different outcomes to hand back.
export const AUTONOMY_INSTRUCTION = `Work autonomously and deliver the task finished. Never ask for permission, confirmation, or clarification: resolve ambiguity by investigating the project and deciding, then record the assumption. Missing credentials and unreachable services are a constraint on what you can run, not on what you can build — implement the work in full against the documented interface, keep secrets out of the code, and finish it. Where something genuinely cannot be exercised without access you do not have, say in the final report what is unverified and what it would take to verify. "I could not run it" is a caveat on a completed task, never a reason to hand back less of one.`

/** One line of the roster: how to address the agent, and what it is for. */
export type Specialist = { name: string; description: string }

/**
 * The team, as this project actually has it.
 *
 * Without this an orchestrator is told to delegate and left to guess to whom.
 * Claude Code does list the loaded agents in its Agent tool description, but
 * that arrives as tool metadata rather than as part of the brief the model plans
 * against, and it is discovered — if at all — after the plan is already shaped.
 * Naming the roster in the system prompt makes the first plan concrete, and it
 * is the only version of the list that cannot be stale: it is read from the
 * files this session is about to load.
 *
 * Names are the plugin-qualified ones (`agentoo:tester`), because that is what
 * resolves at delegation time.
 *
 * Empty is a real configuration, not an error — a project can be given an
 * orchestrator and no specialists — so it gets a sentence rather than silence.
 * Silence would leave the delegation instruction pointing at nothing, and an
 * orchestrator with no Edit or Write tool and no team is a session that stalls.
 */
export function rosterInstruction(specialists: Specialist[]): string {
  if (specialists.length === 0) {
    return `No specialists are assigned to this project, so the roster your delegation instruction refers to is whatever general-purpose agents the harness itself provides. Use those, and say in your final report that this project has no specialists assigned — that is a configuration gap worth fixing, not a reason to stop.`
  }
  const lines = specialists.map((s) => `- ${s.name} — ${s.description}`).join('\n')
  return `These specialists are assigned to this project, and they are the whole roster. Address one by the exact name shown; a name that is not on this list resolves to nothing, however standard the role sounds.\n\n${lines}\n\nRoles nobody here fills are yours to cover by re-scoping the briefs you do send, and worth naming in your final report. Do not invent an agent to fill the gap.`
}

const METHOD_MARKER = '<!-- agentoo:orchestrator:method -->'
const RULES_MARKER = '<!-- agentoo:orchestrator:rules -->'

/**
 * The shared orchestration method, as the operator currently has it.
 *
 * Absent or unreadable is not fatal: an operator who deletes the file has opted
 * out of the method, and their orchestrators still get the guarantees below.
 * Read per composition rather than cached, so editing the file takes effect on
 * the next session instead of the next restart.
 */
export async function loadOrchestratorMethod(): Promise<string> {
  const path = join(env.LIBRARY_DIR, METHOD_PATH)
  try {
    await stat(path)
  } catch {
    logger.warn(`No orchestration method at ${path} — orchestrators run without it`)
    return ''
  }
  try {
    // Tolerate frontmatter so the file can carry metadata later without the
    // whole block leaking into the prompt.
    return matter(await readFile(path, 'utf8')).content.trim()
  } catch (error) {
    logger.warn(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

/**
 * Compose a complete orchestrator system prompt: the method, the agent's own
 * markdown, then the roster and the two non-negotiables.
 *
 * The order is the point. The method goes first as a default the agent's own
 * words can refine or contradict. Delegation, roster and autonomy go last,
 * because they are guarantees and facts rather than advice — an orchestrator
 * that quietly stops to ask a question nobody is there to answer is a hung
 * session, not a style choice, and one that invents a teammate is a failed turn.
 *
 * `leadsTeam: false` drops the method, the delegation instruction and the
 * roster, which for a solo agent are not merely unnecessary but wrong: they tell
 * it to hand off work it was created to do itself. Autonomy stays, because it is
 * about how a headless session behaves, not about how many agents are in it.
 *
 * Pure, so the composition is testable without a library on disk. Idempotent:
 * re-composing an already-composed prompt returns it unchanged.
 */
export function withOrchestratorGuidance(
  prompt: string,
  method: string,
  leadsTeam = true,
  specialists: Specialist[] = [],
): string {
  if (prompt.includes(METHOD_MARKER) || prompt.includes(RULES_MARKER)) return prompt
  const own = prompt.trim()
  const base = leadsTeam ? method.trim() : ''
  return [
    ...(base ? [METHOD_MARKER, base, ''] : []),
    // The heading only earns its place under the method, where it marks the
    // switch from the shared craft to this agent's own standards. Alone at the
    // top of a solo agent's prompt it is just noise.
    ...(own ? (base ? ['# This agent', '', own, ''] : [own, '']) : []),
    RULES_MARKER,
    ...(leadsTeam
      ? [
          `<delegation>\n${DELEGATION_INSTRUCTION}\n</delegation>`,
          `<team>\n${rosterInstruction(specialists)}\n</team>`,
        ]
      : []),
    `<autonomy>\n${AUTONOMY_INSTRUCTION}\n</autonomy>`,
    '',
  ].join('\n')
}

/**
 * Convenience for the common path: load the method, compose against it.
 *
 * A solo agent (`team: false`) skips the read entirely — there is nothing to
 * warn about when it is missing something it was never going to use, and no
 * roster to give an agent that delegates to nobody.
 */
export async function composeOrchestratorPrompt(
  prompt: string,
  leadsTeam = true,
  specialists: Specialist[] = [],
): Promise<string> {
  const method = leadsTeam ? await loadOrchestratorMethod() : ''
  return withOrchestratorGuidance(prompt, method, leadsTeam, specialists)
}

// Prompting only steers, so the ceiling on fan-out is enforced, not asked for.
// This is what makes an always-delegate orchestrator affordable. Passed through
// the SDK's `env` option. Defaults are 3 and 20 respectively, which is far more
// concurrency than a single-box deployment wants.
export function delegationEnv(maxDepth: number, maxConcurrent: number): Record<string, string> {
  return {
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(maxDepth),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(maxConcurrent),
  }
}
