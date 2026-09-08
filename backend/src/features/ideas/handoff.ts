// The loop that closes the Idea Manager: watching the "selected for
// development" column, handing an idea off into a session, and advancing the
// card when the work stops.
//
// Deliberately a claim-based sweep (sweepIdeaHandoffs below), not a hook on
// POST /ideas/{id}/move: a move whose own enqueue failed would leave a hook
// design stuck on that card forever, with nothing left to nudge it. A sweep
// on a short scheduler (see queue/idea-handoff.worker.ts) is self-healing —
// the next tick just tries again — and the claim itself is a database
// constraint, not a check-then-act: idea_runs_open_key (db/schema.ts) permits
// at most one open run per idea, so two concurrent sweeps (or a scheduler
// tick landing on top of a worker-boot sweep) attempting the same idea at once
// always converge on exactly one INSERT succeeding and the other catching a
// clean unique-violation skip (lib/errors.ts's isUniqueViolation) — never a
// crash, and never two runs.
//
// Three things live here: claiming a card and generating its first prompt,
// dispatching a ready prompt into a session (createSession, then
// attachIdeaAssetsToSession, then sendMessage — that order is load-bearing,
// see dispatchRun's own comment), and closing a run once the chain of turns
// it started has actually stopped (handleTurnEnded, the QUEUE_TURN_ENDED
// consumer registered in queue/idea-handoff.worker.ts). The follow-up path
// (continueIdea) reuses dispatchRun's exact same reactive route rather than
// sending a message itself, so there remains exactly one place in this
// codebase that ever sends a prompt into a session on this feature's behalf.
//
// `closeRun` itself, and the reconciler's third predicate
// (reconcileOrphanedIdeaRuns), live in features/ideas/run-close.ts instead of
// here — see that file's own header for why: queue/turn-reconcile.worker.ts
// needs only those two, and importing them from this file would drag in
// everything below (createSession, sendMessage, createIdeaPrompt), each of
// which reaches @/queue for its own enqueue call.

import { and, desc, eq, gte, inArray, isNull, notExists, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import {
  ideaPrompts,
  type ideaRunOutcomeEnum,
  ideaRuns,
  type ideaStatusEnum,
  ideas,
  messages,
  turnOutcomeEnum,
} from '@/db/schema'
import { env } from '@/env'
import { attachIdeaAssetsToSession } from '@/features/ideas/files'
import { closeRun } from '@/features/ideas/run-close'
import { createSession, sendMessage } from '@/features/sessions/service'
import { conflict, isUniqueViolation } from '@/lib/errors'
import { logger } from '@/lib/logger'
import type { TurnEndedJob } from '@/queue'
import { createIdeaPrompt } from './service'

type IdeaRow = typeof ideas.$inferSelect
type IdeaPromptRow = typeof ideaPrompts.$inferSelect
type IdeaStatus = (typeof ideaStatusEnum.enumValues)[number]
type IdeaRunOutcome = (typeof ideaRunOutcomeEnum.enumValues)[number]
type TurnOutcome = (typeof turnOutcomeEnum.enumValues)[number]

// Derived from the enum itself, not a second hand-written list: a future
// outcome added to turnOutcomeEnum (db/schema.ts) is recognised here the
// moment it exists, with nothing to keep in sync by hand.
const KNOWN_TURN_OUTCOMES = new Set<string>(turnOutcomeEnum.enumValues)

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function ideaRowById(ideaId: string): Promise<IdeaRow | undefined> {
  const [row] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1)
  return row
}

async function promptRowById(promptId: string): Promise<IdeaPromptRow | undefined> {
  const [row] = await db.select().from(ideaPrompts).where(eq(ideaPrompts.id, promptId)).limit(1)
  return row
}

// --- claiming a card, and generating its first prompt -----------------------

/**
 * Insert this idea's one and only open run. The INSERT itself is the claim —
 * see this module's header for why a unique-violation here is a clean skip,
 * not a crash.
 */
async function claimIdeaForHandoff(ideaId: string): Promise<boolean> {
  let runId: string
  try {
    const [row] = await db
      .insert(ideaRuns)
      .values({ ideaId, kind: 'initial', status: 'generating' })
      .returning({ id: ideaRuns.id })
    if (!row) return false
    runId = row.id
  } catch (error) {
    if (isUniqueViolation(error, 'idea_runs_open_key')) return false
    throw error
  }

  try {
    const prompt = await createIdeaPrompt(ideaId, { kind: 'initial' })
    await db.update(ideaRuns).set({ promptId: prompt.id }).where(eq(ideaRuns.id, runId))
  } catch (error) {
    const detail = `Could not generate a development prompt: ${errMessage(error)}`
    await closeRun(runId, ideaId, 'needs_attention', detail, { lastError: detail })
  }
  return true
}

