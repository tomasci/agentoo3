// The attachments GC against the ideas storage root, on a real Postgres and a
// real filesystem.
//
// attachments-db.test.ts proves runCheck/runCleanup/stillAnAnomaly against the
// *sessions* root, and asserts the three idea counters stay at zero precisely
// because nothing there ever touches the second root. idea-files.test.ts
// proves upload, caps, permissions and the handoff, and never calls the GC.
// This file is the other half: each idea-rooted anomaly class produced by
// hand, a control idea left alone, the single-pass invariant that keeps one
// root's stale sweep from resolving the other root's genuine findings, and
// the dual-table lookup in stillAnAnomaly's orphan_blob branch.
//
// Same mechanism as attachments-db.test.ts and idea-files.test.ts: the
// scenarios run once, in a child process (idea-gc-db-child.ts) with its own
// DATABASE_URL and ATTACHMENTS_DIR, against a cluster this file initdb's into
// /tmp and throws away afterwards. Nothing here can reach the deployment's own
// database or its attachments store. The child gathers facts; every assertion
// lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const ATTACHMENTS_DIR = `/tmp/agentoo-idea-gc-attachments-${process.pid}`
const PROJECTS_DIR = `/tmp/agentoo-idea-gc-projects-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-gc-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        ATTACHMENTS_DIR,
        // Deliberately dead: the child never uses the queue, and this keeps a
        // stray BullMQ connection off the fake Redis the rest of the run uses.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR,
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
  await rm(PROJECTS_DIR, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the ideas-root scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the ideas-root GC scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'ideaCheck',
    'ideaCleanup',
    'ideaHttpRemediation',
    'ideaOrphanRevalidated',
    'ideaOrphanRevalidatedOverHttp',
    'ideaSecondCheck',
    'sameFileIdBothRoots',
    'singlePass',
  ])
})

// --- the single-pass hazard ---------------------------------------------------
//
// runCheck's stale sweep is `WHERE resolved_at IS NULL AND last_seen_at <
// runStartedAt`, unconditional over the whole table. If the two roots were
// ever walked as two passes — two runs, two runStartedAt values — each would
// resolve every open anomaly belonging to the root it had not walked. One
// check has to leave both roots' findings open; so does a second.

dbTest('one check leaves both a session-rooted and an idea-rooted anomaly open', () => {
  const f = fact('singlePass')
  expect(f.sessionAnomalyOpenAfterOneCheck).toEqual(['dangling_row'])
  expect(f.ideaAnomalyOpenAfterOneCheck).toEqual(['idea_dangling_row'])
  // Nothing was swept: the one sweep ran after both roots, not between them.
  expect(f.firstResolvedAutomatically).toBe(0)
})

dbTest('a second check re-confirms both roots rather than resolving either', () => {
  const f = fact('ideaSecondCheck')
  expect(f.sessionAnomalyStillOpen).toEqual(['dangling_row'])
  expect(f.ideaAnomalyStillOpen).toEqual(['idea_dangling_row'])
  expect(f.secondResolvedAutomatically).toBe(0)
})

// --- each idea-rooted class, produced by hand ---------------------------------

dbTest('every idea-rooted class is produced and classified, alongside a session one', () => {
  const f = fact('ideaCheck')
  expect(f.firstClassified).toEqual({
    // Both roots feed this one class — two here, both on the ideas root.
    orphan_blob: 2,
    dangling_row: 1,
    orphan_session_dir: 0,
    checksum_mismatch: 0,
    orphan_idea_dir: 1,
    idea_dangling_row: 1,
    idea_checksum_mismatch: 1,
  })
  expect(f.openAfterFirst).toEqual([
    'dangling_row',
    'idea_checksum_mismatch',
    'idea_dangling_row',
    'orphan_blob',
    'orphan_idea_dir',
  ])
  expect(f.detailsAfterFirst).toEqual(
    expect.arrayContaining([
      'No idea_files row for this id',
      'Row exists in idea_files; no blob found on disk',
      'Row exists in session_files; no blob found on disk',
      expect.stringContaining('db: 22 bytes'),
      expect.stringContaining('No idea row for'),
    ]),
  )
})

