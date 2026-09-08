import { z } from '@hono/zod-openapi'

export const sessionFileStatusSchema = z.enum(['ready', 'missing', 'unreadable'])

export const sessionFileSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  checksum: z.string().openapi({ description: 'sha256, hex-encoded' }),
  status: sessionFileStatusSchema.openapi({
    description:
      "'missing' means the GC job could not find this file's blob on disk any more; it is " +
      'omitted from ATTACHMENTS.md and the per-turn announcement so an agent is never pointed ' +
      'at a Read that will fail',
  }),
  lineCount: z.number().int().nullable(),
  pageCount: z.number().int().nullable(),
  createdAt: z.string(),
})
export type SessionFileDto = z.infer<typeof sessionFileSchema>

export const sessionFilesUsageSchema = z.object({
  fileCount: z.number().int(),
  sizeBytes: z.number().int(),
  maxFiles: z.number().int(),
  maxSessionBytes: z.number().int(),
})
export type SessionFilesUsageDto = z.infer<typeof sessionFilesUsageSchema>

export const sessionFilesListSchema = z.object({
  files: z.array(sessionFileSchema),
  usage: sessionFilesUsageSchema,
})
export type SessionFilesListDto = z.infer<typeof sessionFilesListSchema>

export const uploadFileBodySchema = z.object({
  // zod-to-openapi does not introspect z.file()'s internal shape on its own
  // ("Unknown zod object type") — type/format have to be given explicitly,
  // which is also exactly the OpenAPI shape a multipart file field needs.
  file: z.file().openapi({
    type: 'string',
    format: 'binary',
    description: 'The file to attach to this session',
  }),
})

// --- storage / reconciliation ----------------------------------------------

// Mirrors db/schema.ts's storageAnomalyClassEnum exactly — see that file's
// comment on storage_anomalies for what each class means and why the three
// idea_* ones exist as distinct classes rather than a scope column.
export const storageAnomalyClassSchema = z.enum([
  'orphan_blob',
  'dangling_row',
  'orphan_session_dir',
  'checksum_mismatch',
  'orphan_idea_dir',
  'idea_dangling_row',
  'idea_checksum_mismatch',
])
export type StorageAnomalyClass = z.infer<typeof storageAnomalyClassSchema>

export const storageAnomalySchema = z.object({
  id: z.string().uuid(),
  class: storageAnomalyClassSchema,
  sessionId: z.string().uuid().nullable(),
  fileId: z.string().uuid().nullable(),
  path: z.string().nullable(),
  originalFilename: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  detail: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  resolvedAt: z.string().nullable(),
})
export type StorageAnomalyDto = z.infer<typeof storageAnomalySchema>

export const anomalyListQuerySchema = z.object({
  class: storageAnomalyClassSchema.optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'))
    .openapi({ param: { name: 'resolved', in: 'query' } }),
})
export type AnomalyListQuery = { class?: StorageAnomalyClass; resolved?: boolean }

export const anomalyResolveBodySchema = z.object({
  note: z.string().max(500).optional(),
})

// Only currently-open rows are ever affected — "resolve" on an already-
// resolved row is meaningless — so the filters worth exposing here are which
// class to act on, plus an explicit id list for "the rows I selected" (a
// class filter alone cannot express a specific subset), plus the same
// optional note a single resolve takes.
export const anomalyBulkActionSchema = z.object({
  class: storageAnomalyClassSchema.optional(),
  ids: z
    .array(z.string().uuid())
    .max(500)
    .optional()
    .openapi({ description: 'Dismiss exactly these rows instead of (or in addition to) class' }),
  note: z.string().max(500).optional(),
})
export type AnomalyBulkAction = z.infer<typeof anomalyBulkActionSchema>

export const bulkResultSchema = z.object({ resolved: z.number().int() })

// --- per-row and bulk-by-id remediation -------------------------------------
//
// Destructive, unlike resolve/bulk above: these delete the blob, the row or
// the directory an anomaly names, going through the exact same re-verifying
// remediation path /storage/cleanup uses (see reconcile.ts) rather than a
// second implementation.

export const anomalyActionOutcomeSchema = z.enum(['deleted', 'revalidated', 'unchanged', 'failed'])

export const anomalyRemediationSchema = z.object({
  anomaly: storageAnomalySchema,
  outcome: anomalyActionOutcomeSchema.openapi({
    description:
      "'deleted' removed what this anomaly named; 'revalidated' means it no longer held by " +
      "the time this ran (it fixed itself), so nothing was deleted; 'unchanged' is the " +
      "recheck-only result for a finding that still holds; 'failed' means the delete itself " +
      'errored — see error',
  }),
  error: z.string().optional(),
})
export type AnomalyRemediationDto = z.infer<typeof anomalyRemediationSchema>

export const anomalyBulkIdsActionSchema = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(500)
    .openapi({ description: 'Act on exactly these anomalies, not a class-wide sweep' }),
})
export type AnomalyBulkIdsAction = z.infer<typeof anomalyBulkIdsActionSchema>

export const bulkAnomalyRemediationSchema = z.object({
  results: z.array(anomalyRemediationSchema).openapi({
    description:
      'One entry per id that was still open when this ran; an id already resolved, or not ' +
      'found, is silently omitted rather than failing the whole batch',
  }),
})

export const topSessionSchema = z.object({
  sessionId: z.string().uuid(),
  sizeBytes: z.number().int(),
  fileCount: z.number().int(),
})

export const storageSummarySchema = z.object({
  totalBytes: z.number().int().openapi({
    description: 'session file bytes plus idea asset bytes combined — see sessionBytes/ideaBytes',
  }),
  totalFiles: z.number().int(),
  // A handed-off asset lives on disk twice (its idea copy, and the copy
  // attachIdeaAssetsToSession made in its session) and legitimately counts
  // in both sums below — this is a disk-space cap, not a count of distinct
  // logical files. Additive fields: existing consumers of totalBytes/
  // totalFiles are unaffected by these being present.
  sessionBytes: z.number().int(),
  sessionFiles: z.number().int(),
  ideaBytes: z.number().int(),
  ideaFiles: z.number().int(),
  sessionCount: z.number().int(),
  maxTotalBytes: z.number().int(),
  openAnomalies: z.number().int(),
  lastCheckAt: z.string().nullable(),
  lastCleanupAt: z.string().nullable(),
  topSessions: z.array(topSessionSchema).openapi({
    description: 'Up to 10 sessions using the most storage, largest first',
  }),
  nextCheckAt: z
    .string()
    .nullable()
    .openapi({
      description:
        "When the scheduled reconciliation next runs, read from BullMQ's own job-scheduler " +
        'metadata. Null if the schedule has not been registered yet (no worker has booted since ' +
        'this deployment started).',
    }),
})
export type StorageSummaryDto = z.infer<typeof storageSummarySchema>

export const gcEnqueuedSchema = z.object({ enqueued: z.literal(true) })
