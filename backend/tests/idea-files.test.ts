// Idea-owned file assets: the shared writer against the second storage root,
// its permission story, and the database-backed scenarios (caps, totalUsage,
// the handoff's idempotency) that need real Postgres semantics — see
// pg-cluster.ts and attachments-db.test.ts for why a faked `db` is not an
// option for the partial-unique-index / onConflictDoNothing behaviour the
// handoff and the per-idea dedup both depend on.
//
// The filesystem-only checks below run directly, no database involved, the
// same way attachments-put.test.ts checks put() against a scratch
// ATTACHMENTS_DIR. The database-backed ones run once in a child process
// (idea-files-db-child.ts) against a throwaway cluster this file initdb's
// into /tmp and throws away afterwards; the child gathers facts, every
// assertion lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../src/env'
import { openIdeaFile, putIdeaFile } from '../src/features/attachments/storage'
import { ideaUploadsDir } from '../src/lib/paths'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const ROOT = env.ATTACHMENTS_DIR

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

/** A fresh idea id per test, so nothing here can see another test's tree. */
const newIdea = () => randomUUID()

const streamOf = (...chunks: (Uint8Array | string)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      }
      controller.close()
    },
  })

const mode = async (path: string) => (await stat(path)).mode & 0o777

// --- the shared writer, against the second root ------------------------------

test('putIdeaFile stores bytes under <uuid>-<sanitized name>, on the ideas root', async () => {
  const ideaId = newIdea()
  const stored = await putIdeaFile(ideaId, 'notes.log', streamOf('alpha\nbeta\n'))

  expect(stored.storedName).toBe(`${stored.fileId}-notes.log`)
  expect(stored.ideaId).toBe(ideaId)
  const uploads = ideaUploadsDir(ideaId)
  expect(uploads).toContain(`${ROOT}/ideas/`)
  const path = join(uploads, stored.storedName)
  expect(await Bun.file(path).text()).toBe('alpha\nbeta\n')
  expect(stored.sizeBytes).toBe(11)
  expect(stored.mimeType).toBe('text/plain')
  expect(stored.lineCount).toBe(2)
  expect(stored.checksum).toBe(new Bun.CryptoHasher('sha256').update('alpha\nbeta\n').digest('hex'))
})

test('putIdeaFile enforces the same per-file cap and atomicity as put() — the shared writer, not a clone', async () => {
  const ideaId = newIdea()
  const oversized = 'a'.repeat(env.ATTACHMENT_MAX_BYTES + 1)
  await expect(putIdeaFile(ideaId, 'big.log', streamOf(oversized))).rejects.toMatchObject({
    code: 'too_large',
  })
  expect(await readdir(ideaUploadsDir(ideaId)).catch(() => [])).toEqual([])
})

test('a file id from one idea does not resolve inside another', async () => {
  const a = newIdea()
  const b = newIdea()
  const inA = await putIdeaFile(a, 'secret.log', streamOf('classified\n'))
  await putIdeaFile(b, 'other.log', streamOf('mine\n'))

  expect(await openIdeaFile(b, inA.fileId)).toBeUndefined()
  expect(await openIdeaFile(a, inA.fileId)).toBeDefined()
})

// --- modes: 0700 dirs, 0600 files, under a permissive umask — same story as
// a session's, see attachments-put.test.ts's own version of this test -------

test('the idea dir, the uploads dir and the blob are 0700/0700/0600', async () => {
  const previousUmask = process.umask(0o000)
  try {
    const ideaId = newIdea()
    const stored = await putIdeaFile(ideaId, 'x.log', streamOf('x\n'))
    const uploads = ideaUploadsDir(ideaId)
    expect(await mode(uploads)).toBe(0o700)
    expect(await mode(join(uploads, '..'))).toBe(0o700)
    expect(await mode(join(uploads, stored.storedName))).toBe(0o600)
  } finally {
    process.umask(previousUmask)
  }
})

// --- database-backed scenarios: caps, totalUsage, the handoff ----------------

const BACKEND = new URL('..', import.meta.url).pathname
const DB_ATTACHMENTS_DIR = `/tmp/agentoo-idea-files-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-files-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        ATTACHMENTS_DIR: DB_ATTACHMENTS_DIR,
        // Deliberately dead: the child never touches the queue.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: `/tmp/agentoo-idea-files-test-projects-${process.pid}`,
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
  await rm(DB_ATTACHMENTS_DIR, { recursive: true, force: true })
  await rm(`/tmp/agentoo-idea-files-test-projects-${process.pid}`, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the database-backed scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the DB-backed scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(2)
})

dbTest('a per-idea cap violation deletes the blob it just wrote and inserts no row', () => {
  const f = fact('ideaCap')
  expect(f.error).toContain('1500-byte limit')
  expect(f.leftNoOverBlob).toBe(true)
  expect(f.leftNoTmp).toBe(true)
  // Only the seed file's row — the rejected upload never got one.
  expect(f.rowCount).toBe(1)
})

dbTest('totalUsage sums session_files and idea_files together', () => {
  // 500 bytes on the idea side, 700 on the session side — both roots have to
  // be summed, or this would read 700 (session_files alone) or 500 (idea_
  // files alone) instead of 1200.
  expect(fact('totalUsage').delta).toBe(1200)
})

dbTest('the handoff copies every ready idea asset into the session, as ordinary rows', () => {
  const f = fact('handoffIdempotent')
  expect(f.rowCountFirst).toBe(2)
  expect(f.blobCountFirst).toBe(2)
  expect(f.checksumsMatchIdea).toBe(true)
})

dbTest('a second handoff of the same idea into the same session is a no-op', () => {
  const f = fact('handoffIdempotent')
  expect(f.rowCountSecond).toBe(f.rowCountFirst)
  expect(f.sameIds).toBe(true)
  // No second copy of the bytes either — the pre-filter against existing
  // checksums skips the copy entirely on a retry, it does not rely on the
  // database catching a duplicate after writing one.
  expect(f.blobCountSecond).toBe(f.blobCountFirst)
})

dbTest('nine — well, three — 1000-byte assets against a 500-byte cap fail as a unit', () => {
  const f = fact('wholeSetCap')
  expect(f.error).toContain('byte limit')
  // Not "two of three attached, one rejected" — none of them landed.
  expect(f.rowCount).toBe(0)
  expect(f.blobCount).toBe(0)
})
