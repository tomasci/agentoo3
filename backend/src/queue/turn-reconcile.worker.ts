// Three predicates that make "the work kicked off by prompt M has stopped,
// and how" answerable even when nothing was watching when it happened.
//
// A turn's own branches (session-run.worker.ts's `endTurn` calls) are the
// primary way that fact gets recorded, and its own `finally` backstop catches
// a forgotten branch — but neither can survive the worker process itself
// dying: a SIGKILL skips every `finally` in this codebase, that one included.
// This file is the second, independent net: a turn whose prompt was claimed
// but never closed, and whose session has gone quiet by the heartbeat
// session-run.worker.ts's timer keeps warm, is stranded — the worker holding
// it is gone, not merely slow. Separately, a prompt still marked `pending`
// whose session has moved somewhere nothing will ever wake it back up from on
// its own is abandoned. The third predicate isn't about a turn at all: an
// idea_runs row whose session was deleted out from under it
// (reconcileOrphanedIdeaRuns, features/ideas/run-close.ts) can never close by
// the ordinary chain rule either, and lives here rather than as a second
// reconciler for the same reason the first two share this file — one sweep,
// one schedule, one place an operator looks for "what silently got stuck".
//
// Two triggers run the same reconciliation, at two different cadences: once
// at worker boot (backend/src/worker.ts), for whatever piled up while nothing
// was sweeping at all — most likely because this very process is the one that
// restarted; and on this file's own schedule (queue/index.ts's
// `ensureTurnReconcileSchedule`) for everything after that. Neither trigger
// blanket-resets every `running` session: both call the same heartbeat-gated
// query below, so this stays correct even if a second worker process exists
// and genuinely still holds a turn this one knows nothing about.
//
// Deliberately not auto-resume. Diagnosing a stranded turn and unblocking its
// session (so delete, send and interrupt work again) is this file's whole
// job; re-running work that may have already spent money is the policy
// session-run.worker.ts's `recover` refuses in writing, and this file does not
// second-guess that refusal.

import { Worker } from 'bullmq'
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { messages, sessions } from '@/db/schema'
import { reconcileOrphanedIdeaRuns } from '@/features/ideas/run-close'
import { logger } from '@/lib/logger'
import type { TurnReconcileJob } from './index'
// Imported as a namespace, not destructured — see session-run.worker.ts's own
// `queueIndex` import for why: several tests hand-write a mock of this module
// listing only the exports that existed when they were written, and a static
// `import { x } from` a name that mock does not provide is a hard
// `SyntaxError` at load time under Bun's `mock.module`, not a soft
// `undefined`. `startTurnReconcileWorker` below is never called from a test
// that only wants `reconcileStrandedTurns`/`reconcileAbandonedPrompts`, so a
// namespace import degrading those two unused reads to `undefined` there is
// harmless.
import * as queueIndex from './index'
import { endTurn, HEARTBEAT_INTERVAL_MS } from './session-run.worker'

/**
 * How stale a heartbeat has to be before its turn is declared stranded. 3x the
 * heartbeat's own tick, not 1x: a single missed tick is expected noise (a GC
 * pause, a slow write, this sweep landing in the same instant as the timer),
 * not evidence the worker holding the turn is gone. Derived from
 * `HEARTBEAT_INTERVAL_MS` rather than a second constant, so the two can never
 * drift out of the ratio this comment describes.
 */
const STRANDED_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3

/**
 * Turns claimed but never closed, whose session has gone quiet for longer than
 * a worker dying mid-turn would ever leave it quiet on its own.
 *
 * `heartbeatAt IS NULL` alone would misfire on every turn still inside its
 * first `HEARTBEAT_INTERVAL_MS` — claimTurn resets it to null on every fresh
 * claim precisely so a *previous* turn's stale value cannot leak into a brand
 * new one — so a null heartbeat only counts once the claim itself
 * (`sessions.updatedAt`, also reset at claim time) is old enough that the
 * first tick should already have landed.
 */
