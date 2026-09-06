// Reconciliation: walks the storage tree and session_files, classifies every
// disagreement into exactly four anomaly classes, and takes the one action
// that is safe to run unattended (deleting an aged orphan blob). Everything
// else is reported only — see the module doc on runCleanup for the one
// human-triggered pass that acts on what a check already found.
//
// Both passes are safe to run concurrently with an upload: `put()` in
// storage.ts only ever exposes a file under its final name after the write
// and fsync are done (the in-flight name is `.tmp-*`, already excluded by
// listBlobEntries), so the one real race left is a blob renamed into place a
// moment before its session_files row commits. ATTACHMENTS_GC_GRACE_MS is
// exactly the window that protects that moment — an orphan blob younger than
// it is reported, never deleted, in an automatic check.

import { and, eq, isNull, lt } from 'drizzle-orm'
import { db } from '@/db/client'
import { sessionFiles, sessions, storageAnomalies } from '@/db/schema'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import type { AttachmentsGcJob } from '@/queue'
import { remediateAnomaly } from './reconcile'
import type { StorageAnomalyClass } from './schema'
import { regenerateManifest } from './service'
import {
  type BlobEntry,
  checksumFile,
  listBlobEntries,
  removeBlobAt,
  deleteFile as removeStoredFile,
  walkSessionDirs,
} from './storage'

export interface GcReport {
  reason: AttachmentsGcJob['reason']
  classified: Record<StorageAnomalyClass, number>
  resolvedAutomatically: number
  orphanBlobsDeleted: number
  danglingRowsMarkedMissing: number
  /** 0 when ATTACHMENTS_RETENTION_DAYS is 0 (the shipped default: disabled). */
  retentionFilesPurged: number
  cleanup?: {
    orphanBlobsDeleted: number
    danglingRowsDeleted: number
    orphanSessionDirsDeleted: number
    // See remediateAnomaly's module doc in reconcile.ts for why this class is
    // actionable here at all, unlike in the automatic check above.
    checksumMismatchesDeleted: number
    /** Classified as open by the last check, but no longer true by the time
     * this ran — resolved without anything being deleted, not counted as a
     * removal and not a failure. See reconcile.ts's stillAnAnomaly(). */
    skippedRevalidated: number
    failures: string[]
  }
}

function emptyClassified(): Record<StorageAnomalyClass, number> {
  return { orphan_blob: 0, dangling_row: 0, orphan_session_dir: 0, checksum_mismatch: 0 }
}

interface Seen {
  class: StorageAnomalyClass
  sessionId: string | null
  fileId: string | null
  path: string | null
  originalFilename: string | null
  sizeBytes: number | null
  detail: string | null
}

/**
 * Record a sighting. `seenAt` is the *run's* start time, constant across every
 * upsert in one pass — that is what lets the sweep at the end of `runCheck`
 * tell "not seen this run" (stale) apart from "seen a moment ago" by a single
 * comparison, rather than a per-row clock race.
 *
 * `resolvedAt: null` on conflict is deliberate: ground truth from this run
 * always wins over an earlier resolution, automatic or manual — an anomaly a
 * human dismissed while it was still actually present is not something this
 * job should keep hiding.
 */
async function upsertAnomaly(seen: Seen, seenAt: Date): Promise<string> {
  const pathKeyed = seen.class === 'orphan_blob' || seen.class === 'orphan_session_dir'
  const target = pathKeyed
    ? [storageAnomalies.class, storageAnomalies.path]
    : [storageAnomalies.class, storageAnomalies.fileId]
  const [row] = await db
    .insert(storageAnomalies)
    .values({ ...seen, firstSeenAt: seenAt, lastSeenAt: seenAt })
    .onConflictDoUpdate({
      target,
      set: {
        sizeBytes: seen.sizeBytes,
        originalFilename: seen.originalFilename,
        detail: seen.detail,
        lastSeenAt: seenAt,
        resolvedAt: null,
      },
    })
    .returning({ id: storageAnomalies.id })
  if (!row) throw new Error('storage_anomalies upsert returned no row')
  return row.id
}

async function fsAgeMs(mtimeMs: number): Promise<number> {
  return Date.now() - mtimeMs
}

/**
 * Delete every file belonging to a session whose own `updatedAt` has not
 * moved in `ATTACHMENTS_RETENTION_DAYS` days. Disabled by default — nobody
 * asked for attachments to vanish on a timer, and turning it on is a
 * per-deployment decision, not something this feature should default to.
 * Deletes the same way a user-initiated delete does (soft-delete the row,
 * remove the blob), never the session itself.
 */
