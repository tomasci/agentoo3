// Which turns may run at the same time, against a real Postgres.
//
// The claim in session-run.worker.ts's `runTurn` is the only thing deciding
// this, and it is now a conditional UPDATE carrying a correlated `NOT EXISTS`
// subquery over the session's own project. That predicate cannot be tested
// against a fake: session-recovery.test.ts's `db.update().set().where()` takes
// no arguments at all and always answers `.returning()` with the same claimed
// row, so every test that runs through it takes the successful-claim path
// whatever the WHERE says. Nothing there can distinguish a claim that was
// refused from one that was granted, which is precisely the distinction this
// file exists for.
//
// So the scenarios run once, in a child process (session-claim-db-child.ts)
// with its own DATABASE_URL, against a cluster this file initdb's into /tmp and
// throws away afterwards — see pg-cluster.ts for why the connection cannot be
// re-pointed inside the shared test process. Redis, BullMQ and the Agent SDK
// are faked in the child; the database is not. Nothing here can reach the
// deployment's own database.
//
// The child gathers facts; every assertion lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

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
      // Deliberately dead, and never dialled: the child fakes ioredis, bullmq
      // and the event bus. `@/env` still insists on a value.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: `/tmp/agentoo-claim-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-claim-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }
    // Removed, not overridden: the default is one of the things under test,
    // and a box that runs agentoo has WORKER_CONCURRENCY set in its own
    // environment, which would otherwise be inherited and reported back.
    delete childEnv.WORKER_CONCURRENCY

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/session-claim-db-child.ts')], {
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
    console.warn('No Postgres server binaries on this box; the claim scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(8)
})

// --- the regression the operator reported --------------------------------------
//
// Two sessions in two projects, both isolated, both queued. The report was that
// the second would not run and sat behind "1 message waiting", because
// WORKER_CONCURRENCY defaulted to 1 and the BullMQ worker took one turn at a
// time machine-wide. Nothing about either session should hold the other back.

dbTest('two sessions in different projects run at the same time, not one after the other', () => {
  const f = fact('crossProjectConcurrent')
  // Both were inside their SDK call together — this is the whole complaint.
  expect(f.bothInside).toBe(true)
  expect(f.statusesWhileInside).toEqual(['running', 'running'])
  expect(f.finalA).toBe('completed')
  expect(f.finalB).toBe('completed')
})

dbTest('neither of them re-queues, and neither leaves its message waiting', () => {
  const f = fact('crossProjectConcurrent')
  expect(f.requeues).toBe(0)
  expect(f.pendingLeftA).toBe(0)
  expect(f.pendingLeftB).toBe(0)
})

dbTest('the machine-wide cap is above one, and reaches the worker that enforces it', () => {
  // The default alone is what the fix turned on: at 1, everything above is
  // unreachable no matter what the claim allows.
  const f = fact('config')
  expect(f.workerConcurrencyDefault).toBeGreaterThan(1)
  expect(f.workerConcurrency).toBe(f.workerConcurrencyDefault)
})

// --- the predicate restrains non-isolated sessions and nothing else ------------

dbTest('two isolated sessions in the same project also run at the same time', () => {
  const f = fact('sameProjectIsolatedConcurrent')
  expect(f.bothInside).toBe(true)
  expect(f.statusesWhileInside).toEqual(['running', 'running'])
  expect(f.finalA).toBe('completed')
  expect(f.finalB).toBe('completed')
  expect(f.requeues).toBe(0)
})

dbTest('a session with a worktree is claimable whatever its siblings are doing', () => {
  // `idle` is the claim having succeeded: a claimed session with nothing
  // pending is set idle immediately. A refused claim would read `queued`.
  const f = fact('isolatedNeverBlocked')
  expect(f.behindIsolatedSibling).toBe('idle')
  expect(f.behindNonIsolatedSibling).toBe('idle')
  expect(f.blockerStatus).toBe('running')
  expect(f.requeues).toBe(0)
})

dbTest('a session sharing the checkout is not held back by one with its own worktree', () => {
  // Only a sibling that shares the working tree can conflict over it. Blocking
  // on an isolated sibling instead would serialize every session in a git
  // project the moment one of them lost its worktree.
  const f = fact('nonIsolatedBehindIsolated')
  expect(f.status).toBe('idle')
  expect(f.requeues).toBe(0)
})

