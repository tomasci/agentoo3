// Stale-run recovery for learning_runs — the same reasoning
// queue/turn-reconcile.worker.ts's own header gives for turns, one level up:
// a learning run that a dead worker process left `running`, or a `queued` run
// whose BullMQ job is gone, would otherwise block *every future run forever*
// because of `learning_runs_single_active_key` (db/schema.ts) — at most one
// run may be queued or running at a time.
//
// Two independent predicates, each guarded end to end: a DB or Redis call
// failing here must degrade to "try again next sweep", never an exception
// that takes the whole reconciliation tick down with it — the identical
// discipline turn-reconcile.worker.ts's own predicates already follow.

import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { learningRuns } from '@/db/schema'
import { logger } from '@/lib/logger'
import { sessionRunQueue } from '@/queue'
import { HEARTBEAT_INTERVAL_MS } from '@/queue/session-run.worker'

/** 3x the heartbeat's own tick — identical ratio, and identical reasoning, to
 * turn-reconcile.worker.ts's own STRANDED_AFTER_MS: one missed tick is
 * ordinary noise, not evidence the worker holding the run is gone. */
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3

/**
 * A `running` learning run whose heartbeat (or, absent one, whose own claim
 * time — `startedAt`, reset at claim exactly like `sessions.updatedAt` is)
 * has gone quiet for longer than a worker dying mid-run would ever leave it
 * quiet on its own.
 */
async function reconcileHeartbeats(now: Date): Promise<number> {
  try {
    const staleBefore = new Date(now.getTime() - STALE_AFTER_MS)
    const rows = await db
      .select({ id: learningRuns.id })
      .from(learningRuns)
      .where(
        and(
          eq(learningRuns.status, 'running'),
          or(
            and(isNull(learningRuns.heartbeatAt), lt(learningRuns.startedAt, staleBefore)),
            lt(learningRuns.heartbeatAt, staleBefore),
          ),
        ),
      )

    let recovered = 0
    for (const row of rows) {
      const detail =
        'Stranded: the worker process holding this run stopped updating its heartbeat. It most likely died mid-run — nothing was re-run.'
      const [updated] = await db
        .update(learningRuns)
        .set({ status: 'failed', error: detail, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(learningRuns.id, row.id), eq(learningRuns.status, 'running')))
        .returning({ id: learningRuns.id })
      if (updated) recovered++
    }
    return recovered
  } catch (error) {
    logger.error(`Learning stale-run sweep (heartbeats): ${String(error)}`)
    return 0
  }
}

/**
 * A `queued` learning run whose BullMQ job (`learning-<runId>` on
 * `sessionRunQueue` — see queue/index.ts's `enqueueLearningRun`) no longer
 * exists, or has already settled (`completed`/`failed`) without the run row
 * itself ever having been claimed. A job still in `waiting`/`delayed`/
 * `prioritized`/`active`/`waiting-children` is entirely legitimate: a queued
 * run can sit behind running sessions for a long time before its turn comes,
 * exactly as this feature's own README section describes.
 */
async function reconcileLostJobs(): Promise<number> {
  try {
    const rows = await db
      .select({ id: learningRuns.id })
      .from(learningRuns)
      .where(eq(learningRuns.status, 'queued'))

    let recovered = 0
    for (const row of rows) {
      let lost: boolean
      try {
        const job = await sessionRunQueue.getJob(`learning-${row.id}`)
        if (!job) {
          lost = true
        } else {
          const state = await job.getState()
          lost = state === 'completed' || state === 'failed'
        }
      } catch (error) {
        // Redis unreachable, most likely — leave this row for the next sweep
        // rather than guessing it is lost.
        logger.warn(
          `Learning stale-run sweep: could not read job state for run ${row.id}: ${String(error)}`,
        )
        continue
      }
      if (!lost) continue

      const detail =
        'Failed: the queue job for this run no longer exists (or already settled without this row ever being claimed). Something dropped it before a worker could pick it up.'
      const [updated] = await db
        .update(learningRuns)
        .set({ status: 'failed', error: detail, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(learningRuns.id, row.id), eq(learningRuns.status, 'queued')))
        .returning({ id: learningRuns.id })
      if (updated) recovered++
    }
    return recovered
  } catch (error) {
    logger.error(`Learning stale-run sweep (lost jobs): ${String(error)}`)
    return 0
  }
}

/** Both predicates, run once. Called at worker boot and on an ongoing
 * schedule — see queue/turn-reconcile.worker.ts (hooked into its existing
 * sweep) and src/worker.ts for where. */
export async function reconcileStaleLearningRuns(now: Date = new Date()): Promise<{
  staleHeartbeats: number
  lostJobs: number
}> {
  const staleHeartbeats = await reconcileHeartbeats(now)
  const lostJobs = await reconcileLostJobs()
  if (staleHeartbeats > 0 || lostJobs > 0) {
    logger.info(
      `Learning stale-run sweep: recovered ${staleHeartbeats} stale-heartbeat run(s), ${lostJobs} run(s) with a lost queue job`,
    )
  }
  return { staleHeartbeats, lostJobs }
}
