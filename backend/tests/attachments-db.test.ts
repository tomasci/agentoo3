// Session attachments against a real Postgres and a real filesystem.
//
// The scenarios run once, in a child process (attachments-db-child.ts) with
// its own DATABASE_URL and ATTACHMENTS_DIR, against a cluster this file
// initdb's into /tmp and throws away afterwards — see pg-cluster.ts for why
// neither can be re-pointed inside the shared test process, and why faking the
// database was not an option for the reconciliation job. Nothing here can
// reach the deployment's own database or its attachments store.
//
// The child gathers facts; every assertion lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const ATTACHMENTS_DIR = `/tmp/agentoo-db-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/attachments-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        ATTACHMENTS_DIR,
        // Deliberately dead: the child never uses the queue, and this keeps a
        // stray BullMQ connection off the fake Redis the rest of the run uses.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: `/tmp/agentoo-db-test-projects-${process.pid}`,
        LOG_LEVEL: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-2000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(ATTACHMENTS_DIR, { recursive: true, force: true })
  await rm(`/tmp/agentoo-db-test-projects-${process.pid}`, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the DB-backed scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(10)
})

// --- 3: a file id from session A is unreachable from session B ---------------

dbTest('a file id from another session 404s on GET, exactly like an unknown one', () => {
  const f = fact('crossSession')
  expect(f.uploadStatus).toBe(201)
  expect(f.ownGet).toBe(200)
  expect(f.crossGet).toBe(404)
  expect(f.unknownSessionGet).toBe(404)
  expect(f.malformedSessionGet).toBe(400)
})

dbTest('a cross-session DELETE 404s and does not touch the bytes', () => {
  const f = fact('crossSession')
  expect(f.crossDelete).toBe(404)
  expect(f.blobSurvivedCrossDelete).toBe(true)
})

dbTest("another session's listing does not show the file", () => {
  expect(fact('crossSession').listBFileCount).toBe(0)
})

dbTest('the two sessions resolve to two different directories on disk', () => {
  const f = fact('crossSession')
  expect(f.ownUploadsDir).not.toBe(f.otherUploadsDir)
  expect(f.summaryA).toMatchObject({ uploadsDir: f.ownUploadsDir, fileCount: 1 })
  // Null, so runner-options grants nothing at all to a session with no files.
  expect(f.summaryB).toBeNull()
})

// --- 3 (filesystem): what the agent is actually granted ----------------------

dbTest('an agent is granted its own uploads dir and nothing else', () => {
  const f = fact('runnerOptions')
  expect(f.error).toBeUndefined()
  expect(f.additionalDirectories).toEqual([f.ownUploadsDir])
  expect(f.additionalDirectories).not.toContain(f.otherUploadsDir)
  expect(f.additionalDirectories).not.toContain(f.attachmentsRoot)
  expect(f.additionalDirectoriesWithoutFiles).toBeUndefined()
})

dbTest('Edit and Write are denied over the whole store, Read only when there is nothing to read', () => {
  const f = fact('runnerOptions')
  const root = String(f.attachmentsRoot)
  expect(f.deny).toEqual([`Edit(/${root}/**)`, `Write(/${root}/**)`])
  expect(f.denyWithoutFiles).toEqual([
    `Edit(/${root}/**)`,
    `Write(/${root}/**)`,
    `Read(/${root}/**)`,
  ])
})

dbTest('both PreToolUse matchers are registered, delegation first', () => {
  expect(fact('runnerOptions').preToolUseMatchers).toEqual([
    'Agent|Task',
    'Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit',
  ])
})

// --- 14: the allowlist is decided by content ---------------------------------

dbTest('a .log that is really a PDF is classified by its bytes', () => {
  const f = fact('sniffing') as Record<string, Record<string, unknown>>
  expect(f.pdfNamedLog).toMatchObject({ status: 201, mimeType: 'application/pdf', pageCount: 1 })
})

dbTest('a client-declared content type is ignored entirely', () => {
  const f = fact('sniffing') as Record<string, Record<string, unknown>>
  // Sent as application/octet-stream; stored as application/json.
  expect(f.jsonDeclaredOctetStream).toMatchObject({ mimeType: 'application/json' })
  expect(f.markdownNamedMd).toMatchObject({ mimeType: 'text/markdown' })
})

// FIXED: see attachments-put.test.ts for the same case at the storage layer.
// sniff.ts now rejects a promised binary extension (png/jpg/jpeg/gif/webp/pdf)
// whose content does not match it, so a shell script named screenshot.png is
// a 400, not a 201 stored as text/plain.
dbTest('a .png that is really a shell script is rejected by the API', () => {
  expect((fact('sniffing') as Record<string, Record<string, unknown>>).scriptNamedPng).toMatchObject(
    { status: 400 },
  )
})

