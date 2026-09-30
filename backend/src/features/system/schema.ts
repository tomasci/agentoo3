import { z } from 'zod'

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
    "never there, and a dual-stack wildcard listener comes back as '::' where ss prints '*'.",
})

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
    .openapi({ description: 'Null when the process could not be resolved.' }),
  processName: z.string().openapi({
    description: "The literal string 'unknown' when processKnown is false.",
  }),
  processKnown: z.boolean().openapi({
    description:
      'False when the process could not be resolved — kept as its own field so a caller never ' +
      "has to string-compare processName against 'unknown'.",
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
    description: 'Rows (after truncation) with processKnown: false.',
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
