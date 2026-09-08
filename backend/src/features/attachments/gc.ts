// Reconciliation: walks both storage roots (sessions and ideas) and their
// database tables, classifies every disagreement into one of seven anomaly
// classes, and takes the one action that is safe to run unattended (deleting
// an aged orphan blob). Everything else is reported only — see the module
// doc on runCleanup for the one human-triggered pass that acts on what a
// check already found.
//
// Both roots are walked inside the SAME pass, sharing one `runStartedAt` —
// this is load-bearing, not a style choice. The stale-anomaly sweep at the
// end of runCheck is unconditional over the whole storage_anomalies table
// (`WHERE resolved_at IS NULL AND last_seen_at < runStartedAt`): if the two
// roots were walked in separate passes (or separate scheduled jobs), each
// run would silently resolve every open anomaly belonging to whichever root
// it had not walked yet this cycle. One pass, one runStartedAt, both roots,
// then the sweep — never the other order.
//
// Both passes are safe to run concurrently with an upload: `writeBlob()` in
// storage.ts only ever exposes a file under its final name after the write
// and fsync are done (the in-flight name is `.tmp-*`, already excluded by
// listBlobEntries/listIdeaBlobEntries), so the one real race left is a blob
// renamed into place a moment before its session_files/idea_files row
// commits. ATTACHMENTS_GC_GRACE_MS is exactly the window that protects that
// moment — an orphan blob younger than it is reported, never deleted, in an
// automatic check.

import { and, eq, isNull, lt } from 'drizzle-orm'
import { db } from '@/db/client'
import { ideaFiles, ideas, sessionFiles, sessions, storageAnomalies } from '@/db/schema'
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
  listIdeaBlobEntries,
  removeBlobAt,
  deleteFile as removeStoredFile,
  walkStorageDirs,
} from './storage'

export interface GcReport {
  reason: AttachmentsGcJob['reason']
  classified: Record<StorageAnomalyClass, number>
  resolvedAutomatically: number
  orphanBlobsDeleted: number
  danglingRowsMarkedMissing: number
  /** 0 when ATTACHMENTS_RETENTION_DAYS is 0 (the shipped default: disabled). */
  retentionFilesPurged: number
  /** One classification (a single blob or row, on either root) that threw
   * instead of being recorded, describing what and why. runCheck's whole
   * reason to exist is to cope with whatever is actually on disk — including
   * something nobody anticipated — so one bad item must never cost the rest
   * of the pass its stale sweep, its retention purge or its report. Also
   * logged at error level as it happens; empty in the overwhelming common
   * case, and anything here is worth a look since it means this run did NOT
   * fully reconcile one of the two roots. */
  classificationFailures: string[]
  cleanup?: {
    orphanBlobsDeleted: number
    danglingRowsDeleted: number
    orphanSessionDirsDeleted: number
    // See remediateAnomaly's module doc in reconcile.ts for why this class is
    // actionable here at all, unlike in the automatic check above.
    checksumMismatchesDeleted: number
    orphanIdeaDirsDeleted: number
    ideaDanglingRowsDeleted: number
    ideaChecksumMismatchesDeleted: number
    /** Classified as open by the last check, but no longer true by the time
     * this ran — resolved without anything being deleted, not counted as a
     * removal and not a failure. See reconcile.ts's stillAnAnomaly(). */
    skippedRevalidated: number
    failures: string[]
  }
}

function emptyClassified(): Record<StorageAnomalyClass, number> {
  return {
    orphan_blob: 0,
    dangling_row: 0,
    orphan_session_dir: 0,
    checksum_mismatch: 0,
    orphan_idea_dir: 0,
    idea_dangling_row: 0,
    idea_checksum_mismatch: 0,
  }
}

