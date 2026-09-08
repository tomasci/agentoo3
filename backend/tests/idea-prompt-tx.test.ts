// The prompt-generation transaction at its boundaries, against a real
// Postgres: a comment that commits *while* the transaction is open, and a
// retry that has to reuse the stored digest without un-consuming anything.
//
// ideas-routes-db-child.ts already covers the sequential cases and they pass.
// What it cannot reach is the interleaving the transaction exists for. The
// child forces that interleaving with a table-level lock on a second
// connection rather than racing two calls and hoping, so the transaction is
// parked at a known statement boundary — between its SELECT of the unconsumed
// comments and its UPDATE of them — and the concurrent comment commits at
// exactly the moment a "marked but never folded in" bug would be observable.
// See the child's own header for the statement order that makes idea_blocks
// the right table to lock.
//
// The invariant under test, stated once: a comment is folded into a prompt's
// digest if and only if that same transaction marked it consumed. Neither
// half may happen without the other.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const PROJECTS_DIR = `/tmp/agentoo-idea-prompt-tx-projects-${process.pid}`
const ATTACHMENTS_DIR = `/tmp/agentoo-idea-prompt-tx-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-prompt-tx-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        ATTACHMENTS_DIR,
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
  await rm(PROJECTS_DIR, { recursive: true, force: true })
  await rm(ATTACHMENTS_DIR, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the prompt-transaction scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the prompt-transaction scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'commentMidTransaction',
    'concurrentFollowups',
    'enqueueFailure',
    'lateCommentSurvives',
    'overHttp',
    'pendingRetry',
  ])
})

// --- a comment that commits while the transaction is open ---------------------

dbTest('the interleave was actually forced, not hoped for', () => {
  // False would mean the lock never blocked anything and the "concurrent"
  // comment simply landed before or after — the test would then be asserting
  // the sequential case a second time.
  expect(fact('commentMidTransaction').parked).toBe(true)
})

dbTest('a comment already there is folded in and marked, together', () => {
  const f = fact('commentMidTransaction')
  expect(f.earlyInDigest).toBe(true)
  expect(f.earlyConsumed).toBe(true)
  expect(f.promptStatus).toBe('pending')
  expect(f.enqueuedPromptId).toBe(true)
})

dbTest('a comment that commits mid-transaction is neither folded in nor marked', () => {
  const f = fact('commentMidTransaction')
  expect(f.lateExists).toBe(true)
  expect(f.lateInDigest).toBe(false)
  // The half that matters: the UPDATE keys on the ids it folded, not on
  // `consumed_at IS NULL`, so a comment this digest never saw cannot be
  // stamped by it. Stamping it here would silently drop the feedback.
  expect(f.lateConsumed).toBe(false)
})

dbTest('that comment is picked up by the next followup rather than lost', () => {
  const f = fact('lateCommentSurvives')
  expect(f.inNextDigest).toBe(true)
  expect(f.consumedNow).toBe(true)
  // And the one the first attempt already consumed is not folded in twice.
  expect(f.earlyNotRefolded).toBe(true)
})

// --- a stuck (pending) prompt's retry ------------------------------------------

dbTest('a pending prompt is retried by copying its digest verbatim', () => {
  const f = fact('pendingRetry')
  expect(f.digestCopiedVerbatim).toBe(true)
  expect(f.retriedIsNewRow).toBe(true)
  expect(f.retriedStatus).toBe('pending')
  expect(f.stuckRowStatus).toBe('pending')
  expect(f.enqueuedDelta).toBe(1)
})

dbTest('a retry un-consumes nothing and consumes nothing new', () => {
  const f = fact('pendingRetry')
  // To the millisecond: the stamp the original attempt wrote, untouched.
  expect(f.alreadyFoldedTimestampUnchanged).toBe(true)
  // A comment that arrived after the attempt got stuck is not in the copied
  // digest, so it must still be unconsumed and available to a real followup.
  expect(f.arrivedAfterInDigest).toBe(false)
  expect(f.arrivedAfterStillUnconsumed).toBe(true)
})

// --- the real HTTP route --------------------------------------------------------

dbTest('POST /ideas/{id}/prompts consumes and enqueues exactly once', () => {
  const f = fact('overHttp')
  expect(f.status).toBe(201)
  expect(f.promptStatus).toBe('pending')
  expect(f.digestHasComment).toBe(true)
  expect(f.consumed).toBe(true)
  expect(f.enqueuedDelta).toBe(1)
  expect(f.enqueuedThisPrompt).toBe(true)
  expect(f.rowCount).toBe(2)
})

// --- two followups with no forced ordering --------------------------------------

dbTest('two overlapping followups keep the fold/consume invariant, whoever wins', () => {
  // Deliberately interleaving-independent: this asserts the invariant, not a
  // particular winner, so it cannot become a coin flip.
  const f = fact('concurrentFollowups')
  expect(f.errors).toEqual([])
  expect(f.promptRows).toBe(3) // the seeded 'ready' initial, plus one per call
  expect(f.invariantHolds).toBe(true)
  expect(f.unconsumedLeft).toBe(0)
  for (const c of f.perComment as { consumed: boolean; foldedIntoCount: number }[]) {
    expect(c.consumed).toBe(true)
    expect(c.foldedIntoCount).toBeGreaterThan(0)
  }
})

// --- what a queue failure after the commit leaves behind ------------------------

dbTest('a queue failure after the commit leaves a consumed comment on a pending row', () => {
  // Recorded, not a defect claim: enqueueing after the commit is what makes
  // "folded and marked together" atomic in the first place, and the module's
  // own docblock already names the stuck-pending-row gap ("the chosen answer
  // is a regenerate action on the HTTP surface"). This pins the observable
  // state so that a later regenerate surface has something to be measured
  // against — the comment is consumed and the only thing that would ever
  // re-fold it is a retry of this exact row.
  const f = fact('enqueueFailure')
  expect(f.threw).toContain('Stream is not writeable')
  expect(f.promptRowsForIdea).toBe(2)
  expect(f.pendingRows).toBe(1)
  expect(f.commentConsumed).toBe(true)
})
