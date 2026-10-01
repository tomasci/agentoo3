// `@hono/zod-openapi`'s own `z`, not bare 'zod': importing it is what runs
// that package's module-level `extendZodWithOpenApi(z)` (its dist/index.mjs,
// at the bottom), which is what makes `.openapi()` exist at all on the
// schemas below. Every other schema file in this app gets that for free —
// each is only ever reached through a route file that imports OpenAPIHono
// first — but settings.ts (below) is imported by queue/session-concurrency.ts
// too, which the worker reaches with no router, and so no OpenAPIHono, ever
// in its own import graph. A bare 'zod' import here left `.openapi()` missing
// at the moment this file's own top-level schemas ran, in exactly that path.
import { z } from '@hono/zod-openapi'

/**
 * Which text a prompt response actually carries: the operator's own saved
 * file, or the built-in default this app falls back to when no file exists
 * yet. See the comment on KNOWN_PROMPTS in service.ts for why "no file" is the
 * ordinary state on most installations, not an error.
 */
export const promptSourceSchema = z.enum(['file', 'default']).openapi({
  description:
    "'file' when the body is the operator's own saved text; 'default' when no " +
    'file exists (or none has been saved since the last reset) and the body is ' +
    'the built-in instruction the app runs on instead',
})
export type PromptSource = z.infer<typeof promptSourceSchema>

export const promptSchema = z.object({
  name: z.string(),
  body: z.string(),
  path: z.string().openapi({ description: 'Where the file would live on disk' }),
  source: promptSourceSchema,
})
export type PromptDto = z.infer<typeof promptSchema>

// Bounded the way the library's agent/skill bodies are (features/library/schema.ts).
// Blank is rejected outright: an empty instruction is not a leaner prompt, it is
// a one-shot model call with no guidance at all — see library/idea-prompt.ts.
export const updatePromptSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Instruction cannot be blank — an empty instruction means the model runs unguided')
    .max(200_000),
})
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>

// --- the model list, mirroring library/models.ts's ModelOption -------------
//
// A separate enum from features/library/schema.ts's own `effortSchema`
// rather than an import of it: this describes what a *model* supports, not
// what an agent is configured with, and agentFrontmatterSchema (library/
// types.ts) already carries the same values a second time for the same
// reason — the two are duplicated on purpose rather than layered onto one
// import, the same precedent this file follows.
const modelEffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const modelOptionSchema = z.object({
  value: z.string().openapi({
    description:
      "What to write into an agent's `model` frontmatter or a session's model " +
      'override. Not restricted to a fixed shape — the SDK has returned values ' +
      "containing brackets (e.g. 'opus[1m]') — because Claude Code, not this " +
      'app, is what actually validates it.',
    example: 'opus[1m]',
  }),
  resolvedModel: z.string().optional().openapi({
    description:
      "Canonical wire model id this row's `value` resolves to, e.g. 'sonnet' -> 'claude-sonnet-5'.",
  }),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(modelEffortLevelSchema).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
})
export type ModelOptionDto = z.infer<typeof modelOptionSchema>

export const modelsSourceSchema = z.enum(['live', 'fallback']).openapi({
  description:
    "'live' when this ran Query.supportedModels() against this box's Claude " +
    "Code just now; 'fallback' when that could not be reached — no credential " +
    'configured, or the probe failed or timed out — and `models` is the ' +
    'built-in alias list instead.',
})

export const modelsResponseSchema = z.object({
  models: z.array(modelOptionSchema),
  source: modelsSourceSchema,
  fetchedAt: z.string().openapi({
    description:
      'ISO timestamp of the underlying probe: when it last succeeded, for ' +
      "'live', or when the failing attempt happened, for 'fallback'.",
  }),
})
export type ModelsDto = z.infer<typeof modelsResponseSchema>