export async function reconcileStrandedTurns(now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STRANDED_AFTER_MS)
  const rows = await db
    .select({
      promptId: messages.id,
      sessionId: messages.sessionId,
      heartbeatAt: sessions.heartbeatAt,
      updatedAt: sessions.updatedAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(
      and(
        isNotNull(messages.turnStartedAt),
        isNull(messages.turnEndedAt),
        eq(sessions.status, 'running'),
        or(
          and(isNull(sessions.heartbeatAt), lt(sessions.updatedAt, staleBefore)),
          and(isNotNull(sessions.heartbeatAt), lt(sessions.heartbeatAt, staleBefore)),
        ),
      ),
    )

  let recovered = 0
  for (const row of rows) {
    const lastSeen = (row.heartbeatAt ?? row.updatedAt).toISOString()
    const detail = `Stranded: the worker process holding this turn stopped updating its heartbeat (last seen ${lastSeen}). It most likely died mid-turn — nothing was re-run. Send a new message, or delete the session, once you have checked what it left behind.`
    // Guards against a race with the turn itself finishing between the SELECT
    // above and this call: if `rendered` is false, some branch's own endTurn
    // already closed this prompt for real, and the session's real status is
    // already correct — moving it to `failed` here would be the reconciler
    // overwriting a healthy outcome with a stale one.
    const rendered = await endTurn(row.promptId, 'stranded', detail)
    if (!rendered) continue
    await db
      .update(sessions)
      .set({ status: 'failed', lastError: sanitizeForDb(detail), updatedAt: new Date() })
      .where(eq(sessions.id, row.sessionId))
    recovered++
  }
  return recovered
}

/**
 * Prompts still marked `pending` whose session is not `running` or `queued` —
 * nothing will ever pick these up on its own; only a fresh message, sent by a
 * human or the API, moves such a session back to `queued` and re-drains its
 * pending prompts in order. Recorded rather than silently left, so the
 * transcript says what happened instead of a message just sitting there with
 * no explanation.
 *
 * Deliberately not cleared (`pending` stays `true`): a later message reviving
 * this session still finds this prompt and still runs it, oldest first,
 * exactly as `noticeStrandedPrompt`'s own comment describes for the
 * interrupted case — recording that it was once abandoned must not be the
 * thing that makes it stay that way.
 */
export async function reconcileAbandonedPrompts(): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(
      and(
        eq(messages.pending, true),
        inArray(sessions.status, ['idle', 'interrupted', 'completed', 'failed']),
      ),
    )

  let recorded = 0
  for (const row of rows) {
    const rendered = await endTurn(
      row.id,
      'abandoned',
      'Abandoned: this message is still waiting, but its session is not running or queued, so nothing will pick it back up on its own. Send a new message and it will run first, before whatever you send.',
    )
    if (rendered) recorded++
  }
  return recorded
}

export async function reconcileTurns(): Promise<{
  stranded: number
  abandoned: number
  orphanedIdeaRuns: number
}> {
  const stranded = await reconcileStrandedTurns()
  const abandoned = await reconcileAbandonedPrompts()
  const orphanedIdeaRuns = await reconcileOrphanedIdeaRuns()
  if (stranded > 0 || abandoned > 0 || orphanedIdeaRuns > 0) {
    logger.info(
      `Turn reconciler: recovered ${stranded} stranded turn(s), recorded ${abandoned} abandoned ` +
        `prompt(s), closed ${orphanedIdeaRuns} idea run(s) whose session was deleted`,
    )
  }
  return { stranded, abandoned, orphanedIdeaRuns }
}

export function startTurnReconcileWorker() {
  const worker = new Worker<TurnReconcileJob>(
    queueIndex.QUEUE_TURN_RECONCILE,
    () => reconcileTurns(),
    {
      connection: queueIndex.redisConnection(),
      concurrency: 1,
    },
  )
  worker.on('failed', (job, error) => {
    logger.error(`Turn reconcile sweep (${job?.data.reason}) failed: ${error.message}`)
  })
  return worker
}
