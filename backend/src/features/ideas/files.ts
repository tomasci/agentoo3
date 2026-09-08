// Idea-owned file assets: upload, list, soft-delete and download, mirroring
// features/attachments/service.ts's session-scoped functions field for
// field — read that module first, since the reasoning behind each step
// (bytes before rows, dedup via a partial unique index, cheap pre-check then
// authoritative post-write check) is identical here with ideaId standing in
// for sessionId. This file adds one thing that module doesn't have: the
// handoff that copies an idea's assets into a session (see
// attachIdeaAssetsToSession below).
//
// Lives under features/ideas/ rather than features/attachments/ because the
// owning entity — and the caps, the routes another track will build on top,
// and the lifecycle questions ("can this idea's assets be read yet") — is an
// idea's, not a session's. It still imports storage.ts's shared writer and
// attachments/service.ts's shared usage/cap helpers directly rather than
// duplicating either: this module owns the idea half of the *business
// logic*, not a second copy of the filesystem or accounting layer.

import { and, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm'
import { db } from '@/db/client'
import { ideaFiles, ideas, sessionFiles, sessions } from '@/db/schema'
import { env } from '@/env'
import {
  regenerateManifest,
  usageFor as sessionUsageFor,
  totalUsage,
  uploadErrorMessage,
} from '@/features/attachments/service'
import {
  AttachmentUploadError,
  copyIdeaFileIntoSession,
  deleteIdeaFile as storageDeleteIdeaFile,
  openIdeaFile as storageOpenIdeaFile,
  putIdeaFile as storagePutIdeaFile,
} from '@/features/attachments/storage'
import { badRequest, notFound } from '@/lib/errors'

type IdeaFileRow = typeof ideaFiles.$inferSelect

export interface IdeaFileDto {
  id: string
  ideaId: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  checksum: string
  status: IdeaFileRow['status']
  lineCount: number | null
  pageCount: number | null
  createdAt: string
  /**
   * True when this response is the row an earlier, identical-bytes upload
   * already created, not the one this request itself just sent — see
   * uploadIdeaFile's own dedup below. `originalFilename` above then names
   * whatever *that* earlier upload was called, not the file just posted;
   * without this flag a client has no way to tell the two cases apart, and a
   * dedup response can look like it stored a file under the wrong name.
   * Always `false` outside of upload (list, download): there is no "this
   * request" to have matched anything against.
   */
  matchedExisting: boolean
}

function toDto(row: IdeaFileRow, matchedExisting = false): IdeaFileDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    status: row.status,
    lineCount: row.lineCount,
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
    matchedExisting,
  }
}

async function requireIdea(ideaId: string) {
  const [row] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1)
  if (!row) throw notFound('Idea')
  return row
}

interface Usage {
  fileCount: number
  sizeBytes: number
}

