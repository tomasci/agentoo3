// Worker process. Owns anything that outlives an HTTP request: project setup
// and the session turns that run Claude.

import { env } from '@/env'
import { logger } from '@/lib/logger'
import { ensureAttachmentsGcSchedule } from '@/queue'
import { startAttachmentsGcWorker } from '@/queue/attachments-gc.worker'
import { startProjectSetupWorker } from '@/queue/project-setup.worker'
import { startSessionRunWorker } from '@/queue/session-run.worker'

logger.info(`Worker starting (concurrency ${env.WORKER_CONCURRENCY})`)

const workers = [startProjectSetupWorker(), startSessionRunWorker(), startAttachmentsGcWorker()]

// Idempotent — see ensureAttachmentsGcSchedule's own comment — so running it
// on every boot is correct and self-healing rather than a one-time migration
// step someone has to remember.
await ensureAttachmentsGcSchedule()

async function shutdown(signal: string) {
  logger.info(`${signal} received, draining workers`)
  await Promise.allSettled(workers.map((w) => w.close()))
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