/**
 * Every idea sitting in `selected_for_development` that has no *open* run and
 * no run that closed at or after `ideas.updatedAt`.
 *
 * Not "never had a handoff attempted at all": that predicate strands a card
 * for good the moment its one and only attempt ends `needs_attention` for a
 * fixable reason (no orchestrator set, say) — `lastError` tells the user
 * exactly what to fix, they fix it, and the sweep would never look at that
 * idea again, because it already has a run "of any outcome". There is no
 * route back short of deleting the idea.
 *
 * `ideas.updatedAt` is what turns a fixed idea back into a candidate: every
 * user remedy — patching the orchestrator, base branch or budget, or
 * re-moving the card into this column — bumps it (see `PATCH /ideas/{id}`
 * and the move endpoint), and a run's own `closeRun` deliberately does NOT
 * touch it (see run-close.ts's comment on why that write was removed) — so
 * this predicate only re-triggers once per genuine user action and never
 * spins on its own. A run that closed *before* the last `updatedAt` is old
 * news the user has already acted on; one that closed at-or-after it is the
 * fresh attempt that already happened and does not need repeating.
 */
async function claimSelectedIdeas(): Promise<number> {
  const candidates = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(
      and(
        eq(ideas.status, 'selected_for_development'),
        notExists(
          db
            .select({ id: ideaRuns.id })
            .from(ideaRuns)
            .where(
              and(
                eq(ideaRuns.ideaId, ideas.id),
                or(isNull(ideaRuns.endedAt), gte(ideaRuns.endedAt, ideas.updatedAt)),
              ),
            ),
        ),
      ),
    )

  let claimed = 0
  for (const candidate of candidates) {
    if (await claimIdeaForHandoff(candidate.id)) claimed++
  }
  return claimed
}

// --- dispatching a ready prompt into a session -------------------------------

async function resolveSession(idea: IdeaRow, prompt: IdeaPromptRow): Promise<string> {
  if (idea.sessionId) return idea.sessionId
  const session = await createSession(idea.projectId, {
    // generatedTitle is only ever null before a prompt reaches 'ready', which
    // dispatchRun's own caller already checked — but the fallback keeps this
    // honest instead of asserting it.
    ...(prompt.generatedTitle ? { title: prompt.generatedTitle } : {}),
    ...(idea.orchestrator ? { orchestrator: idea.orchestrator } : {}),
    ...(idea.baseBranch ? { baseBranch: idea.baseBranch } : {}),
    ...(idea.maxBudgetUsd !== null ? { maxBudgetUsd: idea.maxBudgetUsd } : {}),
  })
  // Persisted immediately, before either step below runs: a follow-up
  // dispatch (or a retry of this one after a crash) must reuse this session
  // rather than creating a second one for the same idea.
  await db
    .update(ideas)
    .set({ sessionId: session.id, updatedAt: new Date() })
    .where(eq(ideas.id, idea.id))
  return session.id
}

/**
 * Whether `sessionId` already carries a `type='prompt'` message sent for
 * `text` since `runStartedAt` — a crash-retry of `dispatchRun` recognising its
 * own earlier send rather than repeating it. See `dispatchRun`'s own comment
 * for the exact window this closes.
 *
 * Bounding by `runStartedAt` (this run's own, immutable `idea_runs.startedAt`
 * — never "now") is what makes it safe to call even when the session is not
 * actually a retry, e.g. a followup run's very first dispatch reusing the
 * session an earlier, already-closed run on the same idea created: that
 * session can carry plenty of old prompt messages, but every one of them was
 * created before *this* run started, so none can ever match here by
 * accident. `sanitizeForDb` mirrors exactly what `sendMessage` persisted, so
 * a `text` containing a NUL still compares equal to its stored form.
 */
async function findAlreadySentPrompt(
  sessionId: string,
  runStartedAt: Date,
  text: string,
): Promise<string | null> {
  const wanted = sanitizeForDb({ text }).text
  const candidates = await db
    .select({ id: messages.id, payload: messages.payload })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.type, 'prompt'),
        gte(messages.createdAt, runStartedAt),
      ),
    )
  const match = candidates.find((row) => (row.payload as { text?: unknown }).text === wanted)
  return match?.id ?? null
}