async function usageForIdea(ideaId: string): Promise<Usage> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`, bytes: sum(ideaFiles.sizeBytes) })
    .from(ideaFiles)
    .where(and(eq(ideaFiles.ideaId, ideaId), isNull(ideaFiles.deletedAt)))
  return { fileCount: Number(row?.n ?? 0), sizeBytes: Number(row?.bytes ?? 0) }
}

/**
 * Accept an upload for one idea. Same shape as attachments/service.ts's
 * uploadFile, field for field: a cheap pre-check against the client's size
 * hint, bytes written before anything else, then the authoritative
 * post-write check against the real byte count — a violation caught only
 * then deletes the blob it just wrote and never inserts a row (an orphan
 * blob is GC-able; an orphan row is not).
 */
export async function uploadIdeaFile(
  ideaId: string,
  originalFilename: string,
  body: ReadableStream<Uint8Array>,
  declaredType: string | undefined,
  sizeHint: number | undefined,
): Promise<IdeaFileDto> {
  await requireIdea(ideaId)

  const usage = await usageForIdea(ideaId)
  if (usage.fileCount >= env.ATTACHMENTS_IDEA_MAX_FILES) {
    throw badRequest(
      `This idea already has ${usage.fileCount} files, its limit (${env.ATTACHMENTS_IDEA_MAX_FILES})`,
    )
  }
  if (sizeHint !== undefined) {
    if (sizeHint > env.ATTACHMENT_MAX_BYTES) {
      throw badRequest(`Exceeds the ${env.ATTACHMENT_MAX_BYTES}-byte per-file limit`)
    }
    if (usage.sizeBytes + sizeHint > env.ATTACHMENTS_IDEA_MAX_BYTES) {
      throw badRequest(`Would exceed this idea's ${env.ATTACHMENTS_IDEA_MAX_BYTES}-byte limit`)
    }
  }

  let stored: Awaited<ReturnType<typeof storagePutIdeaFile>>
  try {
    stored = await storagePutIdeaFile(ideaId, originalFilename, body, declaredType)
  } catch (error) {
    if (error instanceof AttachmentUploadError) throw badRequest(uploadErrorMessage(error))
    throw error
  }

  // Authoritative, post-write check: sizeHint above is a fast path only, not
  // a guard anything can actually rely on.
  const [freshUsage, freshTotal] = await Promise.all([usageForIdea(ideaId), totalUsage()])
  if (freshUsage.sizeBytes + stored.sizeBytes > env.ATTACHMENTS_IDEA_MAX_BYTES) {
    await storageDeleteIdeaFile(ideaId, stored.fileId)
    throw badRequest(`Would exceed this idea's ${env.ATTACHMENTS_IDEA_MAX_BYTES}-byte limit`)
  }
  if (freshTotal + stored.sizeBytes > env.ATTACHMENTS_TOTAL_MAX_BYTES) {
    await storageDeleteIdeaFile(ideaId, stored.fileId)
    throw badRequest('Would exceed this deployment’s total attachment storage limit')
  }

  // Dedup within this idea only — mirrors uploadFile's own session-scoped
  // dedup, never global, never a hardlink across ideas or into a session.
  const [existing] = await db
    .select()
    .from(ideaFiles)
    .where(
      and(
        eq(ideaFiles.ideaId, ideaId),
        eq(ideaFiles.checksum, stored.checksum),
        isNull(ideaFiles.deletedAt),
      ),
    )
    .limit(1)
  if (existing) {
    await storageDeleteIdeaFile(ideaId, stored.fileId)
    return toDto(existing, true)
  }

  const [row] = await db
    .insert(ideaFiles)
    .values({
      id: stored.fileId,
      ideaId,
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

  return toDto(row)
}

export interface IdeaFilesListDto {
  files: IdeaFileDto[]
  usage: {
    fileCount: number
    sizeBytes: number
    maxFiles: number
    maxIdeaBytes: number
  }
}

export async function listIdeaFiles(ideaId: string): Promise<IdeaFilesListDto> {
  await requireIdea(ideaId)
  const rows = await db
    .select()
    .from(ideaFiles)
    .where(and(eq(ideaFiles.ideaId, ideaId), isNull(ideaFiles.deletedAt)))
    .orderBy(desc(ideaFiles.createdAt))
  const usage = await usageForIdea(ideaId)
  return {
    files: rows.map((row) => toDto(row)),
    usage: {
      fileCount: usage.fileCount,
      sizeBytes: usage.sizeBytes,
      maxFiles: env.ATTACHMENTS_IDEA_MAX_FILES,
      maxIdeaBytes: env.ATTACHMENTS_IDEA_MAX_BYTES,
    },
  }
}

async function requireOwnIdeaFile(ideaId: string, fileId: string): Promise<IdeaFileRow> {
  const [row] = await db
    .select()
    .from(ideaFiles)
    .where(and(eq(ideaFiles.id, fileId), eq(ideaFiles.ideaId, ideaId), isNull(ideaFiles.deletedAt)))
    .limit(1)
  // A file id from a different idea must 404 exactly like an unknown one —
  // the WHERE above resolves by (ideaId, fileId) together, never by fileId
  // alone, which is what makes that true.
  if (!row) throw notFound('File')
  return row
}

/** Soft delete, same as attachments/service.ts's deleteFile: the row stays so
 * its checksum can be re-added later without colliding with a row that no
 * longer represents a real file. No manifest to regenerate afterwards — an
 * idea has none. */
export async function deleteIdeaFile(ideaId: string, fileId: string): Promise<void> {
  await requireOwnIdeaFile(ideaId, fileId)
  await storageDeleteIdeaFile(ideaId, fileId)
  await db.update(ideaFiles).set({ deletedAt: new Date() }).where(eq(ideaFiles.id, fileId))
}

export interface IdeaFileDownload {
  dto: IdeaFileDto
  sizeBytes: number
  stream: ReadableStream<Uint8Array>
}

/** Serves bytes for (ideaId, fileId). 404s rather than 500s whenever the row
 * and the disk disagree, same as attachments/service.ts's
 * getFileForDownload. */
export async function getIdeaFileForDownload(
  ideaId: string,
  fileId: string,
  range?: { start: number; end: number },
): Promise<IdeaFileDownload> {
  const row = await requireOwnIdeaFile(ideaId, fileId)
  if (row.status !== 'ready') throw notFound('File')

  const opened = await storageOpenIdeaFile(ideaId, fileId, range)
  if (!opened) throw notFound('File')

  return { dto: toDto(row), sizeBytes: opened.file.sizeBytes, stream: opened.stream }
}

// --- handoff: copy an idea's assets into a session --------------------------

export interface AttachIdeaAssetsResult {
  /**
   * Every ready idea asset's own `originalFilename`, mapped to the
   * `session_files.originalFilename` that now actually backs those bytes in
   * the session — identical for an ordinary fresh copy, and different only
   * when a checksum collision (an earlier upload, or another idea asset,
   * already claimed that checksum first — see this function's own docblock)
   * meant this asset's own name never landed. Every ready asset appears here,
   * whether this particular call copied it or found it already present:
   * dispatchRun (features/ideas/handoff.ts) needs the full, current picture
   * every time, since the prompt it is about to send can name any of them.
   */
  filenames: Map<string, string>
}

/**
 * Copy an idea's ready, non-deleted assets into a session, as ordinary
 * session_files rows — never a distinguishable "copied from an idea" record.
 * That choice is deliberate and load-bearing: after this returns, nothing in
 * the session's tree or in session_files lets gc.ts, reconcile.ts, storage.ts,
 * runner-options.ts or session-run.worker.ts tell a copied asset apart from
 * an ordinary upload, so none of them need to change to support this. A
 * hard link was rejected — it would break the invariant, stated on
 * attachments/service.ts's deleteFile, that deleting a session deletes its
 * files, since the idea's copy would keep the inode alive. A nullable
 * `ideaId` column on session_files was rejected too: gc.ts walks a session's
 * own uploads dir and would find no blob for such a row unless the bytes
 * were copied anyway, so it would classify every one of these rows
 * `dangling_row`, flip its status to 'missing', drop it from readyFiles, and
 * hard-delete it on the next cleanup — silently un-attaching every handed-off
 * asset within about an hour.
 *
 * Idempotent: an idea can be hit "selected for development" more than once
 * (a follow-up reuses the same session), and this may run again for the same
 * (ideaId, sessionId) pair. Idempotency comes from the same mechanism
 * uploadFile's own dedup uses — the partial unique index on
 * (session_id, checksum) WHERE deleted_at IS NULL — applied two ways here:
 * assets already matching an existing session_files checksum are filtered
 * out before any copying starts (the common, sequential-retry case), and the
 * insert itself carries `onConflictDoNothing` against that same index as a
 * defence against a genuine concurrent double-handoff. Two idea assets with
 * identical bytes collapse to the one session file the index already
 * enforces for an ordinary upload — accepted here unchanged, not a new
 * behaviour this introduces. The dedup is correct; what it costs is a
 * filename that never lands, which is exactly what `filenames` on the
 * returned result exists to let a caller reconcile — see
 * AttachIdeaAssetsResult above and dispatchRun's own use of it.
 *
 * Bytes then row, always, one asset at a time: `copyIdeaFileIntoSession`
 * lands the blob before this inserts anything referencing it, so a failure
 * between the two — or a stale pre-check racing a concurrent handoff and
 * losing the onConflictDoNothing — leaves an unrowed blob, which
 * ATTACHMENTS_GC_GRACE_MS then reaps, never an orphan row.
 *
 * Every cap is pre-checked for the *whole* set before a single byte is
 * copied, and this throws a typed (400) error if any of them would be
 * exceeded: nine 25 MiB assets against a 200 MiB session cap must fail as a
 * unit, not silently attach seven of nine and leave the caller to notice two
 * are missing. This is possible here (unlike the streaming per-file upload
 * path, which only knows a file's real size after reading it) because every
 * idea asset's size is already known, sitting on its idea_files row.
 *
 * IMPORTANT for the caller: this must run *before* the handoff's prompt
 * message is appended to the session, not after. A turn's announcement is
 * computed inside the transaction that claims that turn — a session_files
 * row that lands after the prompt message is already queued has to wait a
 * whole extra turn before an agent is ever told it exists.
 */
export async function attachIdeaAssetsToSession(
  ideaId: string,
  sessionId: string,
): Promise<AttachIdeaAssetsResult> {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!session) throw notFound('Session')

  const readyIdeaFiles = await db
    .select()
    .from(ideaFiles)
    .where(
      and(eq(ideaFiles.ideaId, ideaId), isNull(ideaFiles.deletedAt), eq(ideaFiles.status, 'ready')),
    )
    .orderBy(ideaFiles.createdAt, ideaFiles.id)
  if (readyIdeaFiles.length === 0) return { filenames: new Map() }

  const existingChecksums = new Set(
    (
      await db
        .select({ checksum: sessionFiles.checksum })
        .from(sessionFiles)
        .where(and(eq(sessionFiles.sessionId, sessionId), isNull(sessionFiles.deletedAt)))
    ).map((r) => r.checksum),
  )

  // Which assets still need copying, de-duped by checksum within the batch
  // too — two idea assets sharing bytes must only ever produce the one
  // session_files row the partial unique index allows.
  const seenChecksums = new Set<string>()
  const toCopy = readyIdeaFiles.filter((row) => {
    if (existingChecksums.has(row.checksum)) return false
    if (seenChecksums.has(row.checksum)) return false
    seenChecksums.add(row.checksum)
    return true
  })

  if (toCopy.length > 0) {
    // Pre-check every cap for the whole set before copying a single byte —
    // see this function's own docblock for why "seven of nine" is the
    // failure mode this guards against.
    const [usage, total] = await Promise.all([sessionUsageFor(sessionId), totalUsage()])
    const addedBytes = toCopy.reduce((n, row) => n + row.sizeBytes, 0)
    if (usage.fileCount + toCopy.length > env.ATTACHMENTS_SESSION_MAX_FILES) {
      throw badRequest(
        `Attaching ${toCopy.length} file(s) from this idea would put this session over its ` +
          `${env.ATTACHMENTS_SESSION_MAX_FILES}-file limit`,
      )
    }
    if (usage.sizeBytes + addedBytes > env.ATTACHMENTS_SESSION_MAX_BYTES) {
      throw badRequest(
        `Attaching ${toCopy.length} file(s) from this idea would exceed this session's ` +
          `${env.ATTACHMENTS_SESSION_MAX_BYTES}-byte limit`,
      )
    }
    if (total + addedBytes > env.ATTACHMENTS_TOTAL_MAX_BYTES) {
      throw badRequest(
        'Attaching this idea’s files would exceed this deployment’s total attachment storage limit',
      )
    }

    for (const row of toCopy) {
      const copied = await copyIdeaFileIntoSession(
        ideaId,
        row.storedName,
        sessionId,
        row.originalFilename,
      )
      await db
        .insert(sessionFiles)
        .values({
          id: copied.fileId,
          sessionId,
          originalFilename: row.originalFilename,
          storedName: copied.storedName,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          checksum: row.checksum,
          lineCount: row.lineCount,
          pageCount: row.pageCount,
          // announcedSeq left NULL: the next turn's announcement picks this
          // up automatically, exactly like any other unannounced file.
        })
        .onConflictDoNothing({
          target: [sessionFiles.sessionId, sessionFiles.checksum],
          where: sql`${sessionFiles.deletedAt} is null`,
        })
    }

    await regenerateManifest(sessionId)
  }

  // Resolve idea filename -> session filename for every ready asset, not just
  // the ones this call actually copied: a name already reconciled by an
  // earlier handoff (or lost to an earlier checksum collision) still has to
  // be reported every time, since the caller has no memory of its own across
  // calls. Read back from session_files itself, after any copying above,
  // rather than reasoned about in memory — that is what stays correct even
  // when a concurrent handoff's onConflictDoNothing won the race for a
  // checksum this call also wanted to copy.
  const sessionRows = await db
    .select({ checksum: sessionFiles.checksum, originalFilename: sessionFiles.originalFilename })
    .from(sessionFiles)
    .where(
      and(
        eq(sessionFiles.sessionId, sessionId),
        isNull(sessionFiles.deletedAt),
        inArray(
          sessionFiles.checksum,
          readyIdeaFiles.map((r) => r.checksum),
        ),
      ),
    )
  const sessionNameByChecksum = new Map(sessionRows.map((r) => [r.checksum, r.originalFilename]))
  const filenames = new Map<string, string>()
  for (const row of readyIdeaFiles) {
    const sessionName = sessionNameByChecksum.get(row.checksum)
    if (sessionName !== undefined) filenames.set(row.originalFilename, sessionName)
  }
  return { filenames }
}