dbTest('an idea_dangling_row is marked missing on its idea_files row', () => {
  const f = fact('ideaCheck')
  expect(f.ideaDanglingRowStatus).toBe('missing')
  // One session row and one idea row, counted together by the same field.
  expect(f.firstDanglingMarkedMissing).toBe(2)
})

dbTest('an orphan blob on the ideas root obeys the same grace window as one on sessions', () => {
  const f = fact('ideaCheck')
  expect(f.youngOrphanStillThere).toBe(true)
  expect(f.agedOrphanDeleted).toBe(true)
  expect(f.firstOrphanBlobsDeleted).toBe(1)
})

dbTest('an in-flight .tmp-* on the ideas root is never swept', () => {
  expect(fact('ideaCheck').tmpUntouched).toBe(true)
})

dbTest('idea-rooted anomalies carry the idea id and a path under the ideas root', () => {
  const f = fact('ideaCheck')
  expect(f.orphanIdeaDirAnomaly).toEqual([{ ownerId: expect.any(String), pathIsIdeaRoot: true }])
  expect(f.ideaOrphanBlobPathsUnderIdeasRoot).toBe(true)
})

// --- the control --------------------------------------------------------------

dbTest('the two-root walk does not molest a healthy idea', () => {
  const f = fact('ideaCheck')
  expect(f.intactBlobCount).toBe(1)
  expect(f.intactBytes).toBe('do not touch me\n')
  expect(f.intactRowStatus).toBe('ready')
  expect(f.intactHasNoAnomaly).toBe(true)
})

dbTest('the healthy idea is still intact after two checks, a cleanup and a third check', () => {
  const f = fact('ideaCleanup')
  expect(f.intactBlobCount).toBe(1)
  expect(f.intactBytes).toBe('do not touch me\n')
  expect(f.intactRows).toBe(1)
  expect(f.intactRowStatus).toBe('ready')
})

// --- idempotency ---------------------------------------------------------------

dbTest('a second run in a row changes nothing on the ideas root either', () => {
  const f = fact('ideaSecondCheck')
  expect(f.secondOrphanBlobsDeleted).toBe(0)
  expect(f.secondDanglingMarkedMissing).toBe(0)
  expect(f.sameAnomalyIds).toBe(true)
  expect(f.openAfterSecond).toEqual(fact('ideaCheck').openAfterFirst)
  // One fewer orphan blob to classify: the aged one was deleted by run 1.
  expect(f.secondClassified).toEqual({
    orphan_blob: 1,
    dangling_row: 1,
    orphan_session_dir: 0,
    checksum_mismatch: 0,
    orphan_idea_dir: 1,
    idea_dangling_row: 1,
    idea_checksum_mismatch: 1,
  })
})

// --- cleanup --------------------------------------------------------------------

dbTest('cleanup resolves every idea-rooted class, and the session one in the same pass', () => {
  const f = fact('ideaCleanup')
  expect(f.cleanup).toEqual({
    // The aged orphan was already swept automatically by check 1, leaving the
    // one still inside the grace window.
    orphanBlobsDeleted: 1,
    danglingRowsDeleted: 1,
    orphanSessionDirsDeleted: 0,
    checksumMismatchesDeleted: 0,
    orphanIdeaDirsDeleted: 1,
    ideaDanglingRowsDeleted: 1,
    ideaChecksumMismatchesDeleted: 1,
    skippedRevalidated: 0,
    failures: [],
  })
})

dbTest('cleanup removes exactly what each idea-rooted anomaly named', () => {
  const f = fact('ideaCleanup')
  expect(f.ghostIdeaDirGone).toBe(true)
  expect(f.ideaDanglingRowDeleted).toBe(true)
  expect(f.mismatchRowDeleted).toBe(true)
  expect(f.mismatchBlobDeleted).toBe(true)
  expect(f.youngOrphanDeleted).toBe(true)
  expect(f.sessionRowDeleted).toBe(true)
  expect(f.tmpStillUntouched).toBe(true)
})

