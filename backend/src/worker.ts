// Worker process. Owns anything that outlives an HTTP request: project setup,
// the session turns that run Claude, the one-shot idea-to-prompt calls, and
// session compactions.

import { env } from '@/env'
import { sweepAutomations } from '@/features/automations/scheduler'
import { sweepIdeaHandoffs } from '@/features/ideas/handoff'
import { logger } from '@/lib/logger'
import {
  enqueueDbBackup,
  enqueueEditorReap,
  ensureAttachmentsGcSchedule,
  ensureAutomationSweepSchedule,
  ensureDbBackupSchedule,
  ensureEditorReapSchedule,
  ensureIdeaHandoffSweepSchedule,
  ensureTurnReconcileSchedule,
} from '@/queue'
import { startAttachmentsGcWorker } from '@/queue/attachments-gc.worker'
import { startAutomationSweepWorker } from '@/queue/automation-sweep.worker'
import { startDbBackupWorker } from '@/queue/db-backup.worker'
import { startDockerOpWorker } from '@/queue/docker-op.worker'
import { startEditorOpWorker } from '@/queue/editor-op.worker'
import { startIdeaHandoffSweepWorker, startIdeaTurnEndedWorker } from '@/queue/idea-handoff.worker'
import { startIdeaPromptWorker } from '@/queue/idea-prompt.worker'
import { startLearningScheduleWorker } from '@/queue/learning-schedule.worker'
import { startProjectSetupWorker } from '@/queue/project-setup.worker'
import { startSessionCompactionWorker } from '@/queue/session-compaction.worker'
import { startSessionRunWorker } from '@/queue/session-run.worker'
import { reconcileTurns, startTurnReconcileWorker } from '@/queue/turn-reconcile.worker'

// What max_concurrent_sessions falls back to absent a saved override;
// startUnderSessionConcurrency (started inside startSessionRunWorker) logs the
// effective value — that override, if one exists — right after this.
logger.info(`Worker starting (default concurrency ${env.WORKER_CONCURRENCY})`)

const workers = [
  startProjectSetupWorker(),
  startSessionRunWorker(),
  startAttachmentsGcWorker(),
  startTurnReconcileWorker(),
  startIdeaPromptWorker(),
  startSessionCompactionWorker(),
  startIdeaHandoffSweepWorker(),
  startIdeaTurnEndedWorker(),
  startDockerOpWorker(),
  startEditorOpWorker(),
  // Processes the daily learning-schedule trigger job, and runs the
  // reconcile loop that keeps BullMQ's job scheduler matching the saved
  // setting — see queue/learning-schedule.worker.ts's own header.
  startLearningScheduleWorker(),
  startAutomationSweepWorker(),
  // Scheduled Postgres backups — see features/backups/service.ts.
  startDbBackupWorker(),
]

// Idempotent — see ensureAttachmentsGcSchedule's own comment — so running it
// on every boot is correct and self-healing rather than a one-time migration
// step someone has to remember.
await ensureAttachmentsGcSchedule()
await ensureTurnReconcileSchedule()
await ensureIdeaHandoffSweepSchedule()
await ensureEditorReapSchedule()
await ensureAutomationSweepSchedule()
// Upserts the daily backup, or removes it when BACKUPS_ENABLED is off.
await ensureDbBackupSchedule()

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

// Same reasoning, for the automation sweep: an automation whose enqueue
// never even reached this queue (the worker process died before the
// schedule was registered, or Redis was briefly unreachable) sits invisible
// to BullMQ until this runs once for real, right at boot.
await sweepAutomations().catch((error) => {
  logger.error(
    `Automation sweep at boot failed: ${error instanceof Error ? error.message : String(error)}`,
  )
})

// Same reasoning as the idea-handoff sweep above: an editor container
// orphaned by a worker that died mid-start (or a project deleted outright,
// which skips deleteSession's own inline removal entirely) sits unreaped
// until this runs once for real, right at boot — not just on the 5-minute
// schedule.
await enqueueEditorReap({ kind: 'reap', reason: 'boot' }).catch((error) => {
  logger.error(
    `Editor reap at boot failed to enqueue: ${error instanceof Error ? error.message : String(error)}`,
  )
})

// The backup catch-up: a box that was down when the daily backup was due, or
// was only just installed, gets one now rather than up to a day later. Always
// enqueued; the job itself skips when the newest backup is under 24h old,
// checked under the backup lock so two workers booting at once write one
// dump between them (see SKIP_IF_NEWER_THAN_MS in features/backups/service.ts).
if (env.BACKUPS_ENABLED) {
  await enqueueDbBackup({ reason: 'boot' }).catch((error) => {
    logger.error(
      `Database backup at boot failed to enqueue: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
} else {
  logger.warn(
    'Database backups are disabled (BACKUPS_ENABLED=false): nothing is backing up the database',
  )
}

async function shutdown(signal: string) {
  logger.info(`${signal} received, draining workers`)
  await Promise.allSettled(workers.map((w) => w.close()))
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
