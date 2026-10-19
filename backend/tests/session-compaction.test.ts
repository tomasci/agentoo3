// "Compact session", against a real Postgres and real git repositories — see
// session-compaction-db-child.ts for the exact fixture behind each fact below,
// and why it runs in a child process (the `@/env` first-import-wins constraint
// pg-cluster.ts's own header explains).
//
// The property everything here protects is that the SOURCE session is never
// written: the child snapshots its row and every message (with xmin, so even an
// UPDATE that wrote the same values back would show) before and after, on the
// success path and on each failure path. The summarizer is faked through
// runSessionCompaction's `deps`; tests/session-compaction-summarize.test.ts
// covers the real one against a mocked SDK.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP_PROJECTS = `/tmp/agentoo-session-compaction-test-projects-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis and
      // bullmq. `@/env` still insists on a value.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: TEMP_PROJECTS,
      ATTACHMENTS_DIR: `/tmp/agentoo-session-compaction-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      // deleteSession asks docker about a worktree session's containers when
      // this is on; nothing here has a docker daemon to answer.
      DOCKER_ENABLED: 'false',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/session-compaction-db-child.ts')], {
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
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

const STALE_ERROR = 'The worker running this compaction stopped before it finished'

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the compaction scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'branchGone',
    'concurrent',
    'createFails',
    'enqueueDown',
    'happy',
    'idempotent',
    'lateFailure',
    'plain',
    'refused',
    'stale',
    'summarizerFails',
    'summarizerThrows',
  ])
})

// --- the happy path ------------------------------------------------------------

type Happy = {
  createStatus: number
  createBody: Record<string, unknown>
  enqueuedForIt: { queue: string; name: string; data: unknown }[]
  sourceId: string
  sourceTitle: string
  sourceBranch: string
  before: unknown
  afterCreate: unknown
  afterRun: unknown
  pollStatus: number
  polled: Record<string, unknown>
  compaction: Record<string, unknown>
  redelivery: Record<string, unknown>
  projectSessionCount: number
  newSession: Record<string, unknown>
  newMessages: Record<string, unknown>[]
  sourceHead: string
  newHead: string
  carriedFile: string
  published: { kind: string; seq: number; type: string }[]
  firstPromptSeq: number | string
  nextSeqAfterFirstPrompt: number
  afterEverything: unknown
  listedBefore: { dto: unknown; order: string[] }
  listedAfter: { dto: unknown; order: string[] }
}

/** The shape session-compaction-db-child.ts's snapshot() returns. */
type Snapshot = {
  session: { xmin: string; row: Record<string, unknown> }[]
  messages: { xmin: string; row: Record<string, unknown> }[]
  files: { xmin: string; row: Record<string, unknown> }[]
  messageFiles: { xmin: string; row: Record<string, unknown> }[]
  git: {
    branchTip: string | null
    worktree: { exists: boolean; head: string; status: string } | null
  }
}

dbTest('POST answers 202 with a pending compaction and queues exactly one job for it', () => {
  const f = fact<Happy>('happy')
  expect(f.createStatus).toBe(202)
  expect(f.createBody).toMatchObject({
    sourceSessionId: f.sourceId,
    status: 'pending',
    method: null,
    resultSessionId: null,
    error: null,
    costUsd: 0,
    startedAt: null,
    finishedAt: null,
  })
  expect(f.createBody.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(new Date(f.createBody.createdAt as string).toISOString()).toBe(f.createBody.createdAt)
  expect(f.enqueuedForIt).toEqual([
    { queue: 'session-compaction', name: 'compact', data: { compactionId: f.createBody.id } },
  ])
})

dbTest('the source is untouched: not by the request, and not by running the compaction', () => {
  const f = fact<Happy>('happy')
  expect(f.before).toBeTruthy()
  expect(f.afterCreate).toEqual(f.before)
  expect(f.afterRun).toEqual(f.before)
})

dbTest('the snapshot the "untouched" checks compare really holds every kind of source state', () => {
  // Without this, an empty snapshot would make every toEqual(before) above and
  // below pass vacuously.
  const before = fact<Happy>('happy').before as Snapshot
  expect(before.session).toHaveLength(1)
  expect(before.session[0]?.xmin).toMatch(/^\d+$/)
  expect(Object.keys(before.session[0]?.row ?? {})).toEqual(
    expect.arrayContaining(['id', 'title', 'status', 'sdk_session_id', 'total_cost_usd', 'next_seq', 'updated_at', 'seen_at', 'settled_at', 'last_error', 'branch', 'worktree_path']),
  )
  expect(before.messages.map((m) => m.row.seq)).toEqual([0, 1, 2])
  expect(before.files).toHaveLength(1)
  expect(before.messageFiles).toHaveLength(1)
  expect(before.git.branchTip).toBe(fact<Happy>('happy').sourceHead)
  expect(before.git.worktree).toMatchObject({ exists: true, head: fact<Happy>('happy').sourceHead })
})

dbTest('...and is still untouched after the job is redelivered and the new session is used', () => {
  const f = fact<Happy>('happy')
  expect(f.afterEverything).toEqual(f.before)
})

dbTest("the source reads the same in the sessions list, and keeps its place among the others", () => {
  const f = fact<Happy>('happy')
  expect(f.listedBefore.dto).toBeTruthy()
  expect(f.listedAfter.dto).toEqual(f.listedBefore.dto)
  expect((f.listedAfter.dto as { messageCount: number }).messageCount).toBe(3)
  expect(f.listedAfter.order.filter((id) => id !== f.newSession.id)).toEqual(f.listedBefore.order)
  expect(f.listedAfter.order).toContain(f.newSession.id as string)
})

dbTest('the compaction ends succeeded, with the method, cost and new session recorded', () => {
  const f = fact<Happy>('happy')
  expect(f.pollStatus).toBe(200)
  expect(f.polled).toMatchObject({
    id: f.createBody.id,
    sourceSessionId: f.sourceId,
    status: 'succeeded',
    method: 'sdk_compact',
    resultSessionId: f.newSession.id,
    error: null,
    costUsd: 0.4321,
  })
  expect(typeof f.polled.startedAt).toBe('string')
  expect(typeof f.polled.finishedAt).toBe('string')
  expect(f.compaction).toMatchObject({
    status: 'succeeded',
    method: 'sdk_compact',
    costUsd: 0.4321,
    resultSessionId: f.newSession.id,
  })
})

dbTest('exactly one new session exists, titled, budgeted and led like the source', () => {
  const f = fact<Happy>('happy')
  expect(f.projectSessionCount).toBe(2)
  expect(f.newSession).toMatchObject({
    title: 'Source work (compacted)',
    orchestrator: 'coder',
    maxBudgetUsd: 7,
    status: 'idle',
    sdkSessionId: null,
    lastError: null,
    hasWorktree: true,
  })
  expect(f.newSession.id).not.toBe(f.sourceId)
})

dbTest('its history is one compact_context message at seq 0, nextSeq 1, carrying the cost', () => {
  const f = fact<Happy>('happy')
  expect(f.newMessages).toEqual([
    {
      seq: 0,
      type: 'compact_context',
      pending: false,
      title: null,
      payload: {
        summary: 'SUMMARY TEXT',
        sourceSessionId: f.sourceId,
        sourceTitle: 'Source work',
        sourceTotalCostUsd: 1.25,
        sourceBranch: f.sourceBranch,
        method: 'sdk_compact',
      },
    },
  ])
  expect(f.newSession.nextSeq).toBe(1)
  expect(f.newSession.totalCostUsd).toBe(0.4321)
})

dbTest('the context message is announced to anyone watching the new session', () => {
  const f = fact<Happy>('happy')
  expect(f.published.filter((p) => p.kind === 'message' && p.seq === 0)).toEqual([
    { kind: 'message', seq: 0, type: 'compact_context', sessionId: f.newSession.id },
  ])
})

dbTest('the new worktree is cut from the source branch, locally, with no fetch note', () => {
  const f = fact<Happy>('happy')
  expect(f.newSession.baseBranch).toBe(f.sourceBranch)
  expect(f.newSession.baseSha).toBe(f.sourceHead)
  expect(f.newSession.baseNote).toBeNull()
  expect(f.newHead).toBe(f.sourceHead)
  // The source's own commit is in it, which main does not have.
  expect(f.carriedFile).toBe('work from the source session\n')
  expect(f.newSession.branch).toMatch(/^agentoo\/s-[0-9a-f]{8}$/)
  expect(f.newSession.branch).not.toBe(f.sourceBranch)
})

dbTest('a duplicate delivery of the job summarizes nothing and changes nothing', () => {
  const f = fact<Happy>('happy')
  expect(f.redelivery).toEqual({
    summarizeCalls: 0,
    status: 'succeeded',
    costUsd: 0.4321,
    resultSessionId: f.newSession.id,
  })
})

dbTest('the first prompt in the new session lands at seq 1 instead of colliding', () => {
  const f = fact<Happy>('happy')
  expect(f.firstPromptSeq).toBe(1)
  expect(f.nextSeqAfterFirstPrompt).toBe(2)
})

// --- one at a time ---------------------------------------------------------------

dbTest('a second POST while one is active returns that compaction, pending or running', () => {
  const f = fact<Record<string, unknown>>('idempotent')
  expect(f.firstStatus).toBe(202)
  expect(f.secondStatus).toBe(202)
  expect(f.secondId).toBe(f.firstId)
  expect(f.queuedJobs).toBe(1)
  expect(f.whileRunningStatus).toBe(202)
  expect(f.whileRunningId).toBe(f.firstId)
  // Asking twice writes nothing to the source either.
  expect(f.afterRepeat).toEqual(f.before)
})

dbTest('five simultaneous POSTs converge on one compaction, one row and one queued job', () => {
  const f = fact<{
    statuses: number[]
    distinctIds: number
    rowIds: string[]
    firstId: string
    queuedJobs: number
    before: unknown
    after: unknown
  }>('concurrent')
  expect(f.statuses).toEqual([202, 202, 202, 202, 202])
  expect(f.distinctIds).toBe(1)
  expect(f.rowIds).toEqual([f.firstId])
  expect(f.queuedJobs).toBe(1)
  expect(f.after).toEqual(f.before)
})

dbTest('once it has finished, the next POST is a new compaction', () => {
  const f = fact<Record<string, unknown>>('idempotent')
  expect(f.afterDoneStatus).toBe(202)
  expect(f.afterDoneId).not.toBe(f.firstId)
  expect(f.rowCount).toBe(2)
})

// --- refusals ----------------------------------------------------------------------

type Refused = {
  queued: { status: number; error: string }
  running: { status: number; error: string }
  notReady: { status: number; error: string }
  unknown: number
  malformed: number
  rowsCreated: Record<string, number>
  queuedUntouched: boolean
  get: Record<string, number>
}

dbTest('a queued or running source is a 409 that says to wait or interrupt, and starts nothing', () => {
  const f = fact<Refused>('refused')
  for (const refusal of [f.queued, f.running]) {
    expect(refusal.status).toBe(409)
    expect(refusal.error).toContain('Session is running')
    expect(refusal.error).toContain('interrupt')
  }
  expect(f.rowsCreated.queued).toBe(0)
  expect(f.rowsCreated.running).toBe(0)
  expect(f.queuedUntouched).toBe(true)
})

dbTest('a project that is not ready is a 409', () => {
  const f = fact<Refused>('refused')
  expect(f.notReady.status).toBe(409)
  expect(f.notReady.error).toContain('Project is "cloning"')
  expect(f.rowsCreated.notReady).toBe(0)
})

dbTest('an unknown session is a 404, and a malformed id a 400', () => {
  const f = fact<Refused>('refused')
  expect(f.unknown).toBe(404)
  expect(f.malformed).toBe(400)
})

dbTest('GET is a 404 unless the compaction exists AND belongs to that session', () => {
  const f = fact<Refused>('refused')
  expect(f.get.rightSession).toBe(200)
  expect(f.get.wrongSession).toBe(404)
  expect(f.get.unknownCompaction).toBe(404)
  expect(f.get.unknownBoth).toBe(404)
  expect(f.get.malformed).toBe(400)
})

// --- failures ------------------------------------------------------------------------

type Failure = {
  status: string
  error: string
  costUsd: number
  resultSessionId: string | null
  method: string | null
  sessionsBefore: string[]
  sessionsAfter: string[]
  branchesBefore: string[]
  branchesAfter: string[]
  worktreesBefore?: string[]
  worktreesAfter?: string[]
  before: unknown
  after: unknown
  finishedAtSet?: boolean
  retryStatus?: number
  retryIsNew?: boolean
}

dbTest('a summarizer that fails fails the compaction with its reason and its cost', () => {
  const f = fact<Failure>('summarizerFails')
  expect(f.status).toBe('failed')
  expect(f.error).toBe('model exploded')
  expect(f.costUsd).toBe(0.07)
  expect(f.resultSessionId).toBeNull()
  expect(f.method).toBeNull()
  expect(f.finishedAtSet).toBe(true)
})

dbTest('...creates no session or branch, leaves the source untouched, and frees the slot', () => {
  const f = fact<Failure>('summarizerFails')
  expect(f.sessionsAfter).toEqual(f.sessionsBefore)
  expect(f.branchesAfter).toEqual(f.branchesBefore)
  expect(f.after).toEqual(f.before)
  expect(f.retryStatus).toBe(202)
  expect(f.retryIsNew).toBe(true)
})

dbTest('a failure after the session exists removes it, its worktree and its branch', () => {
  const f = fact<Failure>('lateFailure')
  expect(f.status).toBe('failed')
  expect(f.error).toContain('Could not start the new session')
  expect(f.error).toContain('injected: cannot insert compact_context')
  // Cleanup worked, so there is nothing leftover to report.
  expect(f.error).not.toContain('could not be removed')
  expect(f.resultSessionId).toBeNull()
  expect(f.sessionsAfter).toEqual(f.sessionsBefore)
  expect(f.worktreesAfter).toEqual(f.worktreesBefore)
  expect(f.branchesAfter).toEqual(f.branchesBefore)
})

dbTest('...and still records the money the summary cost, on the compaction row only', () => {
  const f = fact<Failure>('lateFailure')
  expect(f.costUsd).toBe(0.5)
  expect(f.method).toBeNull()
})

dbTest('...with the source untouched', () => {
  const f = fact<Failure>('lateFailure')
  expect(f.after).toEqual(f.before)
})

dbTest('a summarizer that throws instead of answering fails cleanly, and touches nothing', () => {
  const f = fact<Failure>('summarizerThrows')
  expect(f.status).toBe('failed')
  expect(f.error).toBe('Summarizing failed: summarizer blew up')
  expect(f.costUsd).toBe(0)
  expect(f.resultSessionId).toBeNull()
  expect(f.method).toBeNull()
  expect(f.sessionsAfter).toEqual(f.sessionsBefore)
  expect(f.branchesAfter).toEqual(f.branchesBefore)
  expect(f.worktreesAfter).toEqual(f.worktreesBefore)
  expect(f.after).toEqual(f.before)
})

type CreateFails = Failure & { gitWorktreesBefore: string; gitWorktreesAfter: string }

dbTest('createSession failing after its row exists fails the compaction with the cost recorded', () => {
  const f = fact<CreateFails>('createFails')
  expect(f.status).toBe('failed')
  expect(f.error).toContain('Could not start the new session')
  expect(f.error).toContain('injected: cannot record the worktree')
  expect(f.costUsd).toBe(0.3)
  expect(f.resultSessionId).toBeNull()
  expect(f.method).toBeNull()
})

dbTest('...and leaves no session behind, with the source untouched', () => {
  const f = fact<CreateFails>('createFails')
  expect(f.sessionsAfter).toEqual(f.sessionsBefore)
  expect(f.after).toEqual(f.before)
})

// "If a compaction fails, no new session survives it": a worktree directory, a
// git worktree registration and a branch per failed attempt are what is left of
// one. One test each, so a failure names which of the three survived.
dbTest('...and leaves no worktree directory behind', () => {
  const f = fact<CreateFails>('createFails')
  expect(f.worktreesAfter).toEqual(f.worktreesBefore)
})

dbTest('...and leaves no git worktree registered', () => {
  const f = fact<CreateFails>('createFails')
  expect(f.gitWorktreesAfter).toEqual(f.gitWorktreesBefore)
})

dbTest('...and leaves no branch behind', () => {
  const f = fact<CreateFails>('createFails')
  expect(f.branchesAfter).toEqual(f.branchesBefore)
})

// --- a worker that died ---------------------------------------------------------------

dbTest('a compaction older than the timeout is failed by a poll, which terminates the UI', () => {
  const f = fact<Record<string, unknown>>('stale')
  expect(f.polledStatus).toBe(200)
  expect(f.polled).toMatchObject({ status: 'failed', error: STALE_ERROR })
  expect(typeof (f.polled as Record<string, unknown>).finishedAt).toBe('string')
})

dbTest('...and by the next POST, which then starts a new compaction', () => {
  const f = fact<Record<string, unknown>>('stale')
  expect(f.oldPendingStatus).toBe('failed')
  expect(f.oldPendingError).toBe(STALE_ERROR)
  expect(f.postStatus).toBe(202)
  expect(f.postIsNew).toBe(true)
  expect(f.postBodyStatus).toBe('pending')
})

dbTest('a recent running compaction is left alone', () => {
  const f = fact<Record<string, unknown>>('stale')
  expect(f.freshStatus).toBe(202)
  expect(f.freshSameId).toBe(true)
  expect(f.freshBodyStatus).toBe('running')
})

dbTest('a late worker finds its row already failed and does nothing', () => {
  const f = fact<Record<string, unknown>>('stale')
  expect(f.lateWorkerSummarizeCalls).toBe(0)
  expect(f.lateWorkerRow).toBe('failed')
})

// --- the queue ----------------------------------------------------------------------------

dbTest('a queue that is down fails the row, says so, and does not hold the slot', () => {
  const f = fact<{
    status: number
    error: string
    rows: { status: string; error: string }[]
    retryStatus: number
  }>('enqueueDown')
  expect(f.status).toBe(503)
  expect(f.error).toContain('Could not queue the compaction')
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]?.status).toBe('failed')
  expect(f.rows[0]?.error).toContain('Could not queue the compaction')
  expect(f.retryStatus).toBe(202)
  expect((f as unknown as { after: unknown }).after).toEqual((f as unknown as { before: unknown }).before)
})

// --- the base branch -------------------------------------------------------------------------

dbTest('a source with no branch (not a git repo) compacts the ordinary way', () => {
  const f = fact<{
    status: string
    error: string | null
    method: string
    newTitle: string
    newBranch: string | null
    newBaseBranch: string | null
    newWorktree: string | null
    payload: Record<string, unknown>
    before: unknown
    after: unknown
  }>('plain')
  expect(f.status).toBe('succeeded')
  expect(f.method).toBe('transcript_summary')
  expect(f.newBranch).toBeNull()
  expect(f.newBaseBranch).toBeNull()
  expect(f.newWorktree).toBeNull()
  expect(f.payload.sourceBranch).toBeNull()
  expect(f.payload.method).toBe('transcript_summary')
  expect(f.after).toEqual(f.before)
})

dbTest('a title already at the limit is cut to leave room for the suffix, not the other way round', () => {
  const f = fact<{ newTitle: string }>('plain')
  expect(f.newTitle).toHaveLength(200)
  expect(f.newTitle.endsWith(' (compacted)')).toBe(true)
})

dbTest('a source whose branch no longer exists compacts from the ordinary base instead', () => {
  const f = fact<{
    status: string
    error: string | null
    newBaseBranch: string
    newBranchIsOwn: boolean
    payload: Record<string, unknown>
    before: unknown
    after: unknown
  }>('branchGone')
  expect(f.status).toBe('succeeded')
  expect(f.newBaseBranch).toBe('main')
  expect(f.newBranchIsOwn).toBe(true)
  // The context must not claim the worktree came from a branch it did not.
  expect(f.payload.sourceBranch).toBeNull()
  expect(f.after).toEqual(f.before)
})
