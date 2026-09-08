// The prompt-generation transaction, probed at its boundaries against a real
// Postgres: a comment that commits *while* the transaction is open, and a
// retry that must reuse the stored digest without un-consuming anything.
//
// ideas-routes-db-child.ts already covers the sequential cases — the happy
// followup, and a `failed` prompt's retry — and both pass. What neither can
// reach is the interleaving the transaction exists for. Nothing here is a
// race in the "run two things and hope" sense: the interleave is forced with
// a table-level lock taken on a second connection, so the transaction is
// stopped at a known statement boundary and the concurrent comment commits at
// exactly the moment that matters.
//
// createIdeaPrompt's followup branch runs, in order:
//   SELECT the latest prompt -> SELECT the closed run -> SELECT the last
//   ready prompt -> SELECT the unconsumed comments -> loadIdeaInput (SELECT
//   idea_blocks / idea_groups / idea_files) -> UPDATE those comments'
//   consumedAt -> INSERT the pending row.
// An ACCESS EXCLUSIVE lock on idea_blocks therefore parks it precisely
// between the comment SELECT and the comment UPDATE — the one window in which
// "marked but never folded in" would be observable if the UPDATE keyed on
// `consumed_at IS NULL` instead of on the ids it actually folded.
//
// The child gathers facts; every assertion lives in idea-prompt-tx.test.ts.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

/** Every job handed to BullMQ's `Queue.add`, in order. */
const enqueued: { name: string; data: unknown }[] = []
let enqueueThrows = false

mock.module('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown) {
      if (enqueueThrows) throw new Error('Stream is not writeable and enableOfflineQueue is false')
      enqueued.push({ name, data })
      return { id: `job-${enqueued.length}` }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
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

const postgres = (await import('postgres')).default
const { and, eq, isNull } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { ideaComments, ideaPrompts, ideaRuns, ideas, projects } = await import('@/db/schema')
const { env } = await import('@/env')
const { createIdeaComment, createIdeaPrompt } = await import('@/features/ideas/service')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { ideasRouter } = await import('@/features/ideas/routes')

// Mounted the way app.ts mounts it, so the HTTP case below exercises the real
// route and the real error envelope rather than the service alone.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', ideasRouter)

const facts: Record<string, unknown> = {}

/** A second connection, purely to hold locks and commit behind the
 * transaction under test. Never used for anything the app itself does. */
const side = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} })

async function newProject(): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      name: 'demo',
      slug: `demo-${randomUUID().slice(0, 8)}`,
      source: 'empty',
      status: 'ready',
    })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

/** An idea already past one closed run with one successfully generated
 * prompt — the two preconditions a followup needs. */
async function ideaReadyForFollowup(projectId: string): Promise<string> {
  const [idea] = await db
    .insert(ideas)
    .values({ projectId, title: 'demo idea', orchestrator: 'coder', boardPosition: 0 })
    .returning()
  if (!idea) throw new Error('no idea row')
  await db.insert(ideaRuns).values({
    ideaId: idea.id,
    kind: 'initial',
    status: 'closed',
    outcome: 'finished',
    detail: 'Implemented the thing.',
    endedAt: new Date(),
  })
  await db.insert(ideaPrompts).values({
    ideaId: idea.id,
    kind: 'initial',
    sourceDigest: '# demo idea\n',
    status: 'ready',
    generatedTitle: 'Build the thing',
    generatedText: 'Build the thing, please.',
    completedAt: new Date(),
  })
  return idea.id
}

const commentRow = async (id: string) => {
  const [row] = await db.select().from(ideaComments).where(eq(ideaComments.id, id)).limit(1)
  return row
}

const promptRows = (ideaId: string) =>
  db.select().from(ideaPrompts).where(eq(ideaPrompts.ideaId, ideaId))

/** Wait until the connection running `createIdeaPrompt` is actually parked on
 * the lock, rather than guessing with a sleep. */
async function waitForBlockedLock(): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    const rows = await side`select count(*)::int as n from pg_locks where not granted`
    if ((rows[0]?.n ?? 0) > 0) return true
    await Bun.sleep(10)
  }
  return false
}

