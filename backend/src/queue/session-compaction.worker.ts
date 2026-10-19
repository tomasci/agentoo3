// One session compaction per job — a long model call over a whole conversation,
// not a session turn; see features/sessions/compaction.ts for the work and
// queue/index.ts for why it gets its own queue. `concurrency` is
// `SESSION_COMPACTION_CONCURRENCY`, not the knob that bounds parallel session
// turns: each compaction is a Claude Code subprocess reading an entire
// conversation, and raising the session limit must not also multiply those.

import { Worker } from 'bullmq'
import { env } from '@/env'
import { runSessionCompaction } from '@/features/sessions/compaction'
import { logger } from '@/lib/logger'
import { QUEUE_SESSION_COMPACTION, redisConnection, type SessionCompactionJob } from './index'

export function startSessionCompactionWorker() {
  const worker = new Worker<SessionCompactionJob>(
    QUEUE_SESSION_COMPACTION,
    (job) => runSessionCompaction(job.data.compactionId),
    { connection: redisConnection(), concurrency: env.SESSION_COMPACTION_CONCURRENCY },
  )
  worker.on('failed', (job, error) => {
    // Reached only by the backstop described on sessionCompactionQueue:
    // runSessionCompaction writes `status: 'failed'` itself for every failure
    // it can foresee, so a job landing here means something it did not
    // anticipate. Logged, not retried (attempts: 1) — a retry would spend the
    // model call again.
    logger.error(`Session compaction ${job?.data.compactionId} failed: ${error.message}`)
  })
  return worker
}
