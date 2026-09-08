import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@/env'

export const QUEUE_PROJECT_SETUP = 'project-setup'
export const QUEUE_SESSION_RUN = 'session-run'
export const QUEUE_ATTACHMENTS_GC = 'attachments-gc'
export const QUEUE_TURN_ENDED = 'turn-ended'
export const QUEUE_TURN_RECONCILE = 'turn-reconcile'
export const QUEUE_IDEA_PROMPT = 'idea-prompt'
export const QUEUE_IDEA_HANDOFF_SWEEP = 'idea-handoff-sweep'

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

/**
 * Pure session vocabulary, on purpose: this is the fact "prompt M's turn
 * stopped, and how", nothing about who cares. The one consumer today
 * (features/ideas/handoff.ts's `handleTurnEnded`, registered in
 * queue/idea-handoff.worker.ts) lives entirely outside session-run.worker.ts
 * and reads only this payload — this file must never grow a second, idea-
 * shaped field just because that consumer exists. Even with a consumer
 * registered, the durable fact still lives in `messages.turn_outcome`, which
 * is what the reconciler and every other reader answer from; this queue is
 * only ever a nudge for something that wants to react the moment a turn ends
 * instead of polling for it.
 */
export interface TurnEndedJob {
  sessionId: string
  promptMessageId: string
  outcome: string
}

export interface TurnReconcileJob {
  reason: 'scheduled'
}

/**
 * The worker never reads anything about the canvas itself — see the header
 * comment on features/ideas/prompt-service.ts for why `promptId` is the only
 * thing this job carries, and why that is load-bearing rather than incidental.
 */
export interface IdeaPromptJob {
  promptId: string
}

export interface IdeaHandoffSweepJob {
  reason: 'scheduled'
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

export async function enqueueSessionRun(job: SessionRunJob, opts?: { delayMs?: number }) {
  // One BullMQ group per session would be neater, but that is a Pro feature.
  // Ordering is enforced instead by the session's own status: a turn is only
  // claimed out of 'queued', and the claim is a conditional UPDATE. `delayMs`
  // exists for the one case that claim cannot resolve by itself: a
  // non-isolated session blocked behind a same-project sibling that already
  // holds the shared working tree (see the claim in session-run.worker.ts) has
  // nothing that wakes it when that sibling finishes, so it re-enqueues itself
  // after a short delay instead of spinning immediately.
  return sessionRunQueue.add(
    'turn',
    job,
    opts?.delayMs !== undefined ? { delay: opts.delayMs } : undefined,
  )
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

// Announcing a turn ended is a pure notification over data already durably
// written to `messages` by the time it fires (see endTurn in
// session-run.worker.ts, which enqueues this strictly after its own row
// commits) — replaying a dropped delivery costs nothing beyond a redundant
// read of a row that is already correct. That is what earns this
// `attempts: 3`, unlike session-run's deliberate `attempts: 1`: a turn itself
// cannot be safely retried because it has already spent tokens and edited
// files by the time it can fail, but this is bookkeeping over a fact that is
// already true on disk.
export const turnEndedQueue = new Queue<TurnEndedJob>(QUEUE_TURN_ENDED, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
})

export async function enqueueTurnEnded(job: TurnEndedJob) {
  return turnEndedQueue.add('turn-ended', job)
}

/**
 * How often the scheduled sweep below runs. A file-local constant, not
 * `env.ts` — a parallel track owns that file right now — and deliberately its
 * own queue rather than a ride on `attachments-gc`'s hourly one: that cadence
 * is three orders of magnitude too coarse for a stranded turn (whose entire
 * value is being caught within a couple of missed heartbeats, not within the
 * hour), and reusing it would couple a session-liveness sweep to an unrelated
 * filesystem scan for no reason beyond "a schedule already existed".
 * `concurrency: 1` on the worker that consumes this queue is for the same
 * reason `attachments-gc`'s is: the sweep below scans across every session,
 * not one, so its concurrency has nothing to do with `WORKER_CONCURRENCY`.
 */
const TURN_RECONCILE_INTERVAL_MS = 45_000

export const turnReconcileQueue = new Queue<TurnReconcileJob>(QUEUE_TURN_RECONCILE, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
})

