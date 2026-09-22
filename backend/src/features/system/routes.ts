import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { getModels } from './models'
import { getPrompt, resetPrompt, updatePrompt } from './prompts'
import { modelsResponseSchema, promptSchema, updatePromptSchema } from './schema'
import { systemStats } from './service'

const systemSchema = z.object({
  cpu: z.object({
    usagePercent: z.number().openapi({ description: 'Busy time since the previous poll' }),
    cores: z.number().int(),
    load1: z.number(),
  }),
  memory: z.object({
    usedBytes: z.number(),
    totalBytes: z.number(),
    usedPercent: z.number(),
  }),
  disk: z.object({
    usedBytes: z.number(),
    totalBytes: z.number(),
    usedPercent: z.number(),
    path: z.string().openapi({ description: 'Filesystem measured — the projects directory' }),
  }),
  uptimeSeconds: z.number().int(),
})

const nameParam = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'name', in: 'path' }, example: 'idea-to-prompt' }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const systemRouter = new OpenAPIHono()

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system',
    tags: ['system'],
    summary: 'Host CPU, memory and disk usage',
    description:
      'CPU is the delta between this poll and the previous one, so the first ' +
      'call after a restart falls back to load average.',
    responses: {
      200: { content: { 'application/json': { schema: systemSchema } }, description: 'Stats' },
    },
  }),
  async (c) => c.json(await systemStats(), 200),
)

// --- the model list -------------------------------------------------------
//
// Read-only and unowned by anything, like the prompt registry below, but for
// a different reason: this is never listed, created, renamed or assigned
// either, it just answers "what can `model` be set to right now" for
// whichever caller asks — currently the library editor's agent/orchestrator
// forms, but nothing here is specific to them.

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system/models',
    tags: ['system'],
    summary: 'The models this box can actually use right now',
    description:
      'Always 200, never an error response: a failed or timed-out probe (or ' +
      'no Claude credential configured at all) reports the built-in alias ' +
      "list with `source: 'fallback'` rather than failing the request, so a " +
      'caller can always render a picker.',
    responses: {
      200: json(modelsResponseSchema, 'The current model list, live or fallback'),
    },
  }),
  async (c) => c.json(await getModels(), 200),
)

// --- operator-editable prompts -------------------------------------------------
//
// A fixed, small registry of known singleton prompt files (see prompts.ts),
// mounted on /system rather than /library because a prompt is never listed,
// created, renamed or assigned — the one thing the library API's two real
// kinds (agents, skills) always support.

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system/prompts/{name}',
    tags: ['system'],
    summary: 'Read an operator-editable instruction',
    description:
      "`source` is 'file' when this is the operator's own saved text, or " +
      "'default' when no file has been saved (or one has been reset) and the " +
      'body is the built-in instruction the app falls back to. On a box that ' +
      'already had a library before this prompt shipped, `default` is the ' +
      'normal starting state, not an error — the seed step never overwrites an ' +
      'existing library, so the shipped default file never lands there.',
    request: { params: nameParam },
    responses: {
      200: json(promptSchema, 'Prompt'),
      404: json(errorSchema, 'Unknown prompt name'),
    },
  }),
  async (c) => c.json(await getPrompt(c.req.valid('param').name), 200),
)

systemRouter.openapi(
  createRoute({
    method: 'put',
    path: '/system/prompts/{name}',
    tags: ['system'],
    summary: 'Save an operator-editable instruction',
    description: 'Blank is rejected: an empty instruction runs the model with no guidance at all.',
    request: { params: nameParam, body: json(updatePromptSchema, 'New body') },
    responses: {
      200: json(promptSchema, 'Saved'),
      400: json(errorSchema, 'Blank body, or body over the length cap'),
      404: json(errorSchema, 'Unknown prompt name'),
    },
  }),
  async (c) => c.json(await updatePrompt(c.req.valid('param').name, c.req.valid('json')), 200),
)

systemRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/system/prompts/{name}',
    tags: ['system'],
    summary: 'Reset an instruction back to its built-in default',
    description:
      'Deletes the saved file rather than writing the default into it, so the ' +
      'default stays one thing (a constant in the code) instead of a copy that ' +
      'can drift from it.',
    request: { params: nameParam },
    responses: {
      200: json(promptSchema, 'Reset'),
      404: json(errorSchema, 'Unknown prompt name'),
    },
  }),
  async (c) => c.json(await resetPrompt(c.req.valid('param').name), 200),
)
