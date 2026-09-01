import { z } from 'zod'

// Parsed once at boot: a missing DATABASE_URL should stop the process here with
// a clear message, not surface as `undefined` on the first query.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  BACKEND_HOST: z.string().default('127.0.0.1'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Where projects are cloned and where the shared agent/skill library lives.
  PROJECTS_DIR: z.string().default('/opt/agentoo/projects'),
  LIBRARY_DIR: z.string().default('/opt/agentoo/library'),

  // One of these is needed to run agents. Neither is required to boot, so the
  // API still starts and can tell you what is missing.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),

  // How many sessions may run at once. Each Claude Code instance wants ~4GB.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),

  // Comma-separated origin allowlist. Empty by default: nginx and the Vite dev
  // proxy both make the frontend same-origin, so nothing legitimate needs CORS.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  LOG_LEVEL: z.coerce.number().int().min(0).max(5).default(3),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail loudly and legibly rather than throwing a ZodError stack at the wall.
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
  console.error(`Invalid environment:\n${issues.join('\n')}`)
  process.exit(1)
}

export const env = parsed.data

export const hasClaudeCredential = Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN)
