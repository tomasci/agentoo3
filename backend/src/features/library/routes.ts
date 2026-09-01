import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listAgents, listSkills } from '@/library'
import { agentRoleSchema } from '@/library/types'

// The prompt body is deliberately omitted from the list response: agent prompts
// run to hundreds of lines and the projects page only needs to show identity.
const agentSummarySchema = z.object({
  name: z.string(),
  role: agentRoleSchema.openapi({
    description:
      'orchestrator agents may drive a session and delegate; subagents are only reachable by delegation',
  }),
  description: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  tools: z.array(z.string()).optional(),
  path: z.string(),
  promptLines: z.number().int(),
})

const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const libraryRouter = new OpenAPIHono()

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/agents',
    tags: ['library'],
    summary: 'List global agents, marked as orchestrator or subagent',
    responses: { 200: json(z.array(agentSummarySchema), 'Agents') },
  }),
  async (c) => {
    const agents = await listAgents()
    return c.json(
      agents.map((a) => ({
        name: a.name,
        role: a.role,
        description: a.description,
        model: a.model,
        effort: a.effort,
        tools: a.tools,
        path: a.path,
        promptLines: a.prompt.split('\n').length,
      })),
      200,
    )
  },
)

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/skills',
    tags: ['library'],
    summary: 'List global skills',
    responses: { 200: json(z.array(skillSummarySchema), 'Skills') },
  }),
  async (c) => c.json(await listSkills(), 200),
)
