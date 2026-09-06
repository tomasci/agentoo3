import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { badRequest } from '@/lib/errors'
import { hasControlChars } from '@/lib/text'
import { enqueueAttachmentsGc } from '@/queue'
import {
  anomalyBulkActionSchema,
  anomalyBulkIdsActionSchema,
  anomalyListQuerySchema,
  anomalyRemediationSchema,
  anomalyResolveBodySchema,
  bulkAnomalyRemediationSchema,
  bulkResultSchema,
  gcEnqueuedSchema,
  sessionFileSchema,
  sessionFilesListSchema,
  storageAnomalySchema,
  storageSummarySchema,
  uploadFileBodySchema,
} from './schema'
import {
  bulkResolveAnomalies,
  deleteAnomaliesByIds,
  deleteAnomalyById,
  deleteFile,
  getFileForDownload,
  listAnomalies,
  listFiles,
  recheckAnomalyById,
  resolveAnomaly,
  storageSummary,
  uploadFile,
} from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const fileIdParams = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
  fileId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'fileId', in: 'path' } }),
})

const anomalyIdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const attachmentsRouter = new OpenAPIHono()

// --- session-scoped files ----------------------------------------------------

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/files',
    tags: ['attachments'],
    summary: 'Attach a file to a session',
    description:
      'Multipart upload, field `file`. Available on disk to the orchestrator and every ' +
      'subagent from the next turn onward — see additionalDirectories in runner-options.ts. ' +
      'Re-uploading identical content to the same session returns the existing row rather ' +
      'than storing a duplicate.',
    request: {
      params: idParam,
      body: {
        content: { 'multipart/form-data': { schema: uploadFileBodySchema } },
        required: true,
      },
    },
    responses: {
      201: json(sessionFileSchema, 'Stored (or the existing row, for identical content)'),
      400: json(errorSchema, 'Rejected: too large, an unrecognised type, or over a quota'),
      404: json(errorSchema, 'Session not found'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { file } = c.req.valid('form')
    // z.file() only checks the shape; a client that sent the wrong field name
    // or the wrong content type entirely lands here with an empty {} instead
    // of a validation error (see @hono/zod-openapi's non-required body path).
    if (!(file instanceof Blob)) throw badRequest('Expected multipart/form-data with a file field')
    const originalFilename = 'name' in file && typeof file.name === 'string' ? file.name : 'file'
    const dto = await uploadFile(
      id,
      originalFilename,
      file.stream(),
      file.type || undefined,
      file.size,
    )
    return c.json(dto, 201)
  },
)

attachmentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/sessions/{id}/files',
    tags: ['attachments'],
    summary: "List a session's attached files, with usage against its limits",
    request: { params: idParam },
    responses: {
      200: json(sessionFilesListSchema, 'Files and usage'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listFiles(c.req.valid('param').id), 200),
)

attachmentsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/sessions/{id}/files/{fileId}',
    tags: ['attachments'],
    summary: 'Remove a file from a session',
    request: { params: fileIdParams },
    responses: {
      204: { description: 'Deleted' },
      404: json(errorSchema, 'Not found in this session'),
    },
  }),
  async (c) => {
    const { id, fileId } = c.req.valid('param')
    await deleteFile(id, fileId)
    return c.body(null, 204)
  },
)

/** Served with their real type — needed for <img> thumbnails — and safe to,
 * since the allowlist already restricts these four to actual image bytes. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Strips characters that would break out of the quoted header value or
 * inject a second header via a raw CRLF. Not the on-disk sanitizer in
 * storage.ts — that flattens for a filesystem; this only has to be safe
 * inside one HTTP header. */
function contentDispositionName(name: string): string {
  const safe = Array.from(name)
    .filter((ch) => !hasControlChars(ch))
    .join('')
    .replace(/["\\]/g, '_')
  return safe || 'file'
}

/**
 * Serve bytes for (sessionId, fileId).
 *
 * Registered outside the OpenAPI router, like /sessions/:id/export — the
 * generated client neither preserves nor exposes Content-Disposition, and
 * this is a download the browser navigates to, not a JSON fetch.
 *
 * Streamed from Bun rather than handed to nginx via X-Accel-Redirect: nginx
 * runs as www-data and the uploads tree is 0700 agentoo, so X-Accel would
 * require loosening the one OS-level control this feature has, to solve a
 * throughput problem that does not exist on a single tailnet node serving
 * files up to 25 MiB. `storage.open()`'s ReadableStream is backed by
 * `Bun.file(path)`, so the bytes are read by Bun's own native path either way.
 *
 * Non-images are always served as `application/octet-stream` with
 * `Content-Disposition: attachment` — never the stored type — because there
 * is no app-level auth here by design, and echoing a stored `text/html`-ish
 * type back same-origin would be script execution for any browser on the
 * tailnet. `X-Content-Type-Options: nosniff` on every response makes that
 * hold even if a browser second-guesses the declared type.
 *
 * No Range/206 support at this layer: `storage.open()` accepts a byte range
 * already, but nothing here parses an incoming `Range` header yet — the API
 * surface this feature was scoped to serves whole files, and partial-content
 * support is additive whenever a caller (a PDF viewer seeking, say) needs it.
 */
attachmentsRouter.get('/sessions/:id/files/:fileId', async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  const fileId = z.string().uuid().safeParse(c.req.param('fileId'))
  if (!sessionId.success || !fileId.success) throw badRequest('Invalid id')

  const download = await getFileForDownload(sessionId.data, fileId.data)
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

// --- storage / reconciliation ------------------------------------------------

attachmentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/storage/summary',
    tags: ['storage'],
    summary: 'Usage totals and open anomaly count',
    responses: { 200: json(storageSummarySchema, 'Summary') },
  }),
  async (c) => c.json(await storageSummary(), 200),
)

attachmentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/storage/anomalies',
    tags: ['storage'],
    summary: 'List storage anomalies, optionally filtered',
    description:
      'Persisted findings from the reconciliation job, not computed on page load — so this ' +
      'is instant, and history survives past the run that found something.',
    request: { query: anomalyListQuerySchema },
    responses: { 200: json(z.array(storageAnomalySchema), 'Anomalies') },
  }),
  async (c) => c.json(await listAnomalies(c.req.valid('query')), 200),
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/check',
    tags: ['storage'],
    summary: 'Run the reconciliation check now',
    description:
      'Enqueues the same job the hourly schedule enqueues — one code path, not a second ' +
      'implementation of "walk the store and classify".',
    responses: { 202: json(gcEnqueuedSchema, 'Enqueued') },
  }),
  async (c) => {
    await enqueueAttachmentsGc({ reason: 'manual' })
    return c.json({ enqueued: true as const }, 202)
  },
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/cleanup',
    tags: ['storage'],
    summary: 'Resolve every anomaly the last check found',
    description:
      'Acts only on anomalies already classified by the last check run — deletes orphan ' +
      'blobs, dangling rows and orphan session directories. checksum_mismatch is reported ' +
      'only: there is no automatic way to know whether the database or the disk is right.',
    responses: { 202: json(gcEnqueuedSchema, 'Enqueued') },
  }),
  async (c) => {
    await enqueueAttachmentsGc({ reason: 'cleanup' })
    return c.json({ enqueued: true as const }, 202)
  },
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/anomalies/{id}/resolve',
    tags: ['storage'],
    summary: 'Dismiss one anomaly',
    description:
      'Marks this row resolved without taking any destructive action — remediation runs ' +
      'through /storage/cleanup. A row still genuinely present is reopened by the next check.',
    request: { params: anomalyIdParam, body: json(anomalyResolveBodySchema, 'Optional note') },
    responses: {
      200: json(storageAnomalySchema, 'Resolved'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { note } = c.req.valid('json')
    return c.json(await resolveAnomaly(id, note), 200)
  },
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/anomalies/bulk',
    tags: ['storage'],
    summary: 'Dismiss every open anomaly matching a filter',
    request: { body: json(anomalyBulkActionSchema, 'Filter') },
    responses: { 200: json(bulkResultSchema, 'How many were resolved') },
  }),
  async (c) => {
    const resolved = await bulkResolveAnomalies(c.req.valid('json'))
    return c.json({ resolved }, 200)
  },
)

// --- per-row and bulk-by-id remediation: destructive, unlike resolve/bulk ---
//
// Every one of these goes through service.ts's deleteAnomalyById /
// recheckAnomalyById / deleteAnomaliesByIds, which in turn go through
// reconcile.ts's remediateAnomaly — the same re-verifying, per-row unit
// gc.ts's runCleanup uses. Never a raw filesystem call from a handler here,
// and never a second implementation of "is this still real".

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/anomalies/{id}/delete',
    tags: ['storage'],
    summary: 'Delete what this one anomaly names',
    description:
      "Removes the orphan blob, dangling row, or orphan session directory this anomaly's own " +
      'class calls for — or, for a checksum_mismatch, both the corrupt blob and its row. ' +
      're-verifies immediately before acting: an entry that already fixed itself since the ' +
      "last check is resolved without anything being deleted (see the response's `outcome`).",
    request: { params: anomalyIdParam },
    responses: {
      200: json(anomalyRemediationSchema, 'What happened'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Already resolved'),
    },
  }),
  async (c) => c.json(await deleteAnomalyById(c.req.valid('param').id), 200),
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/anomalies/{id}/recheck',
    tags: ['storage'],
    summary: 'Re-run the check on one anomaly, without deleting anything',
    description:
      'A finding that no longer holds is resolved (it fixed itself); one that still holds ' +
      'stays open with its lastSeenAt refreshed, exactly like a full check re-confirming it.',
    request: { params: anomalyIdParam },
    responses: {
      200: json(anomalyRemediationSchema, 'What the recheck found'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Already resolved'),
    },
  }),
  async (c) => c.json(await recheckAnomalyById(c.req.valid('param').id), 200),
)

attachmentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/storage/anomalies/bulk-delete',
    tags: ['storage'],
    summary: 'Delete every anomaly in an explicit, selected id list',
    description:
      'The destructive counterpart to /storage/anomalies/bulk (which only dismisses): for ' +
      '"the rows I selected" rather than a class-wide sweep — that is /storage/cleanup. Every ' +
      'id is re-verified before anything is deleted; an id no longer open (already resolved, ' +
      'or not found) is silently omitted from the result rather than failing the whole batch.',
    request: { body: json(anomalyBulkIdsActionSchema, 'The ids to act on') },
    responses: { 200: json(bulkAnomalyRemediationSchema, 'What happened to each') },
  }),
  async (c) => {
    const results = await deleteAnomaliesByIds(c.req.valid('json').ids)
    return c.json({ results }, 200)
  },
)
