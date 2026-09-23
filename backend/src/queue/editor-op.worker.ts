// Thin dispatcher for the editor-op queue's two job kinds — the actual work
// lives in features/editor/{lifecycle,reaper}.ts. Concurrency: 1, unlike
// docker-op.worker.ts's 2: this queue's whole reason for existing (per the
// design doc) is that a start and a reap sweep must never run against the
// same container at once, and a lock per session (operations.ts) only
// protects two *starts* from racing each other, not a start against a reap.

import { Worker } from 'bullmq'
import { runEditorStart } from '@/features/editor/lifecycle'
import { runEditorReap } from '@/features/editor/reaper'
import { logger } from '@/lib/logger'
import { type EditorOpJob, QUEUE_EDITOR_OP, redisConnection } from './index'

async function runEditorOp(job: EditorOpJob): Promise<void> {
  if (job.kind === 'start') return runEditorStart(job)
  return runEditorReap(job.reason)
}

export function startEditorOpWorker() {
  const worker = new Worker<EditorOpJob>(QUEUE_EDITOR_OP, (job) => runEditorOp(job.data), {
    connection: redisConnection(),
    concurrency: 1,
  })
  worker.on('failed', (job, error) => {
    // Reached only if runEditorOp itself threw past its own try/catch — every
    // foreseeable 'start' failure already lands on the operation record
    // instead, and runEditorReap logs its own skips rather than throwing.
    logger.error(`Editor op job (${job?.data.kind}) failed: ${error.message}`)
  })
  return worker
}
