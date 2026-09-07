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
  // Where session attachments live, sharded by session id so no single
  // directory accumulates tens of thousands of entries. See lib/paths.ts.
  ATTACHMENTS_DIR: z.string().default('/opt/agentoo/attachments'),
  // Drop a folder here to adopt it as a project. Kept separate from
  // PROJECTS_DIR, which holds our own managed project roots — mixing the two
  // would mean listing our own scaffolding as adoptable.
  SOURCES_DIR: z.string().default('/opt/agentoo/sources'),

  // One of these is needed to run agents. Neither is required to boot, so the
  // API still starts and can tell you what is missing.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),

  // Machine-wide cap on how many turns may run at once — not a per-session
  // rule. Per-session serialization is enforced separately, by the conditional
  // claim in session-run.worker.ts's runTurn (a turn is only ever taken out of
  // 'queued'), and stays enforced regardless of what this number is. The
  // installer derives the real value from host RAM (each Claude Code instance
  // wants ~4GB) and pins it in .env; this default is only the fallback for
  // running without the installer.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Where generated ssh keys live. Empty falls back to ~/.ssh/agentoo.
  SSH_KEYS_DIR: z.string().default(''),

  // Per-file cap. Must stay under nginx's client_max_body_size (50m today) —
  // otherwise nginx 413s the request before our own, more specific error can
  // ever be produced.
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),
  ATTACHMENTS_SESSION_MAX_BYTES: z.coerce.number().int().positive().default(209_715_200),
  ATTACHMENTS_SESSION_MAX_FILES: z.coerce.number().int().positive().default(50),
  ATTACHMENTS_TOTAL_MAX_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  // How often the attachments-gc queue runs its scheduled reconciliation pass.
  ATTACHMENTS_GC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // An orphan blob younger than this is left alone: it may be an upload still
  // in flight rather than something abandoned.
  ATTACHMENTS_GC_GRACE_MS: z.coerce.number().int().positive().default(86_400_000),
  // 0 disables retention purging. Shipped off: nobody asked for attachments to
  // vanish on a timer, and turning it on is a per-deployment decision.
  ATTACHMENTS_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

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