// --- dedup ---------------------------------------------------------------------

dbTest('re-attaching identical bytes in one session returns the existing row', () => {
  const f = fact('dedup')
  expect(f.sameIdWithinSession).toBe(true)
  expect(f.rowsInA).toBe(1)
  expect(f.blobsInA).toBe(1)
})

dbTest('identical bytes in two sessions are two files, with no shared inode', () => {
  const f = fact('dedup')
  expect(f.sameChecksum).toBe(true)
  expect(f.differentIdAcrossSessions).toBe(true)
  expect(f.sameInode).toBe(false)
  expect(f.nlinkA).toBe(1)
  expect(f.nlinkB).toBe(1)
})

dbTest("a deleted file's checksum can be re-attached later", () => {
  expect(fact('dedupAfterDelete')).toMatchObject({ status: 201, newId: true, liveRows: 1 })
})

// --- 6: quotas -----------------------------------------------------------------

dbTest('an upload over the session byte limit is rejected with nothing left behind', () => {
  const f = fact('quota')
  expect(f.hintedStatus).toBe(400)
  expect(f.hintedError).toContain('1500-byte limit')
  expect(f.hintedLeftNothing).toBe(true)
  expect(f.hintedLeftNoTmp).toBe(true)
})

dbTest('a client that reports no size at all is still caught, and still leaves nothing', () => {
  const f = fact('quota')
  expect(f.unhintedError).toContain('1500-byte limit')
  expect(f.unhintedLeftNothing).toBe(true)
})

dbTest('the deployment-wide byte limit is enforced too', () => {
  const f = fact('quota')
  expect(f.totalError).toContain('total attachment storage limit')
  expect(f.totalLeftNothing).toBe(true)
})

dbTest('the per-session file count limit is refused before anything is written', () => {
  const f = fact('quota')
  expect(f.countStatus).toBe(400)
  expect(f.countError).toContain('its limit (1)')
  expect(f.liveRows).toBe(1)
})

// --- 5: an interrupted upload --------------------------------------------------

dbTest('an upload that dies mid-stream leaves no partial file and no row', () => {
  const f = fact('interruptedUpload')
  expect(f.message).toBe('socket hang up')
  expect(f.tmpLeft).toBe(0)
  expect(f.entries).toEqual(expect.arrayContaining(['ATTACHMENTS.md']))
  expect((f.entries as string[]).some((n) => n.includes('doomed'))).toBe(false)
  expect(f.rows).toBe(1)
})

// --- 4: deleting a session ------------------------------------------------------

dbTest('deleting a session removes its rows and every byte on disk', () => {
  const f = fact('deleteSession')
  expect(f.dirExistedBefore).toBe(true)
  expect(f.dirExistsAfter).toBe(false)
  expect(f.fileRowsAfter).toBe(0)
  expect(f.sessionRowsAfter).toBe(0)
})

dbTest('deleting a session whose directory is already gone still succeeds', () => {
  const f = fact('deleteSession')
  expect(f.secondDeleteError).toBe('')
  expect(f.neverUploadedError).toBe('')
})

// --- 11: a message pointing at a file whose row was cleaned up -----------------

dbTest('the messages API still answers after a referenced file row is hard-deleted', () => {
  const f = fact('orphanedMessageLink')
  expect(f.messagesStatus).toBe(200)
  expect(f.messageRows).toBe(1)
})

dbTest('the link row survives the hard delete, so the message can still name the file', () => {
  const f = fact('orphanedMessageLink')
  // fileId is ON DELETE SET NULL, not cascade — see db/schema.ts's
  // message_files — precisely so this row is not gone too.
  expect(f.linkRows).toBe(1)
})

dbTest('the message renders a removed-file placeholder instead of silently showing nothing', () => {
  const f = fact('orphanedMessageLink')
  expect(f.files).toEqual([
    { id: null, originalFilename: 'attached.log', mimeType: null, sizeBytes: null, status: null },
  ])
})

// --- 8: each inconsistency class, produced deliberately ------------------------

dbTest('all four classes are produced and classified correctly', () => {
  const f = fact('gcCheck')
  expect(f.firstClassified).toEqual({
    orphan_blob: 2,
    dangling_row: 1,
    orphan_session_dir: 1,
    checksum_mismatch: 1,
  })
  expect(f.openAfterFirst).toEqual([
    'checksum_mismatch',
    'dangling_row',
    'orphan_blob',
    'orphan_session_dir',
  ])
  expect(f.detailsAfterFirst).toEqual(
    expect.arrayContaining([
      'Row exists in session_files; no blob found on disk',
      'No session_files row for this id',
      expect.stringContaining('db: 22 bytes'),
      expect.stringContaining('No session row for'),
    ]),
  )
})

