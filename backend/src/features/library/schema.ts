// z comes from @hono/zod-openapi, not plain zod: its .openapi() is an
// instance-level patch (extendZodWithOpenApi mutates ZodType.prototype as a
// side effect of importing this module), so a schema built from this file's
// own z is guaranteed patched by the time its own top-level code runs. Do not
// call .openapi() on agentRoleSchema itself (built with plain zod in
// library/types.ts, which the CLI-format loaders also read) — whether that
// succeeds would depend on which module happened to import
// '@hono/zod-openapi' first, and this file is now loaded by both the API
// routes and the worker process, which load things in a different order.
import { z } from '@hono/zod-openapi'
import { agentRoleSchema } from '@/library/types'

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const agentSchema = z.object({
  name: z.string(),
  role: z.enum(agentRoleSchema.options).openapi({
    description:
      'orchestrator agents may drive a session and delegate; subagents are only reachable by delegation',
  }),
  team: z.boolean().openapi({
    description:
      'Whether an orchestrator leads a team; false marks a solo agent that gets no orchestration guidance',
  }),
  description: z.string(),
  tools: z.array(z.string()).optional().openapi({
    description: 'Omit to inherit every tool available to subagents',
  }),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  prompt: z.string().openapi({ description: "The agent's system prompt" }),
  path: z.string(),
})
export type AgentDto = z.infer<typeof agentSchema>

// Summaries omit the prompt: it runs to hundreds of lines and a list does not
// need it.
export const agentSummarySchema = agentSchema.omit({ prompt: true }).extend({
  promptLines: z.number().int(),
})

const agentBody = {
  role: agentRoleSchema.default('subagent'),
  team: z.boolean().default(true),
  description: z.string().min(1).max(500),
  tools: z.array(z.string().max(64)).max(64).optional(),
  disallowedTools: z.array(z.string().max(64)).max(64).optional(),
  model: z.string().max(64).optional(),
  effort: effortSchema.optional(),
  skills: z.array(z.string().max(64)).max(64).optional(),
  maxTurns: z.number().int().positive().max(1000).optional(),
  prompt: z.string().min(1).max(200_000),
}

export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .openapi({ description: 'Becomes the filename', example: 'tester' }),
  ...agentBody,
})
export type CreateAgentInput = z.infer<typeof createAgentSchema>

export const updateAgentSchema = z.object({
  // Optional: present and different means rename. The file moves and every
  // project's symlink is rebuilt to follow it.
  name: z.string().min(1).max(64).optional(),
  ...agentBody,
})
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>

export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string(),
  extraFiles: z.array(z.string()).openapi({
    description: 'Files bundled beside SKILL.md. Not editable here; manage them over SSH.',
  }),
})
export type SkillDto = z.infer<typeof skillSchema>

const skillBody = {
  description: z.string().min(1).max(500),
  body: z.string().min(1).max(200_000),
}

export const createSkillSchema = z.object({
  name: z.string().min(1).max(64).openapi({ description: 'Becomes the directory name' }),
  ...skillBody,
})
export type CreateSkillInput = z.infer<typeof createSkillSchema>

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  ...skillBody,
})
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>

// --- per-project assignment ---------------------------------------------------

export const projectLibrarySchema = z.object({
  agents: z.array(z.string()),
  skills: z.array(z.string()),
})
export type ProjectLibraryDto = z.infer<typeof projectLibrarySchema>

export const setProjectLibrarySchema = z.object({
  agents: z.array(z.string().max(64)).max(200),
  skills: z.array(z.string().max(64)).max(200),
})