async function main() {
  const projectId = await newProject()

  // --- a comment that commits mid-transaction ---------------------------------
  {
    const idea = await ideaReadyForFollowup(projectId)
    const early = await createIdeaComment(idea, { body: 'EARLY: fold me in' })

    let blockedResolve: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      blockedResolve = resolve
    })
    let lockedResolve: () => void = () => {}
    // Awaited before the call under test starts: without it the LOCK and the
    // transaction race each other to the table, and a run where the SELECT
    // wins is a sequential test wearing a concurrent test's name.
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve
    })

    // Park the transaction between its comment SELECT and its comment UPDATE.
    const gate = side.begin(async (tx) => {
      await tx`lock table idea_blocks in access exclusive mode`
      lockedResolve()
      await blocked
      await tx`insert into idea_comments (idea_id, body) values (${idea}, ${'LATE: arrived mid-transaction'})`
    })
    await locked

    const inFlight = createIdeaPrompt(idea, { kind: 'followup' })
    const parked = await waitForBlockedLock()
    blockedResolve()
    await gate

    const prompt = await inFlight
    const [late] = await db
      .select()
      .from(ideaComments)
      .where(and(eq(ideaComments.ideaId, idea), eq(ideaComments.body, 'LATE: arrived mid-transaction')))

    facts.commentMidTransaction = {
      parked,
      // The comment that was already there: folded in AND marked.
      earlyInDigest: prompt.sourceDigest.includes('EARLY: fold me in'),
      earlyConsumed: Boolean((await commentRow(early.id))?.consumedAt),
      // The one that landed mid-transaction: neither. Not folded in, so it
      // must not be marked — it has to survive for the next followup.
      lateInDigest: prompt.sourceDigest.includes('LATE: arrived mid-transaction'),
      lateConsumed: Boolean(late?.consumedAt),
      lateExists: Boolean(late),
      promptStatus: prompt.status,
      // Enqueued once, after the commit.
      enqueuedPromptId: (enqueued.at(-1)?.data as { promptId?: string } | undefined)?.promptId ===
        prompt.id,
    }

    // ...and a second followup, now that nothing is in flight, picks the late
    // comment up rather than losing it. This is the other half of "never
    // marked without being folded in".
    await db
      .update(ideaPrompts)
      .set({ status: 'ready', generatedText: 'Build the thing, please.', completedAt: new Date() })
      .where(eq(ideaPrompts.id, prompt.id))
    const next = await createIdeaPrompt(idea, { kind: 'followup' })
    facts.lateCommentSurvives = {
      inNextDigest: next.sourceDigest.includes('LATE: arrived mid-transaction'),
      consumedNow: Boolean((await commentRow(late?.id ?? ''))?.consumedAt),
      // Not folded in twice: the early one was consumed by the first attempt.
      earlyNotRefolded: !next.sourceDigest.includes('EARLY: fold me in'),
    }
  }

  // --- a pending prompt's retry -----------------------------------------------
  //
  // ideas-routes-db-child.ts covers the `failed` retry. `pending` is the other
  // half of the same predicate, and the one the module's own "known gap" note
  // is about: a worker killed mid-generation leaves the row pending forever.
  {
    const idea = await ideaReadyForFollowup(projectId)
    const consumedAt = new Date(Date.now() - 90_000)
    const [alreadyFolded] = await db
      .insert(ideaComments)
      .values({ ideaId: idea, body: 'folded into the stuck attempt', consumedAt })
      .returning()
    const arrivedAfter = await createIdeaComment(idea, { body: 'arrived after it got stuck' })

    const STUCK_DIGEST = '## Follow-up for: demo idea\n\nDIGEST FROM THE STUCK ATTEMPT\n'
    const [stuck] = await db
      .insert(ideaPrompts)
      .values({ ideaId: idea, kind: 'followup', sourceDigest: STUCK_DIGEST, status: 'pending' })
      .returning()

    const before = enqueued.length
    const retried = await createIdeaPrompt(idea, { kind: 'followup' })
    const [stuckAfter] = await db
      .select()
      .from(ideaPrompts)
      .where(eq(ideaPrompts.id, stuck?.id ?? ''))

    facts.pendingRetry = {
      digestCopiedVerbatim: retried.sourceDigest === STUCK_DIGEST,
      retriedIsNewRow: retried.id !== stuck?.id,
      retriedStatus: retried.status,
      stuckRowStatus: stuckAfter?.status,
      // Nothing un-consumed: the same timestamp, to the millisecond.
      alreadyFoldedTimestampUnchanged:
        (await commentRow(alreadyFolded?.id ?? ''))?.consumedAt?.getTime() === consumedAt.getTime(),
      // And nothing newly consumed either: this digest never saw it.
      arrivedAfterStillUnconsumed: !(await commentRow(arrivedAfter.id))?.consumedAt,
      arrivedAfterInDigest: retried.sourceDigest.includes('arrived after it got stuck'),
      enqueuedDelta: enqueued.length - before,
    }
  }

  // --- the same thing through the real HTTP route -----------------------------
  {
    const idea = await ideaReadyForFollowup(projectId)
    const c1 = await createIdeaComment(idea, { body: 'over HTTP: add X' })
    const before = enqueued.length
    const res = await app.request(`/api/ideas/${idea}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'followup' }),
    })
    const body = (await res.json()) as { id?: string; status?: string; sourceDigest?: string }
    facts.overHttp = {
      status: res.status,
      promptStatus: body.status,
      digestHasComment: body.sourceDigest?.includes('over HTTP: add X'),
      consumed: Boolean((await commentRow(c1.id))?.consumedAt),
      enqueuedDelta: enqueued.length - before,
      enqueuedThisPrompt:
        (enqueued.at(-1)?.data as { promptId?: string } | undefined)?.promptId === body.id,
      rowCount: (await promptRows(idea)).length,
    }
  }

  // --- two followups racing, with no forced ordering ---------------------------
  //
  // Deliberately assertion-light and interleaving-independent: whichever of
  // the two wins, the invariant has to hold for every comment — folded into
  // at least one digest if and only if it is marked consumed.
  {
    const idea = await ideaReadyForFollowup(projectId)
    const bodies = ['racing A', 'racing B', 'racing C']
    const created = []
    for (const body of bodies) created.push(await createIdeaComment(idea, { body }))

    const errors: string[] = []
    const settled = await Promise.allSettled([
      createIdeaPrompt(idea, { kind: 'followup' }),
      createIdeaPrompt(idea, { kind: 'followup' }),
    ])
    const digests: string[] = []
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') digests.push(outcome.value.sourceDigest)
      else errors.push(String(outcome.reason?.message ?? outcome.reason))
    }

    const perComment = []
    for (const c of created) {
      const row = await commentRow(c.id)
      perComment.push({
        body: c.body,
        consumed: Boolean(row?.consumedAt),
        foldedIntoCount: digests.filter((d) => d.includes(c.body)).length,
      })
    }
    const stillUnconsumed = await db
      .select()
      .from(ideaComments)
      .where(and(eq(ideaComments.ideaId, idea), isNull(ideaComments.consumedAt)))

    facts.concurrentFollowups = {
      errors,
      promptRows: (await promptRows(idea)).length,
      perComment,
      unconsumedLeft: stillUnconsumed.length,
      // Every comment folded in at least once, and consumed exactly when it was.
      invariantHolds: perComment.every((c) => c.consumed === c.foldedIntoCount > 0),
    }
  }

  // --- what a queue failure after the commit actually leaves behind ------------
  //
  // Not a defect claim on its own: the module's own docblock says the enqueue
  // happens after the commit precisely so the digest and the consumedAt
  // stamps are written together. This records the cost of that ordering when
  // the enqueue is what fails, since nothing re-drives such a row.
  {
    const idea = await ideaReadyForFollowup(projectId)
    const c1 = await createIdeaComment(idea, { body: 'consumed by a prompt nobody will run' })
    enqueueThrows = true
    let threw = ''
    try {
      await createIdeaPrompt(idea, { kind: 'followup' })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    enqueueThrows = false
    const rows = await promptRows(idea)
    facts.enqueueFailure = {
      threw,
      promptRowsForIdea: rows.length,
      pendingRows: rows.filter((r) => r.status === 'pending').length,
      commentConsumed: Boolean((await commentRow(c1.id))?.consumedAt),
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await side.end({ timeout: 5 })
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await side.end({ timeout: 5 }).catch(() => {})
    await closeDb().catch(() => {})
    process.exit(1)
  })
