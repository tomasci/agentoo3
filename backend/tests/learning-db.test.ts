// The learning feature against a real Postgres: the one-active-run
// constraint, apply-modify (write + version history + stale-hash rejection),
// apply-create (write + version 1 + name-taken conflict), reject, delete, and
// a genuine concurrent double-apply. See learning-db-child.ts for why this
// runs in a child process and for the fixtures behind each fact below.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''
let libraryDir = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    libraryDir = await mkdtemp(join(tmpdir(), 'agentoo-learning-db-library-'))

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
      REDIS_URL: 'redis://127.0.0.1:1',
      LIBRARY_DIR: libraryDir,
      PROJECTS_DIR: `/tmp/agentoo-learning-db-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-learning-db-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/learning-db-child.ts')], {
      cwd: BACKEND,
      env: childEnv,
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
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
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
  if (libraryDir) await rm(libraryDir, { recursive: true, force: true })
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
    console.warn('No Postgres server binaries on this box; the learning scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(5)
})

// --- 1. at most one active run ----------------------------------------------

dbTest('a new run inserts queued, windowStart is windowEnd minus 24h, and enqueues it', () => {
  const f = fact('runConstraint')
  expect(f.firstStatus).toBe('queued')
  expect(new Date(f.firstWindowEnd as string).getTime() - new Date(f.firstWindowStart as string).getTime()).toBe(
    24 * 60 * 60 * 1000,
  )
  expect(f.enqueuedAfterFirst).toEqual(['learning'])
})

dbTest('a second run while the first is queued is a conflict naming the active run', () => {
  const f = fact('runConstraint')
  expect(f.secondWhileQueuedIsConflict).toBe(true)
  expect(f.secondWhileQueuedConflictId).toBe(true)
})

dbTest('a second run while the first is running is also a conflict', () => {
  const f = fact('runConstraint')
  expect(f.secondWhileRunningIsConflict).toBe(true)
})

dbTest('a new run after the first completes succeeds, as a new row', () => {
  const f = fact('runConstraint')
  expect(f.afterCompletionSucceeded).toBe(true)
  expect(f.afterCompletionIsNewRow).toBe(true)
})

dbTest('a run whose enqueue fails is marked failed with an error, and does not block the next one', () => {
  const f = fact('enqueueFailure')
  expect(f.failedRunStatus).toBe('failed')
  expect(f.failedRunHasError).toBe(true)
  expect(f.nextRunSucceeded).toBe(true)
})

dbTest('POST /library/learning/runs is 202 then 409 on a second call', () => {
  const f = fact('runRoute')
  expect(f.firstStatus).toBe(202)
  expect(f.firstBodyStatus).toBe('queued')
  expect(f.secondStatus).toBe(409)
  expect(f.secondHasError).toBe(true)
})

dbTest('GET /library/learning reports an overview with a schedule and the active run', () => {
  const f = fact('overview')
  expect(f.status).toBe(200)
  expect(f.hasSchedule).toBe(true)
  expect(f.activeRunPresent).toBe(true)
})

// --- 2 & 3. apply-modify: write, version history, stale-hash rejection -----

dbTest('listSuggestions resolves source sessions and omits a deleted one', () => {
  const f = fact('modify')
  expect(f.summaryListLength).toBe(1)
  const entry = f.summaryEntry as { sourceSessions: { title: string }[]; targetExists: boolean }
  expect(entry.sourceSessions).toHaveLength(1)
  expect(entry.sourceSessions[0]?.title).toBe('A session that asked scout for X')
  expect(entry.targetExists).toBe(true)
})

dbTest('getSuggestion detail is not stale right after proposal', () => {
  const f = fact('modify')
  expect(f.detailStatus).toBe(200)
  expect(f.detailTargetExists).toBe(true)
  expect(f.detailStale).toBe(false)
})

dbTest('apply with a stale hash 409s and leaves the file untouched', () => {
  const f = fact('modify')
  expect(f.staleApplyStatus).toBe(409)
  expect(f.fileUnchangedAfterStaleApply).toBe(true)
  expect(f.suggestionStillPendingAfterStaleApply).toBe('pending')
})

dbTest('apply with the correct hash writes the file and records both versions', () => {
  const f = fact('modify')
  expect(f.goodApplyStatus).toBe(200)
  expect(f.goodApplyStatusField).toBe('applied')
  expect(f.goodApplyAppliedVersion).toBe(2)
  expect(f.fileMatchesProposedAfterApply).toBe(true)

  expect(f.versionsStatus).toBe(200)
  expect(f.versionsCount).toBe(2)
  const versions = f.versions as { version: number; source: string; suggestionId: string | null }[]
  expect(versions[0]?.version).toBe(2)
  expect(versions[0]?.source).toBe('suggestion')
  expect(versions[0]?.suggestionId).not.toBeNull()
  expect(versions[1]?.version).toBe(1)
  expect(versions[1]?.source).toBe('snapshot')
  expect(versions[1]?.suggestionId).toBeNull()
})

dbTest('re-applying an already-applied suggestion 409s', () => {
  expect(fact('modify').reapplyStatus).toBe(409)
})

// Item 3 in the defect log: stale only ever means "a pending modify whose
// target has drifted since" — never an applied or rejected one.
dbTest('an applied suggestion never reads as stale, even though applying it is what moved the file away from baseMarkdown', () => {
  const f = fact('modify')
  expect(f.detailAfterApplyStatus).toBe('applied')
  expect(f.detailAfterApplyStale).toBe(false)
})

dbTest('a rejected suggestion reads as stale:false regardless of how far its baseMarkdown has drifted from disk', () => {
  const f = fact('modify')
  expect(f.rejectResponseStatus).toBe(200)
  expect(f.rejectedDetailStatus).toBe('rejected')
  expect(f.rejectedDetailStale).toBe(false)
})

// --- 4. apply-create: new skill, version 1, 409 if the name is now taken ---

dbTest('apply-create writes the new skill and records version 1', () => {
  const f = fact('create')
  expect(f.firstApplyStatus).toBe(200)
  expect(f.firstApplyVersion).toBe(1)
  expect(f.createdMarkdownHasDescription).toBe(true)
  expect(f.versionsCount).toBe(1)
})

dbTest('apply-create 409s once the name is taken, and leaves that suggestion pending', () => {
  const f = fact('create')
  expect(f.secondApplyIsConflict).toBe(true)
  expect(f.secondSuggestionStillPending).toBe(true)
})

// --- 5 & 6. reject, and delete only once rejected ---------------------------

dbTest('a pending suggestion cannot be deleted', () => {
  expect(fact('rejectAndDelete').deleteWhilePendingStatus).toBe(409)
})

dbTest('reject moves it to the rejected list and off the pending one', () => {
  const f = fact('rejectAndDelete')
  expect(f.rejectStatus).toBe(200)
  expect(f.rejectStatusField).toBe('rejected')
  expect(f.rejectedListIncludesIt).toBe(true)
  expect(f.pendingListExcludesItAfterReject).toBe(true)
})

dbTest('rejecting an already-rejected suggestion 409s', () => {
  expect(fact('rejectAndDelete').rejectAgainStatus).toBe(409)
})

dbTest('deleting a rejected suggestion succeeds, and it is gone for good', () => {
  const f = fact('rejectAndDelete')
  expect(f.deleteStatus).toBe(204)
  expect(f.getAfterDeleteStatus).toBe(404)
  expect(f.deleteAgainStatus).toBe(404)
})

dbTest('deleting an unknown id is a 404', () => {
  expect(fact('rejectAndDelete').deleteUnknownStatus).toBe(404)
})

// --- 7. concurrent double-apply writes exactly once -------------------------

dbTest('two concurrent applies of the same suggestion: exactly one writes', () => {
  const f = fact('concurrentApply')
  expect(f.exactlyOneSucceeded).toBe(true)
  // 1 snapshot + 1 suggestion version — never 4, which a double-write would produce.
  expect(f.versionsCount).toBe(2)
})
