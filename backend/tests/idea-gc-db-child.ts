// The attachments GC and reconciler against the *ideas* storage root, on a
// real Postgres and a real filesystem — the half of runCheck/runCleanup/
// stillAnAnomaly that attachments-db-child.ts never reaches.
//
// A separate child from both attachments-db-child.ts (which seeds only
// session-rooted anomalies, and asserts the three idea counters stay at zero
// precisely because it never touches that root) and idea-files-db-child.ts
// (which covers upload, caps, permissions and the handoff, and never calls
// the GC at all). Extending either would have destroyed the thing each one
// proves: the first's "zero idea anomalies" assertions, and the second's
// tree, which the GC would then be walking mid-scenario.
//
// Same contract as its siblings: this child gathers facts, every assertion
// lives in the parent (idea-gc.test.ts).

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, isNull } from 'drizzle-orm'
import { createApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { ideaFiles, ideas, projects, sessionFiles, sessions, storageAnomalies } from '@/db/schema'
import { env } from '@/env'
import { runAttachmentsGc } from '@/features/attachments/gc'
import { putIdeaFile } from '@/features/attachments/storage'
import { uploadIdeaFile } from '@/features/ideas/files'
import { uploadFile } from '@/features/attachments/service'
import { ideaAttachmentsDir, ideaUploadsDir, sessionUploadsDir } from '@/lib/paths'

const app = createApp()
const facts: Record<string, unknown> = {}
const PROJECT_ID = randomUUID()

const streamOf = (body: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })

async function newIdea(title = 'idea'): Promise<string> {
  const [row] = await db
    .insert(ideas)
    .values({ projectId: PROJECT_ID, title, boardPosition: 0 })
    .returning()
  if (!row) throw new Error('no idea row')
  return row.id
}

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId: PROJECT_ID, status: 'idle' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

const listDir = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()
const exists = async (path: string) => Boolean(await stat(path).catch(() => undefined))

const openAnomalies = () =>
  db.select().from(storageAnomalies).where(isNull(storageAnomalies.resolvedAt))

const ideaRows = (ideaId: string) =>
  db.select().from(ideaFiles).where(eq(ideaFiles.ideaId, ideaId))

/** The blob an upload actually wrote, by the naming rule storage.ts enforces. */
const ideaBlobPath = (ideaId: string, fileId: string, filename: string) =>
  join(ideaUploadsDir(ideaId), `${fileId}-${filename}`)

