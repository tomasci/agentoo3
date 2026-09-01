import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { hasClaudeCredential } from '@/env'

const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  claudeCredential: z.boolean().openapi({
    description:
      'False when neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — the API runs but agents cannot',
  }),
})

export const healthRouter = new OpenAPIHono()

healthRouter.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['health'],
    summary: 'Liveness and credential status',
    responses: {
      200: { content: { 'application/json': { schema: healthSchema } }, description: 'Healthy' },
    },
  }),
  (c) =>
    c.json(
      {
        status: 'ok' as const,
        version: process.env.npm_package_version ?? '0.1.0',
        claudeCredential: hasClaudeCredential,
      },
      200,
    ),
)