/**
 * The prompt names an idea asset by its own filename (library/idea-prompt.ts's
 * own instruction: "Carry that filename into the prompt exactly as given") —
 * but attachIdeaAssetsToSession's checksum dedup can land those same bytes in
 * the session under a *different* name (an earlier upload, or another idea
 * asset, already claimed that checksum first; see that function's own
 * docblock). Left alone, the agent is pointed at a filename that exists
 * nowhere in its uploads directory. This reconciles the two: for every ready
 * idea asset whose idea-side name differs from the session-side name that
 * now actually backs its bytes, a short note is appended naming both — never
 * a rewrite of the generated text itself, which stays exactly what
 * prompt-service.ts produced. An idea with nothing renamed gets no note at
 * all.
 */
function renamedAssetsNote(filenames: Map<string, string>): string {
  const renamed = [...filenames].filter(([ideaName, sessionName]) => ideaName !== sessionName)
  if (renamed.length === 0) return ''
  const lines = renamed.map(
    ([ideaName, sessionName]) => `"${ideaName}" is available in this session as "${sessionName}".`,
  )
  return (
    '\n\n(Note: this idea named some files that already existed in this session under another ' +
    `name. ${lines.join(' ')})`
  )
}

/**
 * Drive one claimed run from a ready prompt into `running`.
 *
 * Order matters and is load-bearing: assets are copied into the session
 * before the prompt is sent, never after — see attachIdeaAssetsToSession's
 * own docblock (features/ideas/files.ts) for why a session_files row landing
 * after the prompt message already queued waits a whole extra turn before the
 * agent is ever told it exists. The same call is also where any renamed
 * filename is discovered (see renamedAssetsNote above), which is why the
 * text actually sent is only finalised after it returns, never before.
 *
 * Every step can fail — createSession 400s on a baseBranch that resolves to
 * nothing and 409s on a project that is not `ready`; attachIdeaAssetsToSession
 * fails as a unit when the whole asset set busts a cap; sendMessage 400s
 * without an orchestrator — and none of it may leave the run open or the card
 * silently stuck: any failure below closes the run `needs_attention` and
 * writes a human sentence onto `ideas.lastError` instead. Never retried in a
 * loop from in here; the next sweep tick may pick the same run back up only
 * while it is still open, which a needs_attention closure ends.
 *
 * The one narrow window this has to cope with: a worker process killed
 * between `sendMessage` returning and the transaction below it committing
 * leaves the run at `dispatching` with no `promptMessageId` recorded, and the
 * next tick's retry resolves the same (already-persisted) session —
 * `resolveSession` and `attachIdeaAssetsToSession` are both safe to repeat,
 * and produce the same renamed-assets note on the retry as they did the
 * first time, since the mapping is derived from rows already committed —
 * and would otherwise call `sendMessage` a second time: a second prompt
 * message, real spend, and an orchestrator told to do the same job twice.
 * Fixed by content rather than a dedicated idempotency key this schema does
 * not carry: `findAlreadySentPrompt` looks for a message this exact run could
 * only have produced by having already sent it, and adopts its id instead of
 * sending again. Gated on `idea.sessionId` already being set *before* this
 * call resolves it — a brand-new session obviously carries no messages yet,
 * so this only spends the extra query when it can possibly matter.
 */
