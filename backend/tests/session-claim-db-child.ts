// Runs every turn-claim scenario once, against the throwaway cluster its
// parent started, and prints what happened as JSON.
//
// A child process rather than more `mock.module` calls, for the reason
// attachments-db-child.ts gives: `@/env` parses process.env at first import
// and bun shares one module registry across the whole test run, so
// DATABASE_URL cannot be re-pointed for one file without re-pointing it for
// every other. It matters more here than anywhere else, because the thing
// under test *is* a SQL predicate — a correlated `NOT EXISTS` inside the
// claim's `UPDATE ... WHERE`. The fake `db` in session-recovery.test.ts
// ignores `where()` entirely and always answers the claim with a fixed row, so
// nothing that runs against it can tell a claim that succeeded from one that
// was refused. Only a real Postgres can.
//
// Redis, BullMQ and the Agent SDK are still faked: none of them is what is
// being tested, and the fake `Queue` is what lets the blocked branch's
// re-enqueue (and its delay) be observed as the arguments BullMQ would really
// have been given. Assertions live in session-claim-db.test.ts.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

// --- fakes, registered before anything imports the modules that use them -----

/** A session whose enqueue Redis refuses, standing in for a queue going down. */
let rejectEnqueueFor = ''
/** Every job `enqueueSessionRun` really handed to BullMQ, with its options. */
const enqueued: { queue: string; name: string; data: unknown; opts: unknown }[] = []
/** Options `startSessionRunWorker` constructs its Worker with. */
let workerOptions: Record<string, unknown> = {}

mock.module('bullmq', () => ({
  Queue: class {
    constructor(private readonly queueName: string) {}
    async add(name: string, data: unknown, opts: unknown) {
      const { sessionId } = data as { sessionId?: string }
      if (sessionId && sessionId === rejectEnqueueFor) {
        throw new Error('Stream is not writeable and enableOfflineQueue is false')
      }
      enqueued.push({ queue: this.queueName, name, data, opts })
      return { id: `job-${enqueued.length}` }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    constructor(_name: string, _processor: unknown, options: Record<string, unknown>) {
      workerOptions = options
    }
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

// The bus is a no-op rather than a fake server: every scenario below asserts on
// database rows, and a publish against a Redis that is not there costs seconds.
mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

/** What the SDK does for the next turn that gets far enough to call it. */
let turnBehaviour: () => AsyncIterable<unknown> = () => succeed()
/** How many turns are inside the SDK call right now. */
let inside = 0

async function* succeed(): AsyncIterable<unknown> {
  yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => turnBehaviour(),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

// optionsFor syncs the plugin directory and shells out to git in a checkout
// that does not exist here. Nothing below is about what an agent is granted.
mock.module(`${SRC}/features/sessions/runner-options.ts`, () => ({
  optionsFor: async () => ({ cwd: '/tmp' }),
  delegationHook: () => async () => ({}),
}))

const { and, eq, sql } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { messages, projects, sessions } = await import(`${SRC}/db/schema.ts`)
const { env } = await import(`${SRC}/env.ts`)
const { enqueueSessionRun } = await import(`${SRC}/queue/index.ts`)
const { runTurn, startSessionRunWorker } = await import(`${SRC}/queue/session-run.worker.ts`)

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      name,
      slug: `${name}-${randomUUID().slice(0, 8)}`,
      source: 'existing',
      status: 'ready',
    })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

type Status = 'idle' | 'queued' | 'running' | 'interrupted' | 'completed' | 'failed'

async function newSession(
  projectId: string,
  status: Status,
  worktreePath: string | null,
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, status, worktreePath, orchestrator: 'orchestrator' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

/** A prompt waiting to be answered, exactly as `sendMessage` leaves one. */
async function pendingPrompt(sessionId: string, text: string): Promise<string> {
  const [row] = await db
    .update(sessions)
    .set({ nextSeq: 1 })
    .where(eq(sessions.id, sessionId))
    .returning({ seq: sessions.nextSeq })
  const [message] = await db
    .insert(messages)
    .values({
      sessionId,
      seq: (row?.seq ?? 1) - 1,
      type: 'prompt',
      pending: true,
      payload: { text },
    })
    .returning()
  if (!message) throw new Error('no message row')
  return message.id
}

const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]

const statusOf = async (id: string) => (await sessionRow(id))?.status

const pendingCount = async (id: string) => {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, id), eq(messages.pending, true)))
  return rows.length
}

const rowCount = async (id: string) =>
  (await db.select().from(messages).where(eq(messages.sessionId, id))).length

/** Jobs enqueued for one session, oldest first. */
const jobsFor = (id: string) =>
  enqueued.filter((j) => (j.data as { sessionId?: string }).sessionId === id)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(10)
  }
  return condition()
}