interface Seen {
  class: StorageAnomalyClass
  /** A session id for every session-rooted class; an IDEA id for every
   * idea-rooted one. storage_anomalies has no separate ideaId column (see
   * db/schema.ts's comment on that table) — `class` is what disambiguates
   * which kind of id is sitting in this slot. */
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
  const pathKeyed =
    seen.class === 'orphan_blob' ||
    seen.class === 'orphan_session_dir' ||
    seen.class === 'orphan_idea_dir'

  // storage_anomalies carries two unique indexes, (class, path) and
  // (class, fileId) — see the comment on both in db/schema.ts. Path-keyed
  // classes normally arbitrate on (class, path) below, but orphan_blob is
  // path-keyed AND (the common case) carries a non-null fileId, so two
  // orphan blobs that share a file id under different paths — a restored
  // backup, a hand-copied tree, never something the app itself mints — would
  // satisfy the path arbiter and then throw on class_file_key. Arbitrate on
  // (class, fileId) first whenever one is present: if a row already exists
  // for it, update that one instead of inserting a second. The index forces
  // only one row to ever exist for a given (class, fileId), so this row
  // stands in for whichever of the (possibly several) colliding paths this
  // run saw last — not a claim that it is the only one on disk.
  if (pathKeyed && seen.fileId) {
    const [existing] = await db
      .select({ id: storageAnomalies.id })
      .from(storageAnomalies)
      .where(and(eq(storageAnomalies.class, seen.class), eq(storageAnomalies.fileId, seen.fileId)))
      .limit(1)
    if (existing) {
      await db
        .update(storageAnomalies)
        .set({
          path: seen.path,
          sizeBytes: seen.sizeBytes,
          originalFilename: seen.originalFilename,
          detail: seen.detail,
          lastSeenAt: seenAt,
          resolvedAt: null,
        })
        .where(eq(storageAnomalies.id, existing.id))
      return existing.id
    }
  }

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
 *
 * Sessions only — deliberately. Ideas have no equivalent staleness signal:
 * `sessions.updatedAt` moves with every turn, so "no turn in N days" is a
 * real notion of abandonment, but an idea can sit untouched in a backlog
 * column for months and still be exactly the asset-bearing card a user comes
 * back to act on — there is no idea-side timestamp this job could key on
 * without inventing a retention story nobody asked for. Left out entirely
 * rather than guessed at.
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

/**
 * Log and record a single blob or row this run could not classify, without
 * letting the exception escape to the caller. `descriptor` names what failed
 * and where (class, path or id) plainly enough to find it on disk without
 * re-running the check. See GcReport.classificationFailures for why this
 * exists at all: one bad item on disk must never cost every other finding in
 * the same pass its stale sweep, its retention purge or its report.
 */
function recordClassificationFailure(report: GcReport, descriptor: string, error: unknown): void {
  const message = `${descriptor}: ${error instanceof Error ? error.message : String(error)}`
  logger.error(`Attachments GC could not classify ${message}`)
  report.classificationFailures.push(message)
}

/** The automatic pass: classify everything on both roots, act only on aged
 * orphan blobs. */
async function runCheck(reason: 'scheduled' | 'manual'): Promise<GcReport> {
  const runStartedAt = new Date()
  const report: GcReport = {
    reason,
    classified: emptyClassified(),
    resolvedAutomatically: 0,
    orphanBlobsDeleted: 0,
    danglingRowsMarkedMissing: 0,
    retentionFilesPurged: 0,
    classificationFailures: [],
  }

  const dbSessionIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id),
  )
  const dbIdeaIds = new Set((await db.select({ id: ideas.id }).from(ideas)).map((r) => r.id))
  const touchedSessions = new Set<string>()

  // --- sessions root -----------------------------------------------------
  for (const { id: sessionId, dir } of await walkStorageDirs('sessions')) {
    if (!dbSessionIds.has(sessionId)) {
      try {
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
        report.classified.orphan_session_dir += 1
      } catch (error) {
        recordClassificationFailure(report, `orphan_session_dir ${dir}`, error)
      }
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
      // Anything below can throw on input this pass did not anticipate (the
      // (class, file_id) collision arbitrated in upsertAnomaly is the one
      // known case, not the only possible one) — never let it cost every
      // other blob and row in this run its classification. See
      // GcReport.classificationFailures.
      try {
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
        report.classified.orphan_blob += 1
        if ((await fsAgeMs(blob.mtimeMs)) >= env.ATTACHMENTS_GC_GRACE_MS) {
          await removeBlobAt(blob.path)
          await db
            .update(storageAnomalies)
            .set({ resolvedAt: new Date() })
            .where(eq(storageAnomalies.id, anomalyId))
          report.orphanBlobsDeleted += 1
          logger.info(`Attachments GC removed orphan blob ${blob.path}`)
        }
      } catch (error) {
        recordClassificationFailure(report, `orphan_blob ${blob.path}`, error)
      }
    }

    for (const row of rows) {
      try {
        const blob = blobsByFileId.get(row.id)
        if (!blob) {
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
          report.classified.dangling_row += 1
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
          report.classified.checksum_mismatch += 1
        }
      } catch (error) {
        recordClassificationFailure(
          report,
          `session_files row ${row.id} (session ${sessionId})`,
          error,
        )
      }
    }
  }

  // --- ideas root ----------------------------------------------------------
  //
  // Same shape as the sessions loop above, field for field, with three
  // differences: the owning table (ideas/idea_files), the class names for
  // the two row-keyed anomalies (idea_dangling_row/idea_checksum_mismatch —
  // see db/schema.ts's storage_anomalies comment for why a shared class
  // cannot work here), and no manifest to regenerate — an idea has no
  // ATTACHMENTS.md, so there is no touchedSessions-equivalent bookkeeping to
  // do afterwards. orphan_blob itself is NOT renamed here: it is keyed on
  // `path`, and paths are globally unique across both roots, so this loop
  // and the one above both feed the exact same anomaly class and the exact
  // same upsert key.
  for (const { id: ideaId, dir } of await walkStorageDirs('ideas')) {
    if (!dbIdeaIds.has(ideaId)) {
      try {
        await upsertAnomaly(
          {
            class: 'orphan_idea_dir',
            sessionId: ideaId,
            fileId: null,
            path: dir,
            originalFilename: null,
            sizeBytes: null,
            detail: `No idea row for ${ideaId}`,
          },
          runStartedAt,
        )
        report.classified.orphan_idea_dir += 1
      } catch (error) {
        recordClassificationFailure(report, `orphan_idea_dir ${dir}`, error)
      }
      continue
    }

    const [blobs, rows] = await Promise.all([
      listIdeaBlobEntries(ideaId),
      db
        .select()
        .from(ideaFiles)
        .where(and(eq(ideaFiles.ideaId, ideaId), isNull(ideaFiles.deletedAt))),
    ])
    const rowsById = new Map(rows.map((r) => [r.id, r]))
    const blobsByFileId = new Map<string, BlobEntry>()

    for (const blob of blobs) {
      if (blob.fileId && rowsById.has(blob.fileId)) {
        blobsByFileId.set(blob.fileId, blob)
        continue
      }
      // Same resilience as the sessions loop above — see the comment there.
      try {
        const anomalyId = await upsertAnomaly(
          {
            class: 'orphan_blob',
            sessionId: ideaId,
            fileId: blob.fileId ?? null,
            path: blob.path,
            originalFilename: blob.storedName,
            sizeBytes: blob.sizeBytes,
            detail: blob.fileId
              ? 'No idea_files row for this id'
              : 'On-disk name has no uuid prefix',
          },
          runStartedAt,
        )
        report.classified.orphan_blob += 1
        if ((await fsAgeMs(blob.mtimeMs)) >= env.ATTACHMENTS_GC_GRACE_MS) {
          await removeBlobAt(blob.path)
          await db
            .update(storageAnomalies)
            .set({ resolvedAt: new Date() })
            .where(eq(storageAnomalies.id, anomalyId))
          report.orphanBlobsDeleted += 1
          logger.info(`Attachments GC removed orphan blob ${blob.path}`)
        }
      } catch (error) {
        recordClassificationFailure(report, `orphan_blob ${blob.path}`, error)
      }
    }

    for (const row of rows) {
      try {
        const blob = blobsByFileId.get(row.id)
        if (!blob) {
          await upsertAnomaly(
            {
              class: 'idea_dangling_row',
              sessionId: ideaId,
              fileId: row.id,
              path: null,
              originalFilename: row.originalFilename,
              sizeBytes: row.sizeBytes,
              detail: 'Row exists in idea_files; no blob found on disk',
            },
            runStartedAt,
          )
          report.classified.idea_dangling_row += 1
          if (row.status !== 'missing') {
            await db.update(ideaFiles).set({ status: 'missing' }).where(eq(ideaFiles.id, row.id))
            report.danglingRowsMarkedMissing += 1
          }
          continue
        }

        if (row.status === 'missing') {
          await db.update(ideaFiles).set({ status: 'ready' }).where(eq(ideaFiles.id, row.id))
        }

        const checksum = await checksumFile(blob.path)
        if (checksum !== row.checksum || blob.sizeBytes !== row.sizeBytes) {
          await upsertAnomaly(
            {
              class: 'idea_checksum_mismatch',
              sessionId: ideaId,
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
          report.classified.idea_checksum_mismatch += 1
        }
      } catch (error) {
        recordClassificationFailure(report, `idea_files row ${row.id} (idea ${ideaId})`, error)
      }
    }
  }

  // Anything open that this run did not re-confirm has disappeared since the
  // last one — resolved, not deleted, so a flapping problem stays visible.
  // Runs exactly once per pass, after BOTH roots above have been walked — see
  // this module's own header for why that ordering is load-bearing.
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
 * blob reappeared, a session or idea directory that got its row back — and
 * an entry that no longer holds is skipped and marked resolved rather than
 * destroyed. That is what makes it safe for this to act on a check that ran
 * anywhere from a second to an hour ago, without also having to re-scan the
 * whole store to know that.
 */
async function runCleanup(): Promise<GcReport> {
  const open = await db.select().from(storageAnomalies).where(isNull(storageAnomalies.resolvedAt))
  const touchedSessions = new Set<string>()
  const failures: string[] = []
  let orphanBlobsDeleted = 0
  let danglingRowsDeleted = 0
  let orphanSessionDirsDeleted = 0
  let checksumMismatchesDeleted = 0
  let orphanIdeaDirsDeleted = 0
  let ideaDanglingRowsDeleted = 0
  let ideaChecksumMismatchesDeleted = 0
  let skippedRevalidated = 0

  for (const anomaly of open) {
    const result = await remediateAnomaly(anomaly, 'delete')
    if (result.touchedSessionId) touchedSessions.add(result.touchedSessionId)

    if (result.outcome === 'deleted') {
      if (anomaly.class === 'orphan_blob') orphanBlobsDeleted += 1
      else if (anomaly.class === 'dangling_row') danglingRowsDeleted += 1
      else if (anomaly.class === 'orphan_session_dir') orphanSessionDirsDeleted += 1
      else if (anomaly.class === 'checksum_mismatch') checksumMismatchesDeleted += 1
      else if (anomaly.class === 'orphan_idea_dir') orphanIdeaDirsDeleted += 1
      else if (anomaly.class === 'idea_dangling_row') ideaDanglingRowsDeleted += 1
      else if (anomaly.class === 'idea_checksum_mismatch') ideaChecksumMismatchesDeleted += 1
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
    classificationFailures: [],
    cleanup: {
      orphanBlobsDeleted,
      danglingRowsDeleted,
      orphanSessionDirsDeleted,
      checksumMismatchesDeleted,
      orphanIdeaDirsDeleted,
      ideaDanglingRowsDeleted,
      ideaChecksumMismatchesDeleted,
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