async function dispatchRun(runId: string, ideaId: string, prompt: IdeaPromptRow): Promise<boolean> {
  const [claim] = await db
    .update(ideaRuns)
    .set({ status: 'dispatching' })
    .where(and(eq(ideaRuns.id, runId), isNull(ideaRuns.endedAt)))
    .returning({ id: ideaRuns.id, startedAt: ideaRuns.startedAt })
  if (!claim) return false

  const idea = await ideaRowById(ideaId)
  if (!idea) {
    await closeRun(runId, ideaId, 'needs_attention', 'The idea behind this run no longer exists.', {
      lastError: null,
    })
    return false
  }

  const generatedText = prompt.generatedText
  if (!generatedText) {
    const detail = 'The generated prompt has no text to send — nothing to hand off.'
    await closeRun(runId, ideaId, 'needs_attention', detail, { lastError: detail })
    return false
  }

  const sessionAlreadyPersisted = Boolean(idea.sessionId)

  let sessionId: string
  try {
    sessionId = await resolveSession(idea, prompt)
  } catch (error) {
    const detail = `Could not create a session for this idea: ${errMessage(error)}`
    await closeRun(runId, ideaId, 'needs_attention', detail, { lastError: detail })
    return false
  }

  let text = generatedText
  try {
    const { filenames } = await attachIdeaAssetsToSession(ideaId, sessionId)
    text += renamedAssetsNote(filenames)
  } catch (error) {
    const detail = `Could not attach this idea's files to its session: ${errMessage(error)}`
    await closeRun(runId, ideaId, 'needs_attention', detail, { lastError: detail })
    return false
  }

  let messageId: string
  const alreadySent = sessionAlreadyPersisted
    ? await findAlreadySentPrompt(sessionId, claim.startedAt, text)
    : null
  if (alreadySent) {
    messageId = alreadySent
  } else {
    try {
      const message = await sendMessage(sessionId, text)
      messageId = message.id
    } catch (error) {
      const detail = `Could not send the prompt into the session: ${errMessage(error)}`
      await closeRun(runId, ideaId, 'needs_attention', detail, { lastError: detail })
      return false
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(ideaRuns)
      .set({ sessionId, promptMessageId: messageId, status: 'running' })
      .where(eq(ideaRuns.id, runId))
    await tx
      .update(ideas)
      .set({ status: 'in_progress_dev', lastError: null, updatedAt: new Date() })
      .where(eq(ideas.id, ideaId))
  })
  return true
}

/**
 * Advance every run still short of `running`: a `pending` prompt is left
 * alone (nothing to do until the generation worker finishes it), a `failed`
 * one closes the run `needs_attention`, and a `ready` one is dispatched.
 *
 * Also revisits a run still `dispatching` — a worker crash mid-handoff, see
 * `dispatchRun`'s own comment on the one gap that leaves — rather than only
 * ever looking at `generating` ones, so a crash there is retried rather than
 * left open forever.
 */
async function progressOpenRuns(): Promise<{ dispatched: number; failed: number }> {
  const openRuns = await db
    .select()
    .from(ideaRuns)
    .where(and(isNull(ideaRuns.endedAt), inArray(ideaRuns.status, ['generating', 'dispatching'])))

  let dispatched = 0
  let failed = 0
  for (const run of openRuns) {
    if (!run.promptId) {
      // True between claimIdeaForHandoff's own two writes (insert the run,
      // then link the prompt it just generated) — those cannot be one
      // transaction (createIdeaPrompt's own enqueue must run only after ITS
      // transaction commits, see that function's own comment), so a worker
      // killed in between leaves exactly this: an open run nothing will ever
      // link a prompt onto again. Indistinguishable, for one tick, from an
      // ordinary claim still in flight — IDEA_HANDOFF_CLAIM_GRACE_MS is what
      // tells the two apart, so this is left alone until it has clearly
      // stopped being the ordinary case. Past that window, closed
      // needs_attention like every other unrecoverable failure here, so the
      // card is not stranded on `selected_for_development` forever with
      // nothing to explain it — the existing retry gate (claimSelectedIdeas'
      // own comment) picks it back up once the user does anything to the
      // idea.
      const ageMs = Date.now() - run.startedAt.getTime()
      if (ageMs < env.IDEA_HANDOFF_CLAIM_GRACE_MS) continue
      const detail =
        'This run never received a generated prompt — the process handling it likely crashed ' +
        'before it could. Edit the idea or move its card again to retry.'
      await closeRun(run.id, run.ideaId, 'needs_attention', detail, { lastError: detail })
      failed++
      continue
    }

    const prompt = await promptRowById(run.promptId)
    if (!prompt) {
      const detail = 'The generated prompt for this run disappeared before it could be sent.'
      await closeRun(run.id, run.ideaId, 'needs_attention', detail, { lastError: detail })
      failed++
      continue
    }
    if (prompt.status === 'pending') continue
    if (prompt.status === 'failed') {
      const detail = `Prompt generation failed: ${prompt.error ?? 'no reason recorded'}`
      await closeRun(run.id, run.ideaId, 'needs_attention', detail, { lastError: detail })
      failed++
      continue
    }
    if (await dispatchRun(run.id, run.ideaId, prompt)) dispatched++
    else failed++
  }
  return { dispatched, failed }
}

/** One sweep tick: claim new cards, then push every run already claimed a
 * little further toward `running`. Called on `queue/idea-handoff.worker.ts`'s
 * own short schedule, and once at worker boot for whatever piled up while
 * nothing was sweeping — mirrors `reconcileTurns`'s identical two triggers. */
