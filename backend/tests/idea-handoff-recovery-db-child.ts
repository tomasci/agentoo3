// Reproduces the four defects an independent verification pass found in the
// Idea Manager's handoff, each against a real Postgres — and confirms each
// one's fix. Same shape as every other db-child in this directory: this file
// gathers facts, every assertion lives in idea-handoff-recovery.test.ts.
//
// idea-loop-db-child.ts already drives the whole loop end to end; this file
// is narrower on purpose. Nothing here ever needs a real model call: every
// scenario short-circuits prompt generation by writing the row a completed
// generation would have produced directly (`markPromptReady`, the same
// pattern idea-handoff-db-child.ts already uses), the same way those scenarios
// avoid depending on the Claude SDK. What is faked is exactly what that file
// fakes for the same reason: BullMQ (an array this file drains, or in most
// scenarios below does not, since a job intentionally never running is
// itself the fixture), ioredis, and the pub/sub bridge — nothing here tests a
// queue or a live stream, and Redis is not running.

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job' }
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

mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

const { and, eq, isNull } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { env } = await import(`${SRC}/env.ts`)
const { ideaFiles, ideaPrompts, ideaRuns, ideas, messages, projects, sessionFiles, sessions } =
  await import(`${SRC}/db/schema.ts`)
const { projectRepo, sessionUploadsDir } = await import(`${SRC}/lib/paths.ts`)
const { sweepIdeaHandoffs } = await import(`${SRC}/features/ideas/handoff.ts`)
const { createIdeaPrompt, updateIdea } = await import(`${SRC}/features/ideas/service.ts`)
const { uploadIdeaFile } = await import(`${SRC}/features/ideas/files.ts`)
const { uploadFile } = await import(`${SRC}/features/attachments/service.ts`)
const { createSession } = await import(`${SRC}/features/sessions/service.ts`)

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

async function newProject(name: string): Promise<string> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  // createSession 400s without it; a plain directory is enough here, same as
  // idea-loop-db-child.ts's own fixture.
  await mkdir(projectRepo(slug), { recursive: true })
  return row.id
}

let boardPosition = 0

