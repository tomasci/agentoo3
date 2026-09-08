// Whether an already-classified storage anomaly is still real, and the one
// place that acts on one — shared by gc.ts's runCleanup (the full sweep,
// acting on every anomaly the last check found) and service.ts's per-row and
// bulk-by-id remediation endpoints (acting on an operator's own selection),
// so there is exactly one place that decides "is this still true" and
// exactly one place that deletes a blob, a session_files/idea_files row, or a
// session/idea directory. Neither gc.ts nor a route handler ever touches the
// filesystem or storageAnomalies rows for this directly.
//
// The problem this exists for: both callers act on anomalies an *earlier*
// pass already classified rather than scanning fresh — deliberate, so an
// operator clicking "clean up" is never surprised by something reclassifying
// mid-delete — but the gap between that classification and the click is
// exactly the window ATTACHMENTS_GC_GRACE_MS exists to protect on the
// *automatic* path (a blob renamed into place moments before its row
// commits). Re-verifying immediately before acting is what extends that same
// protection to every path that deletes something a human or an API caller
// asked for, not only the scheduled one.

import { stat } from 'node:fs/promises'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { ideaFiles, ideas, sessionFiles, sessions, storageAnomalies } from '@/db/schema'
import {
  checksumFile,
  listBlobEntries,
  listIdeaBlobEntries,
  removeBlobAt,
  removeIdeaDirAt,
  removeSessionDirAt,
} from './storage'

type Anomaly = typeof storageAnomalies.$inferSelect

/**
 * Re-derive whether `anomaly` still holds, from current disk and database
 * state — never from the row's own (possibly stale) `detail`/`lastSeenAt`.
 *
 * `orphan_blob` → still no live row for its fileId in *either* session_files
 * or idea_files (a blob's owning root cannot be recovered from the anomaly
 * alone — only its path — so both tables have to miss before this is still
 * an anomaly; querying only one would let a perfectly live idea file get
 * reported as still-orphaned forever), and the blob is still actually there
 * (a blob with no uuid prefix at all can never get a row, so the first check
 * is unconditionally true for it). Deliberately *not* re-checking the grace
 * window here: that heuristic exists to protect the *automatic, unattended*
 * pass from a rename-then-commit race it cannot otherwise see coming (see the
 * module doc on runCheck in gc.ts) — but cleanup already asks a strictly
 * stronger question, "does a live row exist right now", synchronously,
 * immediately before deleting. Re-adding a fixed time buffer on top of that
 * live check would not make cleanup safer, it would just make an operator's
 * explicit "clean up everything" silently decline to touch an anomaly that
 * has been sitting open since the last check found it — which is also what
 * acceptance criterion 10 (zero anomalies after cleanup) rules out.
 *
 * `dangling_row`/`idea_dangling_row` → the blob is still absent, on the
 * matching root. `orphan_session_dir`/`orphan_idea_dir` → the session/idea
 * still does not exist. `checksum_mismatch`/`idea_checksum_mismatch` → the
 * row is still there and the blob, re-read, still disagrees with it.
 *
 * `anomaly.sessionId` holds an idea id for every idea_* class — storage_
 * anomalies has no separate ideaId column (see db/schema.ts's comment on that
 * table), and `anomaly.class` is what disambiguates which kind of id it is.
 */
export async function stillAnAnomaly(anomaly: Anomaly): Promise<boolean> {
  switch (anomaly.class) {
    case 'orphan_blob': {
      if (!anomaly.path) return false
      if (anomaly.fileId) {
        const [sessionRow] = await db
          .select({ id: sessionFiles.id })
          .from(sessionFiles)
          .where(and(eq(sessionFiles.id, anomaly.fileId), isNull(sessionFiles.deletedAt)))
          .limit(1)
        if (sessionRow) return false
        const [ideaRow] = await db
          .select({ id: ideaFiles.id })
          .from(ideaFiles)
          .where(and(eq(ideaFiles.id, anomaly.fileId), isNull(ideaFiles.deletedAt)))
          .limit(1)
        if (ideaRow) return false
      }
      return Boolean(await stat(anomaly.path).catch(() => undefined))
    }
    case 'dangling_row': {
      if (!anomaly.sessionId || !anomaly.fileId) return false
      const blobs = await listBlobEntries(anomaly.sessionId)
      return !blobs.some((b) => b.fileId === anomaly.fileId)
    }
    case 'idea_dangling_row': {
      if (!anomaly.sessionId || !anomaly.fileId) return false
      const blobs = await listIdeaBlobEntries(anomaly.sessionId)
      return !blobs.some((b) => b.fileId === anomaly.fileId)
    }
    case 'orphan_session_dir': {
      if (!anomaly.sessionId) return false
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, anomaly.sessionId))
        .limit(1)
      return !row
    }
    case 'orphan_idea_dir': {
      if (!anomaly.sessionId) return false
      const [row] = await db
        .select({ id: ideas.id })
        .from(ideas)
        .where(eq(ideas.id, anomaly.sessionId))
        .limit(1)
      return !row
    }
    case 'checksum_mismatch': {
      if (!anomaly.sessionId || !anomaly.fileId) return false
      const [row] = await db
        .select()
        .from(sessionFiles)
        .where(and(eq(sessionFiles.id, anomaly.fileId), isNull(sessionFiles.deletedAt)))
        .limit(1)
      if (!row) return false
      const blobs = await listBlobEntries(anomaly.sessionId)
      const blob = blobs.find((b) => b.fileId === anomaly.fileId)
      if (!blob) return false
      const checksum = await checksumFile(blob.path)
      return checksum !== row.checksum || blob.sizeBytes !== row.sizeBytes
    }
    case 'idea_checksum_mismatch': {
      if (!anomaly.sessionId || !anomaly.fileId) return false
      const [row] = await db
        .select()
        .from(ideaFiles)
        .where(and(eq(ideaFiles.id, anomaly.fileId), isNull(ideaFiles.deletedAt)))
        .limit(1)
      if (!row) return false
      const blobs = await listIdeaBlobEntries(anomaly.sessionId)
      const blob = blobs.find((b) => b.fileId === anomaly.fileId)
      if (!blob) return false
      const checksum = await checksumFile(blob.path)
      return checksum !== row.checksum || blob.sizeBytes !== row.sizeBytes
    }
    default:
      return false
  }
}

