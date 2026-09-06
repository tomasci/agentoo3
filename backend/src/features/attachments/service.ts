// Orchestration: DB metadata plus the storage module, kept to exactly the
// rule the brief for this feature states — bytes first, then the row, then
// the manifest. storage.ts never touches Postgres and never decides a quota;
// this is the only place that does both.

import { and, desc, eq, inArray, isNotNull, isNull, sql, sum } from 'drizzle-orm'
import { db } from '@/db/client'
import { sessionFiles, sessions, storageAnomalies } from '@/db/schema'
import { env } from '@/env'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { attachmentsManifestPath, sessionUploadsDir } from '@/lib/paths'
import { attachmentsGcQueue } from '@/queue'
import type { ManifestFile } from './manifest'
import { renderManifest } from './manifest'
import { remediateAnomaly } from './reconcile'
import type {
  AnomalyBulkAction,
  AnomalyListQuery,
  AnomalyRemediationDto,
  SessionFileDto,
  SessionFilesListDto,
  StorageAnomalyDto,
  StorageSummaryDto,
} from './schema'
import {
  AttachmentUploadError,
  deleteFile as storageDeleteFile,
  open as storageOpen,
  put as storagePut,
  writeManifest,
} from './storage'

type SessionFileRow = typeof sessionFiles.$inferSelect

function toDto(row: SessionFileRow): SessionFileDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    status: row.status,
    lineCount: row.lineCount,
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toManifestFile(row: SessionFileRow): ManifestFile {
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    storedName: row.storedName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    lineCount: row.lineCount,
    pageCount: row.pageCount,
    createdAt: row.createdAt,
  }
}

async function requireSession(sessionId: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!row) throw notFound('Session')
  return row
}

/** Non-deleted, 'ready' rows only — what an agent may actually be told about. */
async function readyFiles(sessionId: string): Promise<SessionFileRow[]> {
  return db
    .select()
    .from(sessionFiles)
    .where(
      and(
        eq(sessionFiles.sessionId, sessionId),
        isNull(sessionFiles.deletedAt),
        eq(sessionFiles.status, 'ready'),
      ),
    )
    .orderBy(sessionFiles.createdAt, sessionFiles.id)
}

/**
 * Regenerate ATTACHMENTS.md from the current DB rows. The one place this is
 * called from is this service, on every mutation — never the worker, which
 * only reads `announcedSeq` (see session-run.worker.ts). That keeps the file
 * from ever disagreeing with the database, including for a session that never
 * runs another turn after an upload.
 */
export async function regenerateManifest(sessionId: string): Promise<void> {
  const rows = await readyFiles(sessionId)
  await writeManifest(
    sessionId,
    renderManifest(sessionUploadsDir(sessionId), rows.map(toManifestFile)),
  )
}

interface Usage {
  fileCount: number
  sizeBytes: number
}