dbTest('a non-isolated session is not held back by another project', () => {
  // The predicate is scoped by project_id. Dropping that scope would turn one
  // plain adopted folder anywhere on the box into a global lock.
  const f = fact('nonIsolatedCrossProject')
  expect(f.status).toBe('idle')
  expect(f.requeues).toBe(0)
})

// --- the new mutual exclusion --------------------------------------------------

dbTest('a second non-isolated session in one project cannot claim while the first runs', () => {
  expect(fact('blocked').status).toBe('queued')
})

dbTest('a blocked turn leaves the row exactly as it found it', () => {
  // Not failed, not idle, not running, and no error text: the session is
  // waiting, and nothing about it should look like it went wrong.
  const f = fact('blocked')
  expect(f.status).toBe('queued')
  expect(f.lastError).toBeNull()
  expect(f.untouched).toBe(true)
})

dbTest('a blocked turn leaves its message pending and says nothing in the transcript', () => {
  const f = fact('blocked')
  expect(f.pendingLeft).toBe(1)
  expect(f.promptStillPending).toBe(true)
  // Only the prompt that was seeded. A blocked turn is not an event.
  expect(f.transcriptRows).toBe(1)
})

dbTest('a blocked turn re-queues itself, delayed, so nothing has to wake it', () => {
  // The single most important assertion in this file: a session left at
  // `queued` with a pending message and no job behind it is the original bug
  // in a new shape.
  const f = fact('blocked')
  const jobs = f.jobs as { name: string; opts: { delay?: number } }[]
  expect(jobs).toHaveLength(2)
  expect(jobs[0]?.name).toBe('turn')
  expect(jobs[0]?.opts?.delay).toBe(5000)
  // A second delivery while still blocked does the same again, and still does
  // not touch the row.
  expect(jobs[1]?.opts?.delay).toBe(5000)
  expect(f.statusAfterSecondDelivery).toBe('queued')
})

dbTest('once the first session stops running, the waiting one claims and runs', () => {
  const f = fact('unblocked')
  expect(f.status).toBe('completed')
  expect(f.pendingLeft).toBe(0)
  // The two retries from while it was blocked, and no third: a turn that ran
  // does not re-queue itself.
  expect(f.jobs).toBe(2)
})

dbTest('enqueueSessionRun passes the delay through to BullMQ, and only when asked', () => {
  const jobs = fact<unknown>('enqueueOptions') as { data: unknown; opts?: unknown }[]
  expect(jobs[0]).toMatchObject({ data: { sessionId: 'plain' } })
  expect(jobs[0]?.opts).toBeUndefined()
  expect(jobs[1]).toMatchObject({ data: { sessionId: 'delayed' }, opts: { delay: 5000 } })
})

dbTest('a blocked turn whose re-enqueue is refused still keeps the message', () => {
  // Deliberately not asserting *how* this is handled: leaving the row `queued`
  // for the next send to nudge and failing it with a visible error are both
  // defensible, and the queue being down breaks every session on the box
  // either way. What is not defensible is losing the prompt, or marking the
  // turn done. See the report for what happens today.
  const f = fact('blockedEnqueueFails')
  expect(f.pendingLeft).toBe(1)
  expect(['queued', 'failed']).toContain(f.status)
  expect(f.jobs).toBe(0)
})

// --- a claim whose own statement fails -----------------------------------------
//
// Not the predicate refusing the claim — that is the blocked case above, and it
// returns normally. This is the statement itself failing: `claimTurn` rethrows
// anything that is not SQLSTATE 55P03, so `runTurn` throws with nothing
// claimed. Reproduced by an AFTER UPDATE trigger on the session's own row, so
// the claim's write to `running` really happens and is then rolled back with
// the statement that made it — standing in for the connection being terminated
// under the claim, a lock timeout, or a constraint.

dbTest('a claim whose statement fails leaves the session exactly where it was', () => {
  const f = fact('claimStatementFails')
  // It threw, and from the claim: the only UPDATE of `sessions` that runs
  // before a turn owns anything.
  expect(f.threw).not.toBe('')
  expect(String(f.threw)).toContain('update "sessions"')
  // Rolled back, not half-claimed. `running` here would be a session nothing
  // is executing, which the UI will not delete and will queue messages behind.
  expect(f.status).toBe('queued')
  expect(f.lastError).toBeNull()
  expect(f.untouched).toBe(true)
})

dbTest('the failed claim keeps the pending message and says nothing in the transcript', () => {
  const f = fact('claimStatementFails')
  expect(f.pendingLeft).toBe(1)
  // Only the prompt the fixture seeded: a claim that never happened is not an
  // event, and must not spend the session's error line either.
  expect(f.transcriptRows).toBe(1)
})

