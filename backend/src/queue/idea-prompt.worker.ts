// A one-shot Claude call per job, not a session turn — see
// features/ideas/prompt-service.ts for the call itself and queue/index.ts for
// why this gets its own queue. `concurrency` is `IDEA_PROMPT_CONCURRENCY`, its
// own env setting rather than the one that bounds parallel session turns:
// raising that setting for more parallel sessions must not silently throttle
// (or race ahead of) how many idea prompts may generate at once, since
// neither shares a resource with the other.

import { Worker } from 'bullmq'
import { env } from '@/env'
import { runIdeaPrompt } from '@/features/ideas/prompt-service'
import { logger } from '@/lib/logger'
import { type IdeaPromptJob, QUEUE_IDEA_PROMPT, redisConnection } from './index'

export function startIdeaPromptWorker() {
  const worker = new Worker<IdeaPromptJob>(
    QUEUE_IDEA_PROMPT,
    (job) => runIdeaPrompt(job.data.promptId),
    { connection: redisConnection(), concurrency: env.IDEA_PROMPT_CONCURRENCY },
  )
  worker.on('failed', (job, error) => {
    // Reached only by the backstop described on ideaPromptQueue's own
    // comment: runIdeaPrompt writes `status: 'failed'` itself for every
    // failure it can foresee, so a job actually landing here means something
    // this queue did not anticipate — worth a log line, not a silent retry
    // (there is none: attempts: 1).
    logger.error(`Idea prompt ${job?.data.promptId} failed: ${error.message}`)
  })
  return worker
}