async function usageFor(sessionId: string): Promise<Usage> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`, bytes: sum(sessionFiles.sizeBytes) })
    .from(sessionFiles)
    .where(and(eq(sessionFiles.sessionId, sessionId), isNull(sessionFiles.deletedAt)))
  return { fileCount: Number(row?.n ?? 0), sizeBytes: Number(row?.bytes ?? 0) }
}

async function totalUsage(): Promise<number> {
  const [row] = await db
    .select({ bytes: sum(sessionFiles.sizeBytes) })
    .from(sessionFiles)
    .where(isNull(sessionFiles.deletedAt))
  return Number(row?.bytes ?? 0)
}

function uploadErrorMessage(error: AttachmentUploadError): string {
  return error.code === 'too_large'
    ? error.message
    : `Rejected: ${error.message}. Allowed types are png, jpeg, webp, gif, pdf, and plain-text formats ` +
        '(json, csv, markdown, yaml, log/plain).'
}

/**
 * Accept an upload for one session.
 *
 * Bytes are written before anything is checked against the database twice —
 * once cheaply up front (using a client-reported size hint, which is not
 * trustworthy, only a fast path to skip pointless I/O on an obviously
 * oversized request) and once authoritatively after the write, from the real
 * byte count `storage.put()` measured while streaming. A violation caught
 * only after the write deletes the blob it just wrote and never inserts a
 * row — order is load-bearing: an orphan blob is GC-able, an orphan row is
 * not (see storage_anomalies' dangling_row class).
 */
export async function uploadFile(
  sessionId: string,
  originalFilename: string,
  body: ReadableStream<Uint8Array>,
  declaredType: string | undefined,
  sizeHint: number | undefined,
): Promise<SessionFileDto> {
  await requireSession(sessionId)

  const usage = await usageFor(sessionId)
  if (usage.fileCount >= env.ATTACHMENTS_SESSION_MAX_FILES) {
    throw badRequest(
      `This session already has ${usage.fileCount} files, its limit (${env.ATTACHMENTS_SESSION_MAX_FILES})`,
    )
  }
  if (sizeHint !== undefined) {
    if (sizeHint > env.ATTACHMENT_MAX_BYTES) {
      throw badRequest(`Exceeds the ${env.ATTACHMENT_MAX_BYTES}-byte per-file limit`)
    }
    if (usage.sizeBytes + sizeHint > env.ATTACHMENTS_SESSION_MAX_BYTES) {
      throw badRequest(
        `Would exceed this session's ${env.ATTACHMENTS_SESSION_MAX_BYTES}-byte limit`,
      )
    }
  }

  let stored: Awaited<ReturnType<typeof storagePut>>
  try {
    stored = await storagePut(sessionId, originalFilename, body, declaredType)
  } catch (error) {
    if (error instanceof AttachmentUploadError) throw badRequest(uploadErrorMessage(error))
    throw error
  }

  // Authoritative, post-write check: sizeHint above is a fast path only, not
  // a guard anything can actually rely on.
  const [freshUsage, freshTotal] = await Promise.all([usageFor(sessionId), totalUsage()])
  if (freshUsage.sizeBytes + stored.sizeBytes > env.ATTACHMENTS_SESSION_MAX_BYTES) {
    await storageDeleteFile(sessionId, stored.fileId)
    throw badRequest(`Would exceed this session's ${env.ATTACHMENTS_SESSION_MAX_BYTES}-byte limit`)
  }
  if (freshTotal + stored.sizeBytes > env.ATTACHMENTS_TOTAL_MAX_BYTES) {
    await storageDeleteFile(sessionId, stored.fileId)
    throw badRequest('Would exceed this deployment’s total attachment storage limit')
  }

  // Dedup within this session only: never global, never a hardlink across
  // sessions — a shared inode would break "deleting a session deletes its
  // files".
  const [existing] = await db
    .select()
    .from(sessionFiles)
    .where(
      and(
        eq(sessionFiles.sessionId, sessionId),
        eq(sessionFiles.checksum, stored.checksum),
        isNull(sessionFiles.deletedAt),
      ),
    )
    .limit(1)
  if (existing) {
    await storageDeleteFile(sessionId, stored.fileId)
    return toDto(existing)
  }

  const [row] = await db
    .insert(sessionFiles)
    .values({
      id: stored.fileId,
      sessionId,
      originalFilename: stored.originalFilename,
      storedName: stored.storedName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      lineCount: stored.lineCount,
      pageCount: stored.pageCount,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')

  await regenerateManifest(sessionId)
  return toDto(row)
}

export async function listFiles(sessionId: string): Promise<SessionFilesListDto> {
  await requireSession(sessionId)
  const rows = await db
    .select()
    .from(sessionFiles)
    .where(and(eq(sessionFiles.sessionId, sessionId), isNull(sessionFiles.deletedAt)))
    .orderBy(desc(sessionFiles.createdAt))
  const usage = await usageFor(sessionId)
  return {
    files: rows.map(toDto),
    usage: {
      fileCount: usage.fileCount,
      sizeBytes: usage.sizeBytes,
      maxFiles: env.ATTACHMENTS_SESSION_MAX_FILES,
      maxSessionBytes: env.ATTACHMENTS_SESSION_MAX_BYTES,
    },
  }
}

async function requireOwnFile(sessionId: string, fileId: string): Promise<SessionFileRow> {
  const [row] = await db
    .select()
    .from(sessionFiles)
    .where(
      and(
        eq(sessionFiles.id, fileId),
        eq(sessionFiles.sessionId, sessionId),
        isNull(sessionFiles.deletedAt),
      ),
    )
    .limit(1)
  // A file id from a different session must 404 exactly like an unknown one —
  // the WHERE above resolves by (sessionId, fileId) together, never by fileId
  // alone, which is what makes that true.
  if (!row) throw notFound('File')
  return row
}

export async function deleteFile(sessionId: string, fileId: string): Promise<void> {
  await requireOwnFile(sessionId, fileId)
  await storageDeleteFile(sessionId, fileId)
  // Soft delete: the row stays so a message that referenced it (message_files)
  // still resolves to something instead of a broken join, and so its checksum
  // can be re-added later without colliding with a row that no longer
  // represents a real file.
  await db.update(sessionFiles).set({ deletedAt: new Date() }).where(eq(sessionFiles.id, fileId))
  await regenerateManifest(sessionId)
}

export interface FileDownload {
  dto: SessionFileDto
  sizeBytes: number
  stream: ReadableStream<Uint8Array>
}

/** Serves bytes for (sessionId, fileId). 404s rather than 500s whenever the
 * row and the disk disagree — a GC race, or an anomaly not yet detected —
 * since a human or an agent asking for a file that just vanished is not a
 * server error. */
export async function getFileForDownload(
  sessionId: string,
  fileId: string,
  range?: { start: number; end: number },
): Promise<FileDownload> {
  const row = await requireOwnFile(sessionId, fileId)
  if (row.status !== 'ready') throw notFound('File')

  const opened = await storageOpen(sessionId, fileId, range)
  if (!opened) throw notFound('File')

  return { dto: toDto(row), sizeBytes: opened.file.sizeBytes, stream: opened.stream }
}

/**
 * What runner-options.ts needs to decide `additionalDirectories` and the
 * system-prompt attachments block — null for a session with nothing to grant,
 * so the caller can omit both entirely rather than pointing an agent at an
 * uploads directory that does not exist yet.
 */
export async function sessionAttachmentsSummary(
  sessionId: string,
): Promise<{ uploadsDir: string; fileCount: number; manifestPath: string } | null> {
  const rows = await readyFiles(sessionId)
  if (rows.length === 0) return null
  return {
    uploadsDir: sessionUploadsDir(sessionId),
    fileCount: rows.length,
    manifestPath: attachmentsManifestPath(sessionId),
  }
}

// --- storage / reconciliation surface --------------------------------------
//
// Summary and anomaly listing/resolution for the /api/storage/* routes. Live
// here rather than in gc.ts, which owns *finding* anomalies, not serving them
// back — one direction of data flow, one place that reads storage_anomalies
// for an API response.

function toAnomalyDto(row: typeof storageAnomalies.$inferSelect): StorageAnomalyDto {
  return {
    id: row.id,
    class: row.class,
    sessionId: row.sessionId,
    fileId: row.fileId,
    path: row.path,
    originalFilename: row.originalFilename,
    sizeBytes: row.sizeBytes,
    detail: row.detail,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }
}

/**
 * Completed-job history is where "when did this last run" comes from, rather
 * than a dedicated table for two timestamps — attachmentsGcQueue already
 * keeps a bounded number of completed jobs (see queue/index.ts), and a job's
 * own `data.reason` is enough to tell a check from a cleanup.
 */
async function lastGcRunAt(matchesReason: (reason: string) => boolean): Promise<string | null> {
  const jobs = await attachmentsGcQueue.getJobs(['completed'], 0, 50)
  let latest: number | undefined
  for (const job of jobs) {
    const reason = (job.data as { reason?: string } | undefined)?.reason
    if (reason && matchesReason(reason) && typeof job.finishedOn === 'number') {
      if (latest === undefined || job.finishedOn > latest) latest = job.finishedOn
    }
  }
  return latest === undefined ? null : new Date(latest).toISOString()
}

/** BullMQ's own scheduler id for the hourly job — see ensureAttachmentsGcSchedule
 * in queue/index.ts, the one place that registers it. */
const GC_SCHEDULE_ID = 'attachments-gc-hourly'

const TOP_SESSIONS_LIMIT = 10

/** Up to the ten sessions using the most storage, largest first — the "bytes
 * per session distribution" half of the spec's summary requirement. */
async function topSessionsByBytes(): Promise<StorageSummaryDto['topSessions']> {
  const rows = await db
    .select({
      sessionId: sessionFiles.sessionId,
      bytes: sum(sessionFiles.sizeBytes),
      n: sql<number>`count(*)`,
    })
    .from(sessionFiles)
    .where(isNull(sessionFiles.deletedAt))
    .groupBy(sessionFiles.sessionId)
    .orderBy(desc(sum(sessionFiles.sizeBytes)))
    .limit(TOP_SESSIONS_LIMIT)
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sizeBytes: Number(r.bytes ?? 0),
    fileCount: Number(r.n),
  }))
}

