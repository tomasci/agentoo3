// Runs every database-backed attachments scenario once, against the throwaway
// cluster its parent started, and prints what happened as JSON.
//
// A child process rather than more `mock.module` calls: `@/env` parses
// process.env at first import and bun shares one module registry across the
// whole test run, so DATABASE_URL and ATTACHMENTS_DIR cannot be re-pointed for
// one file without re-pointing them for every other. Three files already
// replace `@/db/client` wholesale for the same reason. Here the env is simply
// correct from the start, and the assertions live in attachments-db.test.ts,
// which reads the facts below.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { createApp } from '@/app'
import { closeDb, db } from '@/db/client'
import {
  messageFiles,
  messages,
  projects,
  sessionFiles,
  sessions,
  storageAnomalies,
} from '@/db/schema'
import { env } from '@/env'
import { runAttachmentsGc } from '@/features/attachments/gc'
import {
  deleteFile as serviceDeleteFile,
  sessionAttachmentsSummary,
  uploadFile,
} from '@/features/attachments/service'
import { put } from '@/features/attachments/storage'
import { deleteSession } from '@/features/sessions/service'
import {
  attachmentsManifestPath,
  projectRepo,
  sessionAttachmentsDir,
  sessionUploadsDir,
} from '@/lib/paths'

const app = createApp()
const facts: Record<string, unknown> = {}

const PROJECT_ID = randomUUID()

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId: PROJECT_ID, status: 'idle' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

const streamOf = (body: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })

