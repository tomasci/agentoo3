import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { listAgents, listSkills } from '@/library'
import {
  agentSchema,
  agentSummarySchema,
  createAgentSchema,
  createSkillSchema,
  projectLibrarySchema,
  setProjectLibrarySchema,
  skillSchema,
  updateAgentSchema,
  updateSkillSchema,
} from './schema'
import {
  createAgent,
  createSkill,
  deleteAgent,
  deleteSkill,
  getAgentOrThrow,
  getProjectLibrary,
  getSkillOrThrow,
  setProjectLibrary,
  updateAgent,
  updateSkill,
  usageCounts,
} from './service'

const nameParam = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'name', in: 'path' } }),
})
const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const libraryRouter = new OpenAPIHono()

// --- agents -------------------------------------------------------------------

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/agents',
    tags: ['library'],
    summary: 'List global agents, marked as orchestrator or subagent',
    responses: {
      200: json(z.array(agentSummarySchema.extend({ usedByProjects: z.number().int() })), 'Agents'),
    },
  }),
  async (c) => {
    const [agents, counts] = await Promise.all([listAgents(), usageCounts()])
    return c.json(
      agents.map(({ prompt, ...rest }) => ({
        ...rest,
        promptLines: prompt.split('\n').length,
        usedByProjects: counts.get(`agent:${rest.name}`) ?? 0,
      })),
      200,
    )
  },
)

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/agents/{name}',
    tags: ['library'],
    summary: 'Get one agent, prompt included',
    request: { params: nameParam },
    responses: { 200: json(agentSchema, 'Agent'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getAgentOrThrow(c.req.valid('param').name), 200),
)

libraryRouter.openapi(
  createRoute({
    method: 'post',
    path: '/library/agents',
    tags: ['library'],
    summary: 'Create an agent',
    description:
      'Writes a markdown file to the library. The name becomes the filename, and ' +
      'the prompt becomes the body — the file stays the source of truth, so editing ' +
      'it changes the agent for every project using it.',
    request: { body: json(createAgentSchema, 'Agent to create') },
    responses: {
      201: json(agentSchema, 'Created'),
      400: json(errorSchema, 'Invalid input'),
      409: json(errorSchema, 'Name already used'),
    },
  }),
  async (c) => c.json(await createAgent(c.req.valid('json')), 201),
)

libraryRouter.openapi(
  createRoute({
    method: 'put',
    path: '/library/agents/{name}',
    tags: ['library'],
    summary: 'Replace an agent',
    request: { params: nameParam, body: json(updateAgentSchema, 'New contents') },
    responses: {
      200: json(agentSchema, 'Updated'),
      400: json(errorSchema, 'Invalid input'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateAgent(c.req.valid('param').name, c.req.valid('json')), 200),
)

libraryRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/library/agents/{name}',
    tags: ['library'],
    summary: 'Delete an agent',
    description: 'Also unassigns it from every project, so no broken symlinks are left behind.',
    request: { params: nameParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteAgent(c.req.valid('param').name)
    return c.body(null, 204)
  },
)

// --- skills -------------------------------------------------------------------

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/skills',
    tags: ['library'],
    summary: 'List global skills',
    responses: {
      200: json(z.array(skillSchema.extend({ usedByProjects: z.number().int() })), 'Skills'),
    },
  }),
  async (c) => {
    const [skills, counts] = await Promise.all([listSkills(), usageCounts()])
    return c.json(
      skills.map((s) => ({ ...s, usedByProjects: counts.get(`skill:${s.name}`) ?? 0 })),
      200,
    )
  },
)

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/skills/{name}',
    tags: ['library'],
    summary: 'Get one skill',
    request: { params: nameParam },
    responses: { 200: json(skillSchema, 'Skill'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getSkillOrThrow(c.req.valid('param').name), 200),
)

libraryRouter.openapi(
  createRoute({
    method: 'post',
    path: '/library/skills',
    tags: ['library'],
    summary: 'Create a skill',
    description: 'Creates a directory with a SKILL.md. Bundled resources are added over SSH.',
    request: { body: json(createSkillSchema, 'Skill to create') },
    responses: {
      201: json(skillSchema, 'Created'),
      400: json(errorSchema, 'Invalid input'),
      409: json(errorSchema, 'Name already used'),
    },
  }),
  async (c) => c.json(await createSkill(c.req.valid('json')), 201),
)

libraryRouter.openapi(
  createRoute({
    method: 'put',
    path: '/library/skills/{name}',
    tags: ['library'],
    summary: "Replace a skill's SKILL.md",
    description: 'Only SKILL.md is written; files bundled beside it are left untouched.',
    request: { params: nameParam, body: json(updateSkillSchema, 'New contents') },
    responses: {
      200: json(skillSchema, 'Updated'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateSkill(c.req.valid('param').name, c.req.valid('json')), 200),
)

libraryRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/library/skills/{name}',
    tags: ['library'],
    summary: 'Delete a skill and its directory',
    description:
      'The directory is the skill, so anything bundled beside SKILL.md goes with it. ' +
      'The skill listing reports those files so a confirmation can name them.',
    request: { params: nameParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteSkill(c.req.valid('param').name)
    return c.body(null, 204)
  },
)

// --- per-project assignment ---------------------------------------------------

libraryRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/library',
    tags: ['library'],
    summary: 'Which library items this project uses',
    request: { params: idParam },
    responses: {
      200: json(projectLibrarySchema, 'Assignment'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await getProjectLibrary(c.req.valid('param').id), 200),
)

libraryRouter.openapi(
  createRoute({
    method: 'put',
    path: '/projects/{id}/library',
    tags: ['library'],
    summary: 'Set which library items this project uses',
    description:
      "Writes symlinks into the project's plugin directory, beside the repo rather " +
      'than inside it, so the working tree is never dirtied. The library file stays ' +
      'the source of truth — editing an agent changes it everywhere it is used.',
    request: { params: idParam, body: json(setProjectLibrarySchema, 'Full assignment') },
    responses: {
      200: json(projectLibrarySchema, 'Updated'),
      400: json(errorSchema, 'Unknown item'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await setProjectLibrary(c.req.valid('param').id, c.req.valid('json')), 200),
)