// --- the port table, mirroring features/system/ports.ts's PortEntry -------
//
// `state` stays z.string() rather than a z.enum(): the vocabulary listed
// below is everything the two readers currently emit, but a future kernel
// state neither reader recognises degrades to 'UNKNOWN' rather than being
// rejected, and an enum here would make that impossible to express.

export const portScopeSchema = z.enum(['listening', 'all']).openapi({
  description:
    "'listening' is what `ss -l` shows — TCP LISTEN plus UDP UNCONN (unconnected) sockets. " +
    "'all' is every TCP/UDP socket in any state, including ESTABLISHED and TIME-WAIT.",
})
export type PortScopeDto = z.infer<typeof portScopeSchema>

export const portSourceSchema = z.enum(['ss', 'proc']).openapi({
  description:
    "Which reader produced the rows. 'ss' is the normal path; 'proc' is the " +
    '/proc/net/{tcp,tcp6,udp,udp6} fallback used when `ss` is missing, exits non-zero, or its ' +
    "output does not parse. 'proc' rows are slightly less detailed than `ss`'s: /proc/net has no " +
    "record of a socket's bound interface, so a zone suffix ss would print ('%lo', '%eth0') is " +
    "never there, and a dual-stack wildcard listener comes back as '::' where ss prints '*'. It " +
    "also has no cgroup column at all, so a 'proc' row can never carry attribution: 'service' " +
    "(see portAttributionSchema) — only 'socket' and 'docker' are possible there.",
})

export const portAttributionSchema = z.enum(['socket', 'docker', 'service', 'none']).openapi({
  description:
    'How pid/processName were determined for this row, in the order they are tried (first match ' +
    "wins). 'socket' is the kernel's own fd table: ss's own verified `users:((...))` column, or, " +
    'in the /proc fallback, a direct /proc/*/fd scan — either way, only ever a socket this ' +
    "backend's own uid holds. 'docker' is a docker-proxy process matched by cmdline (proto/host-ip/" +
    'host-port), found by scanning /proc — this works for a socket owned by any uid, since a ' +
    "process's own cmdline is process-table metadata, not something only its uid can read; " +
    '`container` is filled alongside it when Docker could be reached and exactly one container ' +
    "publishes that port. 'service' names the systemd unit implied by the socket's own cgroup, " +
    "attributed to that unit's main process: reliable for the *name* (nginx, postgres, ...), and " +
    "the pid is the unit's main process, which in practice is the listener itself for a " +
    "single-process unit (nginx's master, postgres's postmaster) — not guaranteed to be the " +
    "specific worker behind any one connection. 'none' when nothing above resolved a process; " +
    "`pid` stays null and `processName` stays the literal string 'unknown'.",
})
export type PortAttributionDto = z.infer<typeof portAttributionSchema>

