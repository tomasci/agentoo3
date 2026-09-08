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