async function main() {
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: 'demo', slug: 'demo', source: 'empty', status: 'ready' })

  // --- every idea-rooted anomaly class, by hand, alongside a session one -----
  //
  // The session-rooted anomaly is not decoration: runCheck's stale sweep is
  // unconditional over the whole storage_anomalies table, so if the two roots
  // were ever walked as two passes each would silently resolve the other's
  // genuine findings. One check has to leave both open.
  {
    // (control) an intact idea nothing is done to — the two-root walk must
    // not molest a healthy idea.
    const intact = await newIdea('intact')
    const intactFile = await uploadIdeaFile(
      intact,
      'keep.log',
      streamOf('do not touch me\n'),
      undefined,
      16,
    )
    const intactPath = ideaBlobPath(intact, intactFile.id, 'keep.log')

    // (a) idea_dangling_row: upload, then rm the blob behind the app's back.
    const dangling = await newIdea('dangling')
    const danglingFile = await uploadIdeaFile(
      dangling,
      'gone.log',
      streamOf('about to vanish\n'),
      undefined,
      17,
    )
    await rm(ideaBlobPath(dangling, danglingFile.id, 'gone.log'))

    // (b) orphan_blob on the IDEAS root, twice over — one backdated past the
    //     grace window, one young — plus a .tmp-* that must be ignored either
    //     way. This is the one class shared unchanged across both roots.
    const orphan = await newIdea('orphans')
    const young = await uploadIdeaFile(
      orphan,
      'young.log',
      streamOf('written a moment ago\n'),
      undefined,
      22,
    )
    const old = await uploadIdeaFile(
      orphan,
      'old.log',
      streamOf('written yesterday\n'),
      undefined,
      19,
    )
    await db.delete(ideaFiles).where(eq(ideaFiles.id, young.id))
    await db.delete(ideaFiles).where(eq(ideaFiles.id, old.id))
    const youngPath = ideaBlobPath(orphan, young.id, 'young.log')
    const oldPath = ideaBlobPath(orphan, old.id, 'old.log')
    const backdated = new Date(Date.now() - env.ATTACHMENTS_GC_GRACE_MS - 60_000)
    await utimes(oldPath, backdated, backdated)
    const tmpPath = join(ideaUploadsDir(orphan), `.tmp-${randomUUID()}`)
    await writeFile(tmpPath, 'still uploading')
    await utimes(tmpPath, backdated, backdated)

    // (c) orphan_idea_dir: a directory under the ideas shard tree for an idea
    //     id with no row.
    const ghostIdea = randomUUID()
    await mkdir(ideaUploadsDir(ghostIdea), { recursive: true })
    await writeFile(
      join(ideaUploadsDir(ghostIdea), `${randomUUID()}-ghost.log`),
      'nobody owns me\n',
    )

    // (d) idea_checksum_mismatch: overwrite the blob's bytes behind the app's
    //     back.
    const mismatch = await newIdea('mismatch')
    const corrupted = await uploadIdeaFile(
      mismatch,
      'truncated.log',
      streamOf('the original contents\n'),
      undefined,
      22,
    )
    const corruptedPath = ideaBlobPath(mismatch, corrupted.id, 'truncated.log')
    await writeFile(corruptedPath, 'cut')

    // (e) a SESSION-rooted anomaly, open at the same time as the four above.
    const sessionWithDangling = await newSession()
    const sessionFile = await uploadFile(
      sessionWithDangling,
      'session-gone.log',
      streamOf('the session half\n'),
      undefined,
      18,
    )
    await rm(join(sessionUploadsDir(sessionWithDangling), `${sessionFile.id}-session-gone.log`))

    // --- one check, over both roots -----------------------------------------
    const first = await runAttachmentsGc({ reason: 'manual' })
    const afterFirst = await openAnomalies()
    const firstIds = JSON.stringify(afterFirst.map((a) => a.id).sort())
    const [danglingRowAfterFirst] = await db
      .select()
      .from(ideaFiles)
      .where(eq(ideaFiles.id, danglingFile.id))

    const openClassesOf = (rows: typeof afterFirst, ownerId: string) =>
      rows.filter((a) => a.sessionId === ownerId).map((a) => a.class).sort()

    facts.singlePass = {
      // Both roots' findings survive the one pass's single stale sweep.
      sessionAnomalyOpenAfterOneCheck: openClassesOf(afterFirst, sessionWithDangling),
      ideaAnomalyOpenAfterOneCheck: openClassesOf(afterFirst, dangling),
      firstResolvedAutomatically: first.resolvedAutomatically,
    }

    facts.ideaCheck = {
      firstClassified: first.classified,
      firstOrphanBlobsDeleted: first.orphanBlobsDeleted,
      firstDanglingMarkedMissing: first.danglingRowsMarkedMissing,
      ideaDanglingRowStatus: danglingRowAfterFirst?.status,
      youngOrphanStillThere: await exists(youngPath),
      agedOrphanDeleted: !(await exists(oldPath)),
      tmpUntouched: await exists(tmpPath),
      openAfterFirst: afterFirst.map((a) => a.class).sort(),
      detailsAfterFirst: afterFirst.map((a) => a.detail).sort(),
      // The anomaly rows for the idea root carry the IDEA id in sessionId.
      orphanIdeaDirAnomaly: afterFirst
        .filter((a) => a.class === 'orphan_idea_dir')
        .map((a) => ({ ownerId: a.sessionId, pathIsIdeaRoot: a.path?.includes('/ideas/') })),
      ideaOrphanBlobPathsUnderIdeasRoot: afterFirst
        .filter((a) => a.class === 'orphan_blob')
        .every((a) => a.path?.includes('/ideas/')),
      // The control idea, after a full two-root walk.
      intactBlobCount: (await listDir(ideaUploadsDir(intact))).length,
      intactBytes: await Bun.file(intactPath).text(),
      intactRowStatus: (await ideaRows(intact))[0]?.status,
      intactHasNoAnomaly: afterFirst.every((a) => a.sessionId !== intact),
    }

    // --- a second check changes nothing --------------------------------------
    const second = await runAttachmentsGc({ reason: 'scheduled' })
    const afterSecond = await openAnomalies()

    facts.ideaSecondCheck = {
      secondClassified: second.classified,
      secondOrphanBlobsDeleted: second.orphanBlobsDeleted,
      secondDanglingMarkedMissing: second.danglingRowsMarkedMissing,
      secondResolvedAutomatically: second.resolvedAutomatically,
      sameAnomalyIds: JSON.stringify(afterSecond.map((a) => a.id).sort()) === firstIds,
      openAfterSecond: afterSecond.map((a) => a.class).sort(),
      sessionAnomalyStillOpen: openClassesOf(afterSecond, sessionWithDangling),
      ideaAnomalyStillOpen: openClassesOf(afterSecond, dangling),
    }

    // --- cleanup, then a third check -----------------------------------------
    const cleanup = await runAttachmentsGc({ reason: 'cleanup' })
    const third = await runAttachmentsGc({ reason: 'manual' })
    const afterCleanup = await openAnomalies()

    facts.ideaCleanup = {
      cleanup: cleanup.cleanup,
      ghostIdeaDirGone: !(await exists(ideaAttachmentsDir(ghostIdea))),
      ideaDanglingRowDeleted: (await ideaRows(dangling)).length === 0,
      mismatchRowDeleted: (await ideaRows(mismatch)).length === 0,
      mismatchBlobDeleted: !(await exists(corruptedPath)),
      youngOrphanDeleted: !(await exists(youngPath)),
      tmpStillUntouched: await exists(tmpPath),
      sessionRowDeleted:
        (await db.select().from(sessionFiles).where(eq(sessionFiles.id, sessionFile.id))).length ===
        0,
      thirdClassified: third.classified,
      openAfterCleanup: afterCleanup.map((a) => a.class).sort(),
      // The control idea, after a check, a check, a cleanup and a check.
      intactBlobCount: (await listDir(ideaUploadsDir(intact))).length,
      intactBytes: await Bun.file(intactPath).text(),
      intactRows: (await ideaRows(intact)).length,
      intactRowStatus: (await ideaRows(intact))[0]?.status,
    }
  }

  // --- stillAnAnomaly's orphan_blob branch has to miss in BOTH tables --------
  //
  // The one line-level change with no coverage anywhere: an orphan blob whose
  // fileId has a live row in idea_files specifically. Querying only
  // session_files would keep reporting a perfectly live idea asset as
  // orphaned, and cleanup would then delete it.
  {
    const idea = await newIdea('revalidates')
    // Storage-level: bytes on disk, deliberately no idea_files row yet —
    // exactly the rename-then-commit race ATTACHMENTS_GC_GRACE_MS exists for.
    const stored = await putIdeaFile(idea, 'racing.log', streamOf('committed a moment later\n'))
    const check = await runAttachmentsGc({ reason: 'manual' })
    const seenAsOrphan = (await openAnomalies()).some(
      (a) => a.class === 'orphan_blob' && a.fileId === stored.fileId,
    )

    // The row lands between the check and the cleanup — in idea_files, which
    // is the whole point.
    await db.insert(ideaFiles).values({
      id: stored.fileId,
      ideaId: idea,
      originalFilename: stored.originalFilename,
      storedName: stored.storedName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
    })

    const cleanup = await runAttachmentsGc({ reason: 'cleanup' })
    const after = await runAttachmentsGc({ reason: 'manual' })

    facts.ideaOrphanRevalidated = {
      checkSawOrphan: seenAsOrphan,
      checkDeletedIt: check.orphanBlobsDeleted,
      blobSurvivedCleanup: await exists(join(ideaUploadsDir(idea), stored.storedName)),
      rowStillThere: (await ideaRows(idea)).length === 1,
      skippedRevalidated: cleanup.cleanup?.skippedRevalidated,
      cleanupDeletedNothing: cleanup.cleanup?.orphanBlobsDeleted,
      classifiedAfter: after.classified,
    }
  }

  // --- the same dual-table lookup, through the per-row HTTP endpoint ---------
  {
    const idea = await newIdea('revalidates-http')
    const stored = await putIdeaFile(idea, 'racing-http.log', streamOf('a row is coming\n'))
    await runAttachmentsGc({ reason: 'manual' })
    const anomaly = (await openAnomalies()).find(
      (a) => a.class === 'orphan_blob' && a.fileId === stored.fileId,
    )
    if (!anomaly) throw new Error('expected an orphan_blob anomaly on the ideas root')
    await db.insert(ideaFiles).values({
      id: stored.fileId,
      ideaId: idea,
      originalFilename: stored.originalFilename,
      storedName: stored.storedName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
    })
    const res = await app.request(`/api/storage/anomalies/${anomaly.id}/delete`, { method: 'POST' })
    const body = (await res.json()) as Record<string, unknown>

    facts.ideaOrphanRevalidatedOverHttp = {
      status: res.status,
      outcome: body.outcome,
      blobSurvived: await exists(join(ideaUploadsDir(idea), stored.storedName)),
      rowSurvived: (await ideaRows(idea)).length === 1,
    }
  }

  // --- an idea-rooted anomaly through /recheck and through /delete ----------
  {
    // (a) recheck, on an idea_dangling_row that still holds: never deletes.
    const idea = await newIdea('http-recheck')
    const file = await uploadIdeaFile(idea, 'row-only.log', streamOf('no blob\n'), undefined, 8)
    await rm(ideaBlobPath(idea, file.id, 'row-only.log'))
    await runAttachmentsGc({ reason: 'manual' })
    const dangling = (await openAnomalies()).find(
      (a) => a.class === 'idea_dangling_row' && a.sessionId === idea,
    )
    if (!dangling) throw new Error('expected an idea_dangling_row anomaly')
    const recheckRes = await app.request(`/api/storage/anomalies/${dangling.id}/recheck`, {
      method: 'POST',
    })
    const recheckBody = (await recheckRes.json()) as Record<string, unknown>
    const [rowAfterRecheck] = await ideaRows(idea)
    const [anomalyAfterRecheck] = await db
      .select()
      .from(storageAnomalies)
      .where(eq(storageAnomalies.id, dangling.id))

    // (b) delete, on an idea_checksum_mismatch: removes blob and row both.
    const corruptIdea = await newIdea('http-delete')
    const corrupt = await uploadIdeaFile(
      corruptIdea,
      'corrupt.log',
      streamOf('the original contents\n'),
      undefined,
      22,
    )
    const corruptPath = ideaBlobPath(corruptIdea, corrupt.id, 'corrupt.log')
    await writeFile(corruptPath, 'tampered')
    await runAttachmentsGc({ reason: 'manual' })
    const mismatch = (await openAnomalies()).find(
      (a) => a.class === 'idea_checksum_mismatch' && a.sessionId === corruptIdea,
    )
    if (!mismatch) throw new Error('expected an idea_checksum_mismatch anomaly')
    const deleteRes = await app.request(`/api/storage/anomalies/${mismatch.id}/delete`, {
      method: 'POST',
    })
    const deleteBody = (await deleteRes.json()) as Record<string, unknown>
    const [mismatchAnomalyAfter] = await db
      .select()
      .from(storageAnomalies)
      .where(eq(storageAnomalies.id, mismatch.id))

    // (c) an orphan_idea_dir through bulk-delete, alongside an id that no
    //     longer needs acting on.
    const ghost = randomUUID()
    await mkdir(ideaUploadsDir(ghost), { recursive: true })
    await writeFile(join(ideaUploadsDir(ghost), `${randomUUID()}-ghost.log`), 'nobody owns me\n')
    await runAttachmentsGc({ reason: 'manual' })
    const ghostAnomaly = (await openAnomalies()).find(
      (a) => a.class === 'orphan_idea_dir' && a.sessionId === ghost,
    )
    if (!ghostAnomaly) throw new Error('expected an orphan_idea_dir anomaly')
    const bulkRes = await app.request('/api/storage/anomalies/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [ghostAnomaly.id, mismatch.id, randomUUID()] }),
    })
    const bulkBody = (await bulkRes.json()) as {
      results: { anomaly: { id: string }; outcome: string }[]
    }

    facts.ideaHttpRemediation = {
      recheck: {
        status: recheckRes.status,
        outcome: recheckBody.outcome,
        stillOpen: anomalyAfterRecheck?.resolvedAt === null,
        rowStatus: rowAfterRecheck?.status,
        rowStillThere: Boolean(rowAfterRecheck),
      },
      deleteMismatch: {
        status: deleteRes.status,
        outcome: deleteBody.outcome,
        blobGone: !(await exists(corruptPath)),
        rowGone: (await ideaRows(corruptIdea)).length === 0,
        anomalyResolved: mismatchAnomalyAfter?.resolvedAt !== null,
      },
      bulkGhostDir: {
        status: bulkRes.status,
        resultCount: bulkBody.results.length,
        outcomes: bulkBody.results.map((r) => r.outcome),
        ghostDirGone: !(await exists(ideaAttachmentsDir(ghost))),
      },
    }
  }

  // --- two orphan blobs sharing one file id across the two roots -------------
  //
  // storage_anomalies carries a unique (class, path) AND a unique
  // (class, file_id); upsertAnomaly arbitrates orphan_blob on (class, path)
  // alone. db/schema.ts's own comment argues the second index is harmless
  // because "the classes that leave the other column NULL never spuriously
  // conflict" — but gc.ts sets `fileId: blob.fileId ?? null`, which is
  // non-null for every blob whose on-disk name carries a uuid prefix, i.e.
  // the normal case. Two such blobs under different paths therefore satisfy
  // the arbiter index and violate the other one.
  //
  // Last in this file and isolated, because the failure mode under test is
  // an exception escaping runCheck: everything after it in the same pass —
  // the stale sweep, the retention purge, the report itself — never runs.
  {
    const idea = await newIdea('twin-ids')
    const session = await newSession()
    const stored = await putIdeaFile(idea, 'twin.log', streamOf('idea copy\n'))
    // The same <file-uuid>-<name> basename, planted on the other root. The
    // app's own writer cannot mint this (copyIdeaFileIntoSession takes a
    // fresh uuid); a restored backup or a hand-copied tree can.
    await mkdir(sessionUploadsDir(session), { recursive: true })
    await writeFile(join(sessionUploadsDir(session), stored.storedName), 'session copy\n')
    const ideaPath = join(ideaUploadsDir(idea), stored.storedName)
    const sessionPath = join(sessionUploadsDir(session), stored.storedName)

    let threw = ''
    let constraint = ''
    let orphanBlobClassified: number | undefined
    try {
      const report = await runAttachmentsGc({ reason: 'manual' })
      orphanBlobClassified = report.classified.orphan_blob
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
      // postgres.js hangs the server's own error fields off the cause.
      const cause = (error as { cause?: Record<string, unknown> }).cause
      constraint = String(cause?.constraint_name ?? cause?.detail ?? '')
    }
    const all = await db.select().from(storageAnomalies)
    facts.sameFileIdBothRoots = {
      threw: threw.split('\n')[0] ?? '',
      constraint,
      orphanBlobClassified,
      // Which of the two the pass got as far as recording: sessions is walked
      // first, so the session half lands and the ideas half is what throws.
      sessionTwinRecorded: all.some((a) => a.path === sessionPath),
      ideaTwinRecorded: all.some((a) => a.path === ideaPath),
      ideaBlobStillThere: await exists(ideaPath),
      sessionBlobStillThere: await exists(sessionPath),
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
