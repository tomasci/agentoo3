// Runs every database-backed ideas scenario once, against the throwaway
// cluster its parent (ideas-routes.test.ts) started, and prints what happened
// as JSON — same shape as session-claim-db-child.ts and
// idea-files-db-child.ts, which this mirrors: the child gathers facts, every
// assertion lives in the parent.
//
// Real Postgres is what proves these four things at all:
//   - two concurrent block creations get distinct seq values (a race on
//     ideas.next_seq, only observable against a real UPDATE ... RETURNING);
//   - a move whose neighbours' boardPosition gap is already exhausted
//     renumbers the whole column in one transaction rather than computing an
//     unusable midpoint;
//   - the followup prompt transaction stamps consumedAt on exactly the
//     comments that were unconsumed when it ran, and nothing else — and does
//     so atomically with the pending row's insert;
//   - a failed prompt's retry reuses its stored digest and touches no
//     comment, and the generation job is enqueued only once that transaction
//     has committed.
// A faked `db` answers `.where()` with a fixed row regardless of its
// predicate (see session-recovery.test.ts's own fake), which cannot
// distinguish any of these from their broken alternatives.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

// --- fakes, registered before anything imports the modules that use them ---

/** Every job handed to BullMQ's `Queue.add`, in the order it happened. */
const enqueued: { name: string; data: unknown }[] = []

