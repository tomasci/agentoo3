import { z } from '@hono/zod-openapi'
import { sessionFileStatusSchema } from '@/features/attachments/schema'
import { checkBranchName } from '@/lib/branch-name'

// --- ideas: the board -------------------------------------------------------

export const ideaStatusSchema = z.enum([
  'backlog',
  'todo',
  'selected_for_development',
  'in_progress_dev',
  'verification',
  'done',
])

export const ideaPromptKindSchema = z.enum(['initial', 'followup'])
export const ideaPromptStatusSchema = z.enum(['pending', 'ready', 'failed'])
export const ideaRunStatusSchema = z.enum(['generating', 'dispatching', 'running', 'closed'])
export const ideaRunOutcomeSchema = z.enum([
  'finished',
  'needs_attention',
  'interrupted',
  'superseded',
  'session_deleted',
])

/** What a board polling `GET /projects/{id}/ideas` needs to answer "is
 * anything still working" without a second round trip per card — see this
 * feature's routes.ts for the batched queries that fill these in. */
const latestPromptSchema = z
  .object({
    id: z.string().uuid(),
    kind: ideaPromptKindSchema,
    status: ideaPromptStatusSchema,
    assumptions: z
      .array(z.string())
      .nullable()
      .openapi({
        description:
          "Decisions the generator made on the user's behalf — the entire compensating control " +
          'for sending the generated prompt with no review step, so the board can show it on the ' +
          "card without a request per idea. Same field as GET /ideas/{id}/prompts's own.",
      }),
  })
  .nullable()
const openRunSchema = z.object({ id: z.string().uuid(), status: ideaRunStatusSchema }).nullable()

export const ideaSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  status: ideaStatusSchema,
  boardPosition: z.number().openapi({
    description:
      'Where this card sits within its column. Only meaningful relative to its siblings in ' +
      'the same status — use POST /ideas/{id}/move to change it, never PATCH.',
  }),
  sessionId: z
    .string()
    .uuid()
    .nullable()
    .openapi({
      description:
        'Set at handoff, when this idea is picked off "selected for development" and a ' +
        'session is created for it. Null before that.',
    }),
  orchestrator: z.string().nullable(),
  baseBranch: z.string().nullable(),
  maxBudgetUsd: z.number().int().nullable(),
  lastError: z
    .string()
    .nullable()
    .openapi({
      description:
        'Why a handoff could not proceed, surfaced on the card so the user knows why ' +
        'it is stuck rather than it silently not advancing.',
    }),
  blockCount: z.number().int(),
  commentCount: z.number().int(),
  assetCount: z.number().int(),
  latestPrompt: latestPromptSchema.openapi({
    description:
      'The most recently created prompt for this idea, or null if none has been ' +
      'generated yet.',
  }),
  sessionStatus: z.string().nullable().openapi({
    description: "The bound session's own status, joined in — null when sessionId is null.",
  }),
  openRun: openRunSchema.openapi({
    description: 'The one idea_runs row with no endedAt yet, if any — at most one at a time.',
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type IdeaDto = z.infer<typeof ideaSchema>

export const createIdeaSchema = z.object({
  title: z.string().min(1).max(300),
  status: ideaStatusSchema.optional().openapi({
    description: 'Which column the card starts in. Defaults to backlog.',
  }),
  orchestrator: z.string().min(1).max(64).optional().openapi({
    description: 'Name of a role:orchestrator agent from the library, used at handoff',
  }),
  baseBranch: z
    .string()
    .optional()
    .refine((v) => v === undefined || checkBranchName(v).ok, {
      // Same reasoning as createSessionSchema.baseBranch in features/sessions/schema.ts:
      // `error` rather than a static message so the specific reason
      // ("may not start with -", "is too long", ...) reaches the client. This only
      // checks shape — whether the branch actually exists is a session-creation
      // question, resolved later, at handoff, by a track this one hands off to.
      error: (issue) => {
        const check = checkBranchName(String(issue.input))
        return check.ok ? undefined : check.reason
      },
    })
    .openapi({
      description:
        "Cut this idea's session worktree from this branch instead of the project default, " +
        'once handed off.',
    }),
  maxBudgetUsd: z.number().int().positive().max(1000).optional(),
})
export type CreateIdeaInput = z.infer<typeof createIdeaSchema>

export const updateIdeaSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    orchestrator: z.string().min(1).max(64).nullable().optional(),
    baseBranch: z
      .string()
      .nullable()
      .optional()
      .refine((v) => v === undefined || v === null || checkBranchName(v).ok, {
        error: (issue) => {
          if (issue.input === null) return undefined
          const check = checkBranchName(String(issue.input))
          return check.ok ? undefined : check.reason
        },
      }),
    maxBudgetUsd: z.number().int().positive().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateIdeaInput = z.infer<typeof updateIdeaSchema>

export const moveIdeaSchema = z.object({
  status: ideaStatusSchema,
  // Both refer to cards already in the *destination* column (never the card
  // being moved itself). `afterId` is the neighbour that should end up just
  // above the moved card (lower boardPosition); `beforeId` is the one that
  // should end up just below. Omit one to land at that end of the column;
  // omit both to append at the end (or take the only slot, in an empty one)
  // — see moveIdea's own comment in service.ts for why "append" rather than
  // "top" is the default for a move with no drag position to go on.
  afterId: z.string().uuid().nullable().optional(),
  beforeId: z.string().uuid().nullable().optional(),
})
export type MoveIdeaInput = z.infer<typeof moveIdeaSchema>

// --- canvas: groups ----------------------------------------------------------

export const ideaGroupSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  seq: z.number().int().openapi({ description: "Heading order among this idea's groups" }),
  title: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable(),
  h: z.number().nullable(),
})
export type IdeaGroupDto = z.infer<typeof ideaGroupSchema>

const groupGeometrySchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
})

export const createIdeaGroupSchema = z
  .object({ title: z.string().min(1).max(200) })
  .extend(groupGeometrySchema.shape)
export type CreateIdeaGroupInput = z.infer<typeof createIdeaGroupSchema>

export const updateIdeaGroupSchema = z
  .object({ title: z.string().min(1).max(200).optional() })
  .extend(groupGeometrySchema.shape)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateIdeaGroupInput = z.infer<typeof updateIdeaGroupSchema>

// --- canvas: blocks -----------------------------------------------------------
//
// idea_blocks (db/schema.ts) has no columns for a link's url/label or an
// image's assetId/caption — only a generic `body` (text) and `meta` (jsonb).
// The mapping used everywhere below (service.ts's toBlockDto/blockColumnsFor)
// is: `body` holds the one field every kind has an unambiguous "primary"
// value for (a note/requirement/example's text, a link's url, an image's
// assetId), and `meta` holds whatever secondary field a kind also carries
// (a link's label, an image's caption). Chosen so every kind still has
// exactly one obvious place to look, rather than every kind's data
// flattened into `meta` with `body` left always empty.

export const ideaBlockKindSchema = z.enum(['note', 'requirement', 'example', 'link', 'image'])

const blockGeometrySchema = z.object({
  groupId: z.string().uuid().nullable().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
})

const noteContentSchema = z.object({ kind: z.literal('note'), text: z.string().min(1).max(20_000) })
const requirementContentSchema = z.object({
  kind: z.literal('requirement'),
  text: z.string().min(1).max(20_000),
})
const exampleContentSchema = z.object({
  kind: z.literal('example'),
  text: z.string().min(1).max(20_000),
})
const linkContentSchema = z.object({
  kind: z.literal('link'),
  url: z.string().min(1).max(2000),
  label: z.string().max(300).nullable().optional(),
})
const imageContentSchema = z.object({
  kind: z.literal('image'),
  assetId: z.string().uuid().openapi({ description: 'An asset already uploaded to this idea' }),
  caption: z.string().max(300).nullable().optional(),
})

export const createIdeaBlockSchema = z.discriminatedUnion('kind', [
  noteContentSchema.extend(blockGeometrySchema.shape),
  requirementContentSchema.extend(blockGeometrySchema.shape),
  exampleContentSchema.extend(blockGeometrySchema.shape),
  linkContentSchema.extend(blockGeometrySchema.shape),
  imageContentSchema.extend(blockGeometrySchema.shape),
])
export type CreateIdeaBlockInput = z.infer<typeof createIdeaBlockSchema>

// Content fields are gated by the block's *existing* kind (read from its row,
// not from this body — kind itself is immutable after creation, so there is
// nothing here to discriminate on), which is why this is a flat, not a
// discriminated, schema. service.ts's updateIdeaBlock reads whichever of
// these apply to the row it already has and ignores the rest.
export const updateIdeaBlockSchema = z
  .object({
    text: z.string().min(1).max(20_000).optional(),
    url: z.string().min(1).max(2000).optional(),
    label: z.string().max(300).nullable().optional(),
    assetId: z.string().uuid().optional(),
    caption: z.string().max(300).nullable().optional(),
  })
  .extend(blockGeometrySchema.shape)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateIdeaBlockInput = z.infer<typeof updateIdeaBlockSchema>

// Only blocks — not groups — are reordered here. Groups keep their own seq
// (their own heading order, a separate number line from blocks: see
// nextGroupSeq's comment in service.ts) and the serializer treats the two as
// independent dimensions ("ungrouped blocks by seq, then each group by
// group.seq, with members by block.seq" — serialize.ts). Folding group
// reordering into this same endpoint would mean validating two different id
// spaces against one flat `order` array instead of one; if the canvas track
// ever needs to let a user drag groups into a new heading order, that reads
// as its own endpoint (POST /ideas/{id}/groups/reorder), not a variant of
// this one.
export const reorderIdeaBlocksSchema = z.object({
  order: z
    .array(z.string().uuid())
    .min(1)
    .openapi({
      description:
        "Every one of the idea's block ids, in the new reading order. Must be an exact " +
        'permutation of its current blocks — no id missing, none repeated, none from another ' +
        'idea — or the whole request is rejected rather than partially applied.',
    }),
})
export type ReorderIdeaBlocksInput = z.infer<typeof reorderIdeaBlocksSchema>

const blockCommonResponseSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  groupId: z.string().uuid().nullable(),
  seq: z
    .number()
    .int()
    .openapi({
      description:
        'Reading order — allocated once, from ideas.nextSeq, when the block is created. Never ' +
        'reused and, today, never changed afterward; the canvas position (x/y) below is ' +
        'independent of it.',
    }),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable(),
  h: z.number().nullable(),
})

export const ideaBlockSchema = z.discriminatedUnion('kind', [
  blockCommonResponseSchema.extend(noteContentSchema.shape),
  blockCommonResponseSchema.extend(requirementContentSchema.shape),
  blockCommonResponseSchema.extend(exampleContentSchema.shape),
  blockCommonResponseSchema.extend({
    kind: z.literal('link'),
    url: z.string(),
    label: z.string().nullable(),
  }),
  blockCommonResponseSchema.extend({
    kind: z.literal('image'),
    assetId: z.string().uuid(),
    caption: z.string().nullable(),
  }),
])
export type IdeaBlockDto = z.infer<typeof ideaBlockSchema>

// --- feedback: comments --------------------------------------------------------

export const ideaCommentSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  body: z.string(),
  createdAt: z.string(),
  consumedAt: z
    .string()
    .nullable()
    .openapi({ description: 'Set when a followup prompt has folded this comment in' }),
})
export type IdeaCommentDto = z.infer<typeof ideaCommentSchema>

export const createIdeaCommentSchema = z.object({ body: z.string().min(1).max(10_000) })
export type CreateIdeaCommentInput = z.infer<typeof createIdeaCommentSchema>

// --- prompts --------------------------------------------------------------------

export const ideaPromptSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  kind: ideaPromptKindSchema,
  sourceDigest: z.string().openapi({
    description: 'The deterministic document the model was given — see features/ideas/serialize.ts',
  }),
  generatedTitle: z.string().nullable(),
  generatedText: z.string().nullable(),
  assumptions: z.array(z.string()).nullable().openapi({
    description: "Decisions the generator made on the user's behalf",
  }),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  status: ideaPromptStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
})
export type IdeaPromptDto = z.infer<typeof ideaPromptSchema>

export const createIdeaPromptSchema = z.object({
  kind: ideaPromptKindSchema.openapi({
    description:
      'initial: build a development prompt from the canvas as it stands. followup: fold in ' +
      "what the session did and any unconsumed feedback comments since the idea's last prompt. " +
      'Also the regenerate affordance for a stuck-pending or failed prompt of either kind — ' +
      'posting again with the same kind supersedes it rather than being blocked by it.',
  }),
})
export type CreateIdeaPromptInput = z.infer<typeof createIdeaPromptSchema>

// --- runs (read-only here — created and closed by the handoff track) ------------

export const ideaRunSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  promptId: z.string().uuid().nullable(),
  promptMessageId: z.string().uuid().nullable(),
  kind: ideaPromptKindSchema,
  status: ideaRunStatusSchema,
  outcome: ideaRunOutcomeSchema.nullable(),
  detail: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
export type IdeaRunDto = z.infer<typeof ideaRunSchema>

// --- assets: upload/download, mirroring features/attachments/schema.ts ----------

export const ideaFileSchema = z.object({
  id: z.string().uuid(),
  ideaId: z.string().uuid(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  checksum: z.string().openapi({ description: 'sha256, hex-encoded' }),
  status: sessionFileStatusSchema,
  lineCount: z.number().int().nullable(),
  pageCount: z.number().int().nullable(),
  createdAt: z.string(),
  matchedExisting: z.boolean().openapi({
    description:
      'True on POST /ideas/{id}/assets when this row is an earlier, identical-bytes upload ' +
      'this request matched rather than a new one it just created — originalFilename above ' +
      'names that earlier upload, not the file just sent. Always false from GET (list) or ' +
      'download, where nothing was just uploaded to match against.',
  }),
})
export type IdeaFileResponseDto = z.infer<typeof ideaFileSchema>

export const ideaFilesUsageSchema = z.object({
  fileCount: z.number().int(),
  sizeBytes: z.number().int(),
  maxFiles: z.number().int(),
  maxIdeaBytes: z.number().int(),
})

export const ideaFilesListSchema = z.object({
  files: z.array(ideaFileSchema),
  usage: ideaFilesUsageSchema,
})
export type IdeaFilesListResponseDto = z.infer<typeof ideaFilesListSchema>

export const uploadIdeaFileBodySchema = z.object({
  file: z.file().openapi({
    type: 'string',
    format: 'binary',
    description: 'The file to attach to this idea',
  }),
})
