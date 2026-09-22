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
