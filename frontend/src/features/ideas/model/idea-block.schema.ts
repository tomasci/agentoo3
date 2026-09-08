import { z } from 'zod'

// Mirrors the backend's per-kind rules (features/ideas/schema.ts's
// `createIdeaBlockSchema`): one branch per `kind`, discriminated the same way
// the request body is, so a block editor's form resolves against exactly the
// kind it is editing rather than a hand-rolled shape of its own. Layout
// fields (`groupId`, `x`, `y`, `w`, `h`) are the canvas's own doing — set by
// dragging and dropping, never typed into a form — so they are deliberately
// absent here.

const textBlockText = z
  .string()
  .min(1, { message: 'ideas.canvas.block.errors.textRequired' })
  .max(20000, { message: 'ideas.canvas.block.errors.textTooLong' })

const noteBlockSchema = z.object({ kind: z.literal('note'), text: textBlockText })
const requirementBlockSchema = z.object({ kind: z.literal('requirement'), text: textBlockText })
const exampleBlockSchema = z.object({ kind: z.literal('example'), text: textBlockText })

const linkBlockSchema = z.object({
  kind: z.literal('link'),
  url: z
    .string()
    .min(1, { message: 'ideas.canvas.block.errors.urlRequired' })
    .max(2000, { message: 'ideas.canvas.block.errors.urlTooLong' }),
  label: z.string().max(300, { message: 'ideas.canvas.block.errors.labelTooLong' }).optional(),
})

const imageBlockSchema = z.object({
  kind: z.literal('image'),
  // The id of a file already uploaded to this idea (see `use-idea-assets.ts`)
  // — never a fresh upload from this form itself, which is why this is a
  // plain non-empty string rather than a `File`/`Blob`.
  assetId: z.string().min(1, { message: 'ideas.canvas.block.errors.assetRequired' }),
  caption: z.string().max(300, { message: 'ideas.canvas.block.errors.captionTooLong' }).optional(),
})

export const ideaBlockFormSchema = z.discriminatedUnion('kind', [
  noteBlockSchema,
  requirementBlockSchema,
  exampleBlockSchema,
  linkBlockSchema,
  imageBlockSchema,
])
export type IdeaBlockFormValues = z.infer<typeof ideaBlockFormSchema>
