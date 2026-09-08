// Runs every database-backed idea-handoff scenario once, against the
// throwaway cluster its parent (idea-handoff.test.ts) started, and prints
// what happened as JSON — same shape as session-claim-db-child.ts and
// ideas-routes-db-child.ts, which this mirrors: the child gathers facts,
// every assertion lives in the parent.
//
// Real Postgres is what proves the one thing a faked `db` cannot: two
// concurrent sweeps of one idea colliding on idea_runs_open_key and
// converging on exactly one run. Everything else here could in principle be
// faked, but faking the many small queries features/sessions/service.ts and
// features/ideas/files.ts themselves make (session rows, session_files
// checksums, manifest regeneration, ...) would be far less trustworthy than
// just running them for real against a real, disposable database — so every
// scenario below runs the same way, not only the one that strictly needs it.
//
// BullMQ, ioredis and the pub/sub bridge are faked, exactly as
// session-claim-db-child.ts fakes them: nothing here is testing a queue or a
// live SSE stream, and a publish against a Redis that is not there costs real
// time if it is not short-circuited.

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

// --- fakes, registered before anything imports the modules that use them ---

const enqueued: { queue: string; name: string; data: unknown }[] = []

mock.module('bullmq', () => ({
  Queue: class {
    constructor(private readonly queueName: string) {}
    async add(name: string, data: unknown) {
      enqueued.push({ queue: this.queueName, name, data })
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

// Same reasoning as session-claim-db-child.ts's identical mock: every
// scenario below asserts on database rows, and a publish against a Redis
// that is not really there costs time this file does not need to spend.
mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

// --- call-order instrumentation, for the "assets before prompt" scenario ---
//
// Wraps the two real functions dispatchRun calls, rather than faking either:
// both do substantial real work (checksum dedup, manifest regeneration,
// message sequencing) that is far easier to trust by actually running than
// by reimplementing in a stub. Every other export of each module is
// forwarded unchanged.

const callOrder: string[] = []

// Captured as plain local bindings, not read back off the module namespace
// object at call time: bun's `mock.module` replaces an already-imported
// module's exports *in place*, so a wrapper that re-reads
// `realFiles.attachIdeaAssetsToSession` after registering the mock would find
// its own wrapped version there and recurse into itself forever. Capturing
// the function values themselves, once, before the mock is registered, is
// what keeps this a single indirection rather than a self-call.
const realFiles = (await import(`${SRC}/features/ideas/files.ts`)) as Record<string, unknown>
const realAttachIdeaAssetsToSession = realFiles.attachIdeaAssetsToSession as (
  ideaId: string,
  sessionId: string,
) => Promise<void>
mock.module(`${SRC}/features/ideas/files.ts`, () => ({
  ...realFiles,
  attachIdeaAssetsToSession: async (ideaId: string, sessionId: string) => {
    callOrder.push('attach')
    return realAttachIdeaAssetsToSession(ideaId, sessionId)
  },
}))

const realSessionsService = (await import(`${SRC}/features/sessions/service.ts`)) as Record<
  string,
  unknown
>
const realSendMessage = realSessionsService.sendMessage as (
  sessionId: string,
  text: string,
) => Promise<{ id: string }>
mock.module(`${SRC}/features/sessions/service.ts`, () => ({
  ...realSessionsService,
  sendMessage: async (sessionId: string, text: string) => {
    callOrder.push('send')
    return realSendMessage(sessionId, text)
  },
}))

const { and, eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { ideaPrompts, ideaRuns, ideas, messages, projects, sessionFiles, sessions } = await import(
  `${SRC}/db/schema.ts`
)
const { projectRepo } = await import(`${SRC}/lib/paths.ts`)
const { continueIdea, handleTurnEnded, sweepIdeaHandoffs } = await import(
  `${SRC}/features/ideas/handoff.ts`
)
const { reconcileOrphanedIdeaRuns } = await import(`${SRC}/features/ideas/run-close.ts`)
const { updateIdea } = await import(`${SRC}/features/ideas/service.ts`)

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

async function newProject(
  name: string,
  opts: { withRepoDir?: boolean } = {},
): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  if (opts.withRepoDir) await mkdir(projectRepo(slug), { recursive: true })
  return { id: row.id, slug }
}

let boardPosition = 0

async function newIdea(
  projectId: string,
  overrides: Partial<{ status: (typeof ideas.$inferSelect)['status']; orchestrator: string | null }> = {},
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

async function newSessionRaw(projectId: string): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, status: 'completed', orchestrator: 'coder' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

async function newMessageRaw(
  sessionId: string,
  seq: number,
  overrides: Partial<{
    type: string
    payload: Record<string, unknown>
    continuesMessageId: string | null
    turnDetail: string | null
  }> = {},
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      sessionId,
      seq,
      type: overrides.type ?? 'prompt',
      payload: overrides.payload ?? { text: 'do the thing' },
      continuesMessageId: overrides.continuesMessageId ?? null,
      turnDetail: overrides.turnDetail ?? null,
    })
    .returning()
  if (!row) throw new Error('no message row')
  return row.id
}

/** A run already at `running`, wired to one root prompt message — bypasses
 * claiming/dispatching entirely, since these scenarios are about closing a
 * run, not producing one. */
async function openRunningRun(ideaId: string, sessionId: string, promptMessageId: string): Promise<string> {
  const [row] = await db
    .insert(ideaRuns)
    .values({ ideaId, sessionId, promptMessageId, kind: 'initial', status: 'running' })
    .returning()
  if (!row) throw new Error('no run row')
  return row.id
}

const runRow = async (id: string) => (await db.select().from(ideaRuns).where(eq(ideaRuns.id, id)).limit(1))[0]
const ideaRow = async (id: string) => (await db.select().from(ideas).where(eq(ideas.id, id)).limit(1))[0]
const runsForIdea = async (ideaId: string) =>
  db.select().from(ideaRuns).where(eq(ideaRuns.ideaId, ideaId))

async function markPromptReady(promptId: string, title: string, text: string): Promise<void> {
  await db
    .update(ideaPrompts)
    .set({ status: 'ready', generatedTitle: title, generatedText: text, completedAt: new Date() })
    .where(eq(ideaPrompts.id, promptId))
}

async function promptForIdea(ideaId: string) {
  const [row] = await db
    .select()
    .from(ideaPrompts)
    .where(eq(ideaPrompts.ideaId, ideaId))
    .orderBy(ideaPrompts.createdAt)
  return row
}

async function main() {
  // --- two concurrent sweeps of one idea produce exactly one run -------------
  {
    const { id: project } = await newProject('alpha')
    const idea = await newIdea(project)

    await Promise.all([sweepIdeaHandoffs(), sweepIdeaHandoffs()])

    const runs = await runsForIdea(idea)
    facts.twoConcurrentSweeps = {
      runCount: runs.length,
      status: runs[0]?.status,
      ideaStatusStillSelected: (await ideaRow(idea))?.status,
    }
  }

  // --- assets are copied before the prompt message is appended ---------------
  {
    callOrder.length = 0
    const { id: project, slug } = await newProject('bravo', { withRepoDir: true })
    const idea = await newIdea(project)

    // Give this idea a real, ready asset to copy — attachIdeaAssetsToSession
    // is a silent no-op with none, which would prove nothing about ordering.
    const uploadIdeaFile = realFiles.uploadIdeaFile as (
      ideaId: string,
      filename: string,
      body: ReadableStream<Uint8Array>,
      type: string | undefined,
      size: number,
    ) => Promise<{ id: string }>
    const bytes = new TextEncoder().encode('hello from the idea canvas')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    await uploadIdeaFile(idea, 'notes.txt', stream, 'text/plain', bytes.length)

    await sweepIdeaHandoffs() // claims the idea, generates the (pending) prompt
    const prompt = await promptForIdea(idea)
    if (!prompt) throw new Error('no prompt row for idea')
    await markPromptReady(prompt.id, 'Ship the thing', 'Please ship the thing, end to end.')

    await sweepIdeaHandoffs() // dispatches, now that the prompt is ready

    const run = (await runsForIdea(idea))[0]
    const ideaAfter = await ideaRow(idea)
    const sessionId = ideaAfter?.sessionId ?? ''
    const copiedFiles = sessionId
      ? await db.select().from(sessionFiles).where(eq(sessionFiles.sessionId, sessionId))
      : []

    facts.assetOrdering = {
      callOrder: [...callOrder],
      copiedFileCount: copiedFiles.length,
      runStatus: run?.status,
      promptMessageIdSet: Boolean(run?.promptMessageId),
      ideaStatusAfter: ideaAfter?.status,
      projectSlugIsSet: Boolean(slug),
    }
  }

  // --- a createSession failure closes the run and writes ideas.lastError -----
  {
    // Deliberately no repo dir on disk: createSession 400s on `${repo} is missing`.
    const { id: project } = await newProject('charlie')
    const idea = await newIdea(project)

    await sweepIdeaHandoffs()
    const prompt = await promptForIdea(idea)
    if (!prompt) throw new Error('no prompt row for idea')
    await markPromptReady(prompt.id, 'Ship the thing', 'Please ship the thing.')

    await sweepIdeaHandoffs()

    const run = (await runsForIdea(idea))[0]
    const ideaAfter = await ideaRow(idea)
    facts.createSessionFailure = {
      runStatus: run?.status,
      runOutcome: run?.outcome,
      runEndedAtSet: Boolean(run?.endedAt),
      ideaStatusUnchanged: ideaAfter?.status,
      ideaLastError: ideaAfter?.lastError,
    }
  }

  // --- the outcome -> status mapping, for every row of the table -------------
  {
    const cases: {
      outcome: string
      expectRunOutcome: string
      expectIdeaStatus: string
      expectLastErrorNull: boolean
    }[] = [
      { outcome: 'completed', expectRunOutcome: 'finished', expectIdeaStatus: 'verification', expectLastErrorNull: true },
      { outcome: 'interrupted', expectRunOutcome: 'interrupted', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: true },
      { outcome: 'drained', expectRunOutcome: 'superseded', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stopped_turn_limit', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stopped_api_error', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stopped_execution_error', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stopped_over_budget', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'failed', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stalled', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'unknown', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'abandoned', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
      { outcome: 'stranded', expectRunOutcome: 'needs_attention', expectIdeaStatus: 'in_progress_dev', expectLastErrorNull: false },
    ]

    const results: Record<string, unknown> = {}
    for (const c of cases) {
      const { id: project } = await newProject(`outcome-${c.outcome}`)
      const idea = await newIdea(project, { status: 'in_progress_dev' })
      const session = await newSessionRaw(project)
      const root = await newMessageRaw(session, 0, {
        turnDetail: `sentinel turn detail for ${c.outcome}`,
      })
      const runId = await openRunningRun(idea, session, root)

      await handleTurnEnded({ sessionId: session, promptMessageId: root, outcome: c.outcome })

      const run = await runRow(runId)
      const ideaAfter = await ideaRow(idea)
      results[c.outcome] = {
        runStatus: run?.status,
        runOutcome: run?.outcome,
        runEndedAtSet: Boolean(run?.endedAt),
        ideaStatus: ideaAfter?.status,
        lastErrorIsNull: ideaAfter?.lastError === null,
        lastErrorMentionsSentinel:
          c.expectLastErrorNull || String(ideaAfter?.lastError ?? '').includes(c.outcome),
        matchesExpectation:
          run?.outcome === c.expectRunOutcome &&
          ideaAfter?.status === c.expectIdeaStatus &&
          (ideaAfter?.lastError === null) === c.expectLastErrorNull,
      }
    }
    facts.outcomeMapping = results
  }

  // --- a `continuing` outcome leaves the run open and the card unmoved --------
  {
    const { id: project } = await newProject('delta')
    const idea = await newIdea(project, { status: 'in_progress_dev' })
    const session = await newSessionRaw(project)
    const root = await newMessageRaw(session, 0)
    const runId = await openRunningRun(idea, session, root)

    await handleTurnEnded({ sessionId: session, promptMessageId: root, outcome: 'continuing' })

    const run = await runRow(runId)
    const ideaAfter = await ideaRow(idea)
    facts.continuingLeavesOpen = {
      runStatus: run?.status,
      runEndedAtIsNull: run?.endedAt === null,
      runOutcomeIsNull: run?.outcome === null,
      ideaStatus: ideaAfter?.status,
    }
  }

  // --- a two-hop continuation chain closes on the tail's outcome --------------
  {
    const { id: project } = await newProject('echo')
    const idea = await newIdea(project, { status: 'in_progress_dev' })
    const session = await newSessionRaw(project)
    const root = await newMessageRaw(session, 0)
    const runId = await openRunningRun(idea, session, root)

    // The root's own turn continues...
    await newMessageRaw(session, 1, { continuesMessageId: root })
    const hop1 = (await db.select().from(messages).where(and(eq(messages.sessionId, session), eq(messages.seq, 1))))[0]
    if (!hop1) throw new Error('no hop1 message')
    await handleTurnEnded({ sessionId: session, promptMessageId: root, outcome: 'continuing' })
    const afterRootContinuing = await runRow(runId)

    // ...and hop1's own turn continues again, a second hop.
    const hop2Id = await newMessageRaw(session, 2, { continuesMessageId: hop1.id })
    await handleTurnEnded({ sessionId: session, promptMessageId: hop1.id, outcome: 'continuing' })
    const afterHop1Continuing = await runRow(runId)

    // Finally hop2's own turn actually finishes.
    await db
      .update(messages)
      .set({ type: 'result', payload: { type: 'result', subtype: 'success', result: 'Done, end to end.' } })
      .where(eq(messages.id, hop2Id))
    await handleTurnEnded({ sessionId: session, promptMessageId: hop2Id, outcome: 'completed' })
    const finalRun = await runRow(runId)
    const finalIdea = await ideaRow(idea)

    facts.twoHopChain = {
      stillOpenAfterRootContinuing: afterRootContinuing?.endedAt === null,
      stillOpenAfterHop1Continuing: afterHop1Continuing?.endedAt === null,
      finalRunOutcome: finalRun?.outcome,
      finalRunStatus: finalRun?.status,
      finalIdeaStatus: finalIdea?.status,
      finalRunDetail: finalRun?.detail,
    }
  }

  // --- idea_runs.detail: the last result message, falling back to turnDetail -
  {
    const { id: project } = await newProject('foxtrot')
    const idea = await newIdea(project, { status: 'in_progress_dev' })
    const session = await newSessionRaw(project)
    const root = await newMessageRaw(session, 0, { turnDetail: null })
    const runId = await openRunningRun(idea, session, root)
    await newMessageRaw(session, 1, {
      type: 'result',
      payload: { type: 'result', subtype: 'success', result: 'The agent shipped the export button.' },
    })

    await handleTurnEnded({ sessionId: session, promptMessageId: root, outcome: 'completed' })
    const run = await runRow(runId)

    const { id: project2 } = await newProject('foxtrot-fallback')
    const idea2 = await newIdea(project2, { status: 'in_progress_dev' })
    const session2 = await newSessionRaw(project2)
    const root2 = await newMessageRaw(session2, 0, { turnDetail: 'Stopped: over budget.' })
    const runId2 = await openRunningRun(idea2, session2, root2)
    await handleTurnEnded({ sessionId: session2, promptMessageId: root2, outcome: 'stopped_over_budget' })
    const run2 = await runRow(runId2)

    facts.runDetailDigest = {
      withResultMessage: run?.detail,
      withoutResultMessageFallsBackToTurnDetail: run2?.detail,
    }
  }

  // --- a run whose session was deleted closes as session_deleted -------------
  {
    const { id: project } = await newProject('golf')
    const idea = await newIdea(project, { status: 'in_progress_dev' })
    const session = await newSessionRaw(project)
    const root = await newMessageRaw(session, 0)
    const runId = await openRunningRun(idea, session, root)

    await db.delete(sessions).where(eq(sessions.id, session))
    const closedCount = await reconcileOrphanedIdeaRuns()

    const run = await runRow(runId)
    facts.sessionDeleted = {
      closedCount,
      runOutcome: run?.outcome,
      runStatus: run?.status,
      runSessionIdNull: run?.sessionId === null,
    }
  }

  // --- a run still generating (no session yet) is left alone by that same ----
  // reconciler predicate — the "not merely sessionId IS NULL" guard.
  {
    const { id: project } = await newProject('golf-generating')
    const idea = await newIdea(project)
    const [row] = await db
      .insert(ideaRuns)
      .values({ ideaId: idea, kind: 'initial', status: 'generating' })
      .returning()
    if (!row) throw new Error('no run row')

    await reconcileOrphanedIdeaRuns()
    const run = await runRow(row.id)
    facts.generatingRunNotOrphaned = {
      status: run?.status,
      endedAtIsNull: run?.endedAt === null,
    }
  }

  // --- continueIdea claims a follow-up run on an idea with a closed run ------
  {
    const { id: project } = await newProject('hotel')
    const idea = await newIdea(project, { status: 'verification' })
    const session = await newSessionRaw(project)
    await db.update(ideas).set({ sessionId: session }).where(eq(ideas.id, idea))
    await db.insert(ideaRuns).values({
      ideaId: idea,
      sessionId: session,
      kind: 'initial',
      status: 'closed',
      outcome: 'finished',
      detail: 'Shipped the first pass.',
      endedAt: new Date(),
    })
    await db.insert(ideaPrompts).values({
      ideaId: idea,
      kind: 'initial',
      sourceDigest: '# demo idea\n',
      status: 'ready',
      generatedTitle: 'Ship the thing',
      generatedText: 'Please ship the thing.',
      completedAt: new Date(),
    })

    await continueIdea(idea)
    const runs = await runsForIdea(idea)
    const openRun = runs.find((r) => r.endedAt === null)

    let conflictOnSecondCall = ''
    try {
      await continueIdea(idea)
    } catch (error) {
      conflictOnSecondCall = error instanceof Error ? error.message : String(error)
    }

    facts.continueIdea = {
      openRunKind: openRun?.kind,
      openRunStatus: openRun?.status,
      conflictOnSecondCall,
    }
  }

  // --- the retry gate, end to end: a fixable failure re-triggers exactly ----
  // once per user action, never on its own ----------------------------------
  //
  // No orchestrator is the fastest way to reach `needs_attention`: with none
  // set, createIdeaPrompt itself 400s (see its own guard, features/ideas/
  // service.ts) and claimIdeaForHandoff closes the run right there, in the
  // very same sweep that claimed it — so this never has to reach dispatchRun
  // or create a session at all.
  {
    const { id: project } = await newProject('india')
    const idea = await newIdea(project, { orchestrator: null })

    await sweepIdeaHandoffs() // claims, then fails to generate a prompt, and closes needs_attention
    const ideaAfterFailure = await ideaRow(idea)
    const runCountAfterFailure = (await runsForIdea(idea)).length

    // The assertion that guards the gate: with no user action in between, a
    // second sweep must claim nothing at all. If closeRun ever bumps
    // ideas.updatedAt again (see run-close.ts's own comment on why it must
    // not), this idea's just-closed run would satisfy "closed at or after
    // updatedAt" trivially and get reclaimed right here.
    await sweepIdeaHandoffs()
    const runCountAfterIdleResweep = (await runsForIdea(idea)).length

    // The user does exactly what lastError asked.
    await updateIdea(idea, { orchestrator: 'coder' })

    await sweepIdeaHandoffs() // claims exactly once
    const runCountAfterFix = (await runsForIdea(idea)).length

    // A further sweep with no user action claims nothing again.
    await sweepIdeaHandoffs()
    const runCountAfterSecondIdleResweep = (await runsForIdea(idea)).length

    facts.retryGate = {
      ideaStatusAfterFailure: ideaAfterFailure?.status,
      lastErrorMentionsOrchestrator: String(ideaAfterFailure?.lastError ?? '').includes('orchestrator'),
      runCountAfterFailure,
      runCountAfterIdleResweep,
      runCountAfterFix,
      runCountAfterSecondIdleResweep,
    }
  }

  // --- crash recovery: a re-dispatch must adopt the already-sent message, ---
  // never send a second one ---------------------------------------------------
  {
    const { id: project } = await newProject('juliet', { withRepoDir: true })
    const idea = await newIdea(project)

    await sweepIdeaHandoffs() // claims, generates the (pending) prompt
    const prompt = await promptForIdea(idea)
    if (!prompt) throw new Error('no prompt row for idea')
    await markPromptReady(prompt.id, 'Ship the thing', 'Please ship the thing, twice would be a bug.')

    await sweepIdeaHandoffs() // real dispatch: creates the session, sends the prompt, run -> running

    const runBefore = (await runsForIdea(idea))[0]
    if (!runBefore) throw new Error('no run row after dispatch')
    const sentMessageId = runBefore.promptMessageId
    if (!sentMessageId) throw new Error('dispatch did not record a promptMessageId')

    // Simulate exactly the crash window dispatchRun's own comment documents:
    // a worker killed between sendMessage returning and the final
    // transaction committing leaves the run right here — back at
    // `dispatching`, with no promptMessageId recorded — while the session
    // (ideas.sessionId) and the prompt message it already sent are both real
    // and already committed.
    await db
      .update(ideaRuns)
      .set({ status: 'dispatching', sessionId: null, promptMessageId: null })
      .where(eq(ideaRuns.id, runBefore.id))

    await sweepIdeaHandoffs() // re-dispatch: must adopt the existing message, not resend

    const runAfter = (await runsForIdea(idea))[0]
    const ideaAfter = await ideaRow(idea)
    const sessionId = ideaAfter?.sessionId ?? ''
    const promptMessages = sessionId
      ? await db
          .select()
          .from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.type, 'prompt')))
      : []

    facts.crashRecovery = {
      promptMessageCount: promptMessages.length,
      adoptedSameMessageId: runAfter?.promptMessageId === sentMessageId,
      runStatus: runAfter?.status,
      ideaStatus: ideaAfter?.status,
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
