// The daily Postgres backup and the worker's start-up catch-up — both are
// jobs on this one queue, and both end up in runDbBackup (features/backups/
// service.ts), which holds the advisory lock that actually keeps two dumps
// from overlapping. `concurrency: 1` here is only this process's share of
// that.

import { UnrecoverableError, Worker } from 'bullmq'
import { env } from '@/env'
import type { BackupErrorKind } from '@/features/backups/dump'
import { type DbBackupResult, runDbBackup } from '@/features/backups/service'
import { logger } from '@/lib/logger'
import { type DbBackupJob, QUEUE_DB_BACKUP, redisConnection } from './index'

/** Failures no retry 5 or 10 minutes later can fix: pg_dump missing or older
 * than the server needs a package installed, and a disk too full for a dump
 * needs an operator to free space. A retry would only log the same error
 * twice more. */
const UNRECOVERABLE: readonly (BackupErrorKind | 'other')[] = [
  'missing-binary',
  'version-mismatch',
  'insufficient-space',
]

/**
 * Runs one backup job. A failure is already logged in full by runDbBackup;
 * throwing here is what records it on the BullMQ job too, and lets the
 * queue's retries (queue/index.ts) take another go — except at a failure no
 * retry can fix (UNRECOVERABLE), which is thrown as UnrecoverableError so
 * BullMQ gives up at once.
 */
export async function processDbBackupJob(
  job: DbBackupJob,
  enabled: boolean = env.BACKUPS_ENABLED,
): Promise<DbBackupResult> {
  if (!enabled) {
    logger.warn(`Database backup (${job.reason}) skipped: BACKUPS_ENABLED is false`)
    return { status: 'skipped', reason: 'BACKUPS_ENABLED is false' }
  }
  const result = await runDbBackup({ reason: job.reason })
  if (result.status === 'failed') {
    if (UNRECOVERABLE.includes(result.kind)) throw new UnrecoverableError(result.error)
    throw new Error(result.error)
  }
  return result
}

export function startDbBackupWorker() {
  const worker = new Worker<DbBackupJob>(QUEUE_DB_BACKUP, (job) => processDbBackupJob(job.data), {
    connection: redisConnection(),
    concurrency: 1,
  })
  worker.on('failed', (job, error) => {
    const attempt = job ? ` (attempt ${job.attemptsMade} of ${job.opts.attempts ?? 1})` : ''
    logger.error(`Database backup job (${job?.data.reason})${attempt} failed: ${error.message}`)
  })
  return worker
}