export const portEntrySchema = z.object({
  protocol: z.enum(['tcp', 'udp']),
  localAddress: z.string().openapi({
    description:
      "Bare address, no brackets, and an IPv6 zone kept as a '%iface' suffix when ss reports " +
      "one — e.g. '0.0.0.0', '127.0.0.53%lo', '::', '::1', '*'.",
    example: '127.0.0.1',
  }),
  localPort: z.number().int().min(0).max(65535),
  peerAddress: z
    .string()
    .nullable()
    .openapi({
      description:
        "Null when the peer is a wildcard ('*', or '0.0.0.0'/'::' with no specific port) — which " +
        'is the normal case for a listening or unconnected socket.',
    }),
  peerPort: z.number().int().min(0).max(65535).nullable().openapi({
    description: 'Null exactly when peerAddress is null.',
  }),
  state: z.string().openapi({
    description:
      "ss's own state names, uppercased, with ESTAB normalised to ESTABLISHED: LISTEN, UNCONN, " +
      'ESTABLISHED, SYN-SENT, SYN-RECV, FIN-WAIT-1, FIN-WAIT-2, TIME-WAIT, CLOSE-WAIT, LAST-ACK, ' +
      'CLOSING, CLOSED, UNKNOWN.',
  }),
  pid: z
    .number()
    .int()
    .nullable()
    .openapi({ description: "Null exactly when attribution is 'none'." }),
  processName: z.string().openapi({
    description: "The literal string 'unknown' when attribution is 'none'.",
  }),
  processKnown: z.boolean().openapi({
    description:
      "True exactly when attribution is not 'none' — kept as its own boolean field so a caller " +
      "never has to string-compare attribution or processName to ask 'do we know the process'.",
  }),
  attribution: portAttributionSchema,
  unit: z
    .string()
    .nullable()
    .openapi({
      description:
        "The systemd unit implied by this socket's own cgroup — e.g. 'nginx.service', " +
        "'postgresql@18-main.service', 'ssh.socket' — filled whenever known, regardless of which " +
        'attribution won (a docker-proxy row still names docker.service here, for instance). Null ' +
        "when the socket's cgroup was absent, unreadable, or named no unit at all (a bare slice).",
    }),
  container: z
    .string()
    .nullable()
    .openapi({
      description:
        "Docker container name. Only ever set when attribution is 'docker' and exactly one running " +
        'container was found publishing this exact host port and protocol; null otherwise, ' +
        'including when Docker could not be reached or the match was ambiguous.',
    }),
  owner: z
    .string()
    .nullable()
    .openapi({
      description:
        "Username for the socket's own uid: 'root' for uid 0, the plain numeric uid as a string " +
        'when /etc/passwd has no matching entry, or null when the uid itself is unknown (an old ss ' +
        'with no `-e` support, or an unattributed row from the /proc fallback). Filled whenever ' +
        'known, regardless of which attribution won.',
    }),
})
export type PortEntryDto = z.infer<typeof portEntrySchema>

export const portsResponseSchema = z.object({
  scope: portScopeSchema,
  source: portSourceSchema,
  collectedAt: z.string().openapi({ description: 'ISO timestamp of this read.' }),
  user: z.string().nullable().openapi({
    description: "This backend process's own os.userInfo().username, or null if that call throws.",
  }),
  runningAsRoot: z.boolean().openapi({
    description:
      'Whether the backend process is running as uid 0. Normally false on this deployment — see ' +
      'the module comment on ports.ts — which is why most rows below have no resolvable process.',
  }),
  total: z.number().int().openapi({ description: 'Row count before truncation to MAX_ROWS.' }),
  truncated: z.boolean().openapi({ description: 'True when total exceeded the row cap.' }),
  unattributedCount: z.number().int().openapi({
    description:
      "Rows (after truncation) with attribution 'none' (equivalently, processKnown: false).",
  }),
  inferredCount: z
    .number()
    .int()
    .openapi({
      description:
        "Rows (after truncation) with attribution 'docker' or 'service' — resolved by inference " +
        "(a process-table match, or a systemd unit's main process) rather than the kernel's own fd " +
        "table ('socket').",
    }),
  ports: z.array(portEntrySchema),
})
export type PortsResponseDto = z.infer<typeof portsResponseSchema>

// --- the usage page, mirroring features/system/usage.ts's UsageResult ------
//
// Everything here describes the WIRE shape only. The SDK's own get_usage
// response and the messages table's rate_limit_event payload are both
// snake_case and use different units (see usage.ts's header comment on the
// unit mismatch between a live probe and an observed event) — usage.ts
// normalises both into exactly this shape before it ever reaches c.json(),
// so nothing below needs to describe two ways of saying the same field.

export const usageWindowKeySchema = z
  .enum([
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet',
    'seven_day_oauth_apps',
    'model',
  ])
  .openapi({
    description:
      "Which rate-limit window this row describes. 'model' is a per-model weekly window " +
      "(the SDK's own `model_scoped` list) — there can be more than one row with this key, " +
      'distinguished by `label`; every other key appears at most once.',
  })
