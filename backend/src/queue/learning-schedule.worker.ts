// The daily session-learning schedule: a worker-side reconcile loop that
// keeps BullMQ's own job scheduler in sync with the admin-configurable
// setting (features/learning/schedule.ts), and the Worker that processes the
// one job that scheduler produces. Mirrors the API-writes-DB /
// worker-applies-to-Redis split queue/session-concurrency.ts's own header
// documents for max_concurrent_sessions — the API (features/learning/
// schedule.ts's setLearningSchedule) only ever writes system_settings; this
// file, on the worker, is the only thing that ever touches Redis for it.
//
// Two independent jobs for two independent concerns, both registered by
// src/worker.ts: `startLearningScheduleWorker` processes a `'trigger'` job by
// starting a run, and its own reconcile loop (also started here) keeps the
// BullMQ job scheduler itself matching the saved setting — the identical
// "poll and apply, tick now then every N ms" shape
// queue/session-concurrency.ts's own `pollSessionConcurrency` already uses,
// simplified here since nothing about this reconcile needs that module's
// "wait for the first successful apply before starting anything" ordering.

import { Worker } from 'bullmq'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { learningRuns } from '@/db/schema'
import { createLearningRun } from '@/features/learning/runs'
import {
  cronPatternFor,
  getLearningSchedule,
  latestOccurrenceAtOrBefore,
} from '@/features/learning/schedule'
import { logger } from '@/lib/logger'
import {
  LEARNING_DAILY_SCHEDULER_ID,
  type LearningScheduleTriggerJob,
  learningScheduleQueue,
  QUEUE_LEARNING_SCHEDULE,
  redisConnection,
} from './index'

/** How often the reconcile loop re-reads the saved schedule and re-applies it
 * if it changed — short enough that an admin's save on the Library UI is felt
 * in seconds, long enough that this is a background poll, not a hot loop. The
 * identical cadence queue/session-concurrency.ts's own
 * SESSION_CONCURRENCY_REFRESH_MS uses, for the identical reason. */
export const LEARNING_SCHEDULE_REFRESH_MS = 30_000

/** What was last successfully applied to the job scheduler — compared
 * against on every tick so an unchanged schedule never re-upserts (BullMQ's
 * own `upsertJobScheduler` is idempotent regardless, but doing it every 30s
 * forever for a setting nobody touched is needless Redis traffic and log
 * noise). `undefined` means "nothing applied yet", which is also what makes
 * the very first tick after boot always apply once, regardless of whether
 * that first value happens to equal the built-in default. */
interface AppliedSchedule {
  enabled: boolean
  pattern: string
  timezone: string
}

type SchedulerQueue = Pick<
  typeof learningScheduleQueue,
  'upsertJobScheduler' | 'removeJobScheduler'
>

function sameSchedule(a: AppliedSchedule | undefined, b: AppliedSchedule): boolean {
  return (
    a !== undefined &&
    a.enabled === b.enabled &&
    a.pattern === b.pattern &&
    a.timezone === b.timezone
  )
}

/**
 * One reconcile pass: read the effective schedule and, only if it differs
 * from what this process last applied, upsert or remove the job scheduler.
 *
 * Upserting never fires an immediate run: BullMQ's own `upsertJobScheduler`
 * only computes an immediate `nextMillis` when the caller passes
 * `repeatOpts.immediately: true` (verified directly against the installed
 * version's source, `node_modules/bullmq/dist/cjs/classes/job-scheduler.js` —
 * its default repeat strategy calls `interval.next()`, never `Date.now()`,
 * whenever `immediately` is left unset), which this call never does.
 *
 * Returns the schedule it applied (or left applied, if nothing changed) —
 * `startLearningScheduleWorker`'s own loop feeds this back in as `last` on
 * the next tick.
 */
export async function reconcileLearningSchedule(
  queue: SchedulerQueue,
  last: AppliedSchedule | undefined,
): Promise<AppliedSchedule> {
  const { value } = await getLearningSchedule()
  const next: AppliedSchedule = {
    enabled: value.enabled,
    pattern: cronPatternFor(value),
    timezone: value.timezone,
  }
  if (sameSchedule(last, next)) return last as AppliedSchedule

  if (next.enabled) {
    await queue.upsertJobScheduler(
      LEARNING_DAILY_SCHEDULER_ID,
      { pattern: next.pattern, tz: next.timezone },
      { name: 'trigger', data: { reason: 'scheduled' } },
    )
    logger.info(
      `Learning schedule: upserted the daily job scheduler (${next.pattern}, ${next.timezone})`,
    )
  } else {
    await queue.removeJobScheduler(LEARNING_DAILY_SCHEDULER_ID)
    logger.info('Learning schedule: disabled — removed the daily job scheduler')
  }
  return next
}

/**
 * Starts the reconcile loop: applies once immediately, then every
 * LEARNING_SCHEDULE_REFRESH_MS. Returns a function that stops it. `.unref()`'d
 * so this timer alone never keeps the process alive — identical to every
 * other background poll in this codebase.
 *
 * Guarded so at most one tick is ever in flight, and a failed tick is logged
 * rather than thrown — a transient database or Redis hiccup must not crash
 * the worker process, and the next tick tries again.
 */
