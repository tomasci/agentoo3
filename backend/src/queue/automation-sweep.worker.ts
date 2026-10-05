// The project-automations sweep's own Worker — see
// features/automations/scheduler.ts for the actual business logic
// (`sweepAutomations`) this just dispatches to on every tick. Mirrors
// queue/idea-handoff.worker.ts's identical `startIdeaHandoffSweepWorker`.

import { Worker } from 'bullmq'
import { sweepAutomations } from '@/features/automations/scheduler'
import { logger } from '@/lib/logger'
import { type AutomationSweepJob, QUEUE_AUTOMATION_SWEEP, redisConnection } from './index'

/**
 * The sweep scans across every project's automations, not one row — same
 * reason `turn-reconcile.worker.ts`'s and `idea-handoff.worker.ts`'s own
 * identical `concurrency: 1` give: this has nothing to do with
 * `WORKER_CONCURRENCY`, which bounds parallel session turns.
 */
export function startAutomationSweepWorker() {
  const worker = new Worker<AutomationSweepJob>(QUEUE_AUTOMATION_SWEEP, () => sweepAutomations(), {
    connection: redisConnection(),
    concurrency: 1,
  })
  worker.on('failed', (job, error) => {
    logger.error(`Automation sweep (${job?.data.reason}) failed: ${error.message}`)
  })
  return worker
}