dbTest('the row is still runnable afterwards, and only a fresh delivery runs it', () => {
  // The second half is the risk, recorded rather than worked around: nothing
  // re-queues this session. The job is `attempts: 1` (queue/index.ts), the
  // throw only reaches `worker.on('failed')`, which logs, and `sendMessage`
  // re-enqueues on 'idle' | 'completed' | 'failed' | 'interrupted' only
  // (features/sessions/service.ts) — never on 'queued'. So the row stays
  // runnable, as this asserts, but until something delivers another job for it
  // nothing will run it. See the report.
  const f = fact('claimStatementFails')
  expect(f.jobs).toBe(0)
  expect(f.statusAfterRedelivery).toBe('completed')
  expect(f.pendingAfterRedelivery).toBe(0)
})

dbTest('a claim that fails after locking the shared checkout is left the same way', () => {
  // The other arm of the `OR`: this session has no worktree, so the claim held
  // a `FOR UPDATE NOWAIT` lock over its project's rows when the failure landed.
  // Same outcome required, and the turn that runs after it is what shows the
  // lock went away with the statement rather than outliving it.
  const f = fact('claimStatementFailsShared')
  expect(f.threw).not.toBe('')
  expect(f.status).toBe('queued')
  expect(f.lastError).toBeNull()
  expect(f.pendingLeft).toBe(1)
  expect(f.jobs).toBe(0)
  expect(f.statusAfterRedelivery).toBe('completed')
})

// --- the branch that must not have changed -------------------------------------

dbTest('a turn another worker already claimed is dropped, not re-queued', () => {
  // The lost-claim branch. Re-queueing here would let a duplicate delivery
  // spin against a session that is running perfectly well.
  const f = fact('lostClaim')
  expect(f.runningStatus).toBe('running')
  expect(f.runningRequeues).toBe(0)
  expect(f.completedStatus).toBe('completed')
  expect(f.completedRequeues).toBe(0)
})

dbTest('the dropped turn writes nothing and leaves the pending message alone', () => {
  const f = fact('lostClaim')
  expect(f.runningTranscriptRows).toBe(1)
  expect(f.runningPendingLeft).toBe(1)
})

dbTest('a job for a session that no longer exists is dropped without throwing', () => {
  const f = fact('lostClaim')
  expect(f.deletedThrew).toBe('')
  expect(f.deletedRequeues).toBe(0)
})

dbTest('a session that is already running cannot claim a second turn', () => {
  // Per-session serialization, for the non-isolated case specifically: the
  // sibling subquery excludes the row itself, so `status = 'queued'` is the
  // only thing standing between one session and two concurrent turns.
  const f = fact('lostClaim')
  expect(f.nonIsolatedRunningStatus).toBe('running')
  expect(f.nonIsolatedRunningRequeues).toBe(0)
})

// --- two claims that overlap ---------------------------------------------------

// DEFECT (reported, not worked around): the mutual exclusion above is not a
// mutex. Both halves of it — the `NOT EXISTS` read and the row it writes — run
// in one autocommit statement under READ COMMITTED, so a sibling claim that has
// taken effect but not yet committed is invisible to it. Two non-isolated
// sessions in one project whose turns are picked up at the same instant, which
// is exactly what WORKER_CONCURRENCY above 1 makes possible, therefore both
// claim and both run in the one shared checkout the predicate exists to
// protect. Reproduced deterministically here by holding the first claim open in
// a transaction; the probe below hits it 1-5 times in 20 with no help at all.
dbTest('a claim cannot succeed while a sibling claim is in flight', () => {
  const f = fact('uncommittedSibling')
  expect(f.timedOut).toBe(false)
  // `idle` means it claimed: two turns, one working tree, one git index.
  expect(f.waiterStatus).toBe('queued')
  expect(f.requeues).toBe(1)
})

dbTest('a turn refused in that race is left queued, never failed or idle', () => {
  // Whatever the race decides, neither session may end up in a state nothing
  // will pick up again. This holds for every iteration of the probe.
  const f = fact('simultaneousNonIsolated')
  const outcomes = (f.outcomes as string[][]).flat()
  expect(outcomes).toHaveLength(2 * (f.iterations as number))
  expect(outcomes.filter((s) => s !== 'completed' && s !== 'queued')).toEqual([])
})