dbTest('a dangling row is marked missing and dropped from the manifest', () => {
  const f = fact('gcCheck')
  expect(f.firstDanglingMarkedMissing).toBe(1)
  expect(f.danglingRowStatus).toBe('missing')
  expect(f.manifestMentionsMissingFile).toBe(false)
})

dbTest('an orphan blob inside the grace window is reported, not deleted', () => {
  const f = fact('gcCheck')
  expect(f.youngOrphanStillThere).toBe(true)
  expect(f.agedOrphanDeleted).toBe(true)
  expect(f.firstOrphanBlobsDeleted).toBe(1)
})

dbTest('an in-flight .tmp-* upload is never swept', () => {
  expect(fact('gcCheck').tmpUntouched).toBe(true)
})

dbTest('a session with intact files is untouched by the check', () => {
  expect(fact('gcCheck').intactBlobCount).toBe(2)
})

// --- 9: the scheduled job is idempotent ---------------------------------------

dbTest('a second run in a row changes nothing', () => {
  const f = fact('gcCheck')
  expect(f.secondOrphanBlobsDeleted).toBe(0)
  expect(f.secondDanglingMarkedMissing).toBe(0)
  expect(f.secondResolvedAutomatically).toBe(0)
  expect(f.sameAnomalyIds).toBe(true)
  expect(f.openAfterSecond).toEqual(f.openAfterFirst)
  // One fewer orphan blob to classify: the aged one was deleted by run 1.
  expect(f.secondClassified).toEqual({
    orphan_blob: 1,
    dangling_row: 1,
    orphan_session_dir: 1,
    checksum_mismatch: 1,
  })
})

// --- 10: after cleanup ---------------------------------------------------------

dbTest('cleanup resolves all four classes, checksum_mismatch included', () => {
  const f = fact('gcCleanup')
  expect(f.cleanup).toEqual({
    // One: the aged orphan was already swept by the automatic path in the
    // first check, leaving only the one still inside the grace window.
    orphanBlobsDeleted: 1,
    danglingRowsDeleted: 1,
    orphanSessionDirsDeleted: 1,
    // DECIDED: the spec's own text conflicted — cleanup's description never
    // mentioned checksum_mismatch, but acceptance criterion 10 asks for zero
    // outstanding anomalies after a re-run. Resolved in favour of the
    // criterion: a mismatch means the bytes on disk cannot be trusted to be
    // what the row claims, so cleanup treats it as unusable data and deletes
    // both, same as any other class it can act on unattended. See
    // reconcile.ts's remediateAnomaly for the reasoning at the call site.
    checksumMismatchesDeleted: 1,
    skippedRevalidated: 0,
    failures: [],
  })
  expect(f.ghostDirGone).toBe(true)
  expect(f.danglingRowDeleted).toBe(true)
})

dbTest('cleanup leaves a session with intact files alone', () => {
  const f = fact('gcCleanup')
  expect(f.intactBlobCount).toBe(2)
  expect(f.intactRows).toBe(1)
})

dbTest('a re-run after cleanup reports zero outstanding anomalies', () => {
  expect(fact('gcCleanup').openAfterCleanup).toEqual([])
})

dbTest('a re-run after cleanup classifies nothing at all, of any class', () => {
  const f = fact('gcCleanup')
  expect(f.thirdClassified).toEqual({
    orphan_blob: 0,
    dangling_row: 0,
    orphan_session_dir: 0,
    checksum_mismatch: 0,
  })
})

// FIXED: runCleanup used to act on what the *previous* check classified with
// no re-verification. A blob renamed into place moments before its row
// commits was reported as an orphan_blob (correctly, and correctly not
// deleted automatically, because it is inside ATTACHMENTS_GC_GRACE_MS) — but
// if the row landed before someone clicked "clean up", cleanup deleted the
// blob anyway, destroying a live attachment and turning its row into a
// dangling_row. Cleanup now re-verifies each entry immediately before acting
// (reconcile.ts's stillAnAnomaly): this one no longer holds by the time
// cleanup runs, so it is skipped and marked resolved rather than deleted.
dbTest('cleanup never deletes a blob that has a row by the time it runs', () => {
  const f = fact('staleCleanup')
  expect(f.checkSawOrphan).toBe(true)
  expect(f.checkDeletedIt).toBe(0)
  expect(f.blobSurvivedCleanup).toBe(true)
  expect(f.rowStillThere).toBe(true)
  expect((f.classifiedAfter as Record<string, number>).dangling_row).toBe(0)
})