mock.module('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown) {
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

const { and, eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { ideaComments, ideaPrompts, ideaRuns, ideas, projects } = await import('@/db/schema')
const {
  createIdea,
  createIdeaBlock,
  createIdeaComment,
  createIdeaPrompt,
  moveIdea,
} = await import('@/features/ideas/service')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { ideasRouter } = await import('@/features/ideas/routes')

// Mounted exactly the way app.ts mounts it for real (createApp() itself is
// not booted here — it also wires up every other feature's router and their
// own dependencies, none of which this file is about), so this exercises the
// real route, the real onError envelope, and a real — if empty — database,
// rather than a stubbed query chain that cannot tell a genuine 404 from a
// broken WHERE clause that happens to also return zero rows.

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

async function newProject(name: string, status: 'ready' | 'pending' = 'ready'): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}`, source: 'empty', status })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

type IdeaStatus = (typeof ideas.$inferSelect)['status']

async function newIdea(
  projectId: string,
  overrides: Partial<{
    orchestrator: string | null
    status: IdeaStatus
    boardPosition: number
  }> = {},
): Promise<string> {
  const created = await createIdea(projectId, { title: 'demo idea', orchestrator: 'coder' })
  if (Object.keys(overrides).length > 0) {
    await db
      .update(ideas)
      .set({
        ...('orchestrator' in overrides && { orchestrator: overrides.orchestrator ?? null }),
        ...('status' in overrides && { status: overrides.status }),
        ...('boardPosition' in overrides && { boardPosition: overrides.boardPosition }),
      })
      .where(eq(ideas.id, created.id))
  }
  return created.id
}

const commentRow = async (id: string) =>
  (await db.select().from(ideaComments).where(eq(ideaComments.id, id)).limit(1))[0]

const promptRows = async (ideaId: string) =>
  db.select().from(ideaPrompts).where(eq(ideaPrompts.ideaId, ideaId))

async function main() {
  // --- unknown idea -> 404 in the standard error envelope --------------------
  {
    const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
    app.route('/api', ideasRouter)
    const res = await app.request('/api/ideas/00000000-0000-4000-8000-000000000000')
    facts.unknownIdea404 = {
      status: res.status,
      body: await res.json(),
    }
  }

  // --- a full HTTP round trip through the OpenAPI-validated schemas ---------
  //
  // Everything above calls service.ts directly; this is the one scenario that
  // actually sends JSON through @hono/zod-openapi's request validation —
  // proof the discriminated block-content union, the geometry intersections,
  // and moveIdeaSchema all parse real request bodies, not just whatever
  // shape a direct TypeScript call happens to construct.
  {
    const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
    app.route('/api', ideasRouter)
    const project = await newProject('hotel')
    const postJson = (path: string, body: unknown) =>
      app.request(`/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    const patchJson = (path: string, body: unknown) =>
      app.request(`/api${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    const createRes = await postJson(`/projects/${project}/ideas`, {
      title: 'HTTP smoke idea',
      orchestrator: 'coder',
    })
    const idea = (await createRes.json()) as { id: string }

    const noteRes = await postJson(`/ideas/${idea.id}/blocks`, { kind: 'note', text: 'a note' })
    const linkRes = await postJson(`/ideas/${idea.id}/blocks`, {
      kind: 'link',
      url: 'https://example.com',
      label: 'Example',
    })
    const badBlockRes = await postJson(`/ideas/${idea.id}/blocks`, { kind: 'note' }) // missing text
    const note = (await noteRes.json()) as { id: string; text?: string; x?: number }
    const link = (await linkRes.json()) as { kind?: string; url?: string; label?: string }

    const patchRes = await patchJson(`/idea-blocks/${note.id}`, { text: 'an updated note', x: 12 })
    const patched = (await patchRes.json()) as { text?: string; x?: number }

    const moveRes = await postJson(`/ideas/${idea.id}/move`, { status: 'todo' })
    const moved = (await moveRes.json()) as { status?: string }

    const getRes = await app.request(`/api/ideas/${idea.id}`)
    const fetched = (await getRes.json()) as { blockCount?: number }

    facts.httpSmoke = {
      createStatus: createRes.status,
      createTitle: idea && 'title' in idea ? (idea as { title?: string }).title : undefined,
      noteStatus: noteRes.status,
      linkStatus: linkRes.status,
      linkKind: link.kind,
      linkUrl: link.url,
      linkLabel: link.label,
      badBlockStatus: badBlockRes.status,
      patchStatus: patchRes.status,
      patchedText: patched.text,
      patchedX: patched.x,
      moveStatus: moveRes.status,
      movedStatus: moved.status,
      getStatus: getRes.status,
      fetchedBlockCount: fetched.blockCount,
    }
  }

  // --- concurrent block creation gets distinct seq values --------------------
  {
    const project = await newProject('alpha')
    const idea = await newIdea(project)
    const [a, b] = await Promise.all([
      createIdeaBlock(idea, { kind: 'note', text: 'first' }),
      createIdeaBlock(idea, { kind: 'note', text: 'second' }),
    ])
    const [ideaRow] = await db.select().from(ideas).where(eq(ideas.id, idea)).limit(1)
    facts.concurrentBlockSeq = {
      seqs: [a?.seq, b?.seq].sort((x, y) => (x ?? 0) - (y ?? 0)),
      distinct: a?.seq !== b?.seq,
      nextSeqAfter: ideaRow?.nextSeq,
    }
  }

  // --- move into a full column renumbers rather than exhausting precision ---
  {
    const project = await newProject('bravo')
    const left = await newIdea(project, { status: 'todo', boardPosition: 100 })
    // A gap already below the service's own epsilon (1e-6) — indistinguishable
    // from "exhausted" without ever running fifty real bisections to get
    // there.
    const right = await newIdea(project, { status: 'todo', boardPosition: 100 + 1e-9 })
    const moved = await newIdea(project, { status: 'backlog' })

    const before = await db
      .select({ id: ideas.id, boardPosition: ideas.boardPosition })
      .from(ideas)
      .where(and(eq(ideas.projectId, project), eq(ideas.status, 'todo')))
    let threw = ''
    try {
      await moveIdea(moved, { status: 'todo', afterId: left, beforeId: right })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    const after = await db
      .select({ id: ideas.id, boardPosition: ideas.boardPosition })
      .from(ideas)
      .where(and(eq(ideas.projectId, project), eq(ideas.status, 'todo')))
    facts.moveRenumber = {
      threw,
      before: before.map((r) => r.boardPosition),
      // Ascending by position: left, moved, right, if the renumber landed the
      // moved card where it was asked to.
      order: after
        .slice()
        .sort((x, y) => x.boardPosition - y.boardPosition)
        .map((r) =>
          r.id === left ? 'left' : r.id === moved ? 'moved' : r.id === right ? 'right' : r.id,
        ),
      allDistinct: new Set(after.map((r) => r.boardPosition)).size === after.length,
      allIntegersOfStep: after.every((r) => Number.isInteger(r.boardPosition / 1000)),
    }
  }

  // --- followup transaction: consumedAt on exactly the unconsumed comments ---
  {
    const project = await newProject('charlie')
    const idea = await newIdea(project)

    const closedAt = new Date()
    await db.insert(ideaRuns).values({
      ideaId: idea,
      kind: 'initial',
      status: 'closed',
      outcome: 'finished',
      detail: 'Implemented the thing.',
      endedAt: closedAt,
    })
    await db.insert(ideaPrompts).values({
      ideaId: idea,
      kind: 'initial',
      sourceDigest: '# demo idea\n',
      status: 'ready',
      generatedTitle: 'Build the thing',
      generatedText: 'Build the thing, please.',
      completedAt: closedAt,
    })

    const [alreadyConsumed] = await db
      .insert(ideaComments)
      .values({ ideaId: idea, body: 'old feedback', consumedAt: new Date(Date.now() - 60_000) })
      .returning()
    const c1 = await createIdeaComment(idea, { body: 'please add X' })
    const c2 = await createIdeaComment(idea, { body: 'also please add Y' })

    const before = enqueued.length
    const prompt = await createIdeaPrompt(idea, { kind: 'followup' })
    const after = enqueued.length

    facts.followupConsume = {
      promptStatus: prompt.status,
      promptKind: prompt.kind,
      digestHasNewComments: prompt.sourceDigest.includes('please add X') &&
        prompt.sourceDigest.includes('also please add Y'),
      c1ConsumedAfter: Boolean((await commentRow(c1.id))?.consumedAt),
      c2ConsumedAfter: Boolean((await commentRow(c2.id))?.consumedAt),
      // Was already consumed before this ran, at a fixed timestamp — must be
      // untouched, both in whether it is consumed and exactly when.
      alreadyConsumedUnchanged:
        (await commentRow(alreadyConsumed?.id ?? ''))?.consumedAt?.getTime() ===
        alreadyConsumed?.consumedAt?.getTime(),
      enqueuedCount: after - before,
      enqueuedPromptId: (enqueued.at(-1)?.data as { promptId?: string } | undefined)?.promptId ===
        prompt.id,
    }
  }

  // --- a transaction that fails its own precondition enqueues nothing --------
  {
    const project = await newProject('delta')
    const idea = await newIdea(project) // no run, no ready prompt at all
    const before = enqueued.length
    const promptsBefore = (await promptRows(idea)).length
    let threw = ''
    try {
      await createIdeaPrompt(idea, { kind: 'followup' })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    facts.noRunToFollowUp = {
      threw,
      enqueuedDelta: enqueued.length - before,
      promptRowsDelta: (await promptRows(idea)).length - promptsBefore,
    }
  }

  // --- a failed prompt's retry copies its digest and touches no comment -----
  {
    const project = await newProject('echo')
    const idea = await newIdea(project)
    await db.insert(ideaRuns).values({
      ideaId: idea,
      kind: 'initial',
      status: 'closed',
      outcome: 'finished',
      endedAt: new Date(),
    })
    await db.insert(ideaPrompts).values({
      ideaId: idea,
      kind: 'initial',
      sourceDigest: '# demo idea\n',
      status: 'ready',
      generatedText: 'Build the thing, please.',
      completedAt: new Date(),
    })

    // Comments already consumed by the failed attempt's own (earlier)
    // transaction, plus one that arrived after it failed and is still
    // unconsumed — a naive rebuild would fold the latter in and consume it,
    // which the retry must not do.
    const stampedAt = new Date(Date.now() - 30_000)
    await db
      .insert(ideaComments)
      .values({ ideaId: idea, body: 'folded into the failed attempt', consumedAt: stampedAt })
    const stillUnconsumed = await createIdeaComment(idea, { body: 'arrived after the failure' })

    const STALE_DIGEST = '## Follow-up for: demo idea\n\nSTALE DIGEST FROM THE FAILED ATTEMPT\n'
    const [failed] = await db
      .insert(ideaPrompts)
      .values({
        ideaId: idea,
        kind: 'followup',
        sourceDigest: STALE_DIGEST,
        status: 'failed',
        error: 'Generation failed: simulated',
        completedAt: new Date(),
      })
      .returning()

    const before = enqueued.length
    const retried = await createIdeaPrompt(idea, { kind: 'followup' })

    facts.failedRetry = {
      digestCopiedVerbatim: retried.sourceDigest === STALE_DIGEST,
      staleRowUntouched: (await db
        .select()
        .from(ideaPrompts)
        .where(eq(ideaPrompts.id, failed?.id ?? ''))
        .limit(1))[0]?.status,
      retriedIsNewRow: retried.id !== failed?.id,
      retriedStatus: retried.status,
      stillUnconsumedUntouched: !(await commentRow(stillUnconsumed.id))?.consumedAt,
      enqueuedDelta: enqueued.length - before,
    }
  }

  // --- handoff preconditions guarded here, naming the idea, not the session -
  {
    const project = await newProject('foxtrot')
    const noOrchestrator = await newIdea(project, { orchestrator: null })
    let threwNoOrchestrator = ''
    try {
      await createIdeaPrompt(noOrchestrator, { kind: 'initial' })
    } catch (error) {
      threwNoOrchestrator = error instanceof Error ? error.message : String(error)
    }

    const notReadyProject = await newProject('golf', 'pending')
    const notReadyIdea = await newIdea(notReadyProject)
    let threwNotReady = ''
    try {
      await createIdeaPrompt(notReadyIdea, { kind: 'initial' })
    } catch (error) {
      threwNotReady = error instanceof Error ? error.message : String(error)
    }

    facts.handoffGuards = {
      threwNoOrchestrator,
      namesIdeaNotSession:
        threwNoOrchestrator.toLowerCase().includes('idea') &&
        !threwNoOrchestrator.toLowerCase().includes('session'),
      threwNotReady,
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