async function newIdea(
  projectId: string,
  overrides: Partial<{
    status: (typeof ideas.$inferSelect)['status']
    orchestrator: string | null
  }> = {},
): Promise<string> {
  boardPosition += 1000
  const [row] = await db
    .insert(ideas)
    .values({
      projectId,
      title: 'demo idea',
      status: overrides.status ?? 'selected_for_development',
      boardPosition,
      orchestrator: 'orchestrator' in overrides ? overrides.orchestrator : 'coder',
    })
    .returning()
  if (!row) throw new Error('no idea row')
  return row.id
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
const textBytes = (s: string) => new TextEncoder().encode(s)

const runRow = async (id: string) =>
  (await db.select().from(ideaRuns).where(eq(ideaRuns.id, id)).limit(1))[0]
const ideaRow = async (id: string) =>
  (await db.select().from(ideas).where(eq(ideas.id, id)).limit(1))[0]
const runsForIdea = async (ideaId: string) =>
  db.select().from(ideaRuns).where(eq(ideaRuns.ideaId, ideaId)).orderBy(ideaRuns.startedAt)
const latestPromptForIdea = async (ideaId: string) => {
  const [row] = await db
    .select()
    .from(ideaPrompts)
    .where(eq(ideaPrompts.ideaId, ideaId))
    .orderBy(ideaPrompts.createdAt)
  return row
}

/** What a completed generation would have written — short-circuits the
 * Claude call entirely, the same way idea-handoff-db-child.ts's identical
 * helper does. */
async function markPromptReady(promptId: string, title: string, text: string): Promise<void> {
  await db
    .update(ideaPrompts)
    .set({ status: 'ready', generatedTitle: title, generatedText: text, completedAt: new Date() })
    .where(eq(ideaPrompts.id, promptId))
}

// --- D1: a crash between claimIdeaForHandoff's own two writes ---------------
//
// Reproduces the exact starting state a real crash leaves: insert only the
// claim's first write (the bare `idea_runs` row, no `promptId`), never the
// second. Then proves both halves of the fix — left alone within
// IDEA_HANDOFF_CLAIM_GRACE_MS (env.ts), since that is indistinguishable from
// an ordinary claim still in flight, and closed `needs_attention` once real
// time has clearly passed, which is what gives the card a route out at all.
// Time is advanced by backdating `startedAt` directly, never by sleeping.

async function crashBetweenClaimWrites(): Promise<void> {
  const project = await newProject('d1')
  const idea = await newIdea(project)

  const [run] = await db
    .insert(ideaRuns)
    .values({ ideaId: idea, kind: 'initial', status: 'generating' })
    .returning()
  if (!run) throw new Error('no run row')

  const immediateSweep = await sweepIdeaHandoffs()
  const immediateRun = await runRow(run.id)

  const longAgo = new Date(Date.now() - env.IDEA_HANDOFF_CLAIM_GRACE_MS - 60_000)
  await db.update(ideaRuns).set({ startedAt: longAgo }).where(eq(ideaRuns.id, run.id))

  const sweepPastGrace = await sweepIdeaHandoffs()
  const runAfterGrace = await runRow(run.id)
  const ideaAfterGrace = await ideaRow(idea)

  // The way out: any user action against the idea bumps `updatedAt`, which is
  // exactly what re-opens claimSelectedIdeas' own retry gate.
  await updateIdea(idea, { orchestrator: 'coder' })
  const sweepAfterRemedy = await sweepIdeaHandoffs()
  const runsAfterRemedy = await runsForIdea(idea)

  facts.crashBetweenClaimWrites = {
    immediateSweep,
    immediateRunOpen: immediateRun?.endedAt === null,
    immediateRunStatus: immediateRun?.status,
    sweepPastGrace,
    runAfterGraceStatus: runAfterGrace?.status,
    runAfterGraceOutcome: runAfterGrace?.outcome,
    runAfterGraceClosed: runAfterGrace?.endedAt !== null,
    ideaStatusAfterGrace: ideaAfterGrace?.status,
    ideaLastErrorAfterGrace: ideaAfterGrace?.lastError,
    sweepAfterRemedy,
    runCountAfterRemedy: runsAfterRemedy.length,
    newRunClaimed: runsAfterRemedy.some((r) => r.id !== run.id),
  }
}

// --- D2: the documented remedy for a stuck-pending prompt -------------------
//
// Claim normally (so `idea_runs.promptId` is linked the ordinary way), never
// run the generation job (the worker is simulated as having been killed —
// the row simply never leaves `pending`), then apply the documented remedy
// (repost the same kind) and prove the sweep actually dispatches afterward,
// not just that the new row reaches `ready`.

async function stuckPendingPromptRegenerates(): Promise<void> {
  const project = await newProject('d2')
  const idea = await newIdea(project)

  await sweepIdeaHandoffs() // claims, generates the (pending) prompt, links promptId
  const stale = await latestPromptForIdea(idea)
  if (!stale) throw new Error('no stale prompt row')
  // The generation job for `stale` is never run — the fixture for "worker
  // killed mid-generation".

  const sweepWhileStuck = await sweepIdeaHandoffs()
  const runWhileStuck = (await runsForIdea(idea))[0]

  const regenerated = await createIdeaPrompt(idea, { kind: 'initial' })
  const runRightAfterRegenerate = (await runsForIdea(idea))[0]
  await markPromptReady(regenerated.id, 'Regenerated', 'Do the regenerated thing.')

  const sweepAfterRegenerate = await sweepIdeaHandoffs()
  const runAfterSweep = (await runsForIdea(idea))[0]
  const ideaAfter = await ideaRow(idea)

  facts.stuckPendingPromptRegenerates = {
    stalePromptStatus: stale.status,
    sweepWhileStuck,
    runWhileStuckStatus: runWhileStuck?.status,
    runWhileStuckPromptIsStale: runWhileStuck?.promptId === stale.id,
    // Re-pointed inside createIdeaPrompt's own transaction — true before the
    // sweep ever runs again.
    runRepointedBeforeSweep: runRightAfterRegenerate?.promptId === regenerated.id,
    sweepAfterRegenerate,
    runStatusAfterSweep: runAfterSweep?.status,
    runPromptIdIsRegenerated: runAfterSweep?.promptId === regenerated.id,
    ideaStatusAfter: ideaAfter?.status,
    ideaLastErrorAfter: ideaAfter?.lastError,
    sessionIdSet: Boolean(ideaAfter?.sessionId),
  }
}

// --- D3: the agent is told to read a filename that does not exist -----------
//
// An idea asset ("diagram.txt") and a separate, earlier session upload
// ("screenshot.txt") share identical bytes. The session is bound to the idea
// before the handoff runs — as if an earlier interaction had already created
// it — so dispatchRun reuses it rather than creating an empty one, and the
// collision is already sitting there the moment attachIdeaAssetsToSession
// runs for real. Driven through the actual sweep/dispatch path (not the
// primitives directly), so the assertion is about what dispatchRun really
// sends, with the fix's own reconciliation note in place.

async function filenameReconciliation(): Promise<void> {
  const project = await newProject('d3')
  const idea = await newIdea(project)

  const shared = textBytes('identical payload, uploaded twice under two names\n')
  await uploadIdeaFile(idea, 'diagram.txt', streamOf(shared), 'text/plain', shared.length)

  const session = await createSession(project, { title: 'pre-existing', orchestrator: 'coder' })
  await uploadFile(session.id, 'screenshot.txt', streamOf(shared), 'text/plain', shared.length)
  await db.update(ideas).set({ sessionId: session.id }).where(eq(ideas.id, idea))

  await sweepIdeaHandoffs() // claims, generates the (pending) prompt
  const prompt = await latestPromptForIdea(idea)
  if (!prompt) throw new Error('no prompt row')
  // The instruction asset (library/idea-prompt.ts) tells the model to carry a
  // filename through exactly as given — this is what that produces.
  await markPromptReady(prompt.id, 'Diagram', 'Read diagram.txt before you start.')

  await sweepIdeaHandoffs() // dispatches: attach (dedup skips diagram.txt), then send

  const [sentMessage] = await db
    .select({ payload: messages.payload })
    .from(messages)
    .where(and(eq(messages.sessionId, session.id), eq(messages.type, 'prompt')))
    .orderBy(messages.seq)
  const sentText = (sentMessage?.payload as { text?: string } | undefined)?.text ?? ''

  const sessionFileRows = await db
    .select({ originalFilename: sessionFiles.originalFilename })
    .from(sessionFiles)
    .where(and(eq(sessionFiles.sessionId, session.id), isNull(sessionFiles.deletedAt)))

  facts.filenameReconciliation = {
    sentText,
    sessionFilenames: sessionFileRows.map((r) => r.originalFilename).sort(),
    uploadsDir: sessionUploadsDir(session.id),
  }
}

// --- D4: an upload response contradicts the request --------------------------

async function duplicateUploadResponse(): Promise<void> {
  const project = await newProject('d4')
  const idea = await newIdea(project)

  const bytes = textBytes('alpha bytes, uploaded twice under two names\n')
  const first = await uploadIdeaFile(idea, 'alpha.txt', streamOf(bytes), 'text/plain', bytes.length)
  const second = await uploadIdeaFile(
    idea,
    'alpha-copy.txt',
    streamOf(bytes),
    'text/plain',
    bytes.length,
  )
  const bravoBytes = textBytes('different bytes entirely\n')
  const fresh = await uploadIdeaFile(
    idea,
    'bravo.txt',
    streamOf(bravoBytes),
    'text/plain',
    bravoBytes.length,
  )
  const rows = await db
    .select()
    .from(ideaFiles)
    .where(and(eq(ideaFiles.ideaId, idea), isNull(ideaFiles.deletedAt)))

  facts.duplicateUploadResponse = {
    firstMatchedExisting: first.matchedExisting,
    secondMatchedExisting: second.matchedExisting,
    secondOriginalFilename: second.originalFilename,
    freshMatchedExisting: fresh.matchedExisting,
    rowCount: rows.length,
  }
}

async function main() {
  await crashBetweenClaimWrites()
  await stuckPendingPromptRegenerates()
  await filenameReconciliation()
  await duplicateUploadResponse()

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const cause = (error as { cause?: unknown }).cause
    const causeDetail =
      cause instanceof Error ? `\ncause: ${cause.message}` : cause ? `\ncause: ${String(cause)}` : ''
    console.log(`__ERROR__${detail}${causeDetail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