/** A turn that parks inside the SDK until it is let go. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  turnBehaviour = () =>
    (async function* () {
      inside++
      try {
        await opened
        yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      } finally {
        inside--
      }
    })()
  return { open }
}

/**
 * Claim one turn and report only what the claim did, without running one.
 *
 * A session with nothing pending takes the shortest path there is out of
 * `runTurn`: claim, load the project, find no prompt, set `idle`. So `idle`
 * means the claim succeeded and `queued` means it did not — with no SDK, no
 * transcript and no timing involved.
 */
async function claimOnly(sessionId: string): Promise<Status | undefined> {
  turnBehaviour = () => succeed()
  await runTurn({ sessionId })
  return (await statusOf(sessionId)) as Status | undefined
}

// --- scenarios ---------------------------------------------------------------

async function main() {
  facts.config = {
    workerConcurrencyDefault: env.WORKER_CONCURRENCY,
  }
  {
    const worker = startSessionRunWorker()
    facts.config = { ...(facts.config as object), workerConcurrency: workerOptions.concurrency }
    await (worker as { close: () => Promise<void> }).close()
  }

  // --- the regression: two projects, two worktrees, genuinely at once --------
  {
    const a = await newProject('alpha')
    const b = await newProject('bravo')
    const sa = await newSession(a, 'queued', '/tmp/wt-alpha')
    const sb = await newSession(b, 'queued', '/tmp/wt-bravo')
    await pendingPrompt(sa, 'work on alpha')
    await pendingPrompt(sb, 'work on bravo')

    const { open } = gate()
    const turns = Promise.all([runTurn({ sessionId: sa }), runTurn({ sessionId: sb })])
    const bothInside = await waitFor(() => inside === 2)
    const statusesWhileInside = [await statusOf(sa), await statusOf(sb)]
    open()
    await turns

    facts.crossProjectConcurrent = {
      bothInside,
      statusesWhileInside,
      finalA: await statusOf(sa),
      finalB: await statusOf(sb),
      pendingLeftA: await pendingCount(sa),
      pendingLeftB: await pendingCount(sb),
      requeues: jobsFor(sa).length + jobsFor(sb).length,
    }
  }

  // --- two isolated sessions in one project, also at once ---------------------
  {
    const p = await newProject('charlie')
    const sa = await newSession(p, 'queued', '/tmp/wt-c1')
    const sb = await newSession(p, 'queued', '/tmp/wt-c2')
    await pendingPrompt(sa, 'one')
    await pendingPrompt(sb, 'two')

    const { open } = gate()
    const turns = Promise.all([runTurn({ sessionId: sa }), runTurn({ sessionId: sb })])
    const bothInside = await waitFor(() => inside === 2)
    const statusesWhileInside = [await statusOf(sa), await statusOf(sb)]
    open()
    await turns

    facts.sameProjectIsolatedConcurrent = {
      bothInside,
      statusesWhileInside,
      finalA: await statusOf(sa),
      finalB: await statusOf(sb),
      requeues: jobsFor(sa).length + jobsFor(sb).length,
    }
  }

  // --- an isolated session is never restrained by a sibling -------------------
  {
    const p = await newProject('delta')
    const running = await newSession(p, 'running', '/tmp/wt-d1')
    const isolated = await newSession(p, 'queued', '/tmp/wt-d2')
    const behindNonIsolated = await newSession(p, 'queued', '/tmp/wt-d3')
    const nonIsolatedRunning = await newSession(p, 'running', null)

    facts.isolatedNeverBlocked = {
      behindIsolatedSibling: await claimOnly(isolated),
      behindNonIsolatedSibling: await claimOnly(behindNonIsolated),
      // Set up so the second claim above really did have a non-isolated
      // sibling running next to it.
      blockerStatus: await statusOf(nonIsolatedRunning),
      requeues: jobsFor(isolated).length + jobsFor(behindNonIsolated).length,
    }
  }

  // --- ...and only a *non-isolated* sibling restrains a non-isolated session --
  //
  // The other half of that rule, and the one nothing else here would catch: a
  // session sharing the checkout is held back by another session sharing the
  // checkout, not by one that has a worktree of its own to work in.
  {
    const p = await newProject('delta-two')
    await newSession(p, 'running', '/tmp/wt-d4')
    const sharing = await newSession(p, 'queued', null)

    facts.nonIsolatedBehindIsolated = {
      status: await claimOnly(sharing),
      requeues: jobsFor(sharing).length,
    }
  }

  // --- the new mutual exclusion, and its release ------------------------------
  {
    const p = await newProject('echo')
    const holder = await newSession(p, 'running', null)
    const waiter = await newSession(p, 'queued', null)
    const prompt = await pendingPrompt(waiter, 'please run me')
    const before = await sessionRow(waiter)

    await runTurn({ sessionId: waiter })
    const blocked = await sessionRow(waiter)

    // A second delivery while still blocked must behave identically: no
    // status change, no transcript row, one more delayed retry.
    await runTurn({ sessionId: waiter })

    facts.blocked = {
      status: blocked?.status,
      lastError: blocked?.lastError,
      untouched: blocked?.updatedAt?.getTime() === before?.updatedAt?.getTime(),
      pendingLeft: await pendingCount(waiter),
      promptStillPending: (
        await db.select().from(messages).where(eq(messages.id, prompt)).limit(1)
      )[0]?.pending,
      transcriptRows: await rowCount(waiter),
      jobs: jobsFor(waiter),
      statusAfterSecondDelivery: await statusOf(waiter),
    }

    // The holder finishes; the waiter must now be claimable and must run.
    await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, holder))
    turnBehaviour = () => succeed()
    await runTurn({ sessionId: waiter })

    facts.unblocked = {
      status: await statusOf(waiter),
      pendingLeft: await pendingCount(waiter),
      // The two retries from while it was blocked, and nothing new.
      jobs: jobsFor(waiter).length,
    }
  }

  // --- ...and a non-isolated session in another project is not restrained -----
  {
    const p1 = await newProject('foxtrot')
    const p2 = await newProject('golf')
    await newSession(p1, 'running', null)
    const other = await newSession(p2, 'queued', null)

    facts.nonIsolatedCrossProject = {
      status: await claimOnly(other),
      requeues: jobsFor(other).length,
    }
  }

  // --- a claim genuinely lost to another worker -------------------------------
  {
    const p = await newProject('hotel')
    const taken = await newSession(p, 'running', '/tmp/wt-h1')
    await pendingPrompt(taken, 'someone else has this')
    const finished = await newSession(p, 'completed', '/tmp/wt-h2')
    const nonIsolatedTaken = await newSession(p, 'running', null)
    const gone = randomUUID()

    await runTurn({ sessionId: taken })
    await runTurn({ sessionId: finished })
    await runTurn({ sessionId: nonIsolatedTaken })
    let deletedThrew = ''
    try {
      await runTurn({ sessionId: gone })
    } catch (error) {
      deletedThrew = error instanceof Error ? error.message : String(error)
    }

    facts.lostClaim = {
      runningStatus: await statusOf(taken),
      runningRequeues: jobsFor(taken).length,
      runningTranscriptRows: await rowCount(taken),
      runningPendingLeft: await pendingCount(taken),
      completedStatus: await statusOf(finished),
      completedRequeues: jobsFor(finished).length,
      // Per-session serialization for the non-isolated case: the sibling
      // subquery excludes the row itself, so only `status = 'queued'` stops a
      // session that is already running from claiming a second turn.
      nonIsolatedRunningStatus: await statusOf(nonIsolatedTaken),
      nonIsolatedRunningRequeues: jobsFor(nonIsolatedTaken).length,
      deletedRequeues: jobsFor(gone).length,
      deletedThrew,
    }
  }

  // --- a blocked turn whose re-enqueue is refused ------------------------------
  //
  // The retry is the only thing that will ever run this session again, and it
  // is one Redis round trip. Whatever happens when that round trip fails, the
  // operator's message must still be there to run.
  {
    const p = await newProject('kilo')
    await newSession(p, 'running', null)
    const waiter = await newSession(p, 'queued', null)
    await pendingPrompt(waiter, 'do not lose me')

    rejectEnqueueFor = waiter
    let threw = ''
    try {
      await runTurn({ sessionId: waiter })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    rejectEnqueueFor = ''

    facts.blockedEnqueueFails = {
      threw,
      status: await statusOf(waiter),
      pendingLeft: await pendingCount(waiter),
      jobs: jobsFor(waiter).length,
      transcriptRows: await rowCount(waiter),
    }
  }

  // --- a claim whose own statement fails ---------------------------------------
  //
  // The claim is the only thing that moves a session off `queued`, and it is a
  // statement that can fail for reasons that have nothing to do with its
  // predicate: the connection terminated under it, a lock timeout, a trigger or
  // a constraint. `claimTurn` rethrows anything that is not a lock conflict, so
  // `runTurn` throws with nothing claimed — and with `attempts: 1` on the queue
  // that job is not retried. What the row is left as is therefore the whole
  // story.
  //
  // Injected as an AFTER UPDATE trigger scoped to the one session under test:
  // after rather than before, so the claim's write to `running` really happens
  // and then has to be rolled back with the statement that made it. Nothing
  // gentler fails a claim deterministically from outside the worker's own
  // process. Run twice, because the two arms of the claim's `OR` reach the
  // UPDATE by different routes: a session with a worktree short-circuits, while
  // a session sharing the checkout has taken the `FOR UPDATE NOWAIT` lock over
  // its project by the time the failure lands.
  {
    await db.execute(
      sql.raw(
        `create or replace function agentoo_break_claim() returns trigger language plpgsql as $$ begin raise exception 'injected claim failure'; end $$`,
      ),
    )

    const claimFailure = async (name: string, worktreePath: string | null) => {
      const p = await newProject(name)
      const failing = await newSession(p, 'queued', worktreePath)
      await pendingPrompt(failing, 'do not lose me either')
      const before = await sessionRow(failing)

      await db.execute(
        sql.raw(
          `create trigger agentoo_break_claim after update on sessions for each row when (new.id = '${failing}') execute function agentoo_break_claim()`,
        ),
      )
      let threw = ''
      try {
        await runTurn({ sessionId: failing })
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error)
      }
      const after = await sessionRow(failing)
      const outcome = {
        threw,
        status: after?.status,
        lastError: after?.lastError,
        untouched: after?.updatedAt?.getTime() === before?.updatedAt?.getTime(),
        pendingLeft: await pendingCount(failing),
        transcriptRows: await rowCount(failing),
        jobs: jobsFor(failing).length,
      }
      await db.execute(sql.raw('drop trigger agentoo_break_claim on sessions'))

      // With the failure gone the next delivery must find a row it can still
      // claim and run to the end: leaving it `queued` is only worth anything
      // if it is still runnable. For the shared-checkout case this is also
      // what shows the lock the failed claim took was released with it.
      turnBehaviour = () => succeed()
      await runTurn({ sessionId: failing })

      return {
        ...outcome,
        statusAfterRedelivery: await statusOf(failing),
        pendingAfterRedelivery: await pendingCount(failing),
      }
    }

    facts.claimStatementFails = await claimFailure('lima', '/tmp/wt-l1')
    facts.claimStatementFailsShared = await claimFailure('lima-shared', null)
  }

  // --- what enqueueSessionRun really hands BullMQ ------------------------------
  {
    const before = enqueued.length
    await enqueueSessionRun({ sessionId: 'plain' })
    await enqueueSessionRun({ sessionId: 'delayed' }, { delayMs: 5_000 })
    facts.enqueueOptions = enqueued.slice(before)
  }

  // --- a sibling claim that has run but not yet committed ---------------------
  //
  // The same collision as the probe below, made deterministic. A claim is a
  // single autocommit statement, so "two turns claiming at the same moment" is
  // exactly "one claim has taken effect and not yet committed while the other
  // evaluates its predicate". That is reproduced here by holding the first
  // claim open in an explicit transaction on its own connection and letting
  // the real `runTurn` claim the sibling from the pool: the `NOT EXISTS`
  // subquery reads under its own snapshot, in which the holder is not running
  // yet.
  //
  // `claimOnly` (no pending prompt) so the answer is one status and no timing:
  // `queued` means the predicate held, `idle` means both sessions were handed
  // the same shared checkout.
  {
    const postgres = (await import('postgres')).default
    const raw = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })
    const p = await newProject('juliet')
    const holder = await newSession(p, 'queued', null)
    const waiter = await newSession(p, 'queued', null)
    let waiterStatus: string | undefined
    let timedOut = false
    try {
      await raw.begin(async (tx) => {
        await tx`update sessions set status = 'running' where id = ${holder}`
        // Bounded: if a future implementation takes a lock that makes this
        // wait for the open transaction, that is a pass, not a hung suite.
        const claim = claimOnly(waiter).then((status) => {
          waiterStatus = status
        })
        await Promise.race([
          claim,
          sleep(5_000).then(() => {
            timedOut = true
          }),
        ])
      })
      if (timedOut) await sleep(1_000)
    } finally {
      await raw.end()
    }
    facts.uncommittedSibling = {
      waiterStatus,
      timedOut,
      requeues: jobsFor(waiter).length,
      holderStatus: await statusOf(holder),
    }
  }

  // --- two non-isolated turns arriving together, nothing running yet ----------
  //
  // The state the predicate exists for, reached the way production reaches it:
  // two queued rows picked up by two worker slots at the same moment, rather
  // than one of them already marked `running` by the fixture.
  {
    const iterations = 20
    let bothClaimed = 0
    let oneClaimed = 0
    const outcomes: string[][] = []
    for (let i = 0; i < iterations; i++) {
      const p = await newProject(`india${i}`)
      const sa = await newSession(p, 'queued', null)
      const sb = await newSession(p, 'queued', null)
      await pendingPrompt(sa, 'first')
      await pendingPrompt(sb, 'second')

      const { open } = gate()
      const turns = Promise.all([runTurn({ sessionId: sa }), runTurn({ sessionId: sb })])
      await waitFor(() => inside === 2, 250)
      const claimedAtOnce = inside
      open()
      await turns

      if (claimedAtOnce === 2) bothClaimed++
      if (claimedAtOnce === 1) oneClaimed++
      outcomes.push([String(await statusOf(sa)), String(await statusOf(sb))])
    }
    facts.simultaneousNonIsolated = { iterations, bothClaimed, oneClaimed, outcomes }
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