export type UsageWindowKey = z.infer<typeof usageWindowKeySchema>

// Shared between limits.status and limits.overage.status — both are the same
// claude.ai rate-limit verdict, just about a different scope (the window
// overall vs. its overage extension).
export const usageLimitStatusSchema = z.enum(['allowed', 'allowed_warning', 'rejected'])
export type UsageLimitStatus = z.infer<typeof usageLimitStatusSchema>

export const usageLimitsSourceSchema = z.enum(['live', 'observed', 'none']).openapi({
  description:
    "'live' when this box's Claude Code just answered Query.usage_EXPERIMENTAL_MAY_CHANGE_" +
    'DO_NOT_RELY_ON_THIS_API_YET() with real rate_limits (needs profile-scope auth, e.g. ' +
    "`claude login` — a `claude setup-token` credential never gets these). 'observed' falls " +
    'back to the most recent rate-limit report Claude attached to any session turn on this ' +
    "box, read from the messages table, when a live probe is unavailable. 'none' means " +
    'neither exists yet and `windows` is empty.',
})
export type UsageLimitsSource = z.infer<typeof usageLimitsSourceSchema>

export const usageWindowSchema = z
  .object({
    key: usageWindowKeySchema,
    label: z
      .string()
      .nullable()
      .openapi({
        description:
          "Server-supplied display name for a 'model' row (e.g. 'Fable'); null for " +
          'every other key.',
      }),
    utilization: z.number().nullable().openapi({
      description: 'Percent of the window used, 0-100. Null when the source reported no value.',
    }),
    resetsAt: z.string().nullable().openapi({ description: 'ISO timestamp, or null if unknown.' }),
  })
  .openapi('UsageWindow', {
    description:
      'One rate-limit window. `windows` on the parent object omits a window the source did ' +
      'not report at all — this never appears as an all-null placeholder row.',
  })
export type UsageWindowDto = z.infer<typeof usageWindowSchema>

export const usageOverageSchema = z
  .object({
    status: usageLimitStatusSchema.nullable(),
    disabledReason: z.string().nullable().openapi({
      description: "The SDK/event's own reason code, e.g. 'org_level_disabled_until', verbatim.",
    }),
    inUse: z.boolean().nullable(),
  })
  .nullable()
  .openapi('UsageOverage', {
    description:
      "Overage-credit status. Only ever populated for `limits.source === 'observed'` — the " +
      'live SDK path carries no overage fields — and null even there when the event reported ' +
      'none of overageStatus/overageDisabledReason/isUsingOverage/overageInUse.',
  })
export type UsageOverageDto = z.infer<typeof usageOverageSchema>

export const usageExtraUsageSchema = z
  .object({
    isEnabled: z.boolean(),
    monthlyLimit: z
      .number()
      .nullable()
      .openapi({ description: 'Minor units of currency (cents).' }),
    usedCredits: z.number().nullable().openapi({ description: 'Minor units of currency (cents).' }),
    utilization: z.number().nullable().openapi({ description: 'Percent, 0-100.' }),
    currency: z.string().nullable(),
  })
  .nullable()
  .openapi('UsageExtraUsage', {
    description:
      "Pay-as-you-go overage spend, from the live SDK's rate_limits.extra_usage. Null when " +
      "`limits.source` is not 'live', or when the probe answered with no extra_usage block.",
  })
export type UsageExtraUsageDto = z.infer<typeof usageExtraUsageSchema>

