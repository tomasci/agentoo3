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
