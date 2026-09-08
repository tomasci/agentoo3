// Runs every database-backed reorder scenario once, against the throwaway
// cluster its parent (idea-reorder.test.ts) started, and prints what happened
// as JSON — same shape as ideas-routes-db-child.ts, which this mirrors: the
// child gathers facts, every assertion lives in the parent.
//
// Real Postgres is what proves the one thing a faked `db` cannot: that
// reorderIdeaBlocks's two-phase (offset, then settle) write never has a
// not-yet-updated row still holding the value another row is about to be
// given — `idea_blocks_idea_seq_key` is a real, non-deferrable unique index,
// checked at the end of each statement, so a naive single-pass write (in the
// order the caller happened to name blocks) would abort the whole
// transaction the moment a full reversal asked to swap two blocks' seq
// values. A faked `db` answers `.where()` with a fixed row regardless of its
// predicate (see session-recovery.test.ts's own fake), which cannot enforce
// that constraint at all, let alone prove a real write path never violates
// it.

import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'

// --- fakes, registered before anything imports the modules that use them ---

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
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

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { ideaBlocks, ideas, projects } = await import('@/db/schema')
const { createIdea, createIdeaBlock } = await import('@/features/ideas/service')
const { serializeIdea } = await import('@/features/ideas/serialize')
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import('@/lib/openapi-hook')
const { ideasRouter } = await import('@/features/ideas/routes')

// Mounted exactly the way app.ts mounts it for real — same reasoning as
// ideas-routes-db-child.ts's own comment on this: a real (if empty) database
// and a real route, not a stubbed query chain.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', ideasRouter)

const facts: Record<string, unknown> = {}

// --- fixtures ------------------------------------------------------------------

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}`, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

async function newIdea(projectId: string): Promise<string> {
  const created = await createIdea(projectId, { title: 'canvas idea', orchestrator: 'coder' })
  return created.id
}

async function newBlocks(ideaId: string, texts: string[]): Promise<string[]> {
  const ids: string[] = []
  // Sequential, not Promise.all: the point here is a known, ascending seq per
  // text (0, 1, 2, ...), not a race on allocation — that race is already
  // covered by ideas-routes.test.ts's concurrentBlockSeq scenario.
  for (const text of texts) {
    const block = await createIdeaBlock(ideaId, { kind: 'note', text })
    ids.push(block.id)
  }
  return ids
}

const postJson = (path: string, body: unknown) =>
  app.request(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const ideaRow = async (ideaId: string) =>
  (await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1))[0]

const blockSeqsById = async (ideaId: string) => {
  const rows = await db
    .select({ id: ideaBlocks.id, seq: ideaBlocks.seq })
    .from(ideaBlocks)
    .where(eq(ideaBlocks.ideaId, ideaId))
  return new Map(rows.map((r) => [r.id, r.seq]))
}

async function main() {
  // --- a full reversal: cycles that force the two-phase write to matter -----
  {
    const project = await newProject('reorder-alpha')
    const idea = await newIdea(project)
    const texts = ['first block', 'second block', 'third block', 'fourth block']
    const ids = await newBlocks(idea, texts)
    const textById = new Map(ids.map((id, i) => [id, texts[i]]))
    const requestedOrder = [...ids].reverse()

    const before = await ideaRow(idea)

    const res = await postJson(`/ideas/${idea}/blocks/reorder`, { order: requestedOrder })
    const body = (await res.json()) as { id: string }[]

    const after = await ideaRow(idea)

    const listRes = await app.request(`/api/ideas/${idea}/blocks`)
    const listed = (await listRes.json()) as { id: string; seq: number }[]
    const listedOrder = listed.map((b) => b.id)

    // Rebuild the serializer's own input from the now-reordered rows (any
    // array order — serializeIdea re-sorts by seq itself) and check the
    // rendered document's block order follows the new seq order, not the old
    // one.
    const blockInputs = listed.map((b) => ({
      id: b.id,
      seq: b.seq,
      groupId: null as string | null,
      kind: 'note' as const,
      text: textById.get(b.id) ?? '',
    }))
    const serialized = serializeIdea({
      title: 'canvas idea',
      blocks: blockInputs,
      groups: [],
      assets: [],
    })
    const positions = requestedOrder.map((id) => serialized.indexOf(textById.get(id) ?? ''))
    const serializedOrderMatches = positions.every(
      (pos, i) => i === 0 || positions[i - 1]! < pos,
    )

    facts.fullReversal = {
      reorderStatus: res.status,
      responseOrder: body.map((b) => b.id),
      requestedOrder,
      listedOrder,
      serializedOrderMatches,
      updatedAtUnchanged: before?.updatedAt.getTime() === after?.updatedAt.getTime(),
    }
  }

  // --- validation: omits an id ------------------------------------------------
  {
    const project = await newProject('reorder-bravo')
    const idea = await newIdea(project)
    const ids = await newBlocks(idea, ['a', 'b', 'c'])
    const before = await blockSeqsById(idea)

    const res = await postJson(`/ideas/${idea}/blocks/reorder`, { order: ids.slice(0, 2) })
    const body = (await res.json()) as { error?: string }

    const after = await blockSeqsById(idea)
    facts.omitsId = {
      status: res.status,
      error: body.error,
      seqUnchanged: JSON.stringify([...before]) === JSON.stringify([...after]),
    }
  }

  // --- validation: a duplicate id ---------------------------------------------
  {
    const project = await newProject('reorder-charlie')
    const idea = await newIdea(project)
    const ids = await newBlocks(idea, ['a', 'b', 'c'])
    const before = await blockSeqsById(idea)

    const res = await postJson(`/ideas/${idea}/blocks/reorder`, {
      order: [ids[0]!, ids[0]!, ids[1]!],
    })
    const body = (await res.json()) as { error?: string }

    const after = await blockSeqsById(idea)
    facts.duplicateId = {
      status: res.status,
      error: body.error,
      seqUnchanged: JSON.stringify([...before]) === JSON.stringify([...after]),
    }
  }

  // --- validation: a block from a different idea ------------------------------
  {
    const project = await newProject('reorder-delta')
    const ideaA = await newIdea(project)
    const ideaB = await newIdea(project)
    const idsA = await newBlocks(ideaA, ['a', 'b', 'c'])
    const idsB = await newBlocks(ideaB, ['x'])
    const before = await blockSeqsById(ideaA)

    // Same size as ideaA's own set, but one id swapped for a foreign one —
    // an exact-permutation check on length alone would miss this.
    const res = await postJson(`/ideas/${ideaA}/blocks/reorder`, {
      order: [idsA[0]!, idsA[1]!, idsB[0]!],
    })
    const body = (await res.json()) as { error?: string }

    const after = await blockSeqsById(ideaA)
    facts.foreignBlock = {
      status: res.status,
      error: body.error,
      seqUnchanged: JSON.stringify([...before]) === JSON.stringify([...after]),
    }
  }

  // --- idempotency: the current order changes nothing observable -------------
  {
    const project = await newProject('reorder-echo')
    const idea = await newIdea(project)
    const ids = await newBlocks(idea, ['a', 'b', 'c'])
    const before = await blockSeqsById(idea)
    const beforeIdea = await ideaRow(idea)

    const res = await postJson(`/ideas/${idea}/blocks/reorder`, { order: ids })

    const after = await blockSeqsById(idea)
    const afterIdea = await ideaRow(idea)
    facts.noop = {
      status: res.status,
      seqUnchanged: JSON.stringify([...before]) === JSON.stringify([...after]),
      updatedAtUnchanged: beforeIdea?.updatedAt.getTime() === afterIdea?.updatedAt.getTime(),
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