async function purgeRetention(): Promise<number> {
  if (env.ATTACHMENTS_RETENTION_DAYS <= 0) return 0
  const cutoff = new Date(Date.now() - env.ATTACHMENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const stale = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.updatedAt, cutoff))

  let purged = 0
  for (const { id: sessionId } of stale) {
    const rows = await db
      .select()
      .from(sessionFiles)
      .where(and(eq(sessionFiles.sessionId, sessionId), isNull(sessionFiles.deletedAt)))
    if (rows.length === 0) continue

    for (const row of rows) {
      await removeStoredFile(sessionId, row.id)
      await db
        .update(sessionFiles)
        .set({ deletedAt: new Date() })
        .where(eq(sessionFiles.id, row.id))
      purged += 1
    }
    await regenerateManifest(sessionId)
    logger.info(
      `Attachments retention purge: removed ${rows.length} file(s) from session ${sessionId}`,
    )
  }
  return purged
}

/** The automatic pass: classify everything, act only on aged orphan blobs. */
async function runCheck(reason: 'scheduled' | 'manual'): Promise<GcReport> {
  const runStartedAt = new Date()
  const report: GcReport = {
    reason,
    classified: emptyClassified(),
    resolvedAutomatically: 0,
    orphanBlobsDeleted: 0,
    danglingRowsMarkedMissing: 0,
    retentionFilesPurged: 0,
  }

  const dbSessionIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id),
  )
  const touchedSessions = new Set<string>()

  for (const { sessionId, dir } of await walkSessionDirs()) {
    if (!dbSessionIds.has(sessionId)) {
      report.classified.orphan_session_dir += 1
      await upsertAnomaly(
        {
          class: 'orphan_session_dir',
          sessionId,
          fileId: null,
          path: dir,
          originalFilename: null,
          sizeBytes: null,
          detail: `No session row for ${sessionId}`,
        },
        runStartedAt,
      )
      continue
    }

    const [blobs, rows] = await Promise.all([
      listBlobEntries(sessionId),
      db
        .select()
        .from(sessionFiles)
        .where(and(eq(sessionFiles.sessionId, sessionId), isNull(sessionFiles.deletedAt))),
    ])
    const rowsById = new Map(rows.map((r) => [r.id, r]))
    const blobsByFileId = new Map<string, BlobEntry>()

    for (const blob of blobs) {
      if (blob.fileId && rowsById.has(blob.fileId)) {
        blobsByFileId.set(blob.fileId, blob)
        continue
      }
      report.classified.orphan_blob += 1
      const anomalyId = await upsertAnomaly(
        {
          class: 'orphan_blob',
          sessionId,
          fileId: blob.fileId ?? null,
          path: blob.path,
          originalFilename: blob.storedName,
          sizeBytes: blob.sizeBytes,
          detail: blob.fileId
            ? 'No session_files row for this id'
            : 'On-disk name has no uuid prefix',
        },
        runStartedAt,
      )
      if ((await fsAgeMs(blob.mtimeMs)) >= env.ATTACHMENTS_GC_GRACE_MS) {
        await removeBlobAt(blob.path)
        await db
          .update(storageAnomalies)
          .set({ resolvedAt: new Date() })
          .where(eq(storageAnomalies.id, anomalyId))
        report.orphanBlobsDeleted += 1
        logger.info(`Attachments GC removed orphan blob ${blob.path}`)
      }
    }

    for (const row of rows) {
      const blob = blobsByFileId.get(row.id)
      if (!blob) {
        report.classified.dangling_row += 1
        await upsertAnomaly(
          {
            class: 'dangling_row',
            sessionId,
            fileId: row.id,
            path: null,
            originalFilename: row.originalFilename,
            sizeBytes: row.sizeBytes,
            detail: 'Row exists in session_files; no blob found on disk',
          },
          runStartedAt,
        )
        if (row.status !== 'missing') {
          await db
            .update(sessionFiles)
            .set({ status: 'missing' })
            .where(eq(sessionFiles.id, row.id))
          report.danglingRowsMarkedMissing += 1
          touchedSessions.add(sessionId)
        }
        continue
      }

      // A row marked missing on an earlier run whose blob is back (restored
      // by hand — there is no backup system to do this automatically) is
      // worth un-hiding rather than leaving stuck, since nothing else ever
      // clears 'missing' once set.
      if (row.status === 'missing') {
        await db.update(sessionFiles).set({ status: 'ready' }).where(eq(sessionFiles.id, row.id))
        touchedSessions.add(sessionId)
      }

      const checksum = await checksumFile(blob.path)
      if (checksum !== row.checksum || blob.sizeBytes !== row.sizeBytes) {
        report.classified.checksum_mismatch += 1
        await upsertAnomaly(
          {
            class: 'checksum_mismatch',
            sessionId,
            fileId: row.id,
            path: blob.path,
            originalFilename: row.originalFilename,
            sizeBytes: blob.sizeBytes,
            detail:
              `db: ${row.sizeBytes} bytes, ${row.checksum.slice(0, 12)}… — ` +
              `disk: ${blob.sizeBytes} bytes, ${checksum.slice(0, 12)}…`,
          },
          runStartedAt,
        )
      }
    }
  }

  // Anything open that this run did not re-confirm has disappeared since the
  // last one — resolved, not deleted, so a flapping problem stays visible.
  const resolved = await db
    .update(storageAnomalies)
    .set({ resolvedAt: runStartedAt })
    .where(and(isNull(storageAnomalies.resolvedAt), lt(storageAnomalies.lastSeenAt, runStartedAt)))
    .returning({ id: storageAnomalies.id })
  report.resolvedAutomatically = resolved.length

  for (const sessionId of touchedSessions) await regenerateManifest(sessionId)

  report.retentionFilesPurged = await purgeRetention()

  logger.info(`Attachments GC check (${reason}): ${JSON.stringify(report)}`)
  return report
}