dbTest('a re-run after cleanup classifies nothing at all, on either root', () => {
  const f = fact('ideaCleanup')
  expect(f.openAfterCleanup).toEqual([])
  expect(f.thirdClassified).toEqual({
    orphan_blob: 0,
    dangling_row: 0,
    orphan_session_dir: 0,
    checksum_mismatch: 0,
    orphan_idea_dir: 0,
    idea_dangling_row: 0,
    idea_checksum_mismatch: 0,
  })
})

// --- stillAnAnomaly's orphan_blob branch has to miss in BOTH tables -----------

dbTest('an orphan blob whose row landed in idea_files revalidates instead of being deleted', () => {
  const f = fact('ideaOrphanRevalidated')
  expect(f.checkSawOrphan).toBe(true)
  // Inside the grace window, so the automatic pass reported it and stopped.
  expect(f.checkDeletedIt).toBe(0)
  expect(f.blobSurvivedCleanup).toBe(true)
  expect(f.rowStillThere).toBe(true)
  expect(f.skippedRevalidated).toBe(1)
  expect(f.cleanupDeletedNothing).toBe(0)
  expect((f.classifiedAfter as Record<string, number>).idea_dangling_row).toBe(0)
  expect((f.classifiedAfter as Record<string, number>).orphan_blob).toBe(0)
})

dbTest('the same dual-table lookup holds through the per-row delete endpoint', () => {
  const f = fact('ideaOrphanRevalidatedOverHttp')
  expect(f.status).toBe(200)
  expect(f.outcome).toBe('revalidated')
  expect(f.blobSurvived).toBe(true)
  expect(f.rowSurvived).toBe(true)
})

// --- the remediation endpoints, against idea-rooted classes -------------------

dbTest('rechecking a still-valid idea_dangling_row leaves it open and deletes nothing', () => {
  const f = fact('ideaHttpRemediation') as Record<string, Record<string, unknown>>
  expect(f.recheck).toMatchObject({
    status: 200,
    outcome: 'unchanged',
    stillOpen: true,
    rowStatus: 'missing',
    rowStillThere: true,
  })
})

dbTest('deleting an idea_checksum_mismatch by id removes both the blob and the row', () => {
  const f = fact('ideaHttpRemediation') as Record<string, Record<string, unknown>>
  expect(f.deleteMismatch).toMatchObject({
    status: 200,
    outcome: 'deleted',
    blobGone: true,
    rowGone: true,
    anomalyResolved: true,
  })
})

dbTest('bulk-delete acts on an orphan_idea_dir and silently skips the rest', () => {
  const f = fact('ideaHttpRemediation') as Record<string, Record<string, unknown>>
  expect(f.bulkGhostDir).toMatchObject({
    status: 200,
    // The already-resolved id and the never-existed one are absent, not failures.
    resultCount: 1,
    ghostDirGone: true,
  })
  expect((f.bulkGhostDir as { outcomes: string[] }).outcomes).toEqual(['deleted'])
})

// --- DEFECT: one file id, two roots, and the whole pass dies -----------------
//
// storage_anomalies has a unique (class, path) and a unique (class, file_id).
// upsertAnomaly arbitrates orphan_blob on (class, path) only, and gc.ts fills
// fileId in for every blob whose on-disk name carries a uuid prefix — the
// normal case, not the NULL one db/schema.ts's comment reasons about. So two
// orphan blobs sharing a file id under different paths pass the arbiter and
// violate the other index, and the insert throws straight out of runCheck.
//
// The blast radius is the point: the exception escapes runCheck, so the stale
// sweep, the retention purge and the report never run, and the scheduled job
// fails on every subsequent tick (queue/attachments-gc.worker.ts only logs
// it). Nothing in the app mints such a pair — copyIdeaFileIntoSession takes a
// fresh uuid — so it takes a restored backup or a hand-copied tree to reach.
// gc.ts's whole job is to classify whatever is actually on disk, up to and
// including a file it did not write (it has a branch for a blob with no uuid
// prefix at all), so crashing on one is a defect, not an out-of-contract
// fixture. Reported, not worked around: see the report accompanying this file.

dbTest('two orphan blobs sharing one file id across the roots must not abort the pass', () => {
  const f = fact('sameFileIdBothRoots')
  expect(f.threw).toBe('')
  expect(f.orphanBlobClassified).toBe(2)
})
