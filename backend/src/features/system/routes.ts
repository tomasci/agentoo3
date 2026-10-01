import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { getModels } from './models'
import { getPorts } from './ports'
import { getPrompt, resetPrompt, updatePrompt } from './prompts'
import {
  modelsResponseSchema,
  portScopeSchema,
  portsResponseSchema,
  promptSchema,
  systemSettingsSchema,
  updatePromptSchema,
  updateSystemSettingsSchema,
  usageResponseSchema,
} from './schema'
import { systemStats } from './service'
import { getSystemSettings, updateSystemSettings } from './settings'
import { getUsage } from './usage'

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

// --- the usage page --------------------------------------------------------
//
// See features/system/usage.ts's header for the two sources this reconciles
// (a live SDK probe, and the newest rate_limit_event row) and why they need
// unit conversion to agree.

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system/usage',
    tags: ['system'],
    summary: "This box's Claude subscription plan limits, account, and what has been consuming it",
    description:
      'Always 200, never an error response — this endpoint itself. `limits.source` explains ' +
      "where the reported limits came from: 'live' when this box's Claude Code just answered " +
      'with real rate_limits (needs profile-scope auth, e.g. `claude login`; a `claude ' +
      "setup-token` credential never gets these); 'observed' is the most recent rate-limit " +
      "report Claude attached to any session's turn on this box, so it is as old as " +
      "`limits.asOf`, not as fresh as `fetchedAt`; 'none' means neither exists yet. A failed or " +
      'timed-out probe is not itself a failure of this endpoint: `probeError` carries a readable ' +
      'sentence, the fields the probe would have filled are null, and the database-observed ' +
      'limits (if any) are still reported.',
    responses: {
      200: json(usageResponseSchema, "This box's plan limits, account, and usage breakdown"),
    },
  }),
  async (c) => c.json(await getUsage(), 200),
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

// --- the port table -------------------------------------------------------
//
// A structured `ss -tulpn`: read-only, and the process column is only ever
// as complete as `ss -p`'s own — see the module comment on ports.ts for why
// most rows on this deployment have no resolvable process at all.

const portsQuery = z.object({
  scope: portScopeSchema.default('listening').openapi({
    param: { name: 'scope', in: 'query' },
  }),
})

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system/ports',
    tags: ['system'],
    summary: "The host's current port -> process mapping",
    description:
      'Backed by `ss`, falling back to /proc/net/{tcp,tcp6,udp,udp6} plus a /proc/*/fd scan when ' +
      '`ss` is missing or its output cannot be parsed. Never a 500 for either of those — only a ' +
      '503, and only if both readers fail. Every row also carries `attribution`, `unit`, ' +
      '`container` and `owner` — see portAttributionSchema for how a row that `ss -p` itself ' +
      'cannot resolve (the common case for this unprivileged account) can still often be named, ' +
      'without this endpoint ever gaining a new privilege to do it.',
    request: { query: portsQuery },
    responses: {
      200: json(portsResponseSchema, 'The current port table'),
      400: json(errorSchema, 'scope was not one of listening, all'),
      503: json(errorSchema, 'Neither `ss` nor /proc could be read'),
    },
  }),
  async (c) => c.json(await getPorts(c.req.valid('query').scope), 200),
)

// --- settings ---------------------------------------------------------------
//
// An admin-configurable surface, today exactly one key (max_concurrent
// sessions — see features/system/settings.ts's own header for why "no row"
// means "use env.WORKER_CONCURRENCY" rather than an error, and
// queue/session-concurrency.ts for how the worker picks a saved override up
// without a restart).

systemRouter.openapi(
  createRoute({
    method: 'get',
    path: '/system/settings',
    tags: ['system'],
    summary: 'Admin-configurable settings and their current effective values',
    description:
      "Every setting reports `source`: 'override' when an admin has saved a value for it, " +
      "'default' when none has and `value` is simply `defaultValue`. A box with nothing ever " +
      'saved here reports every setting as its default — the normal starting state, not an ' +
      'error.',
    responses: {
      200: json(systemSettingsSchema, 'Current settings'),
    },
  }),
  async (c) => c.json(await getSystemSettings(), 200),
)

systemRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/system/settings',
    tags: ['system'],
    summary: 'Save, or reset, one or more settings',
    description:
      'A sparse patch: a key left out of the body is untouched. Setting a key to a value saves ' +
      "it as an override — including a value equal to that key's own default, which still " +
      'pins it rather than being treated as a no-op. Setting a key to `null` resets it, ' +
      'deleting the saved override rather than writing the default back in, so the default ' +
      'stays one thing instead of a copy that can drift from it. The body must name at least ' +
      'one key.',
    request: {
      body: {
        // required: true, unlike the `json()` helper above: without it,
        // @hono/zod-openapi only validates a body whose content-type is
        // application/json, and hands the handler `{}` for anything else —
        // a missing body or a text/plain one included — so the schema's own
        // "Nothing to update" refine never ran and a client got a silent 200
        // that saved nothing. See sessions/routes.ts's identical body shape
        // for the same reason.
        content: { 'application/json': { schema: updateSystemSettingsSchema } },
        description: 'Keys to save or reset',
        required: true,
      },
    },
    responses: {
      200: json(systemSettingsSchema, 'Settings after the patch was applied'),
      400: json(errorSchema, 'A value failed validation, or the body named no key at all'),
    },
  }),
  async (c) => c.json(await updateSystemSettings(c.req.valid('json')), 200),
)