export const usageLimitsSchema = z
  .object({
    source: usageLimitsSourceSchema,
    asOf: z
      .string()
      .nullable()
      .openapi({
        description:
          "ISO timestamp this came from: the probe time for 'live', the rate_limit_event row's " +
          "own createdAt for 'observed' — so an 'observed' reading is only as fresh as `asOf` " +
          "says, not as fresh as `fetchedAt` above it — and null for 'none'.",
      }),
    status: usageLimitStatusSchema.nullable().openapi({
      description:
        "The observed event's own verdict for the window it reported. Null for " +
        "'live' and 'none' — the live SDK response carries no equivalent field.",
    }),
    windows: z.array(usageWindowSchema).openapi({
      description:
        'Ordered five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_oauth_apps, ' +
        'then any model rows in the order the source listed them. A window absent from the ' +
        'source is omitted here rather than included with null fields.',
    }),
    overage: usageOverageSchema,
    extraUsage: usageExtraUsageSchema,
  })
  .openapi('UsageLimits', { description: "This box's claude.ai plan rate limits, however known." })
export type UsageLimitsDto = z.infer<typeof usageLimitsSchema>

export const usageAccountSchema = z
  .object({
    subscriptionType: z.string().nullable().openapi({
      description:
        "e.g. 'pro', 'max', 'team', 'enterprise'; null for an API-key/3P-provider session.",
    }),
    email: z.string().nullable(),
    organization: z.string().nullable(),
    tokenSource: z.string().nullable().openapi({
      description: "e.g. 'CLAUDE_CODE_OAUTH_TOKEN', or the literal string 'none'.",
      example: 'CLAUDE_CODE_OAUTH_TOKEN',
    }),
    apiKeySource: z.string().nullable(),
    apiProvider: z.string().nullable().openapi({
      description: "e.g. 'firstParty', 'bedrock', 'vertex', 'gateway'.",
    }),
  })
  .nullable()
  .openapi('UsageAccount', {
    description: "Who this box's Claude Code is authenticated as. Null when accountInfo() failed.",
  })
export type UsageAccountDto = z.infer<typeof usageAccountSchema>

// Shared by breakdown.{day,week}.{agents,skills,plugins,mcpServers} — all four
// are the same "name plus its share of weighted local usage" shape.
export const usageNamedShareSchema = z
  .object({ name: z.string(), pct: z.number().openapi({ description: 'Percent, 0-100.' }) })
  .openapi('UsageNamedShare', {
    description: 'Share of weighted local usage attributed to one name.',
  })
export type UsageNamedShareDto = z.infer<typeof usageNamedShareSchema>

export const usageBehaviorEntrySchema = z
  .object({
    // A string, not an enum: the SDK's current vocabulary (cache_miss,
    // long_context, subagent_heavy, high_parallel, cron) is documented on
    // SDKControlGetUsageResponse, but an enum here would drop a row outright
    // the day the SDK adds a new one, rather than passing it through unlabeled.
    key: z.string(),
    pct: z
      .number()
      .openapi({ description: 'Percent, 0-100. Categories overlap, so these do not sum to 100.' }),
    count: z.number().openapi({ description: 'Requests in this window exhibiting the behavior.' }),
  })
  .openapi('UsageBehaviorEntry')
export type UsageBehaviorEntryDto = z.infer<typeof usageBehaviorEntrySchema>

export const usagePeriodSchema = z
  .object({
    requestCount: z.number(),
    sessionCount: z.number(),
    behaviors: z.array(usageBehaviorEntrySchema),
    agents: z.array(usageNamedShareSchema),
    skills: z.array(usageNamedShareSchema),
    plugins: z.array(usageNamedShareSchema),
    mcpServers: z.array(usageNamedShareSchema),
  })
  .openapi('UsagePeriod', {
    description: 'What contributed to local usage over one window (day or week).',
  })
export type UsagePeriodDto = z.infer<typeof usagePeriodSchema>

export const usageBreakdownSchema = z
  .object({ day: usagePeriodSchema, week: usagePeriodSchema })
  .nullable()
  .openapi('UsageBreakdown', {
    description:
      "From the SDK's own scan of local transcripts (a few seconds of I/O — see usage.ts). Null " +
      'when that scan failed, timed out, or the account has no claude.ai subscription to attribute ' +
      'usage against.',
  })