/**
 * When the scheduled reconciliation next runs.
 *
 * Read from BullMQ's own job-scheduler metadata rather than derived as
 * `lastCheckAt + ATTACHMENTS_GC_INTERVAL_MS`: a derived value would get this
 * wrong the moment someone clicks "run check now" — that manual run does not
 * reset the hourly clock, but it would move `lastCheckAt` forward and make a
 * derived next-run look like it moved too. The scheduler's own `next` is
 * authoritative regardless of how many manual or cleanup runs happened in
 * between.
 */
async function nextScheduledCheckAt(): Promise<string | null> {
  const scheduler = await attachmentsGcQueue.getJobScheduler(GC_SCHEDULE_ID)
  return scheduler?.next ? new Date(scheduler.next).toISOString() : null
}

export async function storageSummary(): Promise<StorageSummaryDto> {
  const [totals] = await db
    .select({ n: sql<number>`count(*)`, bytes: sum(sessionFiles.sizeBytes) })
    .from(sessionFiles)
    .where(isNull(sessionFiles.deletedAt))
  const [sessionsAgg] = await db
    .select({ n: sql<number>`count(distinct ${sessionFiles.sessionId})` })
    .from(sessionFiles)
    .where(isNull(sessionFiles.deletedAt))
  const [openAgg] = await db
    .select({ n: sql<number>`count(*)` })
    .from(storageAnomalies)
    .where(isNull(storageAnomalies.resolvedAt))
  const [lastCheckAt, lastCleanupAt, topSessions, nextCheckAt] = await Promise.all([
    lastGcRunAt((reason) => reason !== 'cleanup'),
    lastGcRunAt((reason) => reason === 'cleanup'),
    topSessionsByBytes(),
    nextScheduledCheckAt(),
  ])

  return {
    totalBytes: Number(totals?.bytes ?? 0),
    totalFiles: Number(totals?.n ?? 0),
    sessionCount: Number(sessionsAgg?.n ?? 0),
    maxTotalBytes: env.ATTACHMENTS_TOTAL_MAX_BYTES,
    openAnomalies: Number(openAgg?.n ?? 0),
    lastCheckAt,
    lastCleanupAt,
    topSessions,
    nextCheckAt,
  }
}

