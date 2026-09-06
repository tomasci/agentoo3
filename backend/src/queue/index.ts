import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/env'

export const QUEUE_PROJECT_SETUP = 'project-setup'
export const QUEUE_SESSION_RUN = 'session-run'
export const QUEUE_ATTACHMENTS_GC = 'attachments-gc'

export interface ProjectSetupJob {
  projectId: string
}

export interface SessionRunJob {
  sessionId: string
}

export interface AttachmentsGcJob {
  // 'scheduled' is the hourly upsertJobScheduler tick; 'manual' is the UI's
  // "run check now"; 'cleanup' resolves what the last check found rather than
  // scanning again — see gc.ts for why those are two different passes.
  reason: 'scheduled' | 'manual' | 'cleanup'
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

// A third queue rather than a second job type on session-run: gc walks the
// whole storage tree, not one session, and concurrency: 1 below only makes
// sense scoped to its own queue — sharing session-run's queue would tie its
// concurrency to WORKER_CONCURRENCY, which this deliberately does not.
export const attachmentsGcQueue = new Queue<AttachmentsGcJob>(QUEUE_ATTACHMENTS_GC, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
})

export async function enqueueAttachmentsGc(job: AttachmentsGcJob) {
  return attachmentsGcQueue.add('gc', job)
}

/**
 * Register the hourly schedule. Idempotent by construction — BullMQ's
 * `upsertJobScheduler` replaces the existing schedule by this id rather than
 * adding a second one — so calling this on every worker boot is correct and
 * self-healing rather than something that needs its own "already scheduled"
 * check.
 */
export async function ensureAttachmentsGcSchedule() {
  await attachmentsGcQueue.upsertJobScheduler(
    'attachments-gc-hourly',
    { every: env.ATTACHMENTS_GC_INTERVAL_MS },
    { name: 'gc', data: { reason: 'scheduled' } },
  )
}
