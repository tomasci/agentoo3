// Runs the max_concurrent_sessions enforcement scenarios against a REAL
// BullMQ Queue and Worker on a REAL redis-server, with the setting stored in a
// REAL Postgres, and prints what happened as JSON. The parent
// (session-concurrency-bullmq.test.ts) starts both servers and asserts.
//
// Nothing is mocked here — that is the point. The chain under test is:
// updateSystemSettings (Postgres row) -> syncSessionConcurrency /
// watchSessionConcurrency / startUnderSessionConcurrency ->
// applySessionConcurrency -> worker.concurrency and queue.setGlobalConcurrency
// -> BullMQ's Lua-side global cap. Each scenario uses its own queue name so no
// state carries over between them. The one exception to "nothing mocked" is
// noDoubleStart, whose worker and queue are fakes that count calls.
//
// A child process because `@/env` is parsed once per process (see
// pg-cluster.ts) and because the shared test process has `bullmq` and
// `ioredis` mocked by other files; only a fresh process gets the real ones.

import { randomUUID } from 'node:crypto'

const { Queue, Worker } = await import('bullmq')
const { default: IORedis } = await import('ioredis')
const { default: postgres } = await import('postgres')
const { closeDb } = await import('@/db/client')
const { env } = await import('@/env')
const { updateSystemSettings } = await import('@/features/system/settings')
const { logger } = await import('@/lib/logger')
const { startUnderSessionConcurrency, syncSessionConcurrency, watchSessionConcurrency } =
  await import('@/queue/session-concurrency')

const REDIS_URL = env.REDIS_URL
const facts: Record<string, unknown> = {}
const connections: InstanceType<typeof IORedis>[] = []

const connection = () => {
  // Exactly the options queue/index.ts's redisConnection() uses.
  const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })
  connections.push(c)
  return c
}

async function until(predicate: () => boolean, ms: number): Promise<number | undefined> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) return undefined
    await Bun.sleep(10)
  }
  return Date.now() - start
}

/**
 * A real queue + worker whose processor blocks each job on a gate this file
 * controls, and records how many jobs are inside at once.
 */
function harness(label: string, opts: { name?: string } = {}) {
  const name = opts.name ?? `conc-test-${label}-${randomUUID().slice(0, 8)}`
  const queue = new Queue(name, { connection: connection() })
  let inside = 0
  let peak = 0
  let windowPeak = 0
  const entered: number[] = []
  const exited: number[] = []
  const gates = new Map<number, () => void>()
  const failed: string[] = []
  const stalled: string[] = []

  const worker = new Worker(
    name,
    async (job) => {
      const n = (job.data as { n: number }).n
      inside++
      peak = Math.max(peak, inside)
      windowPeak = Math.max(windowPeak, inside)
      entered.push(n)
      await new Promise<void>((resolve) => gates.set(n, resolve))
      inside--
      exited.push(n)
      return `done-${n}`
    },
    {
      connection: connection(),
      // What startSessionRunWorker constructs it with.
      concurrency: env.WORKER_CONCURRENCY,
      autorun: false,
    },
  )
  worker.on('failed', (job, error) => failed.push(`${job?.id}: ${error.message}`))
  worker.on('stalled', (id) => stalled.push(String(id)))
  worker.on('error', () => {})

  return {
    queue,
    worker,
    get inside() {
      return inside
    },
    get peak() {
      return peak
    },
    get windowPeak() {
      return windowPeak
    },
    resetWindow() {
      windowPeak = inside
    },
    entered,
    exited,
    failed,
    stalled,
    async add(count: number) {
      for (let n = 1; n <= count; n++) await queue.add('turn', { n })
    },
    start() {
      worker.run().catch(() => {})
    },
    /** Let job n out of the processor (waiting for it to be inside first). */
    async release(n: number) {
      await until(() => gates.has(n), 10_000)
      gates.get(n)?.()
      gates.delete(n)
    },
    async releaseAll() {
      for (const resolve of gates.values()) resolve()
      gates.clear()
    },
    async states() {
      const jobs = await queue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed'])
      const out: Record<string, { state: string; returnvalue: unknown }> = {}
      for (const job of jobs) {
        out[String((job.data as { n: number }).n)] = {
          state: await job.getState(),
          returnvalue: job.returnvalue,
        }
      }
      return out
    },
    async close() {
      for (const resolve of gates.values()) resolve()
      gates.clear()
      await worker.close(true).catch(() => {})
      await queue.close().catch(() => {})
    },
  }
}

