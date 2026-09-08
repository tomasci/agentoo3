// Closing an idea_runs row, and the one reconciler predicate that does not
// belong to a turn's own chain (a run whose session was deleted out from
// under it).
//
// Deliberately its own file, split out of features/ideas/handoff.ts: this is
// the one piece queue/turn-reconcile.worker.ts needs, and that file is
// imported by turn-outcome.test.ts alongside a hand-written, intentionally
// minimal mock of @/queue/index.ts (one that lists only the exports that
// existed when it was written — the same constraint session-run.worker.ts's
// own header documents for a different mock). handoff.ts pulls in
// createSession, sendMessage and createIdeaPrompt, each of which reaches
// @/queue for its own enqueue call; importing any single export from that
// module still evaluates the whole file's top-level imports, so
// turn-reconcile.worker.ts importing so much as one function from handoff.ts
// would drag that entire chain in with it and break that mock — a module
// boundary problem, not a naming one. Keeping the two functions here, with
// nothing above them but `db`, the schema and `sanitizeForDb`, is what lets
// the reconciler stay exactly as cheap to import as it always was.
//
// features/ideas/handoff.ts imports `closeRun` from here rather than
// defining its own — there is exactly one way an idea_runs row closes,
// used by both the reactive (QUEUE_TURN_ENDED) and the swept
// (reconcileOrphanedIdeaRuns) paths.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { type ideaRunOutcomeEnum, ideaRuns, type ideaStatusEnum, ideas } from '@/db/schema'

type IdeaStatus = (typeof ideaStatusEnum.enumValues)[number]
type IdeaRunOutcome = (typeof ideaRunOutcomeEnum.enumValues)[number]

/**
 * Close an open run and, in the same transaction, patch its idea —
 * `ideaPatch.status` only when the caller actually wants to move the card;
 * omitting it leaves the card exactly where the user — or a manual drag —
 * last put it, rather than this reasserting a status over whatever that was.
 *
 * `WHERE endedAt IS NULL` makes this idempotent: whichever caller gets here
 * first (an ordinary close, the reconciler closing an orphaned run, a stale
 * retry) renders the verdict, and every other one finds nothing left to do —
 * the same shape session-run.worker.ts's own `endTurn` already documents for
 * turns.
 */
export async function closeRun(
  runId: string,
  ideaId: string,
  outcome: IdeaRunOutcome,
  detail: string | null,
  ideaPatch: { status?: IdeaStatus; lastError: string | null },
): Promise<boolean> {
  let closed = false
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ideaRuns)
      .set({
        status: 'closed',
        outcome,
        detail: detail == null ? null : sanitizeForDb(detail),
        endedAt: new Date(),
      })
      .where(and(eq(ideaRuns.id, runId), isNull(ideaRuns.endedAt)))
      .returning({ id: ideaRuns.id })
    if (!row) return
    closed = true
    await tx
      .update(ideas)
      .set({
        ...(ideaPatch.status !== undefined && { status: ideaPatch.status }),
        lastError: ideaPatch.lastError == null ? null : sanitizeForDb(ideaPatch.lastError),
        // Deliberately NOT touching updatedAt here — do not add it back.
        // handoff.ts's claimSelectedIdeas gates its retry on "no run that
        // closed at or after ideas.updatedAt", precisely so a card stuck
        // `needs_attention` re-triggers once a user actually does something
        // about it (patches the orchestrator, moves the card, ...) and never
        // on its own. A close touching updatedAt here would move that
        // watermark forward on every single close, which makes "closed at or
        // after updatedAt" trivially true forever and the gate never open
        // again — the exact stranding bug that predicate exists to fix. Never
        // needed anyway: every outcome that closes a run either leaves the
        // idea's status untouched (closeRun's own ideaPatch.status is
        // undefined) or moves it off `selected_for_development` (the
        // `completed` outcome, into `verification`) — the status-changing
        // case does not depend on updatedAt moving here to be seen.
      })
      .where(eq(ideas.id, ideaId))
  })
  return closed
}

/**
 * Runs whose `session_id` has been cleared by `ON DELETE SET NULL` (see
 * `idea_runs.session_id`, db/schema.ts): the session, and every message that
 * could ever close this run through `handleTurnEnded`'s chain walk
 * (features/ideas/handoff.ts), are gone. Such a run can never close by the
 * ordinary rule, so it needs its own predicate — added here, to the existing
 * reconciler (queue/turn-reconcile.worker.ts), rather than a second one.
 *
 * Scoped to `status = 'running'` specifically, not merely "sessionId is
 * null": a run still `generating` or `dispatching` also has a null
 * `sessionId`, for the ordinary reason that dispatch has not reached
 * resolving a session yet — closing *those* here would be wrong, not
 * orphaned. Only a run that had genuinely reached `running` (and therefore
 * definitely had a session, before something deleted it) qualifies.
 *
 * Idea status is left untouched: nothing about a deleted session tells this
 * which column the card belongs in, so this only records why in `lastError`
 * rather than guessing a move.
 */
export async function reconcileOrphanedIdeaRuns(): Promise<number> {
  const rows = await db
    .select({ id: ideaRuns.id, ideaId: ideaRuns.ideaId })
    .from(ideaRuns)
    .where(
      and(isNull(ideaRuns.sessionId), isNull(ideaRuns.endedAt), eq(ideaRuns.status, 'running')),
    )

  let closed = 0
  const detail = 'The session behind this run was deleted, so it can never close on its own.'
  for (const row of rows) {
    if (await closeRun(row.id, row.ideaId, 'session_deleted', detail, { lastError: detail }))
      closed++
  }
  return closed
}
