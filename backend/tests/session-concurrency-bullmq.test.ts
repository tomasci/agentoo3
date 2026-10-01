// The operator's acceptance criterion for max_concurrent_sessions: with the
// setting at N, at most N session turns run at once — and a change to it is
// felt by a worker that is already running, in both directions.
//
// Against a real redis-server (redis-server.ts) and a real Postgres
// (pg-cluster.ts), with real BullMQ, because the cap is enforced in Lua inside
// Redis and nothing short of that can say whether it holds. The scenarios run
// in session-concurrency-bullmq-child.ts, which drives the worker only through
// the setting (updateSystemSettings) and session-concurrency.ts
// (syncSessionConcurrency / watchSessionConcurrency /
// startUnderSessionConcurrency). The child gathers facts; every assertion
// lives here.
//
// Skipped, loudly, when either server binary is missing from the box.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'
import { type RedisServer, redisServerBin, startTempRedis } from './redis-server'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let redis: RedisServer | undefined
let facts: Facts = {}
let setupError = ''
let childStderr = ''

const hasPostgres = Boolean(postgresBinDir())
const hasRedis = Boolean(redisServerBin())
const canRun = hasPostgres && hasRedis

if (canRun) {
  try {
    ;[cluster, redis] = await Promise.all([
      startTempCluster(join(BACKEND, 'src/db/migrations')),
      startTempRedis(),
    ])
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      REDIS_URL: redis.url,
      PROJECTS_DIR: `/tmp/agentoo-conc-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-conc-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }
    // Removed, not overridden: "limit 2" below is the built-in default, and a
    // box that runs agentoo has WORKER_CONCURRENCY in its own environment.
    delete childEnv.WORKER_CONCURRENCY

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/session-concurrency-bullmq-child.ts')], {
      cwd: BACKEND,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Bounded: a wedged child must not hang the suite.
    const killer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(killer)
    childStderr = stderr
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await Promise.all([cluster?.stop(), redis?.stop()])
})

const realTest = canRun ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!canRun) {
    console.warn(
      `Real-BullMQ concurrency scenarios did not run: ${[
        !hasPostgres && 'no Postgres server binaries',
        !hasRedis && 'no redis-server on PATH',
      ]
        .filter(Boolean)
        .join(', ')}.`,
    )
    return
  }
  expect(setupError).toBe('')
  expect(fact('env').workerConcurrency).toBe(2)
  expect(childStderr).not.toContain('Unhandled')
})

// --- the cap holds --------------------------------------------------------------

realTest('limit 1: global 1 in Redis, 2 local slots', () => {
  const f = fact('limitOne')
  expect(f.applied).toBe(1)
  expect(f.globalInRedis).toBe(1)
  expect(f.local).toBe(2)
})

realTest('limit 1: with 3 jobs queued, exactly one runs at a time, and all three finish', () => {
  const f = fact('limitOne')
  expect(f.firstIn).toBe(true)
  expect(f.insideWhileFirstRuns).toBe(1)
  expect((f.enteredWhileFirstRuns as number[]).length).toBe(1)
  expect(f.insideAfterEach).toEqual([1, 1])
  expect(f.peak).toBe(1)
  expect(f.exited).toBe(3)
  const states = f.states as Record<string, { state: string; returnvalue: unknown }>
  expect(Object.values(states).map((s) => s.state)).toEqual(['completed', 'completed', 'completed'])
  expect(f.failed).toEqual([])
})

realTest(
  'limit 3: three run at once — the third would have been blocked at 2 — and a fourth waits',
  () => {
    const f = fact('limitThree')
    expect(f.applied).toBe(3)
    expect(f.globalInRedis).toBe(3)
    expect(f.local).toBe(4)
    expect(f.threeIn).toBe(true)
    expect(f.insideAfterSettle).toBe(3)
    expect(f.enteredAfterSettle).toBe(3)
    expect(f.fourthIn).toBe(true)
    expect(f.peak).toBe(3)
    expect(f.exited).toBe(4)
    expect(f.failed).toEqual([])
  },
)

realTest('limit 2 (no row, the default): exactly two run at once and a third waits', () => {
  const f = fact('limitDefault')
  expect(f.applied).toBe(2)
  expect(f.globalInRedis).toBe(2)
  expect(f.local).toBe(3)
  expect(f.twoIn).toBe(true)
  expect(f.insideAfterSettle).toBe(2)
  expect(f.enteredAfterSettle).toBe(2)
  expect(f.thirdIn).toBe(true)
  expect(f.peak).toBe(2)
  expect(f.exited).toBe(3)
})

// --- changes reach a running worker ----------------------------------------------

realTest('raise 1 -> 3 while saturated: three are inside within 8s, and never a fourth', () => {
  const f = fact('raise')
  expect(f.insideBefore).toBe(1)
  expect(f.applied).toBe(3)
  expect(f.globalInRedis).toBe(3)
  expect(f.local).toBe(4)
  expect({ threeIn: f.threeIn, insideAtDeadline: f.insideAtDeadline }).toEqual({
    threeIn: true,
    insideAtDeadline: 3,
  })
  expect(f.elapsedMs as number).toBeLessThan(8000)
  expect(f.insideAfterSettle).toBe(3)
  expect(f.peak).toBe(3)
  expect(f.failed).toEqual([])
})

realTest('control: the same raise with no spare local slot does NOT take effect within 8s', () => {
  // Pins why the spare slot exists: without it, BullMQ's main loop never
  // re-fetches while saturated. If this ever starts passing at 3, BullMQ has
  // changed and the +1 in session-concurrency.ts is no longer load-bearing.
  const f = fact('raiseWithoutSpareSlot')
  expect(f.threeIn).toBe(false)
  expect(f.insideAtDeadline).toBe(1)
})

realTest('lower 3 -> 1 while 3 run: none of the three is interrupted, and no fourth starts', () => {
  const f = fact('lower')
  expect(f.threeIn).toBe(true)
  expect(f.applied).toBe(1)
  expect(f.globalInRedis).toBe(1)
  expect(f.local).toBe(2)
  expect(f.insideAfterLower).toBe(3)
  expect(f.enteredAfterLower).toBe(3)
  expect(f.exitedAfterLower).toBe(0)
  // Draining 3 -> 2 -> 1 -> 0 running: nothing new until all three are out.
  expect((f.enteredAfterEachDrain as number[]).slice(0, 2)).toEqual([3, 3])
  expect(f.failed).toEqual([])
  expect(f.stalled).toEqual([])
})

realTest('lower 3 -> 1: once the three drain, new jobs run strictly one at a time', () => {
  const f = fact('lower')
  expect(f.insideWithFourth).toBe(1)
  expect(f.insideWithFifth).toBe(1)
  expect(f.peakAfterDrain).toBe(1)
  expect(f.exited).toBe(5)
  const states = f.states as Record<string, { state: string; returnvalue: unknown }>
  for (const [n, s] of Object.entries(states)) {
    expect(s).toEqual({ state: 'completed', returnvalue: `done-${n}` })
  }
})

realTest(
  'end to end: a saved raise reaches a saturated worker through the 5s watcher alone',
  () => {
    // One refresh (5s) plus one BullMQ drainDelay (5s) is the worst case;
    // 14s is that plus slack.
    const f = fact('endToEndWatch')
    expect(f.insideBefore).toBe(1)
    expect(f.threeIn).toBe(true)
    expect(f.local).toBe(4)
    expect(f.globalInRedis).toBe(3)
    expect(f.peak).toBe(3)
  },
)

// --- worker restart, through the real startUnderSessionConcurrency ----------------

type Startup = {
  duringLock: {
    runCalls: number
    isRunning: boolean
    entered: number
    globalInRedis: number | null
  }
  firstIn: boolean
  insideAfterSettle: number
  enteredAfterSettle: number
  peak: number
  exited: number
  runCalls: number
  local: number
  globalAfterTick: number | null
  startErrors: string[]
  failed: string[]
}

for (const [variant, title, redisBefore] of [
  ['freshRedis', 'fresh Redis', null],
  // The admin lowered 3 -> 1 while the worker was down; Redis still says 3.
  ['staleCapThree', 'stale higher cap of 3 in Redis', 3],
] as const) {
  realTest(
    `worker restart, ${title}: nothing is fetched while the first DB read is held up`,
    () => {
      const f = fact<Record<string, Startup>>('startupOrder')[variant]
      expect(f?.duringLock).toEqual({
        runCalls: 0,
        isRunning: false,
        entered: 0,
        globalInRedis: redisBefore,
      })
    },
  )

  realTest(
    `worker restart, ${title}: 3 queued turns never exceed a saved limit of 1, and all finish`,
    () => {
      const f = fact<Record<string, Startup>>('startupOrder')[variant]
      expect(f?.firstIn).toBe(true)
      expect(f?.insideAfterSettle).toBe(1)
      expect(f?.enteredAfterSettle).toBe(1)
      expect(f?.peak).toBe(1)
      expect(f?.exited).toBe(3)
      expect(f?.globalAfterTick).toBe(1)
      expect(f?.local).toBe(2)
      expect(f?.runCalls).toBe(1)
      expect(f?.startErrors).toEqual([])
      expect(f?.failed).toEqual([])
    },
  )
}

// --- the database is unreachable at boot ------------------------------------------

type ReadFails = {
  requestedMs: number
  whileDown: {
    runCalls: number
    isRunning: boolean
    entered: number
    local: number
    globalInRedis: number | null
    failedReads: number
    waiting: number
  }
  firstIn: boolean
  startedWithinMs: number
  insideAfterSettle: number
  enteredAfterSettle: number
  peak: number
  exited: number
  runCalls: number
  local: number
  globalInRedis: number | null
  startErrors: string[]
  failed: string[]
}

realTest('first DB read fails: the poll asks for the real 5s interval', () => {
  // The child shortens it to 200ms; this pins what it was asked for.
  expect(fact<ReadFails>('firstReadFails').requestedMs).toBe(5000)
})

realTest(
  'first DB read fails: the worker is not started, nothing is processed, and reads keep retrying',
  () => {
    const f = fact<ReadFails>('firstReadFails').whileDown
    expect(f.runCalls).toBe(0)
    expect(f.isRunning).toBe(false)
    expect(f.entered).toBe(0)
    expect(f.waiting).toBe(3)
    // No cap was ever written: not the saved one, and not env's either.
    expect(f.globalInRedis).toBeNull()
    expect(f.local).toBe(2)
    // ~10 ticks in 2s at 200ms; more than one proves it retries rather than gives up.
    expect(f.failedReads).toBeGreaterThan(1)
  },
)

realTest(
  'first DB read fails: once the table is back, the worker starts within 3s under the saved cap of 1',
  () => {
    const f = fact<ReadFails>('firstReadFails')
    expect(f.firstIn).toBe(true)
    // One 200ms tick plus a fetch; 3s is generous slack.
    expect(f.startedWithinMs).toBeLessThan(3000)
    expect(f.insideAfterSettle).toBe(1)
    expect(f.enteredAfterSettle).toBe(1)
    expect(f.peak).toBe(1)
    expect(f.exited).toBe(3)
    expect(f.globalInRedis).toBe(1)
    expect(f.local).toBe(2)
    expect(f.failed).toEqual([])
  },
)

realTest('first DB read fails: run() is called once, despite many ticks after recovery', () => {
  const f = fact<ReadFails>('firstReadFails')
  expect(f.runCalls).toBe(1)
  // A second run() on a real Worker would reject "Worker is already running."
  // and be logged here.
  expect(f.startErrors).toEqual([])
})

// --- closed before the first successful apply --------------------------------------

type Closed = {
  closeTimedOut: boolean
  globalInRedis: number | null
  runCalls: number
  isRunning: boolean
  entered: number
  waiting: number
  startErrors: string[]
  failedReadsBeforeClose?: number
}

realTest(
  'closed while the first read is held up: the late apply lands, but run() is never called',
  () => {
    const f = fact<Record<string, Closed>>('closedBeforeFirstApply').duringSlowRead
    // A never-started worker has no jobs to wait for.
    expect(f?.closeTimedOut).toBe(false)
    // The tick that was parked on the lock did complete its apply...
    expect(f?.globalInRedis).toBe(1)
    // ...and did not start the closed worker.
    expect(f?.runCalls).toBe(0)
    expect(f?.isRunning).toBe(false)
    expect(f?.entered).toBe(0)
    expect(f?.waiting).toBe(3)
    expect(f?.startErrors).toEqual([])
  },
)

realTest(
  'closed while reads are failing, ticks still running: the first good tick does not start it',
  () => {
    const f = fact<Record<string, Closed>>('closedBeforeFirstApply').afterFailedReads
    // A never-started worker has no jobs to wait for.
    expect(f?.closeTimedOut).toBe(false)
    expect(f?.failedReadsBeforeClose).toBeGreaterThan(0)
    expect(f?.globalInRedis).toBe(1)
    expect(f?.runCalls).toBe(0)
    expect(f?.isRunning).toBe(false)
    expect(f?.entered).toBe(0)
    expect(f?.waiting).toBe(3)
    expect(f?.startErrors).toEqual([])
  },
)

// --- run() at most once (fake worker, real setting) ---------------------------------

type NoDouble = {
  many: {
    intervalMs: number
    runCallsAfterFirst: number
    runCalls: number
    applies: number
    globals: number[]
    local: number
    stopCleared: boolean
  }
  applyRejectsFirst: {
    runCallsWhileRefused: number
    runCalls: number
    attempts: number
    stopCleared: boolean
  }
  runRejects: { runCalls: number; applies: number; startErrors: string[]; stopCleared: boolean }
  alreadyClosing: { runCalls: number; applies: number; stopCleared: boolean }
  unhandled: string[]
}

realTest('no double start: run() is called exactly once across 21 successful ticks', () => {
  const f = fact<NoDouble>('noDoubleStart').many
  expect(f.intervalMs).toBe(5000)
  expect(f.runCallsAfterFirst).toBe(1)
  expect(f.runCalls).toBe(1)
  // Every tick applied, so run()'s never-settling promise was not awaited.
  expect(f.applies).toBe(21)
  expect(f.globals).toEqual([2])
  expect(f.local).toBe(3)
  expect(f.stopCleared).toBe(true)
})

realTest(
  'no double start: applies that Redis refuses do not start the worker; the first that lands does, once',
  () => {
    const f = fact<NoDouble>('noDoubleStart').applyRejectsFirst
    expect(f.runCallsWhileRefused).toBe(0)
    expect(f.attempts).toBe(9)
    expect(f.runCalls).toBe(1)
  },
)

realTest('a run() that rejects is logged, never unhandled, and not retried', () => {
  const f = fact<NoDouble>('noDoubleStart')
  expect(f.runRejects.runCalls).toBe(1)
  expect(f.runRejects.applies).toBe(6)
  expect(f.runRejects.startErrors).toHaveLength(1)
  expect(f.unhandled).toEqual([])
})

realTest('a worker already closing is never started, over 6 successful ticks', () => {
  const f = fact<NoDouble>('noDoubleStart').alreadyClosing
  expect(f.applies).toBe(6)
  expect(f.runCalls).toBe(0)
})
