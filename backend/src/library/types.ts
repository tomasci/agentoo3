import { z } from 'zod'

// The mark you asked for. It is our own frontmatter field, not one Claude Code
// defines, which is fine because we parse these files ourselves and build the
// SDK's AgentDefinition from them.
//
//   orchestrator - may drive a session's main thread and delegate to subagents
//   subagent     - only reachable by delegation, never drives a session
export const agentRoleSchema = z.enum(['orchestrator', 'subagent'])
export type AgentRole = z.infer<typeof agentRoleSchema>

// Mirrors the SDK's AgentDefinition where the names overlap, so frontmatter maps
// straight onto it. `role` and `name` are ours.
export const agentFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  role: agentRoleSchema.default('subagent'),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
})
export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>

export const libraryAgentSchema = agentFrontmatterSchema.extend({
  name: z.string().min(1),
  // The markdown body: the agent's system prompt. Often long, which is exactly
  // why it lives in a file and not a database column.
  prompt: z.string(),
  path: z.string(),
})
export type LibraryAgent = z.infer<typeof libraryAgentSchema>

export const librarySkillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  // The markdown body of SKILL.md, without the frontmatter.
  body: z.string(),
  path: z.string(),
  // Files bundled beside SKILL.md. Listed so a delete can say what goes with
  // it; the UI never edits them.
  extraFiles: z.array(z.string()),
})
export type LibrarySkill = z.infer<typeof librarySkillSchema>

/**
 * A name that becomes a filename or a directory name.
 *
 * Checked like a path because it is one: the same rule that keeps an ssh key
 * name from escaping its directory applies here.
 */
export function checkLibraryName(name: string): { ok: boolean; reason?: string } {
  if (name.length === 0) return { ok: false, reason: 'Name is empty' }
  if (name.length > 64) return { ok: false, reason: 'Name is too long (max 64)' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return {
      ok: false,
      reason: 'Use lowercase letters, digits and dashes, starting with a letter or digit',
    }
  }
  return { ok: true }
}