export async function sweepIdeaHandoffs(): Promise<{
  claimed: number
  dispatched: number
  failed: number
}> {
  const claimed = await claimSelectedIdeas()
  const { dispatched, failed } = await progressOpenRuns()
  if (claimed > 0 || dispatched > 0 || failed > 0) {
    logger.info(
      `Idea handoff sweep: claimed ${claimed}, dispatched ${dispatched}, failed ${failed}`,
    )
  }
  return { claimed, dispatched, failed }
}

// --- the follow-up path -------------------------------------------------------

/**
 * "Continue work": generate a follow-up prompt and claim this idea's next
 * run for it. Dispatch itself is not done here — the same reactive sweep that
 * dispatches an initial handoff picks this run up too, once its prompt turns
 * `ready`, through the identical `progressOpenRuns` path above. That is
 * deliberate: it keeps exactly one place in this codebase that ever sends a
 * prompt into a session on this feature's behalf, rather than a second copy
 * of `dispatchRun`'s logic living here.
 *
 * Ordering differs from `claimIdeaForHandoff` on purpose: `createIdeaPrompt`
 * runs *before* the run is claimed, not after. Its own validation (no
 * orchestrator, project not ready, no completed run to follow up on) has to
 * reach the caller of this explicit, user-initiated endpoint directly, as the
 * 400/409 it already is — burying that inside a needs_attention run the UI
 * would have to separately poll for is a worse experience for an action a
 * human just clicked. The cost is a narrow race the sweep's own claim-first
 * order does not have: two overlapping "Continue" clicks can both generate a
 * prompt before either wins the run-claim below, so the losing generation is
 * spent for nothing. Accepted here because it takes a double-click to reach,
 * not an automatic sweep re-running every tick — the failure mode
 * claimIdeaForHandoff's own ordering exists to prevent.
 */
export async function continueIdea(ideaId: string): Promise<void> {
  const prompt = await createIdeaPrompt(ideaId, { kind: 'followup' })
  try {
    await db
      .insert(ideaRuns)
      .values({ ideaId, kind: 'followup', promptId: prompt.id, status: 'generating' })
  } catch (error) {
    if (isUniqueViolation(error, 'idea_runs_open_key')) {
      throw conflict('This idea already has a handoff in progress')
    }
    throw error
  }
}

// --- closing a run once its chain of turns stops -----------------------------

/**
 * Whether `targetId` is reachable from `rootId` by walking
 * `messages.continuesMessageId` — an auto-continuation chain is the *same*
 * run continuing, not a new one (see this module's header). Walked backward,
 * from the message that just ended toward the run's own root, rather than
 * forward from the root: `messages.id` is the primary key, so each hop here
 * is an index lookup, where walking forward would mean an unindexed scan for
 * "whichever message continues this one" at every level. Depth is bounded by
 * how long the chain actually is, never hardcoded to
 * session-run.worker.ts's own `MAX_AUTO_CONTINUATIONS` — that budget resets
 * on an operator message mid-chain, so a real run can legitimately walk
 * further than it. `seen` only guards against a cycle that should never
 * exist, not a real depth limit.
 */
async function messageIsInChain(rootId: string, targetId: string): Promise<boolean> {
  let currentId: string | null = targetId
  const seen = new Set<string>()
  while (currentId) {
    if (currentId === rootId) return true
    if (seen.has(currentId)) return false
    seen.add(currentId)
    const [row] = await db
      .select({ continuesMessageId: messages.continuesMessageId })
      .from(messages)
      .where(eq(messages.id, currentId))
      .limit(1)
    if (!row) return false
    currentId = row.continuesMessageId
  }
  return false
}

/**
 * `idea_runs.detail` — the digest a later follow-up prompt reads as "what the
 * session did" (see createIdeaPrompt's own followup branch). The honest
 * source is the last `type='result'` message this run's own chain produced —
 * the agent's own final text, already persisted verbatim in that message's
 * payload — bounded below by the run's root prompt message's own `seq` so a
 * *previous*, already-closed run's result on the same session is never
 * picked up by mistake. Falls back to `turnDetail` (the sentence
 * session-run.worker.ts already wrote about how the turn stopped) when there
 * is no result message at all — a turn that never got that far still leaves
 * something better than silence.
 */