export function watchLearningSchedule(queue: SchedulerQueue): () => void {
  let last: AppliedSchedule | undefined
  let inFlight = false

  const tick = () => {
    if (inFlight) return
    inFlight = true
    reconcileLearningSchedule(queue, last)
      .then((applied) => {
        last = applied
      })
      .catch((error) => {
        logger.warn(`Learning schedule reconcile tick failed: ${String(error)}`)
      })
      .finally(() => {
        inFlight = false
      })
  }

  tick()
  const interval = setInterval(tick, LEARNING_SCHEDULE_REFRESH_MS)
  interval.unref()
  return () => clearInterval(interval)
}

/**
 * The scheduled occurrence this trigger fired for, so a run's `windowEnd`
 * reflects the tick that was actually due — e.g. exactly 04:00:00 UTC+3 —
 * rather than whenever the worker happened to get around to processing the
 * job (which can be much later: this job rides no special priority, and a
 * busy worker may not reach it for a while).
 *
 * `job.opts.prevMillis` is the primary source: BullMQ's own JobScheduler
 * stamps every job it produces with `prevMillis` set to that job's own
 * intended fire time, in epoch ms (verified directly against the installed
 * version's source — `getNextJobOpts` in job-scheduler.js sets
 * `prevMillis: nextMillis` on the options object that becomes the job's own
 * `opts`). `timestamp + delay` is the fallback for a job that somehow lacks
 * that field (hand-added in a test, or a future BullMQ that stops stamping
 * it): `timestamp` is when the job was created and `delay` is how long after
 * that it was scheduled to fire, so their sum is the same intended instant.
 * Only if neither is usable does this fall back to asking the *current*
 * schedule what its most recent occurrence at-or-before now was
 * (`latestOccurrenceAtOrBefore`) — a weaker answer, since the schedule may
 * have changed since this job was created, but still better than refusing to
 * run at all.
 */
export function scheduledWindowEnd(
  opts: { prevMillis?: number; timestamp?: number; delay?: number },
  now: Date,
): Date {
  if (
    typeof opts.prevMillis === 'number' &&
    Number.isFinite(opts.prevMillis) &&
    opts.prevMillis > 0
  ) {
    return new Date(opts.prevMillis)
  }
  if (
    typeof opts.timestamp === 'number' &&
    Number.isFinite(opts.timestamp) &&
    typeof opts.delay === 'number' &&
    Number.isFinite(opts.delay)
  ) {
    return new Date(opts.timestamp + opts.delay)
  }
  return now
}

/**
 * Processes one `'trigger'` job: resolves its windowEnd, skips (logging) a
 * duplicate for the same scheduled occurrence, then starts a run exactly as
 * the manual "run now" button does (createLearningRun) — the trigger's whole
 * job is creating the row and enqueueing it; the actual analysis runs on the
 * session-run queue, behind whatever sessions are already running.
 */
export async function handleLearningScheduleTrigger(opts: {
  prevMillis?: number
  timestamp?: number
  delay?: number
}): Promise<void> {
  const now = new Date()
  let windowEnd = scheduledWindowEnd(opts, now)
  if (windowEnd.getTime() === now.getTime()) {
    // Neither opts field was usable — fall back to what the schedule itself
    // says was last due, per this function's own doc above.
    const { value } = await getLearningSchedule()
    windowEnd = latestOccurrenceAtOrBefore(value, now) ?? now
  }

  const [existing] = await db
    .select({ id: learningRuns.id })
    .from(learningRuns)
    .where(and(eq(learningRuns.trigger, 'scheduled'), eq(learningRuns.windowEnd, windowEnd)))
    .limit(1)
  if (existing) {
    logger.info(
      `Learning schedule: a scheduled run for ${windowEnd.toISOString()} already exists (${existing.id}); skipping`,
    )
    return
  }

  const result = await createLearningRun({ trigger: 'scheduled', windowEnd })
  if ('conflict' in result) {
    logger.info(
      `Learning schedule: skipped the ${windowEnd.toISOString()} run — a run is already ${result.conflict.status} (${result.conflict.id})`,
    )
    return
  }
  logger.info(`Learning schedule: started the ${windowEnd.toISOString()} run (${result.run.id})`)
}

export function startLearningScheduleWorker() {
  const worker = new Worker<LearningScheduleTriggerJob>(
    QUEUE_LEARNING_SCHEDULE,
    (job) =>
      handleLearningScheduleTrigger(
        job.opts as { prevMillis?: number; timestamp?: number; delay?: number },
      ),
    { connection: redisConnection(), concurrency: 1 },
  )
  worker.on('failed', (job, error) => {
    logger.error(`Learning schedule trigger (${job?.id}) failed: ${error.message}`)
  })
  const stop = watchLearningSchedule(learningScheduleQueue)
  worker.on('closing', stop)
  return worker
}