export type AnomalyRemediationOutcome = 'deleted' | 'revalidated' | 'unchanged' | 'failed'

export interface AnomalyRemediationResult {
  outcome: AnomalyRemediationOutcome
  /** Set only when a delete actually removed a session_files row (dangling_row
   * or checksum_mismatch), so a caller knows which session's ATTACHMENTS.md
   * needs regenerating. Never set for an idea_* class — an idea has no
   * manifest to regenerate. */
  touchedSessionId?: string
  error?: string
}

/**
 * Act on one already-open anomaly row.
 *
 * `mode: 'recheck'` is "re-run the check on a single entry": it never
 * deletes anything. A finding that no longer holds is resolved (it fixed
 * itself); one that still holds has its `lastSeenAt` refreshed and stays
 * open, matching what a full check does to something it re-confirms.
 *
 * `mode: 'delete'` performs the class-appropriate removal, but only once
 * `stillAnAnomaly` has confirmed it is still real. An entry that resolved
 * itself in the meantime is marked resolved without anything being deleted —
 * that is what makes this safe to call well after the last full check, from
 * a full sweep or from a single operator-triggered row.
 *
 * `checksum_mismatch`/`idea_checksum_mismatch` deletes both the blob and the
 * row: neither side of a mismatch can be trusted (the database and the disk
 * disagree about the same file's bytes), so there is no automatic way to
 * decide which one is right, and no legitimate way to serve the file either
 * way. Treating it as unusable data — rather than leaving it as the one
 * class a "clean up everything" pass can never actually clear — is what lets
 * a re-run after cleanup report zero outstanding anomalies (acceptance
 * criterion 10).
 */
export async function remediateAnomaly(
  anomaly: Anomaly,
  mode: 'delete' | 'recheck',
): Promise<AnomalyRemediationResult> {
  const now = new Date()
  if (!(await stillAnAnomaly(anomaly))) {
    await db
      .update(storageAnomalies)
      .set({ resolvedAt: now })
      .where(eq(storageAnomalies.id, anomaly.id))
    return { outcome: 'revalidated' }
  }
  if (mode === 'recheck') {
    await db
      .update(storageAnomalies)
      .set({ lastSeenAt: now })
      .where(eq(storageAnomalies.id, anomaly.id))
    return { outcome: 'unchanged' }
  }

  try {
    let touchedSessionId: string | undefined
    if (anomaly.class === 'orphan_blob' && anomaly.path) {
      await removeBlobAt(anomaly.path)
    } else if (anomaly.class === 'orphan_session_dir' && anomaly.path && anomaly.sessionId) {
      await removeSessionDirAt(anomaly.sessionId, anomaly.path)
    } else if (anomaly.class === 'orphan_idea_dir' && anomaly.path && anomaly.sessionId) {
      await removeIdeaDirAt(anomaly.sessionId, anomaly.path)
    } else if (anomaly.class === 'dangling_row' && anomaly.fileId) {
      await db.delete(sessionFiles).where(eq(sessionFiles.id, anomaly.fileId))
      touchedSessionId = anomaly.sessionId ?? undefined
    } else if (anomaly.class === 'checksum_mismatch' && anomaly.fileId) {
      if (anomaly.path) await removeBlobAt(anomaly.path)
      await db.delete(sessionFiles).where(eq(sessionFiles.id, anomaly.fileId))
      touchedSessionId = anomaly.sessionId ?? undefined
    } else if (anomaly.class === 'idea_dangling_row' && anomaly.fileId) {
      await db.delete(ideaFiles).where(eq(ideaFiles.id, anomaly.fileId))
    } else if (anomaly.class === 'idea_checksum_mismatch' && anomaly.fileId) {
      if (anomaly.path) await removeBlobAt(anomaly.path)
      await db.delete(ideaFiles).where(eq(ideaFiles.id, anomaly.fileId))
    } else {
      throw new Error(`Anomaly ${anomaly.id} (${anomaly.class}) has nothing actionable to delete`)
    }
    await db
      .update(storageAnomalies)
      .set({ resolvedAt: now })
      .where(eq(storageAnomalies.id, anomaly.id))
    return { outcome: 'deleted', touchedSessionId }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { outcome: 'failed', error: detail }
  }
}