async function lastResultDigest(sessionId: string, rootMessageId: string): Promise<string | null> {
  const [root] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, rootMessageId))
    .limit(1)
  if (!root) return null
  const [resultRow] = await db
    .select({ payload: messages.payload })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.type, 'result'),
        gte(messages.seq, root.seq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1)
  const result = (resultRow?.payload as { result?: unknown } | undefined)?.result
  return typeof result === 'string' && result.trim() !== '' ? result : null
}

/**
 * The turn_outcome -> (idea_run outcome, board move, lastError) mapping this
 * whole track exists to implement. `ideaStatus` is only ever set for
 * `completed`: every other outcome "stays" exactly where the brief's own
 * table says, which this reads as leaving the card wherever it already is —
 * including wherever a human may have dragged it in the meantime — rather
 * than this reasserting `in_progress_dev` over that. A closed switch, not a
 * `default`, on purpose: `turnOutcomeEnum` (db/schema.ts) is deliberately
 * exhaustive so a future outcome added there fails this file to compile
 * instead of silently landing on `needs_attention` by accident of it being
 * the last branch.
 */
function mapTurnOutcome(
  outcome: Exclude<TurnOutcome, 'continuing'>,
  turnDetail: string | null,
): { runOutcome: IdeaRunOutcome; ideaStatus?: IdeaStatus; lastError: string | null } {
  switch (outcome) {
    case 'completed':
      return { runOutcome: 'finished', ideaStatus: 'verification', lastError: null }
    case 'interrupted':
      return { runOutcome: 'interrupted', lastError: null }
    case 'drained':
      return {
        runOutcome: 'superseded',
        lastError: 'The session was given other work while this run was still in flight.',
      }
    case 'stopped_turn_limit':
    case 'stopped_api_error':
    case 'stopped_execution_error':
    case 'stopped_over_budget':
    case 'failed':
    case 'stalled':
    case 'unknown':
    case 'abandoned':
    case 'stranded':
      return {
        runOutcome: 'needs_attention',
        lastError:
          turnDetail ?? 'The session stopped without finishing, and left no further detail.',
      }
  }
}

/**
 * The QUEUE_TURN_ENDED consumer (registered in queue/idea-handoff.worker.ts,
 * never inside session-run.worker.ts itself — that file announces facts in
 * session vocabulary and must not learn who listens).
 *
 * Most turns this fires for belong to no idea at all — the first, cheap
 * lookup is exactly that filter: an open idea_runs row for this session. Once
 * one is found, `messageIsInChain` confirms `promptMessageId` genuinely
 * belongs to *this* run's own chain (rather than assuming any open run on the
 * session must be it), and `continuing` is handed back before ever mapping an
 * outcome — the run's tail simply moved one message further out, so nothing
 * about the idea changes yet.
 */
export async function handleTurnEnded(job: TurnEndedJob): Promise<void> {
  const { sessionId, promptMessageId, outcome } = job

  const [run] = await db
    .select()
    .from(ideaRuns)
    .where(and(eq(ideaRuns.sessionId, sessionId), isNull(ideaRuns.endedAt)))
    .limit(1)
  if (!run?.promptMessageId) return

  if (!(await messageIsInChain(run.promptMessageId, promptMessageId))) return

  // Validated at the boundary, not cast: TurnEndedJob.outcome is a queue
  // payload — data, not a value this module produced — and is typed `string`
  // rather than the enum precisely so this file cannot skip the check.
  if (!KNOWN_TURN_OUTCOMES.has(outcome)) {
    const detail = `Unrecognised turn outcome "${outcome}" for prompt message ${promptMessageId}`
    logger.error(`Idea handoff: ${detail}`)
    await closeRun(run.id, run.ideaId, 'needs_attention', detail, { lastError: detail })
    return
  }
  if (outcome === 'continuing') return

  const [messageRow] = await db
    .select({ turnDetail: messages.turnDetail })
    .from(messages)
    .where(eq(messages.id, promptMessageId))
    .limit(1)
  const turnDetail = messageRow?.turnDetail ?? null

  const mapping = mapTurnOutcome(outcome as Exclude<TurnOutcome, 'continuing'>, turnDetail)
  const detail = (await lastResultDigest(sessionId, run.promptMessageId)) ?? turnDetail
  await closeRun(run.id, run.ideaId, mapping.runOutcome, detail, {
    ...(mapping.ideaStatus !== undefined && { status: mapping.ideaStatus }),
    lastError: mapping.lastError,
  })
}
