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
  // Idea-owned assets get their own pair of caps rather than sharing the
  // session ones: an idea has no session yet, so there is no session row to
  // scope a limit to. A straight clone of ATTACHMENTS_SESSION_MAX_BYTES/
  // ATTACHMENTS_SESSION_MAX_FILES otherwise — see features/ideas/files.ts.
  ATTACHMENTS_IDEA_MAX_BYTES: z.coerce.number().int().positive().default(209_715_200),
  ATTACHMENTS_IDEA_MAX_FILES: z.coerce.number().int().positive().default(50),
  // How often the attachments-gc queue runs its scheduled reconciliation pass.
  ATTACHMENTS_GC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // An orphan blob younger than this is left alone: it may be an upload still
  // in flight rather than something abandoned.
  ATTACHMENTS_GC_GRACE_MS: z.coerce.number().int().positive().default(86_400_000),
  // 0 disables retention purging. Shipped off: nobody asked for attachments to
  // vanish on a timer, and turning it on is a per-deployment decision.
  ATTACHMENTS_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

  // Idea Manager: converting one idea's canvas into a development prompt is a
  // single, short, tool-less model call — nothing like a session turn — so it
  // gets its own concurrency knob rather than sharing WORKER_CONCURRENCY (see
  // queue/index.ts for why every queue whose work looks nothing like a
  // session turn gets its own). Tying it to session concurrency would starve
  // idea prompts behind long-running turns, or let a burst of idea prompts
  // crowd out sessions — neither shares a resource with the other, so neither
  // should share a knob.
  IDEA_PROMPT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Passed to the SDK's own maxTurns. `tools: []` on this call means there is
  // no tool-use fan-out that could loop turn after turn, so this is not what
  // stands between an ordinary run and a runaway one — maxBudgetUsd and the
  // timeout below are the real bounds, and this used to be pinned at 1, which
  // is a single API round-trip: no room for the model to retry a structured-
  // output attempt the CLI itself rejected (see error_max_structured_output_
  // retries in the SDK's SDKResultMessage) or to continue a longer answer,
  // so every generation failed with "Reached maximum number of turns (1)"
  // before it could produce one. 6 is a handful of round-trips — enough to
  // absorb a retry or two — while staying far short of a real multi-tool
  // agentic session.
  IDEA_PROMPT_MAX_TURNS: z.coerce.number().int().positive().default(6),
  // Per-generation ceiling passed to the SDK's own maxBudgetUsd. An ordinary
  // one-shot, tool-less structured-output call over one idea's canvas costs a
  // small fraction of this; it exists to bound the ordinary case, not to be
  // brushed against.
  IDEA_PROMPT_MAX_BUDGET_USD: z.coerce.number().positive().default(1),
  // The only timeout the SDK offers is an AbortController — see
  // features/ideas/prompt-service.ts — so this is what stops a generation
  // that never produces a result (a hung connection, a model stuck retrying
  // structured output) from tying up a worker slot indefinitely. A killed
  // *worker process* mid-generation is a separate, known gap that module
  // documents; this only covers a live process that never gets an answer.
  IDEA_PROMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // How long a claimed run may sit `generating` with no promptId linked yet
  // before the sweep gives up on it — see features/ideas/handoff.ts's
  // progressOpenRuns. claimIdeaForHandoff's own two writes (insert the run,
  // then link the prompt it just generated) cannot be one transaction —
  // createIdeaPrompt's own enqueue must run only after ITS transaction
  // commits (see that function's own comment) — so a worker killed in
  // between is, for one tick, indistinguishable from a claim still in
  // flight. Comfortably above how long that gap ordinarily takes (a couple
  // of database round trips), never brushed against in the ordinary case.
  IDEA_HANDOFF_CLAIM_GRACE_MS: z.coerce.number().int().positive().default(120_000),

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
