import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listIdeaFiles, uploadIdeaFile } from '@/features/ideas/files'
import { continueIdea } from '@/features/ideas/handoff'
import { errorSchema } from '@/features/projects/schema'
import { AppError, badRequest, errorBody } from '@/lib/errors'
import { hasControlChars } from '@/lib/text'
import {
  createIdeaBlockSchema,
  createIdeaCommentSchema,
  createIdeaGroupSchema,
  createIdeaPromptSchema,
  createIdeaSchema,
  ideaBlockSchema,
  ideaCommentSchema,
  ideaFileSchema,
  ideaFilesListSchema,
  ideaGroupSchema,
  ideaPromptSchema,
  ideaRunSchema,
  ideaSchema,
  moveIdeaSchema,
  reorderIdeaBlocksSchema,
  updateIdeaBlockSchema,
  updateIdeaGroupSchema,
  updateIdeaSchema,
  uploadIdeaFileBodySchema,
} from './schema'
import {
  createIdea,
  createIdeaBlock,
  createIdeaComment,
  createIdeaGroup,
  createIdeaPrompt,
  deleteIdea,
  deleteIdeaAsset,
  deleteIdeaBlock,
  deleteIdeaComment,
  deleteIdeaGroup,
  downloadIdeaAsset,
  getIdea,
  listIdeaBlocks,
  listIdeaComments,
  listIdeaGroups,
  listIdeaPrompts,
  listIdeaRuns,
  listIdeas,
  moveIdea,
  reorderIdeaBlocks,
  updateIdea,
  updateIdeaBlock,
  updateIdeaGroup,
} from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const ideasRouter = new OpenAPIHono()

// Same reasoning as sessionsRouter.onError (features/sessions/routes.ts): lets
// this router be tested standalone (mounted under a bespoke parent, or hit
// directly via `.request()`) and still answer an AppError in the exact
// envelope app.ts's own onError produces when this router is mounted for
// real — and it is what /idea-assets/{id}/download (below, outside the
// OpenAPI router) needs, since that route never reaches app.ts's onError on
// its own.
ideasRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

// --- ideas: the board --------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/ideas',
    tags: ['ideas'],
    summary: "List a project's ideas",
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaSchema), 'Ideas, grouped by column and ordered within it'),
      404: json(errorSchema, 'Project not found'),
    },
  }),
  async (c) => c.json(await listIdeas(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/ideas',
    tags: ['ideas'],
    summary: 'Create an idea card',
    request: { params: idParam, body: json(createIdeaSchema, 'Idea to create') },
    responses: {
      201: json(ideaSchema, 'Created'),
      404: json(errorSchema, 'Project not found'),
    },
  }),
  async (c) => c.json(await createIdea(c.req.valid('param').id, c.req.valid('json')), 201),
)

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}',
    tags: ['ideas'],
    summary: 'Get one idea',
    request: { params: idParam },
    responses: { 200: json(ideaSchema, 'Idea'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getIdea(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/ideas/{id}',
    tags: ['ideas'],
    summary: 'Rename an idea, or change its orchestrator, base branch or budget',
    description: 'Status and board position are not settable here — see POST /ideas/{id}/move.',
    request: { params: idParam, body: json(updateIdeaSchema, 'Fields to change') },
    responses: {
      200: json(ideaSchema, 'Updated'),
      400: json(errorSchema, 'Invalid input'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateIdea(c.req.valid('param').id, c.req.valid('json')), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/ideas/{id}',
    tags: ['ideas'],
    summary: 'Delete an idea and its whole canvas',
    request: { params: idParam },
    responses: {
      204: { description: 'Deleted' },
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'A handoff is in progress'),
    },
  }),
  async (c) => {
    await deleteIdea(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/move',
    tags: ['ideas'],
    summary: 'Move a card to a status and a slot within it',
    description:
      'afterId/beforeId name the cards that should end up immediately above/below the moved ' +
      'one in the destination column; omit one to land at that end, omit both to append. The ' +
      'new position is the midpoint of its neighbours — or, when that gap is too small to trust ' +
      'any more, the whole destination column is renumbered in the same transaction.',
    request: { params: idParam, body: json(moveIdeaSchema, 'Target status and neighbours') },
    responses: {
      200: json(ideaSchema, 'Moved'),
      400: json(errorSchema, 'afterId/beforeId not in the destination column, or out of order'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await moveIdea(c.req.valid('param').id, c.req.valid('json')), 200),
)

// --- canvas: blocks -----------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/blocks',
    tags: ['ideas'],
    summary: "List an idea's canvas blocks, in reading order",
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaBlockSchema), 'Blocks'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaBlocks(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/blocks',
    tags: ['ideas'],
    summary: 'Add a block to the canvas',
    description:
      "Reading order (seq) is allocated automatically, atomically, from this idea's own " +
      'counter — never supplied by the caller.',
    request: { params: idParam, body: json(createIdeaBlockSchema, 'Block to create') },
    responses: {
      201: json(ideaBlockSchema, 'Created'),
      400: json(errorSchema, 'groupId/assetId does not belong to this idea'),
      404: json(errorSchema, 'Idea not found'),
    },
  }),
  async (c) => c.json(await createIdeaBlock(c.req.valid('param').id, c.req.valid('json')), 201),
)

ideasRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/idea-blocks/{id}',
    tags: ['ideas'],
    summary: "Update a block's content or canvas position",
    description:
      "Content fields are read according to the block's own (immutable) kind; a field that " +
      'does not apply to it is ignored rather than rejected.',
    request: { params: idParam, body: json(updateIdeaBlockSchema, 'Fields to change') },
    responses: {
      200: json(ideaBlockSchema, 'Updated'),
      400: json(errorSchema, "groupId/assetId does not belong to this block's idea"),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateIdeaBlock(c.req.valid('param').id, c.req.valid('json')), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/idea-blocks/{id}',
    tags: ['ideas'],
    summary: 'Remove a block from the canvas',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteIdeaBlock(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/blocks/reorder',
    tags: ['ideas'],
    summary: "Fix a card's reading order",
    description:
      'Reassigns every block a fresh seq in one transaction, per the given permutation — the ' +
      'correcting half of seq (see idea_blocks.seq, db/schema.ts): dragging a card only ever ' +
      'moves its canvas x/y, never its reading order. Only blocks are reordered here; groups ' +
      'keep their own seq. Submitting the current order is a no-op, and idea.updatedAt is not ' +
      "touched by this (it gates a different mechanism's retry window — see handoff.ts's " +
      'claimSelectedIdeas).',
    request: { params: idParam, body: json(reorderIdeaBlocksSchema, 'The full new order') },
    responses: {
      200: json(z.array(ideaBlockSchema), 'Blocks, in the new order'),
      400: json(
        errorSchema,
        "order is not an exact permutation of this idea's current blocks: something is " +
          'missing, duplicated, or belongs to a different idea',
      ),
      404: json(errorSchema, 'Idea not found'),
    },
  }),
  async (c) => c.json(await reorderIdeaBlocks(c.req.valid('param').id, c.req.valid('json')), 200),
)

