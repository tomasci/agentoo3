// Session learning against REAL BullMQ on a REAL redis-server and a real
// Postgres, with the real session-run worker — see
// learning-verify-queue-child.ts for the fixtures. Requirement 1 (the worker
// keeps BullMQ's job scheduler in sync), 2 (a late trigger still names its
// scheduled instant), 3 (a learning run waits behind a turn holding the
// global cap) and 8 (a queued run whose job is gone is failed).

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKEND, type ChildResult, factReader, runChild } from './learning-verify-harness'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'
import { type RedisServer, redisServerBin, startTempRedis } from './redis-server'

const available = Boolean(postgresBinDir()) && Boolean(redisServerBin())
let cluster: Cluster | undefined
let redis: RedisServer | undefined
let root = ''
let result: ChildResult = { facts: {}, error: 'not run' }

if (available) {
  try {
    root = await mkdtemp(join(tmpdir(), 'agentoo-learning-verify-queue-'))
    ;[cluster, redis] = await Promise.all([startTempCluster(join(BACKEND, 'src/db/migrations')), startTempRedis()])
    result = await runChild('learning-verify-queue-child.ts', {
      DATABASE_URL: cluster.connectionString,
      REDIS_URL: redis.url,
      LIBRARY_DIR: join(root, 'library'),
      PROJECTS_DIR: join(root, 'projects'),
      ATTACHMENTS_DIR: join(root, 'attachments'),
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      WORKER_CONCURRENCY: '2',
    })
  } catch (error) {
    result = { facts: {}, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
}

afterAll(async () => {
  await Promise.all([cluster?.stop(), redis?.stop()])
  if (root) await rm(root, { recursive: true, force: true })
})

const realTest = available ? test : test.skip
const fact = factReader(() => result)

realTest('the child ran every scenario without throwing', () => {
  expect(result.error).toBe('')
  expect(result.facts.stepErrors).toEqual({})
})

describe('req 1: the worker keeps the BullMQ job scheduler in sync with the setting', () => {
  type S = { pattern: string; tz: string; next: number } | null
  realTest('default: scheduler learning-daily with pattern "0 4 * * *", tz UTC, next = nextRunAt', () => {
    const f = fact('scheduler')
    const s1 = f.s1 as S
    expect(s1?.pattern).toBe('0 4 * * *')
    expect(s1?.tz).toBe('UTC')
    expect(s1?.next).toBe(f.expectedNext1 as number)
  })

  realTest('upserting does not fire an immediate run: one delayed trigger, nothing waiting', () => {
    const f = fact('scheduler')
    expect(f.delayed1).toBe(1)
    expect(f.waiting1).toBe(0)
  })

  realTest('a changed setting re-points the scheduler (pattern + tz + next), still exactly one delayed trigger', () => {
    const f = fact('scheduler')
    const s2 = f.s2 as S
    expect(s2?.pattern).toBe('30 5 * * *')
    expect(s2?.tz).toBe('Asia/Jerusalem')
    expect(s2?.next).toBe(f.expectedNext2 as number)
    expect(f.delayed2).toBe(1)
    expect(f.delayedJobNames2).toEqual(['trigger'])
  })

  realTest('disabling removes the scheduler and leaves no pending trigger behind', () => {
    const f = fact('scheduler')
    expect(f.s3).toBeNull()
    expect(f.delayed3).toBe(0)
    expect(f.waiting3).toBe(0)
  })

  realTest('reset to null brings back the default scheduler', () => {
    expect(fact('scheduler').s4).toEqual({ pattern: '0 4 * * *', tz: 'UTC' })
  })
})

describe('req 2: a late trigger still names its scheduled instant', () => {
  realTest('real BullMQ stamps prevMillis with the scheduled instant; the run row uses exactly that as windowEnd', () => {
    const f = fact('prevMillis')
    expect(f.seen as number).toBeGreaterThanOrEqual(1)
    expect(f.alignedTo2s).toBe(true)
    expect(f.lateByMs as number).toBeGreaterThan(500)
    expect(f.rowTrigger).toBe('scheduled')
    expect(f.rowWindowEndMs).toBe(f.prevMillis as number)
    expect((f.rowWindowEndMs as number) - (f.rowWindowStartMs as number)).toBe(86_400_000)
  })
})

describe('req 3: one queue, one cap', () => {
  realTest('the real worker consumes the session-run queue, and the learning job sits on it as "learning"', () => {
    expect(fact('worker').queueName).toBe('session-run')
    expect(fact('lostJob').jobName).toBe('learning')
  })

  realTest('cap 1, a turn holding the slot: the learning run stays queued (job waiting), no model call, never 2 active', () => {
    const f = fact('capOne')
    expect(f.applied).toBe(true)
    expect(f.turnActive).toBe(true)
    expect(f.turnStillActive).toBe(true)
    expect(f.statusWhileHeld).toBe('queued')
    expect(f.jobStateWhileHeld).toBe('waiting')
    expect(f.sdkCallsWhileHeld).toBe(0)
    expect(f.peakActive).toBe(1)
  })

  realTest('cap 1: once the turn ends, the learning run starts (after the release) and completes', () => {
    const f = fact('capOne')
    expect(f.done).toBe(true)
    expect(f.finalStatus).toBe('completed')
    expect(f.startedAfterRelease).toBe(true)
    expect(f.reviewSawWindowSession).toBe(true)
    expect(f.turnCompleted).toBe(true)
  })

  realTest('cap 2 (contrast): the learning run proceeds alongside the blocked turn, so the wait above was the cap', () => {
    const f = fact('capTwo')
    expect(f.applied).toBe(true)
    expect(f.turnStillActive).toBe(true)
    expect(f.sdkCallsWhileHeld as number).toBeGreaterThan(0)
    expect(f.statusWhileHeld).toBe('completed')
    expect(f.peakActive as number).toBeLessThanOrEqual(2)
  })

  realTest('enqueueing the same run twice yields one job', () => {
    expect(fact('duplicateEnqueue').added).toBe(1)
  })
})

describe('req 8: lost jobs, against the real queue', () => {
  realTest('a queued run whose job is waiting is left alone; once the job is removed it is marked failed', () => {
    const f = fact('lostJob')
    expect(f.stateBefore).toBe('waiting')
    expect(f.afterWaiting).toBe('queued')
    expect(f.afterRemoved).toBe('failed')
    expect(String(f.error)).toContain('no longer exists')
  })
})
