// The Idea Manager's own two Workers: the short, self-healing sweep that
// claims a card dropped into "selected for development" and drives its
// handoff forward, and the QUEUE_TURN_ENDED consumer that closes a run once
// its chain's tail turn stops. See features/ideas/handoff.ts for the actual
// business logic — this file is only the two registrations and their own
// concurrency reasoning.
//
// One file for both, not two: neither is large enough to earn its own, and
// both exist for the same reason (closing the loop this track owns) — mirrors
// turn-reconcile.worker.ts, itself one file serving more than one
// reconciliation predicate.

import { Worker } from 'bullmq'
import { handleTurnEnded, sweepIdeaHandoffs } from '@/features/ideas/handoff'
import { logger } from '@/lib/logger'
import {
  type IdeaHandoffSweepJob,
  QUEUE_IDEA_HANDOFF_SWEEP,
  QUEUE_TURN_ENDED,
  redisConnection,
  type TurnEndedJob,
} from './index'

/**
 * The sweep scans across every project's board, not one card — same reason
 * `turn-reconcile.worker.ts`'s own identical `concurrency: 1` gives: this has
 * nothing to do with `WORKER_CONCURRENCY`, which bounds parallel session
 * turns.
 */
export function startIdeaHandoffSweepWorker() {
  const worker = new Worker<IdeaHandoffSweepJob>(
    QUEUE_IDEA_HANDOFF_SWEEP,
    () => sweepIdeaHandoffs(),
    {
      connection: redisConnection(),
      concurrency: 1,
    },
  )
  worker.on('failed', (job, error) => {
    logger.error(`Idea handoff sweep (${job?.data.reason}) failed: ${error.message}`)
  })
  return worker
}

/**
 * The consumer TurnEndedJob's own comment (queue/index.ts) now names —
 * registered here, never inside session-run.worker.ts, which announces facts
 * in session vocabulary and must not learn who listens. No explicit
 * `concurrency` set, unlike the sweep above: closing one idea_run is a
 * handful of small, independent reads and a guarded UPDATE, nothing that
 * needs single-flight the way a whole-board scan does.
 */
export function startIdeaTurnEndedWorker() {
  const worker = new Worker<TurnEndedJob>(QUEUE_TURN_ENDED, (job) => handleTurnEnded(job.data), {
    connection: redisConnection(),
  })
  worker.on('failed', (job, error) => {
    logger.error(
      `Idea handoff: closing the run for turn-ended message ${job?.data.promptMessageId} failed: ${error.message}`,
    )
  })
  return worker
}
