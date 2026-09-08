// Worker process. Owns anything that outlives an HTTP request: project setup,
// the session turns that run Claude, and the one-shot idea-to-prompt calls.

import { env } from '@/env'
import { sweepIdeaHandoffs } from '@/features/ideas/handoff'
import { logger } from '@/lib/logger'
import {
  ensureAttachmentsGcSchedule,
  ensureIdeaHandoffSweepSchedule,
  ensureTurnReconcileSchedule,
} from '@/queue'
import { startAttachmentsGcWorker } from '@/queue/attachments-gc.worker'
import { startIdeaHandoffSweepWorker, startIdeaTurnEndedWorker } from '@/queue/idea-handoff.worker'
import { startIdeaPromptWorker } from '@/queue/idea-prompt.worker'
import { startProjectSetupWorker } from '@/queue/project-setup.worker'
import { startSessionRunWorker } from '@/queue/session-run.worker'
import { reconcileTurns, startTurnReconcileWorker } from '@/queue/turn-reconcile.worker'

logger.info(`Worker starting (concurrency ${env.WORKER_CONCURRENCY})`)

const workers = [
  startProjectSetupWorker(),
  startSessionRunWorker(),
  startAttachmentsGcWorker(),
  startTurnReconcileWorker(),
  startIdeaPromptWorker(),
  startIdeaHandoffSweepWorker(),
  startIdeaTurnEndedWorker(),
]

// Idempotent — see ensureAttachmentsGcSchedule's own comment — so running it
// on every boot is correct and self-healing rather than a one-time migration
// step someone has to remember.
await ensureAttachmentsGcSchedule()
await ensureTurnReconcileSchedule()
await ensureIdeaHandoffSweepSchedule()

// The other reconciliation trigger, alongside the schedule above: run once
// right now, for whatever piled up while nothing was sweeping at all — most
// likely because this very restart is what orphaned it. Gated on a stale
// heartbeat inside reconcileTurns itself, never a blanket reset of every
// `running` session, so this stays correct even if a second worker process
// exists and genuinely still holds a turn this one knows nothing about.
await reconcileTurns()

// Same reasoning, for the idea-handoff sweep: a card whose enqueue never
// even reached this queue (the API process died before the schedule was
// registered, or Redis was briefly unreachable) sits invisible to BullMQ
// until this runs once for real, right at boot.
await sweepIdeaHandoffs().catch((error) => {
  logger.error(
    `Idea handoff sweep at boot failed: ${error instanceof Error ? error.message : String(error)}`,
  )
})

async function shutdown(signal: string) {
  logger.info(`${signal} received, draining workers`)
  await Promise.allSettled(workers.map((w) => w.close()))
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
