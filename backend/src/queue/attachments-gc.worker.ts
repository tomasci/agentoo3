// Reconciliation over one filesystem tree, so `concurrency: 1` is explicit
// here rather than `env.WORKER_CONCURRENCY` — inheriting the session
// concurrency would silently break single-flight over the storage root the
// moment someone raises that setting for more parallel sessions, which has
// nothing to do with how many GC passes may run at once (at most one, ever).

import { Worker } from 'bullmq'
import { runAttachmentsGc } from '@/features/attachments/gc'
import { logger } from '@/lib/logger'
import { type AttachmentsGcJob, QUEUE_ATTACHMENTS_GC, redisConnection } from './index'

export function startAttachmentsGcWorker() {
  const worker = new Worker<AttachmentsGcJob>(
    QUEUE_ATTACHMENTS_GC,
    (job) => runAttachmentsGc(job.data),
    { connection: redisConnection(), concurrency: 1 },
  )
  worker.on('failed', (job, error) => {
    logger.error(`Attachments GC (${job?.data.reason}) failed: ${error.message}`)
  })
  return worker
}
