import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
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
