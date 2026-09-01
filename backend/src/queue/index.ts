import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/env'

export const QUEUE_PROJECT_SETUP = 'project-setup'

export interface ProjectSetupJob {
  projectId: string
  /** Set when adopting a directory that already exists on disk. */
  existingPath?: string
}

// BullMQ requires maxRetriesPerRequest: null on the connection it blocks on.
export const redisConnection = () =>
  new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })

export const projectSetupQueue = new Queue<ProjectSetupJob>(QUEUE_PROJECT_SETUP, {
  connection: redisConnection(),
  defaultJobOptions: {
    // A clone that fails on auth will fail again immediately; the user has to
    // intervene, so retrying is pointless noise.
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
})

export async function enqueueProjectSetup(job: ProjectSetupJob) {
  return projectSetupQueue.add('setup', job)
}