export async function enqueueTurnReconcile(job: TurnReconcileJob) {
  return turnReconcileQueue.add('reconcile', job)
}

/**
 * Register the sweep's own schedule. Idempotent by construction, exactly like
 * `ensureAttachmentsGcSchedule` above — safe, and correct, to call on every
 * worker boot.
 */
export async function ensureTurnReconcileSchedule() {
  await turnReconcileQueue.upsertJobScheduler(
    'turn-reconcile-sweep',
    { every: TURN_RECONCILE_INTERVAL_MS },
    { name: 'reconcile', data: { reason: 'scheduled' } },
  )
}

/**
 * A fourth queue rather than a job type shared with anything else, for the
 * same two reasons `attachmentsGcQueue` gets its own above. First,
 * `idea-prompt.worker.ts`'s own `concurrency` is `IDEA_PROMPT_CONCURRENCY`,
 * deliberately not `WORKER_CONCURRENCY` — a one-shot, tool-less
 * structured-output call over a few paragraphs of canvas text takes seconds,
 * nothing like a session turn's minutes of tool use, so tying its concurrency
 * to the session knob would either starve it behind long-running turns or let
 * a burst of idea prompts crowd sessions out. Second, it is a different kind
 * of work entirely: no git worktree, no tools, no plugin directory — see
 * features/ideas/prompt-service.ts for the call itself.
 *
 * `attempts: 1`, for the same reason `sessionRunQueue` states for its own: a
 * generation that failed halfway has already spent whatever the model call
 * cost by the time anything can fail, and BullMQ retrying the job would spend
 * it again. `runIdeaPrompt` itself never throws on an ordinary failure — it
 * writes `status: 'failed'` and returns — so this `attempts: 1` is a backstop
 * for the failure modes that function cannot catch (the process dying, the
 * database going away mid-write), not the expected path.
 */
export const ideaPromptQueue = new Queue<IdeaPromptJob>(QUEUE_IDEA_PROMPT, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
})

export async function enqueueIdeaPrompt(job: IdeaPromptJob) {
  return ideaPromptQueue.add('generate', job)
}

/**
 * How often the idea-handoff sweep (features/ideas/handoff.ts's
 * `sweepIdeaHandoffs`) runs — short on purpose, unlike `attachments-gc`'s
 * hourly cadence: the whole point of a claim-based sweep instead of a hook on
 * `POST /ideas/{id}/move` is that a card dropped into "selected for
 * development" gets picked up within one tick of that move, not within the
 * hour. A fifth queue rather than a ride on `turn-reconcile`'s existing
 * schedule, for the same reason every other queue here gets its own: this
 * scans the ideas board, not sessions, and ties its own cadence to nothing
 * else. `concurrency: 1` on the worker that consumes this (see
 * queue/idea-handoff.worker.ts) is for the same reason `turn-reconcile`'s is
 * — the sweep scans across every project's board, not one card, so its
 * concurrency has nothing to do with `WORKER_CONCURRENCY`.
 */
const IDEA_HANDOFF_SWEEP_INTERVAL_MS = 10_000

export const ideaHandoffSweepQueue = new Queue<IdeaHandoffSweepJob>(QUEUE_IDEA_HANDOFF_SWEEP, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
})

export async function enqueueIdeaHandoffSweep(job: IdeaHandoffSweepJob) {
  return ideaHandoffSweepQueue.add('sweep', job)
}

/**
 * Register the sweep's own schedule. Idempotent by construction, exactly like
 * `ensureAttachmentsGcSchedule` and `ensureTurnReconcileSchedule` above — safe,
 * and correct, to call on every worker boot.
 */
export async function ensureIdeaHandoffSweepSchedule() {
  await ideaHandoffSweepQueue.upsertJobScheduler(
    'idea-handoff-sweep',
    { every: IDEA_HANDOFF_SWEEP_INTERVAL_MS },
    { name: 'sweep', data: { reason: 'scheduled' } },
  )
}