const SETTLE_MS = 1500
const ENTER_MS = 8000

async function setSetting(value: number | null) {
  await updateSystemSettings({ maxConcurrentSessions: value })
}

// --- limit 1 ------------------------------------------------------------------
async function limitOne() {
  await setSetting(1)
  const h = harness('limit1')
  try {
    await h.add(3)
    const applied = await syncSessionConcurrency(h.worker, h.queue)
    h.start()
    const firstIn = await until(() => h.inside === 1, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideWhileFirstRuns = h.inside
    const enteredWhileFirstRuns = [...h.entered]
    const insideAfterEach: number[] = []
    for (let k = 0; k < 3; k++) {
      const n = h.entered[k] as number
      await h.release(n)
      if (k < 2) {
        await until(() => h.entered.length === k + 2, ENTER_MS)
        await Bun.sleep(500)
        insideAfterEach.push(h.inside)
      }
    }
    await until(() => h.exited.length === 3, ENTER_MS)
    await Bun.sleep(200)
    facts.limitOne = {
      applied,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      firstIn: firstIn !== undefined,
      insideWhileFirstRuns,
      enteredWhileFirstRuns,
      insideAfterEach,
      peak: h.peak,
      exited: h.exited.length,
      states: await h.states(),
      failed: h.failed,
    }
  } finally {
    await h.close()
  }
}

// --- limit 3 ------------------------------------------------------------------
async function limitThree() {
  await setSetting(3)
  const h = harness('limit3')
  try {
    await h.add(4)
    const applied = await syncSessionConcurrency(h.worker, h.queue)
    h.start()
    const threeInMs = await until(() => h.inside === 3, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideAfterSettle = h.inside
    const enteredAfterSettle = h.entered.length
    await h.release(h.entered[0] as number)
    const fourthInMs = await until(() => h.entered.length === 4, ENTER_MS)
    await Bun.sleep(300)
    await h.releaseAll()
    await until(() => h.exited.length === 4, ENTER_MS)
    facts.limitThree = {
      applied,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      threeIn: threeInMs !== undefined,
      insideAfterSettle,
      enteredAfterSettle,
      fourthIn: fourthInMs !== undefined,
      peak: h.peak,
      exited: h.exited.length,
      failed: h.failed,
    }
  } finally {
    await h.close()
  }
}

// --- limit 2, the default (no row) ---------------------------------------------
async function limitDefault() {
  await setSetting(null)
  const h = harness('limit2')
  try {
    await h.add(3)
    const applied = await syncSessionConcurrency(h.worker, h.queue)
    h.start()
    const twoInMs = await until(() => h.inside === 2, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideAfterSettle = h.inside
    const enteredAfterSettle = h.entered.length
    await h.release(h.entered[0] as number)
    const thirdInMs = await until(() => h.entered.length === 3, ENTER_MS)
    await Bun.sleep(300)
    await h.releaseAll()
    await until(() => h.exited.length === 3, ENTER_MS)
    facts.limitDefault = {
      applied,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      twoIn: twoInMs !== undefined,
      insideAfterSettle,
      enteredAfterSettle,
      thirdIn: thirdInMs !== undefined,
      peak: h.peak,
      exited: h.exited.length,
      failed: h.failed,
    }
  } finally {
    await h.close()
  }
}

// --- raise 1 -> 3 while saturated ------------------------------------------------
async function raiseWhileSaturated() {
  await setSetting(1)
  const h = harness('raise')
  try {
    await h.add(5)
    await syncSessionConcurrency(h.worker, h.queue)
    h.start()
    await until(() => h.inside === 1, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideBefore = h.inside
    await setSetting(3)
    const raisedAt = Date.now()
    const applied = await syncSessionConcurrency(h.worker, h.queue)
    const threeInMs = await until(() => h.inside === 3, ENTER_MS)
    const elapsedMs = threeInMs === undefined ? undefined : Date.now() - raisedAt
    const insideAtDeadline = h.inside
    await Bun.sleep(SETTLE_MS)
    const insideAfterSettle = h.inside
    await h.releaseAll()
    await until(() => h.exited.length >= 3, ENTER_MS)
    facts.raise = {
      insideBefore,
      applied,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      threeIn: threeInMs !== undefined,
      elapsedMs,
      insideAtDeadline,
      insideAfterSettle,
      peak: h.peak,
      failed: h.failed,
    }
  } finally {
    await h.close()
  }
}

// --- control: the same raise without the spare local slot -----------------------
//
// Not a test of the code under review: a test of the claim its comment makes
// about BullMQ, so that the raise scenario above is known to be able to fail.
async function raiseWithoutSpareSlot() {
  const h = harness('nospare')
  try {
    await h.add(5)
    h.worker.concurrency = 1
    await h.queue.setGlobalConcurrency(1)
    h.start()
    await until(() => h.inside === 1, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    h.worker.concurrency = 3
    await h.queue.setGlobalConcurrency(3)
    const threeInMs = await until(() => h.inside === 3, ENTER_MS)
    facts.raiseWithoutSpareSlot = { threeIn: threeInMs !== undefined, insideAtDeadline: h.inside }
  } finally {
    await h.close()
  }
}

// --- lower 3 -> 1 while 3 run --------------------------------------------------
async function lowerWhileRunning() {
  await setSetting(3)
  const h = harness('lower')
  try {
    await h.add(5)
    await syncSessionConcurrency(h.worker, h.queue)
    h.start()
    const threeIn = (await until(() => h.inside === 3, ENTER_MS)) !== undefined
    const runningAtLower = [...h.entered]
    await setSetting(1)
    const applied = await syncSessionConcurrency(h.worker, h.queue)
    h.resetWindow()
    await Bun.sleep(2000)
    const insideAfterLower = h.inside
    const enteredAfterLower = h.entered.length
    const exitedAfterLower = h.exited.length

    // Drain the three that were running, one at a time; nothing new may start
    // until all three are gone (active 2, then 1, are both >= the new cap).
    const enteredAfterEachDrain: number[] = []
    for (const n of runningAtLower) {
      await h.release(n)
      await Bun.sleep(SETTLE_MS)
      enteredAfterEachDrain.push(h.entered.length)
    }
    // Once all three are out, exactly one new job may be in.
    await until(() => h.entered.length === 4, ENTER_MS)
    h.resetWindow()
    await Bun.sleep(SETTLE_MS)
    const insideWithFourth = h.inside
    await h.release(h.entered[3] as number)
    await until(() => h.entered.length === 5, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideWithFifth = h.inside
    const peakAfterDrain = h.windowPeak
    await h.release(h.entered[4] as number)
    await until(() => h.exited.length === 5, ENTER_MS)
    await Bun.sleep(200)
    facts.lower = {
      threeIn,
      runningAtLower,
      applied,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      insideAfterLower,
      enteredAfterLower,
      exitedAfterLower,
      enteredAfterEachDrain,
      insideWithFourth,
      insideWithFifth,
      peakAfterDrain,
      exited: h.exited.length,
      states: await h.states(),
      failed: h.failed,
      stalled: h.stalled,
    }
  } finally {
    await h.close()
  }
}

// --- end to end through the real watcher ----------------------------------------
//
// No manual sync: the setting is saved and the 5s watcher alone has to carry
// it to the running worker. Bounded by one refresh plus one drainDelay plus
// slack.
async function endToEndWatch() {
  await setSetting(1)
  const h = harness('watch')
  let stop: () => void = () => {}
  try {
    await h.add(5)
    stop = watchSessionConcurrency(h.worker, h.queue)
    // Wait for the first tick to land in Redis, not just locally: the local
    // number (2) already matches its target at construction.
    const deadline = Date.now() + 5000
    while ((await h.queue.getGlobalConcurrency()) !== 1 && Date.now() < deadline)
      await Bun.sleep(20)
    h.start()
    await until(() => h.inside === 1, ENTER_MS)
    await Bun.sleep(SETTLE_MS)
    const insideBefore = h.inside
    const savedAt = Date.now()
    await setSetting(3)
    const threeInMs = await until(() => h.inside === 3, 14_000)
    facts.endToEndWatch = {
      insideBefore,
      threeIn: threeInMs !== undefined,
      elapsedMs: threeInMs === undefined ? undefined : Date.now() - savedAt,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      peak: h.peak,
    }
  } finally {
    stop()
    await h.close()
  }
}

// --- startup, through the real startUnderSessionConcurrency --------------------
//
// A worker restart as startSessionRunWorker now does it: turns already queued,
// then a real Worker constructed with autorun: false at env.WORKER_CONCURRENCY,
// then the real startUnderSessionConcurrency(worker, queue) — nothing here
// calls run() or orders anything itself. Against two Redis states: a queue
// whose meta has no cap at all (a fresh or flushed Redis), and one still
// holding a higher cap of 3 from before the admin lowered the setting while
// the worker was down (the API process never writes Redis).
//
// The first tick's DB read is held behind an ACCESS EXCLUSIVE lock on
// system_settings for 1.5s — a slow Postgres at boot — which is exactly the
// window in which the old autorun worker over-admitted every time.

const LOCK_MS = 1500
/** The interval the poll loop is handed in place of the real 5s, where a
 * scenario needs many ticks (setInterval is swapped only for the duration of
 * the synchronous startUnderSessionConcurrency call; BullMQ's own timers, set
 * later from run(), get the real one). */
const FAST_TICK_MS = 200

function adminSql() {
  return postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })
}

/** Takes an ACCESS EXCLUSIVE lock on system_settings and holds it until release(). */
async function holdTableLock(admin: ReturnType<typeof adminSql>) {
  let lockHeld: () => void = () => {}
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    lockHeld = resolve
  })
  const done = admin.begin(async (sql) => {
    await sql`lock table system_settings in access exclusive mode`
    lockHeld()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await held
  return { release: () => release(), done }
}

/** Wraps the real worker.run so its calls are counted; it still runs. */
function countRuns(worker: { run: () => Promise<void> }) {
  const calls = { n: 0 }
  const real = worker.run.bind(worker)
  worker.run = () => {
    calls.n++
    return real()
  }
  return calls
}

/** Records logger.warn / logger.error lines until restore(). */
function captureLogs() {
  const warn: string[] = []
  const error: string[] = []
  const originalWarn = logger.warn
  const originalError = logger.error
  logger.warn = ((...args: unknown[]) => {
    warn.push(args.map(String).join(' '))
  }) as typeof logger.warn
  logger.error = ((...args: unknown[]) => {
    error.push(args.map(String).join(' '))
  }) as typeof logger.error
  return {
    warn,
    error,
    restore() {
      logger.warn = originalWarn
      logger.error = originalError
    },
  }
}

/**
 * A graceful worker.close(), bounded. Before its first successful apply the
 * worker has no jobs, so this settles at once; if it was wrongly started, its
 * jobs are parked on gates and an unbounded close() would hang the child.
 */
async function closeWithin(worker: { close: () => Promise<void> }, ms: number) {
  const timedOut = Symbol('timedOut')
  const outcome = await Promise.race([
    worker.close().then(() => 'closed'),
    Bun.sleep(ms).then(() => timedOut),
  ])
  return outcome === timedOut
}

/** Calls startUnderSessionConcurrency with the poll interval shortened to FAST_TICK_MS. */
function startFast(...args: Parameters<typeof startUnderSessionConcurrency>) {
  const realSetInterval = globalThis.setInterval
  let requestedMs: number | undefined
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    requestedMs = ms
    return realSetInterval(fn, FAST_TICK_MS)
  }) as unknown as typeof setInterval
  try {
    return { stop: startUnderSessionConcurrency(...args), requestedMs }
  } finally {
    globalThis.setInterval = realSetInterval
  }
}

async function preQueue(name: string, count: number, staleCap?: number) {
  const pre = new Queue(name, { connection: connection() })
  if (staleCap !== undefined) await pre.setGlobalConcurrency(staleCap)
  for (let n = 1; n <= count; n++) await pre.add('turn', { n })
  await pre.close()
}

/** Lets the jobs out one at a time, in the order they entered, until `count` have finished. */
async function drainOneByOne(h: ReturnType<typeof harness>, count: number) {
  for (let k = 0; k < count; k++) {
    await until(() => h.entered.length > k, ENTER_MS)
    await h.release(h.entered[k] as number)
    await until(() => h.exited.length > k, ENTER_MS)
  }
}

async function startupOrder() {
  await setSetting(1)
  const admin = adminSql()
  const out: Record<string, Record<string, unknown>> = {}
  try {
    for (const variant of ['freshRedis', 'staleCapThree'] as const) {
      const name = `conc-test-startup-${variant}-${randomUUID().slice(0, 8)}`
      await preQueue(name, 3, variant === 'staleCapThree' ? 3 : undefined)
      const lock = await holdTableLock(admin)
      const h = harness('startup', { name })
      const runs = countRuns(h.worker)
      const logs = captureLogs()
      const stop = startUnderSessionConcurrency(h.worker, h.queue)
      h.worker.on('closing', stop)
      try {
        await Bun.sleep(LOCK_MS)
        const duringLock = {
          runCalls: runs.n,
          isRunning: h.worker.isRunning(),
          entered: h.entered.length,
          globalInRedis: await h.queue.getGlobalConcurrency(),
        }
        lock.release()
        await lock.done
        const firstInMs = await until(() => h.entered.length >= 1, ENTER_MS)
        await Bun.sleep(SETTLE_MS)
        const insideAfterSettle = h.inside
        const enteredAfterSettle = h.entered.length
        await drainOneByOne(h, 3)
        out[variant] = {
          duringLock,
          firstIn: firstInMs !== undefined,
          insideAfterSettle,
          enteredAfterSettle,
          peak: h.peak,
          exited: h.exited.length,
          runCalls: runs.n,
          local: h.worker.concurrency,
          globalAfterTick: await h.queue.getGlobalConcurrency(),
          startErrors: logs.error,
          failed: h.failed,
        }
      } finally {
        logs.restore()
        lock.release()
        stop()
        await h.close()
      }
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
  facts.startupOrder = { ...out, envDefault: env.WORKER_CONCURRENCY }
}

// --- startup with the database unreachable at boot ------------------------------
//
// The read fails for real: system_settings is renamed away. Saved cap 1, so a
// worker that fell back to env (2) would be told apart by its peak.
async function firstReadFails() {
  await setSetting(1)
  const admin = adminSql()
  const name = `conc-test-readfail-${randomUUID().slice(0, 8)}`
  await preQueue(name, 3)
  await admin`alter table system_settings rename to system_settings_away`
  const h = harness('readfail', { name })
  const runs = countRuns(h.worker)
  const logs = captureLogs()
  const { stop, requestedMs } = startFast(h.worker, h.queue)
  h.worker.on('closing', stop)
  try {
    await Bun.sleep(2000)
    const failedReads = logs.warn.filter((w) => w.includes('max_concurrent_sessions')).length
    const whileDown = {
      runCalls: runs.n,
      isRunning: h.worker.isRunning(),
      entered: h.entered.length,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      failedReads,
      waiting: await h.queue.getWaitingCount(),
    }
    await admin`alter table system_settings_away rename to system_settings`
    const restoredAt = Date.now()
    const firstInMs = await until(() => h.entered.length >= 1, ENTER_MS)
    const startedWithinMs = firstInMs === undefined ? undefined : Date.now() - restoredAt
    // Many more FAST_TICK_MS ticks land here, each one a successful apply.
    await Bun.sleep(SETTLE_MS)
    const insideAfterSettle = h.inside
    const enteredAfterSettle = h.entered.length
    await drainOneByOne(h, 3)
    facts.firstReadFails = {
      requestedMs,
      whileDown,
      firstIn: firstInMs !== undefined,
      startedWithinMs,
      insideAfterSettle,
      enteredAfterSettle,
      peak: h.peak,
      exited: h.exited.length,
      runCalls: runs.n,
      local: h.worker.concurrency,
      globalInRedis: await h.queue.getGlobalConcurrency(),
      startErrors: logs.error,
      failed: h.failed,
    }
  } finally {
    logs.restore()
    await admin`alter table if exists system_settings_away rename to system_settings`
    stop()
    await h.close()
    await admin.end({ timeout: 5 })
  }
}

// --- closed before the first successful apply ------------------------------------
//
// Two ways in. "duringSlowRead": close() while the first tick is parked on the
// table lock; production's own `worker.on('closing', stop)` is wired, so that
// in-flight tick is the only one that can ever reach run(). "afterFailedReads":
// close() while reads are failing, with NO stop wired, so ticks keep coming
// and the first successful one must itself refuse to start a closing worker.
// Real BullMQ's run() would no-op on a closing worker anyway, so the counted
// run() calls are what tell the guard apart, not the processed jobs alone.
async function closedBeforeFirstApply() {
  await setSetting(1)
  const admin = adminSql()
  const out: Record<string, Record<string, unknown>> = {}
  try {
    {
      const name = `conc-test-closed-slow-${randomUUID().slice(0, 8)}`
      await preQueue(name, 3)
      const lock = await holdTableLock(admin)
      const h = harness('closed-slow', { name })
      const runs = countRuns(h.worker)
      const logs = captureLogs()
      const stop = startUnderSessionConcurrency(h.worker, h.queue)
      h.worker.on('closing', stop)
      try {
        await Bun.sleep(300)
        const closeTimedOut = await closeWithin(h.worker, 3000)
        lock.release()
        await lock.done
        // The parked tick does finish its apply after the close (Redis goes
        // from no cap to 1)...
        const deadline = Date.now() + 3000
        while ((await h.queue.getGlobalConcurrency()) !== 1 && Date.now() < deadline)
          await Bun.sleep(20)
        // ...and nothing starts from it.
        await Bun.sleep(SETTLE_MS)
        out.duringSlowRead = {
          closeTimedOut,
          globalInRedis: await h.queue.getGlobalConcurrency(),
          runCalls: runs.n,
          isRunning: h.worker.isRunning(),
          entered: h.entered.length,
          waiting: await h.queue.getWaitingCount(),
          startErrors: logs.error,
        }
      } finally {
        logs.restore()
        lock.release()
        stop()
        await h.close()
      }
    }
    {
      const name = `conc-test-closed-failing-${randomUUID().slice(0, 8)}`
      await preQueue(name, 3)
      await admin`alter table system_settings rename to system_settings_away`
      const h = harness('closed-failing', { name })
      const runs = countRuns(h.worker)
      const logs = captureLogs()
      const { stop } = startFast(h.worker, h.queue)
      try {
        await Bun.sleep(600)
        const failedReadsBeforeClose = logs.warn.filter((w) =>
          w.includes('max_concurrent_sessions'),
        ).length
        const closeTimedOut = await closeWithin(h.worker, 3000)
        await admin`alter table system_settings_away rename to system_settings`
        const deadline = Date.now() + 3000
        while ((await h.queue.getGlobalConcurrency()) !== 1 && Date.now() < deadline)
          await Bun.sleep(20)
        await Bun.sleep(SETTLE_MS)
        out.afterFailedReads = {
          closeTimedOut,
          failedReadsBeforeClose,
          globalInRedis: await h.queue.getGlobalConcurrency(),
          runCalls: runs.n,
          isRunning: h.worker.isRunning(),
          entered: h.entered.length,
          waiting: await h.queue.getWaitingCount(),
          startErrors: logs.error,
        }
      } finally {
        logs.restore()
        await admin`alter table if exists system_settings_away rename to system_settings`
        stop()
        await h.close()
      }
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
  facts.closedBeforeFirstApply = out
}

// --- run() at most once, over many ticks -----------------------------------------
//
// Fake worker and queue, real setting in Postgres. setInterval is swapped for
// one that only records its callback, so every tick is one this file fires.
async function noDoubleStart() {
  await setSetting(2)
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  /** Starts under a captured interval; returns the tick to fire by hand. */
  function startCaptured(...args: Parameters<typeof startUnderSessionConcurrency>) {
    let tick: (() => void) | undefined
    let intervalMs: number | undefined
    const handle = { unref: () => handle }
    const cleared: unknown[] = []
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      tick = fn
      intervalMs = ms
      return handle
    }) as unknown as typeof setInterval
    globalThis.clearInterval = ((x: unknown) => {
      cleared.push(x)
    }) as typeof clearInterval
    let stop: () => void
    try {
      stop = startUnderSessionConcurrency(...args)
    } finally {
      globalThis.setInterval = realSetInterval
    }
    return {
      tick: () => tick?.(),
      intervalMs,
      stop() {
        stop()
        globalThis.clearInterval = realClearInterval
        return cleared.includes(handle)
      },
    }
  }

  const unhandled: string[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(String(reason))
  process.on('unhandledRejection', onUnhandled)
  const logs = captureLogs()
  const out: Record<string, unknown> = {}
  try {
    // Many successful ticks. run() never resolves, as the real one does not
    // while the worker runs — so if it were awaited, the in-flight guard would
    // swallow every tick after the first and the apply count would stay at 1.
    {
      let runCalls = 0
      const globals: number[] = []
      const worker = {
        concurrency: env.WORKER_CONCURRENCY,
        closing: undefined as Promise<void> | undefined,
        run() {
          runCalls++
          return new Promise<void>(() => {})
        },
      }
      const queue = {
        async setGlobalConcurrency(n: number) {
          globals.push(n)
          return 1
        },
      }
      const s = startCaptured(worker, queue)
      await until(() => globals.length === 1, 3000)
      await Bun.sleep(20)
      const runCallsAfterFirst = runCalls
      for (let k = 0; k < 20; k++) {
        s.tick()
        await until(() => globals.length === k + 2, 3000)
        await Bun.sleep(5)
      }
      out.many = {
        intervalMs: s.intervalMs,
        runCallsAfterFirst,
        runCalls,
        applies: globals.length,
        globals: [...new Set(globals)],
        local: worker.concurrency,
        stopCleared: s.stop(),
      }
    }

    // Applies that reject (Redis refusing the cap) are not "successful": no
    // run() until one lands, then exactly one.
    {
      let runCalls = 0
      let attempts = 0
      let refuse = true
      const worker = {
        concurrency: env.WORKER_CONCURRENCY,
        closing: undefined as Promise<void> | undefined,
        run() {
          runCalls++
          return new Promise<void>(() => {})
        },
      }
      const queue = {
        async setGlobalConcurrency() {
          attempts++
          if (refuse) throw new Error('redis refused the cap')
          return 1
        },
      }
      const s = startCaptured(worker, queue)
      await until(() => attempts === 1, 3000)
      for (let k = 0; k < 3; k++) {
        await Bun.sleep(20)
        s.tick()
        await until(() => attempts === k + 2, 3000)
      }
      await Bun.sleep(20)
      const runCallsWhileRefused = runCalls
      refuse = false
      for (let k = 0; k < 5; k++) {
        s.tick()
        await until(() => attempts === k + 5, 3000)
        await Bun.sleep(20)
      }
      out.applyRejectsFirst = {
        runCallsWhileRefused,
        runCalls,
        attempts,
        stopCleared: s.stop(),
      }
    }

    // A run() that rejects is logged, never unhandled, and never retried.
    {
      let runCalls = 0
      let applies = 0
      const worker = {
        concurrency: env.WORKER_CONCURRENCY,
        closing: undefined as Promise<void> | undefined,
        async run() {
          runCalls++
          throw new Error('No process function is defined.')
        },
      }
      const queue = {
        async setGlobalConcurrency() {
          applies++
          return 1
        },
      }
      const s = startCaptured(worker, queue)
      await until(() => applies === 1, 3000)
      for (let k = 0; k < 5; k++) {
        await Bun.sleep(20)
        s.tick()
        await until(() => applies === k + 2, 3000)
      }
      await Bun.sleep(50)
      out.runRejects = {
        runCalls,
        applies,
        startErrors: logs.error.filter((e) => e.includes('No process function')),
        stopCleared: s.stop(),
      }
    }

    // A worker that is already closing is never started, however many ticks.
    {
      let runCalls = 0
      let applies = 0
      const worker = {
        concurrency: env.WORKER_CONCURRENCY,
        closing: Promise.resolve() as Promise<void> | undefined,
        run() {
          runCalls++
          return new Promise<void>(() => {})
        },
      }
      const queue = {
        async setGlobalConcurrency() {
          applies++
          return 1
        },
      }
      const s = startCaptured(worker, queue)
      await until(() => applies === 1, 3000)
      for (let k = 0; k < 5; k++) {
        await Bun.sleep(20)
        s.tick()
        await until(() => applies === k + 2, 3000)
      }
      await Bun.sleep(20)
      out.alreadyClosing = { runCalls, applies, stopCleared: s.stop() }
    }
  } finally {
    logs.restore()
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    await Bun.sleep(50)
    process.off('unhandledRejection', onUnhandled)
  }
  facts.noDoubleStart = { ...out, unhandled }
}

async function main() {
  facts.env = { workerConcurrency: env.WORKER_CONCURRENCY }
  await limitOne()
  await limitThree()
  await limitDefault()
  await raiseWhileSaturated()
  await raiseWithoutSpareSlot()
  await lowerWhileRunning()
  await endToEndWatch()
  await startupOrder()
  await firstReadFails()
  await closedBeforeFirstApply()
  await noDoubleStart()
  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    for (const c of connections) c.disconnect()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    for (const c of connections) c.disconnect()
    process.exit(1)
  })