/**
 * The human-triggered pass: acts on exactly what the last check already
 * classified as open, rather than scanning again — "run cleanup" and "run
 * check" are deliberately two different passes, so cleanup never surprises
 * an operator by reclassifying something mid-delete.
 *
 * Every anomaly is re-verified immediately before anything is deleted (see
 * reconcile.ts's remediateAnomaly): what the last check found may already
 * have fixed itself in the time since — a blob whose row landed, a row whose
 * blob reappeared, a session directory that got a session row — and an entry
 * that no longer holds is skipped and marked resolved rather than destroyed.
 * That is what makes it safe for this to act on a check that ran anywhere
 * from a second to an hour ago, without also having to re-scan the whole
 * store to know that.
 */
async function runCleanup(): Promise<GcReport> {
  const open = await db.select().from(storageAnomalies).where(isNull(storageAnomalies.resolvedAt))
  const touchedSessions = new Set<string>()
  const failures: string[] = []
  let orphanBlobsDeleted = 0
  let danglingRowsDeleted = 0
  let orphanSessionDirsDeleted = 0
  let checksumMismatchesDeleted = 0
  let skippedRevalidated = 0

  for (const anomaly of open) {
    const result = await remediateAnomaly(anomaly, 'delete')
    if (result.touchedSessionId) touchedSessions.add(result.touchedSessionId)

    if (result.outcome === 'deleted') {
      if (anomaly.class === 'orphan_blob') orphanBlobsDeleted += 1
      else if (anomaly.class === 'dangling_row') danglingRowsDeleted += 1
      else if (anomaly.class === 'orphan_session_dir') orphanSessionDirsDeleted += 1
      else if (anomaly.class === 'checksum_mismatch') checksumMismatchesDeleted += 1
      logger.info(
        `Attachments GC cleanup resolved ${anomaly.class} ${anomaly.path ?? anomaly.fileId}`,
      )
    } else if (result.outcome === 'revalidated') {
      skippedRevalidated += 1
      logger.info(
        `Attachments GC cleanup skipped ${anomaly.class} ${anomaly.path ?? anomaly.fileId}: no longer an anomaly`,
      )
    } else if (result.outcome === 'failed') {
      failures.push(`${anomaly.class} ${anomaly.path ?? anomaly.fileId}: ${result.error}`)
      logger.warn(`Attachments GC cleanup could not resolve ${anomaly.id}: ${result.error}`)
    }
  }

  for (const sessionId of touchedSessions) await regenerateManifest(sessionId)

  const report: GcReport = {
    reason: 'cleanup',
    classified: emptyClassified(),
    resolvedAutomatically: 0,
    orphanBlobsDeleted: 0,
    danglingRowsMarkedMissing: 0,
    retentionFilesPurged: 0,
    cleanup: {
      orphanBlobsDeleted,
      danglingRowsDeleted,
      orphanSessionDirsDeleted,
      checksumMismatchesDeleted,
      skippedRevalidated,
      failures,
    },
  }
  logger.info(`Attachments GC cleanup: ${JSON.stringify(report)}`)
  return report
}

export async function runAttachmentsGc(job: AttachmentsGcJob): Promise<GcReport> {
  return job.reason === 'cleanup' ? runCleanup() : runCheck(job.reason)
}