export async function listAnomalies(query: AnomalyListQuery): Promise<StorageAnomalyDto[]> {
  const conditions = []
  if (query.class) conditions.push(eq(storageAnomalies.class, query.class))
  if (query.resolved !== undefined) {
    conditions.push(
      query.resolved ? isNotNull(storageAnomalies.resolvedAt) : isNull(storageAnomalies.resolvedAt),
    )
  }
  const rows = await db
    .select()
    .from(storageAnomalies)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(storageAnomalies.lastSeenAt))
  return rows.map(toAnomalyDto)
}

/** Appends rather than overwrites `detail`: that field already carries the
 * diagnostic gc.ts computed (a size/checksum comparison, for instance), and a
 * human's dismissal note is additional context, not a replacement for it. */
export async function resolveAnomaly(id: string, note?: string): Promise<StorageAnomalyDto> {
  const [row] = await db.select().from(storageAnomalies).where(eq(storageAnomalies.id, id)).limit(1)
  if (!row) throw notFound('Anomaly')

  const detail = note ? [row.detail, `Resolved: ${note}`].filter(Boolean).join(' — ') : row.detail
  const [updated] = await db
    .update(storageAnomalies)
    .set({ resolvedAt: new Date(), detail })
    .where(eq(storageAnomalies.id, id))
    .returning()
  if (!updated) throw new Error('Update returned no row')
  return toAnomalyDto(updated)
}

/** Only ever affects rows that are still open — resolving an already-resolved
 * row a second time is a no-op, so there is nothing for a "resolved" filter to
 * usefully narrow here (see schema.ts's anomalyBulkActionSchema). `ids`, when
 * given, is ANDed with `class` rather than replacing it — an operator who
 * selected specific rows in a filtered view expects both to apply. */