dbTest('that revalidation is reported separately from a real removal', () => {
  const f = fact('staleCleanup')
  expect(f.skippedRevalidated).toBe(1)
})

// --- Gap B: per-row and bulk-by-id remediation endpoints ----------------------

dbTest('deleting an orphan_blob by id removes the blob and resolves the anomaly', () => {
  const f = fact('remediation') as Record<string, Record<string, unknown>>
  expect(f.orphanBlobDelete).toMatchObject({ status: 200, outcome: 'deleted', blobGone: true })
})

dbTest('deleting a dangling_row by id removes the row and resolves the anomaly', () => {
  const f = fact('remediation') as Record<string, Record<string, unknown>>
  expect(f.danglingRowDelete).toMatchObject({ status: 200, outcome: 'deleted', rowGone: true })
})

dbTest('rechecking a still-valid anomaly leaves it open and deletes nothing', () => {
  const f = fact('remediation') as Record<string, Record<string, unknown>>
  expect(f.recheckStillOpen).toMatchObject({
    status: 200,
    outcome: 'unchanged',
    stillOpen: true,
    rowStatus: 'missing',
  })
})

dbTest('deleting an anomaly that already fixed itself revalidates instead of destroying it', () => {
  // Same re-verification Defect 2 fixed in runCleanup, exercised here through
  // the per-row /delete endpoint instead: a row landed for this orphan blob
  // before anyone acted on the anomaly, so the delete must not touch it.
  const f = fact('remediation') as Record<string, Record<string, unknown>>
  expect(f.selfFixed).toMatchObject({ status: 200, outcome: 'revalidated', blobSurvived: true })
})

dbTest('an unknown anomaly id 404s; an already-resolved one 409s', () => {
  const f = fact('remediation') as Record<string, unknown>
  expect(f.notFoundStatus).toBe(404)
  expect(f.alreadyResolvedStatus).toBe(409)
})

dbTest('bulk-delete acts on exactly the open ids given, silently skipping the rest', () => {
  const f = fact('remediation') as Record<string, Record<string, unknown>>
  const bulk = f.bulk as Record<string, unknown>
  expect(bulk.status).toBe(200)
  // Only the one still-open id in the list comes back; the already-resolved
  // and the never-existed ids are silently absent, not failures.
  expect(bulk.resultCount).toBe(1)
})

// --- the manifest tracks the database ------------------------------------------

dbTest('ATTACHMENTS.md lists every ready file, and drops one that is deleted', () => {
  const f = fact('manifest')
  expect(f.insideUploadsDir).toBe(true)
  expect(f.withBoth).toContain('| first.log | text/plain | 11 B | 2 lines |')
  expect(f.withBoth).toContain('| second.log | text/plain | 6 B | 1 line |')
  expect(f.afterDelete).not.toContain('first.log')
  expect(f.afterDelete).toContain('second.log')
  expect(f.blobGoneAfterDelete).toBe(true)
  expect(f.rowSoftDeleted).toBe(true)
})

// --- 7: a traversing filename, end to end --------------------------------------

dbTest('a traversing filename is stored flattened, and nothing lands outside', () => {
  const f = fact('traversalUpload')
  expect(f.status).toBe(201)
  // The name the human typed survives in the database, untouched...
  expect(f.originalFilename).toBe('../../../../etc/cron.d/pwn')
  // ...and never on disk.
  expect(f.entries).toHaveLength(1)
  expect((f.entries as string[])[0]).toMatch(/^[0-9a-f-]{36}-_\.\._\.\._\.\._etc_cron\.d_pwn$/)
  expect(f.escapedToTmp).toBe(false)
})

// --- the download route ----------------------------------------------------------

dbTest('a non-image is served as an octet-stream attachment, with nosniff', () => {
  const f = fact('download')
  expect(f.textStatus).toBe(200)
  expect(f.textContentType).toBe('application/octet-stream')
  expect(f.textDisposition).toBe('attachment; filename="notes.log"')
  expect(f.textNosniff).toBe('nosniff')
  expect(f.textBody).toBe('plain words\n')
})

dbTest('an image is served inline with its sniffed type', () => {
  const f = fact('download')
  expect(f.pngMime).toBe('image/png')
  expect(f.pngContentType).toBe('image/png')
  expect(f.pngDisposition).toBeNull()
})
