import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/env'

export const QUEUE_PROJECT_SETUP = 'project-setup'
export const QUEUE_SESSION_RUN = 'session-run'

export interface ProjectSetupJob {
  projectId: string
}

export interface SessionRunJob {
  sessionId: string
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

export const sessionRunQueue = new Queue<SessionRunJob>(QUEUE_SESSION_RUN, {
  connection: redisConnection(),
  defaultJobOptions: {
    // A turn is not idempotent: it has already written files and spent tokens
    // by the time anything can fail. Re-running it would double both.
    attempts: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
})

export async function enqueueSessionRun(job: SessionRunJob) {
  // One BullMQ group per session would be neater, but that is a Pro feature.
  // Ordering is enforced instead by the session's own status: a turn is only
  // claimed out of 'queued', and the claim is a conditional UPDATE.
  return sessionRunQueue.add('turn', job)
}