export async function bulkResolveAnomalies(action: AnomalyBulkAction): Promise<number> {
  const conditions = [isNull(storageAnomalies.resolvedAt)]
  if (action.class) conditions.push(eq(storageAnomalies.class, action.class))
  if (action.ids && action.ids.length > 0) conditions.push(inArray(storageAnomalies.id, action.ids))
  const detailSuffix = action.note ? ` — Resolved: ${action.note}` : ''
  const rows = await db
    .update(storageAnomalies)
    .set({
      resolvedAt: new Date(),
      ...(action.note && {
        detail: sql`coalesce(${storageAnomalies.detail}, '') || ${detailSuffix}`,
      }),
    })
    .where(and(...conditions))
    .returning({ id: storageAnomalies.id })
  return rows.length
}

// --- per-row and bulk-by-id remediation -------------------------------------
//
// Destructive, unlike resolve/bulkResolveAnomalies above: these delete the
// blob, row or directory an anomaly names. Both go through reconcile.ts's
// remediateAnomaly — the same per-row unit gc.ts's runCleanup uses — never a
// raw filesystem call from here, and never a second implementation of "is
// this still real".

async function requireAnomaly(id: string): Promise<typeof storageAnomalies.$inferSelect> {
  const [row] = await db.select().from(storageAnomalies).where(eq(storageAnomalies.id, id)).limit(1)
  if (!row) throw notFound('Anomaly')
  return row
}

async function remediateAndReload(
  id: string,
  mode: 'delete' | 'recheck',
): Promise<AnomalyRemediationDto> {
  const row = await requireAnomaly(id)
  if (row.resolvedAt) throw conflict('This anomaly is already resolved; nothing to act on')

  const result = await remediateAnomaly(row, mode)
  if (result.touchedSessionId) await regenerateManifest(result.touchedSessionId)

  const [after] = await db
    .select()
    .from(storageAnomalies)
    .where(eq(storageAnomalies.id, id))
    .limit(1)
  if (!after) throw new Error(`Anomaly ${id} disappeared mid-remediation`)
  return { anomaly: toAnomalyDto(after), outcome: result.outcome, error: result.error }
}

/** Delete whatever this one anomaly's own class calls for — the blob, the
 * row, or the directory — after re-verifying it still holds. */
export async function deleteAnomalyById(id: string): Promise<AnomalyRemediationDto> {
  return remediateAndReload(id, 'delete')
}

/** "Re-run the check" on one row, without deleting anything: a finding that
 * no longer holds is resolved (it fixed itself); one that still holds stays
 * open with its lastSeenAt refreshed, exactly like a full check re-confirming it. */
export async function recheckAnomalyById(id: string): Promise<AnomalyRemediationDto> {
  return remediateAndReload(id, 'recheck')
}

/**
 * Delete every anomaly in an explicit, operator-selected id list — the
 * destructive counterpart to bulkResolveAnomalies's `ids`, for "the rows I
 * selected" rather than a class-wide sweep (that is /storage/cleanup).
 *
 * An id that is not open any more (already resolved, or never existed) is
 * silently absent from the result rather than failing the whole batch over
 * one stale selection — the caller can tell by comparing lengths if it cares.
 */
export async function deleteAnomaliesByIds(ids: string[]): Promise<AnomalyRemediationDto[]> {
  const rows = await db
    .select()
    .from(storageAnomalies)
    .where(and(inArray(storageAnomalies.id, ids), isNull(storageAnomalies.resolvedAt)))
  if (rows.length === 0) return []

  const touchedSessions = new Set<string>()
  const outcomes = new Map<string, { outcome: AnomalyRemediationDto['outcome']; error?: string }>()
  for (const row of rows) {
    const result = await remediateAnomaly(row, 'delete')
    if (result.touchedSessionId) touchedSessions.add(result.touchedSessionId)
    outcomes.set(row.id, { outcome: result.outcome, error: result.error })
  }
  for (const sessionId of touchedSessions) await regenerateManifest(sessionId)

  const after = await db
    .select()
    .from(storageAnomalies)
    .where(
      inArray(
        storageAnomalies.id,
        rows.map((r) => r.id),
      ),
    )
  const afterById = new Map(after.map((r) => [r.id, r]))

  return rows.map((row) => {
    const fresh = afterById.get(row.id) ?? row
    const outcome = outcomes.get(row.id)
    return {
      anomaly: toAnomalyDto(fresh),
      outcome: outcome?.outcome ?? 'failed',
      error: outcome?.error,
    }
  })
}