// --- canvas: groups -------------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/groups',
    tags: ['ideas'],
    summary: "List an idea's canvas groups",
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaGroupSchema), 'Groups'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaGroups(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/groups',
    tags: ['ideas'],
    summary: 'Add a group to the canvas',
    request: { params: idParam, body: json(createIdeaGroupSchema, 'Group to create') },
    responses: { 201: json(ideaGroupSchema, 'Created'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await createIdeaGroup(c.req.valid('param').id, c.req.valid('json')), 201),
)

ideasRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/idea-groups/{id}',
    tags: ['ideas'],
    summary: 'Rename a group or move it on the canvas',
    request: { params: idParam, body: json(updateIdeaGroupSchema, 'Fields to change') },
    responses: {
      200: json(ideaGroupSchema, 'Updated'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateIdeaGroup(c.req.valid('param').id, c.req.valid('json')), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/idea-groups/{id}',
    tags: ['ideas'],
    summary: 'Remove a group; its blocks fall back to ungrouped rather than being deleted',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteIdeaGroup(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

// --- feedback: comments ----------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/comments',
    tags: ['ideas'],
    summary: "List an idea's feedback comments",
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaCommentSchema), 'Comments, oldest first'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaComments(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/comments',
    tags: ['ideas'],
    summary: 'Leave feedback on an idea',
    description:
      'Folded into the next followup prompt this idea generates — see POST ' +
      '/ideas/{id}/prompts.',
    request: { params: idParam, body: json(createIdeaCommentSchema, 'Comment to add') },
    responses: { 201: json(ideaCommentSchema, 'Created'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await createIdeaComment(c.req.valid('param').id, c.req.valid('json')), 201),
)

ideasRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/idea-comments/{id}',
    tags: ['ideas'],
    summary: 'Remove a comment',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteIdeaComment(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

// --- prompts --------------------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/prompts',
    tags: ['ideas'],
    summary: "List an idea's generated prompts, newest first",
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaPromptSchema), 'Prompts'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaPrompts(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/prompts',
    tags: ['ideas'],
    summary: 'Generate (or regenerate) a development prompt',
    description:
      'Builds the source document, inserts the pending row and — for kind=followup — stamps ' +
      'every currently-unconsumed comment consumed, all in one transaction; the generation job ' +
      'is enqueued only once that commits. Also the regenerate affordance for a prompt stuck ' +
      'pending or ended failed: reposting the same kind supersedes it rather than being blocked ' +
      'by it, and never re-consumes a comment a stale attempt already consumed.',
    request: { params: idParam, body: json(createIdeaPromptSchema, 'Which kind to generate') },
    responses: {
      201: json(ideaPromptSchema, 'Accepted; generation runs in the background'),
      400: json(errorSchema, 'This idea has no orchestrator'),
      404: json(errorSchema, 'Not found'),
      409: json(
        errorSchema,
        'Project is not ready, or a followup was requested with no completed run/prompt yet',
      ),
    },
  }),
  async (c) => c.json(await createIdeaPrompt(c.req.valid('param').id, c.req.valid('json')), 201),
)

// --- runs -------------------------------------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/runs',
    tags: ['ideas'],
    summary: "List an idea's handoff runs, newest first",
    description:
      'Read-only here: runs are created and closed by the track that owns session creation ' +
      'and dispatch, not this one.',
    request: { params: idParam },
    responses: {
      200: json(z.array(ideaRunSchema), 'Runs'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaRuns(c.req.valid('param').id), 200),
)

// --- continuing after verification -------------------------------------------

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/continue',
    tags: ['ideas'],
    summary: 'Continue work on an idea, after verification',
    description:
      'Generates a follow-up prompt (folding in what the last run did and any unconsumed ' +
      'feedback comments) and hands it into the same session the idea already has, exactly like ' +
      'the initial handoff — the idea moves to in_progress_dev once that finishes, not ' +
      'immediately: generation and dispatch both run in the background, the same way POST ' +
      '/ideas/{id}/prompts already does for the prompt half of this.',
    request: { params: idParam },
    responses: {
      200: json(ideaSchema, 'Accepted; the follow-up run starts once its prompt is ready'),
      400: json(errorSchema, 'This idea has no orchestrator'),
      404: json(errorSchema, 'Not found'),
      409: json(
        errorSchema,
        'A handoff is already in progress, project is not ready, or there is no completed run ' +
          'yet to follow up on',
      ),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    await continueIdea(id)
    return c.json(await getIdea(id), 200)
  },
)

// --- assets: upload/download, mirroring features/attachments/routes.ts -----------

ideasRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ideas/{id}/assets',
    tags: ['ideas'],
    summary: "List an idea's attached files, with usage against its limits",
    request: { params: idParam },
    responses: {
      200: json(ideaFilesListSchema, 'Files and usage'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listIdeaFiles(c.req.valid('param').id), 200),
)

ideasRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ideas/{id}/assets',
    tags: ['ideas'],
    summary: 'Attach a file to an idea',
    description:
      'Multipart upload, field `file`. Copied into its session at handoff (see ' +
      'attachIdeaAssetsToSession, features/ideas/files.ts). Re-uploading identical content to ' +
      'the same idea returns the existing row rather than storing a duplicate.',
    request: {
      params: idParam,
      body: {
        content: { 'multipart/form-data': { schema: uploadIdeaFileBodySchema } },
        required: true,
      },
    },
    responses: {
      201: json(ideaFileSchema, 'Stored (or the existing row, for identical content)'),
      400: json(errorSchema, 'Rejected: too large, an unrecognised type, or over a quota'),
      404: json(errorSchema, 'Idea not found'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { file } = c.req.valid('form')
    // Same defensive check as attachments/routes.ts's identical upload route:
    // z.file() only checks shape, so a client that sent the wrong field name
    // or content type entirely lands here with an empty {} rather than a
    // validation error.
    if (!(file instanceof Blob)) throw badRequest('Expected multipart/form-data with a file field')
    const originalFilename = 'name' in file && typeof file.name === 'string' ? file.name : 'file'
    const dto = await uploadIdeaFile(
      id,
      originalFilename,
      file.stream(),
      file.type || undefined,
      file.size,
    )
    return c.json(dto, 201)
  },
)

ideasRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/idea-assets/{id}',
    tags: ['ideas'],
    summary: 'Remove an asset from its idea',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteIdeaAsset(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

/** Served with their real type only for the four allow-listed image types
 * (needed for <img> thumbnails); everything else goes out as
 * application/octet-stream with Content-Disposition: attachment — same
 * reasoning as attachments/routes.ts's identical constant and the comment on
 * its own download route, which this mirrors exactly. Duplicated rather than
 * imported: that module keeps both private, and this feature does not touch
 * features/attachments/**. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function contentDispositionName(name: string): string {
  const safe = Array.from(name)
    .filter((ch) => !hasControlChars(ch))
    .join('')
    .replace(/["\\]/g, '_')
  return safe || 'file'
}

/**
 * Serve bytes for one asset id.
 *
 * Registered outside the OpenAPI router, like attachments/routes.ts's
 * /sessions/:id/files/:fileId: this is a download the browser navigates to,
 * not a JSON fetch, and the generated client neither preserves nor exposes
 * Content-Disposition. No Range/206 support here either, for the same reason
 * that module gives: nothing yet parses an incoming Range header, additive
 * whenever a caller needs it.
 */
ideasRouter.get('/idea-assets/:id/download', async (c) => {
  const parsed = z.string().uuid().safeParse(c.req.param('id'))
  if (!parsed.success) throw badRequest('Invalid id')

  const download = await downloadIdeaAsset(parsed.data)
  const isImage = INLINE_IMAGE_TYPES.has(download.dto.mimeType)

  const headers: Record<string, string> = {
    'Content-Type': isImage ? download.dto.mimeType : 'application/octet-stream',
    'Content-Length': String(download.sizeBytes),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': isImage ? 'public, max-age=31536000, immutable' : 'no-store',
  }
  if (!isImage) {
    headers['Content-Disposition'] =
      `attachment; filename="${contentDispositionName(download.dto.originalFilename)}"`
  }

  return c.body(download.stream, 200, headers)
})