export type UsageBreakdownDto = z.infer<typeof usageBreakdownSchema>

export const usageResponseSchema = z
  .object({
    fetchedAt: z
      .string()
      .openapi({ description: 'ISO timestamp: when this response was assembled.' }),
    account: usageAccountSchema,
    limits: usageLimitsSchema,
    breakdown: usageBreakdownSchema,
    probeError: z
      .string()
      .nullable()
      .openapi({
        description:
          'A readable sentence describing whatever part of the CLI probe failed or timed out — ' +
          'accountInfo(), the rate-limit call, or the behaviors scan, joined if more than one did. ' +
          'Null only when every part of the probe succeeded. Never gates the response to a non-200: ' +
          'the fields the failed part would have filled are null (or, for `limits`, whatever the ' +
          'database still has) instead.',
      }),
  })
  .openapi('UsageResponse')
export type UsageResponseDto = z.infer<typeof usageResponseSchema>

// --- system settings, mirroring db/schema.ts's systemSettings table --------
//
// A small admin-configurable surface. Today exactly one key exists —
// max_concurrent_sessions, read and written by features/system/settings.ts —
// but the shape below (GET returns the effective value plus where it came
// from, PATCH accepts a sparse partial) is meant to generalise to a second
// one without reshaping either endpoint.
//
// "No row for a key" means "use the built-in default", the identical
// absent-means-default model promptSchema's own `source` already follows for
// the prompt registry above: `source` here plays the same role, telling the
// operator which number a turn would actually run under rather than just
// echoing back whatever the stored row happens to say.

/**
 * Nothing on a box sized for this app is sane anywhere near this number: at
 * ~4GB per Claude Code instance and db/client.ts's own Postgres pool (10
 * connections per process), a value even half this high would already be
 * past what either resource could support. This exists purely as a typo
 * guard — a stray extra digit should 400 loudly, not be quietly accepted and
 * then explain itself as an OOM three turns later.
 */
export const MAX_CONCURRENT_SESSIONS_CEILING = 64

export const maxConcurrentSessionsSchema = z
  .number({ error: 'Must be a whole number' })
  .int('Must be a whole number')
  .min(1, 'Must be at least 1')
  .max(MAX_CONCURRENT_SESSIONS_CEILING, 'Must be at most 64')

export const systemSettingsSourceSchema = z.enum(['override', 'default']).openapi({
  description:
    "'override' when an admin has saved a value for this key (see PATCH below) — including a " +
    "value equal to defaultValue, which still counts as a saved override, not 'default'; " +
    "'default' when no override is stored and `value` is simply `defaultValue` below.",
})

export const systemSettingsSchema = z
  .object({
    maxConcurrentSessions: z.object({
      value: z
        .number()
        .int()
        .openapi({
          description:
            'The effective cap a new turn is claimed under right now: the stored ' +
            'override if one exists, else defaultValue.',
        }),
      source: systemSettingsSourceSchema,
      defaultValue: z
        .number()
        .int()
        .openapi({
          description:
            'env.WORKER_CONCURRENCY as this process parsed it at boot — independent of any saved ' +
            'override, and what `value` reverts to on reset.',
        }),
    }),
  })
  .openapi('SystemSettings')
export type SystemSettingsDto = z.infer<typeof systemSettingsSchema>

// `null` resets a key back to its default (deletes the stored row, rather
// than writing the default value back into it — the same reasoning
// resetPrompt gives for its own delete-not-overwrite above); a key left out
// of the body entirely leaves that setting untouched. The refine is what
// turns a body with nothing recognisable in it — `{}`, or only unknown keys,
// which an OpenAPIHono object schema strips before this refine ever runs —
// into a 400 instead of a silent no-op PATCH.
export const updateSystemSettingsSchema = z
  .object({ maxConcurrentSessions: maxConcurrentSessionsSchema.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>