async function upload(
  sessionId: string,
  filename: string,
  body: string | Uint8Array,
  type = 'text/plain',
) {
  const form = new FormData()
  form.set('file', new File([body], filename, { type }))
  const res = await app.request(`/api/sessions/${sessionId}/files`, { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const listDir = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()
const exists = async (path: string) => Boolean(await stat(path).catch(() => undefined))

const rowsFor = (sessionId: string) =>
  db.select().from(sessionFiles).where(eq(sessionFiles.sessionId, sessionId))

const openAnomalies = () =>
  db.select().from(storageAnomalies).where(isNull(storageAnomalies.resolvedAt))

async function main() {
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: 'demo', slug: 'demo', source: 'empty', status: 'ready' })

  // --- 3: a file id from session A is unreachable from session B -------------
  {
    const a = await newSession()
    const b = await newSession()
    const created = await upload(a, 'secret.log', 'classified\n')
    const fileId = String(created.body.id)
    const blob = join(sessionUploadsDir(a), `${fileId}-secret.log`)

    const get = async (session: string) =>
      (await app.request(`/api/sessions/${session}/files/${fileId}`)).status
    const del = async (session: string) =>
      (await app.request(`/api/sessions/${session}/files/${fileId}`, { method: 'DELETE' })).status

    const crossDelete = await del(b)
    const listB = (await (await app.request(`/api/sessions/${b}/files`)).json()) as {
      files: unknown[]
    }

    facts.crossSession = {
      uploadStatus: created.status,
      ownGet: await get(a),
      crossGet: await get(b),
      crossDelete,
      blobSurvivedCrossDelete: await exists(blob),
      listBFileCount: listB.files.length,
      unknownSessionGet: (await app.request(`/api/sessions/${randomUUID()}/files/${fileId}`)).status,
      malformedSessionGet: (await app.request(`/api/sessions/not-a-uuid/files/${fileId}`)).status,
      ownUploadsDir: sessionUploadsDir(a),
      otherUploadsDir: sessionUploadsDir(b),
      summaryA: await sessionAttachmentsSummary(a),
      summaryB: await sessionAttachmentsSummary(b),
    }
  }

  // --- 14: the allowlist is decided by content, not the client or the name ---
  {
    const s = await newSession()
    const script = await upload(s, 'screenshot.png', '#!/bin/sh\necho pwned\n', 'image/png')
    const pdf = await upload(
      s,
      'notes.log',
      '%PDF-1.7\n/Type /Pages\n/Type /Page\n%%EOF\n',
      'text/plain',
    )
    const json = await upload(s, 'data.json', '{"a":1}\n', 'application/octet-stream')
    const markdown = await upload(s, 'harmless.md', '# heading\n', 'text/markdown')

    facts.sniffing = {
      scriptNamedPng: { status: script.status, mimeType: script.body.mimeType },
      pdfNamedLog: {
        status: pdf.status,
        mimeType: pdf.body.mimeType,
        pageCount: pdf.body.pageCount,
      },
      jsonDeclaredOctetStream: { status: json.status, mimeType: json.body.mimeType },
      markdownNamedMd: { status: markdown.status, mimeType: markdown.body.mimeType },
    }
  }

  // --- dedup is scoped to the session ----------------------------------------
  {
    const a = await newSession()
    const b = await newSession()
    const bytes = 'the same screenshot bytes\n'
    const first = await upload(a, 'shot.log', bytes)
    const again = await upload(a, 'shot-renamed.log', bytes)
    const inB = await upload(b, 'shot.log', bytes)

    const statA = await stat(join(sessionUploadsDir(a), `${String(first.body.id)}-shot.log`))
    const statB = await stat(join(sessionUploadsDir(b), `${String(inB.body.id)}-shot.log`))

    facts.dedup = {
      sameIdWithinSession: first.body.id === again.body.id,
      rowsInA: (await rowsFor(a)).length,
      blobsInA: (await listDir(sessionUploadsDir(a))).filter((n) => n !== 'ATTACHMENTS.md').length,
      differentIdAcrossSessions: first.body.id !== inB.body.id,
      sameChecksum: first.body.checksum === inB.body.checksum,
      sameInode: statA.ino === statB.ino,
      nlinkA: statA.nlink,
      nlinkB: statB.nlink,
    }

    await serviceDeleteFile(a, String(first.body.id))
    const readded = await upload(a, 'shot.log', bytes)
    facts.dedupAfterDelete = {
      status: readded.status,
      newId: readded.body.id !== first.body.id,
      liveRows: (await rowsFor(a)).filter((r) => r.deletedAt === null).length,
    }
  }

  // --- 6: quotas --------------------------------------------------------------
  {
    const s = await newSession()
    const uploads = sessionUploadsDir(s)
    await upload(s, 'seed.log', 'x'.repeat(1000))

    const originalSessionMax = env.ATTACHMENTS_SESSION_MAX_BYTES
    const originalTotalMax = env.ATTACHMENTS_TOTAL_MAX_BYTES
    const originalMaxFiles = env.ATTACHMENTS_SESSION_MAX_FILES

    // An honest size hint, which is what the HTTP route always sends.
    env.ATTACHMENTS_SESSION_MAX_BYTES = 1500
    const overSession = await upload(s, 'over.log', 'y'.repeat(1000))
    const afterHinted = await listDir(uploads)

    // No size hint at all: the service has to catch it after the write.
    let unhintedError = ''
    try {
      await uploadFile(s, 'sneaky.log', streamOf('z'.repeat(1000)), undefined, undefined)
    } catch (error) {
      unhintedError = error instanceof Error ? error.message : String(error)
    }
    const afterUnhinted = await listDir(uploads)

    env.ATTACHMENTS_SESSION_MAX_BYTES = originalSessionMax
    env.ATTACHMENTS_TOTAL_MAX_BYTES = 1200
    let totalError = ''
    try {
      await uploadFile(s, 'global.log', streamOf('w'.repeat(1000)), undefined, undefined)
    } catch (error) {
      totalError = error instanceof Error ? error.message : String(error)
    }
    const afterTotal = await listDir(uploads)
    env.ATTACHMENTS_TOTAL_MAX_BYTES = originalTotalMax

    env.ATTACHMENTS_SESSION_MAX_FILES = 1
    const overCount = await upload(s, 'onemore.log', 'tiny')
    env.ATTACHMENTS_SESSION_MAX_FILES = originalMaxFiles

    facts.quota = {
      hintedStatus: overSession.status,
      hintedError: String(overSession.body.error ?? ''),
      hintedLeftNothing: afterHinted.filter((n) => n.includes('over.log')).length === 0,
      hintedLeftNoTmp: afterHinted.filter((n) => n.startsWith('.tmp-')).length === 0,
      unhintedError,
      unhintedLeftNothing: afterUnhinted.filter((n) => n.includes('sneaky.log')).length === 0,
      totalError,
      totalLeftNothing: afterTotal.filter((n) => n.includes('global.log')).length === 0,
      countStatus: overCount.status,
      countError: String(overCount.body.error ?? ''),
      liveRows: (await rowsFor(s)).filter((r) => r.deletedAt === null).length,
    }
  }

  // --- 5: an upload that dies partway leaves no partial file and no row ------
  {
    const s = await newSession()
    await upload(s, 'good.log', 'keep me\n')
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half a fi'))
      },
      pull() {
        throw new Error('socket hang up')
      },
    })
    let message = ''
    try {
      await uploadFile(s, 'doomed.log', failing, undefined, 9)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const entries = await listDir(sessionUploadsDir(s))
    facts.interruptedUpload = {
      message,
      entries,
      tmpLeft: entries.filter((n) => n.startsWith('.tmp-')).length,
      rows: (await rowsFor(s)).length,
    }
  }

  // --- 4: deleting a session takes the bytes with it -------------------------
  {
    const withFiles = await newSession()
    await upload(withFiles, 'a.log', 'one\n')
    await upload(withFiles, 'b.log', 'two\n')
    const dir = sessionAttachmentsDir(withFiles)
    const before = await exists(dir)

    await deleteSession(withFiles)

    const alreadyGone = await newSession()
    await upload(alreadyGone, 'c.log', 'three\n')
    await rm(sessionAttachmentsDir(alreadyGone), { recursive: true, force: true })
    let secondDeleteError = ''
    try {
      await deleteSession(alreadyGone)
    } catch (error) {
      secondDeleteError = error instanceof Error ? error.message : String(error)
    }

    const never = await newSession()
    let neverUploadedError = ''
    try {
      await deleteSession(never)
    } catch (error) {
      neverUploadedError = error instanceof Error ? error.message : String(error)
    }

    facts.deleteSession = {
      dirExistedBefore: before,
      dirExistsAfter: await exists(dir),
      fileRowsAfter: (
        await db.select().from(sessionFiles).where(eq(sessionFiles.sessionId, withFiles))
      ).length,
      sessionRowsAfter: (await db.select().from(sessions).where(eq(sessions.id, withFiles))).length,
      secondDeleteError,
      neverUploadedError,
    }
  }

  // --- 11: a message referencing a file whose row was cleaned up -------------
  {
    const s = await newSession()
    const created = await upload(s, 'attached.log', 'see this\n')
    const [message] = await db
      .insert(messages)
      .values({ sessionId: s, seq: 0, type: 'prompt', payload: { text: 'look at this' } })
      .returning()
    if (!message) throw new Error('no message row')
    // originalFilename denormalised here exactly as session-run.worker.ts
    // populates it when it stamps an announcement — see message_files in
    // db/schema.ts.
    await db.insert(messageFiles).values({
      messageId: message.id,
      fileId: String(created.body.id),
      originalFilename: 'attached.log',
    })

    // What the GC cleanup path does to a dangling row (or, since the fix for
    // checksum_mismatch, a corrupt one too): a hard delete of session_files.
    // message_files.fileId is ON DELETE SET NULL rather than cascade, exactly
    // so this link row survives that and the message can still say a file
    // was here — see db/schema.ts's message_files for why.
    await rm(join(sessionUploadsDir(s), `${String(created.body.id)}-attached.log`))
    await db.delete(sessionFiles).where(eq(sessionFiles.id, String(created.body.id)))

    const res = await app.request(`/api/sessions/${s}/messages`)
    const body = (await res.json()) as { messages: { files: unknown[] }[] }
    facts.orphanedMessageLink = {
      messagesStatus: res.status,
      linkRows: (await db.select().from(messageFiles).where(eq(messageFiles.messageId, message.id)))
        .length,
      messageRows: (await db.select().from(messages).where(eq(messages.id, message.id))).length,
      files: body.messages[0]?.files,
    }
  }

  // --- 8/9/10: the four anomaly classes, twice, then cleanup -----------------
  {
    const intact = await newSession()
    await upload(intact, 'intact.log', 'do not touch me\n')
    const intactDir = sessionUploadsDir(intact)

    // (a) dangling_row: delete a blob behind the app's back.
    const dangling = await newSession()
    const danglingFile = await upload(dangling, 'gone.log', 'about to vanish\n')
    await rm(join(sessionUploadsDir(dangling), `${String(danglingFile.body.id)}-gone.log`))

    // (b) orphan_blob: delete a row behind the app's back, twice over — one
    //     blob young enough to be inside the grace window, one backdated past
    //     it, plus a .tmp-* that must be ignored either way.
    const orphan = await newSession()
    const young = await upload(orphan, 'young.log', 'written a moment ago\n')
    const old = await upload(orphan, 'old.log', 'written yesterday\n')
    await db.delete(sessionFiles).where(eq(sessionFiles.id, String(young.body.id)))
    await db.delete(sessionFiles).where(eq(sessionFiles.id, String(old.body.id)))
    const youngPath = join(sessionUploadsDir(orphan), `${String(young.body.id)}-young.log`)
    const oldPath = join(sessionUploadsDir(orphan), `${String(old.body.id)}-old.log`)
    const backdated = new Date(Date.now() - env.ATTACHMENTS_GC_GRACE_MS - 60_000)
    await utimes(oldPath, backdated, backdated)
    const tmpPath = join(sessionUploadsDir(orphan), `.tmp-${randomUUID()}`)
    await writeFile(tmpPath, 'still uploading')
    await utimes(tmpPath, backdated, backdated)

    // (c) orphan_session_dir: a directory for a session that no longer exists.
    const ghost = randomUUID()
    await mkdir(sessionUploadsDir(ghost), { recursive: true })
    await writeFile(join(sessionUploadsDir(ghost), `${randomUUID()}-ghost.log`), 'nobody owns me\n')

    // (d) checksum_mismatch: truncate a file behind the app's back.
    const mismatch = await newSession()
    const truncated = await upload(mismatch, 'truncated.log', 'the original contents\n')
    await writeFile(
      join(sessionUploadsDir(mismatch), `${String(truncated.body.id)}-truncated.log`),
      'cut',
    )

    const first = await runAttachmentsGc({ reason: 'manual' })
    const afterFirst = await openAnomalies()
    const firstIds = JSON.stringify(afterFirst.map((a) => a.id).sort())
    const [danglingRow] = await db
      .select()
      .from(sessionFiles)
      .where(eq(sessionFiles.id, String(danglingFile.body.id)))

    const second = await runAttachmentsGc({ reason: 'scheduled' })
    const afterSecond = await openAnomalies()

    facts.gcCheck = {
      firstClassified: first.classified,
      firstOrphanBlobsDeleted: first.orphanBlobsDeleted,
      firstDanglingMarkedMissing: first.danglingRowsMarkedMissing,
      danglingRowStatus: danglingRow?.status,
      youngOrphanStillThere: await exists(youngPath),
      agedOrphanDeleted: !(await exists(oldPath)),
      tmpUntouched: await exists(tmpPath),
      intactBlobCount: (await listDir(intactDir)).length,
      openAfterFirst: afterFirst.map((a) => a.class).sort(),
      detailsAfterFirst: afterFirst.map((a) => a.detail).sort(),

      secondClassified: second.classified,
      secondOrphanBlobsDeleted: second.orphanBlobsDeleted,
      secondDanglingMarkedMissing: second.danglingRowsMarkedMissing,
      secondResolvedAutomatically: second.resolvedAutomatically,
      sameAnomalyIds: JSON.stringify(afterSecond.map((a) => a.id).sort()) === firstIds,
      openAfterSecond: afterSecond.map((a) => a.class).sort(),
      manifestMentionsMissingFile: (await Bun.file(attachmentsManifestPath(dangling)).text()).includes(
        'gone.log',
      ),
    }

    const cleanup = await runAttachmentsGc({ reason: 'cleanup' })
    const third = await runAttachmentsGc({ reason: 'manual' })
    const afterCleanup = await openAnomalies()

    facts.gcCleanup = {
      cleanup: cleanup.cleanup,
      ghostDirGone: !(await exists(sessionAttachmentsDir(ghost))),
      danglingRowDeleted:
        (
          await db
            .select()
            .from(sessionFiles)
            .where(eq(sessionFiles.id, String(danglingFile.body.id)))
        ).length === 0,
      intactBlobCount: (await listDir(intactDir)).length,
      intactRows: (await rowsFor(intact)).length,
      thirdClassified: third.classified,
      openAfterCleanup: afterCleanup.map((a) => a.class).sort(),
    }
  }

  // --- cleanup acts on a stale finding without re-checking -------------------
  {
    const s = await newSession()
    const uploads = sessionUploadsDir(s)
    // A blob renamed into place just before its row commits — exactly the race
    // ATTACHMENTS_GC_GRACE_MS exists to protect.
    const stored = await put(s, 'racing.log', streamOf('committed a moment later\n'))
    const check = await runAttachmentsGc({ reason: 'manual' })
    const seenAsOrphan = (await openAnomalies()).some((a) => a.path?.includes(stored.fileId))

    // The row lands between the check and the cleanup.
    await db.insert(sessionFiles).values({
      id: stored.fileId,
      sessionId: s,
      originalFilename: stored.originalFilename,
      storedName: stored.storedName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
    })

    const cleanup = await runAttachmentsGc({ reason: 'cleanup' })
    const after = await runAttachmentsGc({ reason: 'manual' })

    facts.staleCleanup = {
      graceMs: env.ATTACHMENTS_GC_GRACE_MS,
      checkSawOrphan: seenAsOrphan,
      checkDeletedIt: check.orphanBlobsDeleted,
      blobSurvivedCleanup: await exists(join(uploads, stored.storedName)),
      rowStillThere:
        (await db.select().from(sessionFiles).where(eq(sessionFiles.id, stored.fileId))).length === 1,
      classifiedAfter: after.classified,
      skippedRevalidated: cleanup.cleanup?.skippedRevalidated,
    }
  }

  // --- Gap B: per-row and bulk-by-id remediation endpoints -------------------
  {
    // (a) delete an orphan_blob by id
    const orphanSession = await newSession()
    const orphanFile = await upload(orphanSession, 'solo.log', 'gone soon\n')
    await db.delete(sessionFiles).where(eq(sessionFiles.id, String(orphanFile.body.id)))
    await runAttachmentsGc({ reason: 'manual' })
    const orphanAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'orphan_blob' && a.sessionId === orphanSession,
    )
    if (!orphanAnomaly) throw new Error('expected an orphan_blob anomaly')
    const orphanBlobPath = join(
      sessionUploadsDir(orphanSession),
      `${String(orphanFile.body.id)}-solo.log`,
    )
    const deleteOrphanRes = await app.request(`/api/storage/anomalies/${orphanAnomaly.id}/delete`, {
      method: 'POST',
    })
    const deleteOrphanBody = (await deleteOrphanRes.json()) as Record<string, unknown>

    // (b) delete a dangling_row by id
    const danglingSession = await newSession()
    const danglingFile = await upload(danglingSession, 'row-only.log', 'no blob\n')
    await rm(join(sessionUploadsDir(danglingSession), `${String(danglingFile.body.id)}-row-only.log`))
    await runAttachmentsGc({ reason: 'manual' })
    const danglingAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'dangling_row' && a.sessionId === danglingSession,
    )
    if (!danglingAnomaly) throw new Error('expected a dangling_row anomaly')
    const deleteDanglingRes = await app.request(
      `/api/storage/anomalies/${danglingAnomaly.id}/delete`,
      { method: 'POST' },
    )
    const deleteDanglingBody = (await deleteDanglingRes.json()) as Record<string, unknown>

    // (c) recheck a still-valid anomaly: never deletes, just refreshes it
    const stillOpenSession = await newSession()
    const stillOpenFile = await upload(stillOpenSession, 'still-dangling.log', 'x\n')
    await rm(
      join(sessionUploadsDir(stillOpenSession), `${String(stillOpenFile.body.id)}-still-dangling.log`),
    )
    await runAttachmentsGc({ reason: 'manual' })
    const stillOpenAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'dangling_row' && a.sessionId === stillOpenSession,
    )
    if (!stillOpenAnomaly) throw new Error('expected a dangling_row anomaly for recheck')
    const recheckRes = await app.request(`/api/storage/anomalies/${stillOpenAnomaly.id}/recheck`, {
      method: 'POST',
    })
    const recheckBody = (await recheckRes.json()) as Record<string, unknown>
    const [stillDanglingRow] = await db
      .select()
      .from(sessionFiles)
      .where(eq(sessionFiles.id, String(stillOpenFile.body.id)))
    const [stillOpenAnomalyAfter] = await db
      .select()
      .from(storageAnomalies)
      .where(eq(storageAnomalies.id, stillOpenAnomaly.id))

    // (d) an anomaly that fixed itself before anyone acted on it: delete
    // re-verifies and finds nothing left to do (Defect 2, exercised through
    // the per-row HTTP endpoint rather than through runCleanup this time).
    const selfFixedSession = await newSession()
    const selfFixedStored = await put(selfFixedSession, 'self-fixed.log', streamOf('will get a row\n'))
    await runAttachmentsGc({ reason: 'manual' })
    const selfFixedAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'orphan_blob' && a.sessionId === selfFixedSession,
    )
    if (!selfFixedAnomaly) throw new Error('expected an orphan_blob anomaly to self-fix')
    await db.insert(sessionFiles).values({
      id: selfFixedStored.fileId,
      sessionId: selfFixedSession,
      originalFilename: selfFixedStored.originalFilename,
      storedName: selfFixedStored.storedName,
      mimeType: selfFixedStored.mimeType,
      sizeBytes: selfFixedStored.sizeBytes,
      checksum: selfFixedStored.checksum,
    })
    const selfFixDeleteRes = await app.request(`/api/storage/anomalies/${selfFixedAnomaly.id}/delete`, {
      method: 'POST',
    })
    const selfFixDeleteBody = (await selfFixDeleteRes.json()) as Record<string, unknown>
    const selfFixedBlobSurvived = await exists(
      join(sessionUploadsDir(selfFixedSession), selfFixedStored.storedName),
    )

    // (e) 404 for an unknown id, 409 for one already resolved
    const notFoundRes = await app.request(`/api/storage/anomalies/${randomUUID()}/delete`, {
      method: 'POST',
    })
    const alreadyResolvedRes = await app.request(
      `/api/storage/anomalies/${orphanAnomaly.id}/delete`,
      { method: 'POST' },
    )

    // (f) bulk-delete over an explicit id list: one still-open
    // (orphan_session_dir), one already resolved (from (a) above), one
    // that never existed — the batch must not fail over the latter two.
    const ghostForBulk = randomUUID()
    await mkdir(sessionUploadsDir(ghostForBulk), { recursive: true })
    await writeFile(join(sessionUploadsDir(ghostForBulk), `${randomUUID()}-ghost.log`), 'nobody owns me\n')
    await runAttachmentsGc({ reason: 'manual' })
    const ghostAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'orphan_session_dir' && a.path?.includes(ghostForBulk),
    )
    if (!ghostAnomaly) throw new Error('expected an orphan_session_dir anomaly for bulk-delete')
    const unknownId = randomUUID()
    const bulkRes = await app.request('/api/storage/anomalies/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [ghostAnomaly.id, orphanAnomaly.id, unknownId] }),
    })
    const bulkBody = (await bulkRes.json()) as {
      results: { anomaly: { id: string }; outcome: string }[]
    }

    facts.remediation = {
      orphanBlobDelete: {
        status: deleteOrphanRes.status,
        outcome: deleteOrphanBody.outcome,
        blobGone: !(await exists(orphanBlobPath)),
      },
      danglingRowDelete: {
        status: deleteDanglingRes.status,
        outcome: deleteDanglingBody.outcome,
        rowGone:
          (
            await db
              .select()
              .from(sessionFiles)
              .where(eq(sessionFiles.id, String(danglingFile.body.id)))
          ).length === 0,
      },
      recheckStillOpen: {
        status: recheckRes.status,
        outcome: recheckBody.outcome,
        stillOpen: stillOpenAnomalyAfter?.resolvedAt === null,
        rowStatus: stillDanglingRow?.status,
      },
      selfFixed: {
        status: selfFixDeleteRes.status,
        outcome: selfFixDeleteBody.outcome,
        blobSurvived: selfFixedBlobSurvived,
      },
      notFoundStatus: notFoundRes.status,
      alreadyResolvedStatus: alreadyResolvedRes.status,
      bulk: {
        status: bulkRes.status,
        resultCount: bulkBody.results.length,
        resultIds: bulkBody.results.map((r) => r.anomaly.id).sort(),
      },
    }
  }

  // --- the manifest on disk tracks the database ------------------------------
  {
    const s = await newSession()
    const one = await upload(s, 'first.log', 'alpha\nbeta\n')
    await upload(s, 'second.log', 'gamma\n')
    const withBoth = await Bun.file(attachmentsManifestPath(s)).text()
    await serviceDeleteFile(s, String(one.body.id))
    const afterDelete = await Bun.file(attachmentsManifestPath(s)).text()

    facts.manifest = {
      insideUploadsDir: attachmentsManifestPath(s).startsWith(`${sessionUploadsDir(s)}/`),
      withBoth,
      afterDelete,
      blobGoneAfterDelete: !(await exists(
        join(sessionUploadsDir(s), `${String(one.body.id)}-first.log`),
      )),
      rowSoftDeleted:
        (
          await db
            .select()
            .from(sessionFiles)
            .where(and(eq(sessionFiles.id, String(one.body.id)), isNull(sessionFiles.deletedAt)))
        ).length === 0,
    }
  }

  // --- a filename that is a traversal attempt, end to end --------------------
  {
    const s = await newSession()
    const created = await upload(s, '../../../../etc/cron.d/pwn', 'payload\n')
    const entries = await listDir(sessionUploadsDir(s))
    facts.traversalUpload = {
      status: created.status,
      originalFilename: created.body.originalFilename,
      entries: entries.filter((n) => n !== 'ATTACHMENTS.md'),
      escapedToTmp: await exists('/tmp/etc/cron.d/pwn'),
    }
  }

  // --- what optionsFor hands the SDK ----------------------------------------
  {
    const withFiles = await newSession()
    await upload(withFiles, 'brief.md', '# the brief\n')
    const withoutFiles = await newSession()

    const [session] = await db.select().from(sessions).where(eq(sessions.id, withFiles))
    const [bare] = await db.select().from(sessions).where(eq(sessions.id, withoutFiles))
    if (!session || !bare) throw new Error('no session row')

    try {
      // optionsFor shells out to git in the project's checkout, so the
      // directory has to exist before it will get as far as the attachments.
      await mkdir(projectRepo('demo'), { recursive: true })
      const optionsFor = (await import('@/features/sessions/runner-options')).optionsFor
      const withOpts = await optionsFor(session, 'demo', new AbortController())
      const withoutOpts = await optionsFor(bare, 'demo', new AbortController())
      facts.runnerOptions = {
        additionalDirectories: withOpts.additionalDirectories,
        ownUploadsDir: sessionUploadsDir(withFiles),
        otherUploadsDir: sessionUploadsDir(withoutFiles),
        deny: withOpts.settings?.permissions?.deny,
        denyWithoutFiles: withoutOpts.settings?.permissions?.deny,
        additionalDirectoriesWithoutFiles: withoutOpts.additionalDirectories,
        preToolUseMatchers: (withOpts.hooks?.PreToolUse ?? []).map((m) => m.matcher),
        attachmentsRoot: env.ATTACHMENTS_DIR,
      }
    } catch (error) {
      facts.runnerOptions = { error: error instanceof Error ? error.message : String(error) }
    }
  }

  // --- what the download route actually sets on the wire ---------------------
  {
    const s = await newSession()
    const text = await upload(s, 'notes.log', 'plain words\n')
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ])
    const png = await upload(s, 'shot.png', pngBytes, 'image/png')
    const textRes = await app.request(`/api/sessions/${s}/files/${String(text.body.id)}`)
    const pngRes = await app.request(`/api/sessions/${s}/files/${String(png.body.id)}`)
    facts.download = {
      textStatus: textRes.status,
      textContentType: textRes.headers.get('content-type'),
      textDisposition: textRes.headers.get('content-disposition'),
      textNosniff: textRes.headers.get('x-content-type-options'),
      textBody: await textRes.text(),
      pngMime: png.body.mimeType,
      pngStatus: pngRes.status,
      pngContentType: pngRes.headers.get('content-type'),
      pngDisposition: pngRes.headers.get('content-disposition'),
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
