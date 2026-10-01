// Runs every max_concurrent_sessions scenario once, against the throwaway
// cluster its parent (system-settings-db.test.ts) started, and prints what
// happened as JSON. A child for the reason session-claim-db-child.ts gives:
// `@/env` parses process.env at first import, and the default under test here
// *is* env.WORKER_CONCURRENCY, so the parent runs this file twice — once with
// that variable removed and once with it set — which only a fresh process can
// honour.
//
// SETTINGS_CHILD_MODE=full runs everything; =envDefault runs only the
// scenarios that read the default, for the WORKER_CONCURRENCY=5 run.
//
// Redis and BullMQ are faked: nothing here reaches Redis. The enforcement
// scenarios hand session-concurrency.ts a fake worker and queue that record
// what they were told, so what is under test is the plumbing from a real row
// in Postgres to the numbers BullMQ would have been given.

import { mock } from 'bun:test'

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job' }
    }
    async upsertJobScheduler() {}
    async setGlobalConcurrency() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {},
  }),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const { sql } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { env } = await import('@/env')
const { logger } = await import('@/lib/logger')
const { createApp } = await import('@/app')
const { getMaxConcurrentSessions, getSystemSettings, updateSystemSettings } = await import(
  '@/features/system/settings'
)
const {
  SESSION_CONCURRENCY_REFRESH_MS,
  applySessionConcurrency,
  syncSessionConcurrency,
  watchSessionConcurrency,
} = await import('@/queue/session-concurrency')

const MODE = process.env.SETTINGS_CHILD_MODE ?? 'full'
const facts: Record<string, unknown> = {}

// The whole app, as index.ts serves it — so the 400 envelope below is the one
// a real client gets, not one rebuilt for the test.
const app = createApp()

async function request(method: 'GET' | 'PATCH', body?: string) {
  const res = await app.request('/api/system/settings', {
    method,
    ...(body !== undefined && { body, headers: { 'content-type': 'application/json' } }),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed }
}

/** The stored row's raw jsonb value, straight from Postgres, or null if none. */
async function storedValue(): Promise<unknown> {
  const rows = (await db.execute(
    sql`select value from system_settings where key = 'max_concurrent_sessions'`,
  )) as unknown as { value: unknown }[]
  return rows.length === 0 ? null : { value: rows[0]?.value }
}

async function clearRow() {
  await db.execute(sql`delete from system_settings`)
}

/** Writes a raw jsonb literal, bypassing the write path's validation. */
async function writeRaw(jsonLiteral: string) {
  await clearRow()
  await db.execute(
    sql`insert into system_settings (key, value) values ('max_concurrent_sessions', ${jsonLiteral}::jsonb)`,
  )
}

/** Every logger.warn emitted while `fn` ran. */
async function capturingWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const original = logger.warn.bind(logger)
  logger.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }) as typeof logger.warn
  try {
    return { result: await fn(), warnings }
  } finally {
    logger.warn = original
  }
}

/** A worker/queue pair that records, in order, every number it was handed. */
function fakePair(initialLocal: number) {
  const events: string[] = []
  let local = initialLocal
  const worker = {
    get concurrency() {
      return local
    },
    set concurrency(value: number) {
      events.push(`local:${value}`)
      local = value
    },
  }
  const globals: number[] = []
  const queue = {
    async setGlobalConcurrency(value: number) {
      events.push(`global:${value}`)
      globals.push(value)
      return 1
    },
  }
  return { worker, queue, events, globals }
}

async function until(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(5)
  }
}

async function envDefaultScenarios() {
  await clearRow()
  facts.envDefault = {
    envWorkerConcurrency: env.WORKER_CONCURRENCY,
    get: await request('GET'),
    effective: await getMaxConcurrentSessions(),
  }

  const pair = fakePair(env.WORKER_CONCURRENCY)
  const applied = await syncSessionConcurrency(pair.worker, pair.queue)
  facts.envDefaultEnforcement = {
    applied,
    local: pair.worker.concurrency,
    globals: pair.globals,
  }

  // Saved then reset: the reset lands on this process's default, not on 2.
  await request('PATCH', JSON.stringify({ maxConcurrentSessions: 9 }))
  facts.envDefaultReset = {
    patch: await request('PATCH', JSON.stringify({ maxConcurrentSessions: null })),
  }
}

async function fullScenarios() {
  await envDefaultScenarios()

  // --- 1. validation ---------------------------------------------------------
  //
  // An override of 7 is in place before every rejected body, so "unchanged"
  // can be told apart both from "reset to the default" and from "deleted".
  const invalidBodies: Record<string, string> = {
    zero: JSON.stringify({ maxConcurrentSessions: 0 }),
    negative: JSON.stringify({ maxConcurrentSessions: -1 }),
    fraction: JSON.stringify({ maxConcurrentSessions: 1.5 }),
    string: JSON.stringify({ maxConcurrentSessions: '3' }),
    boolean: JSON.stringify({ maxConcurrentSessions: true }),
    tooHigh: JSON.stringify({ maxConcurrentSessions: 65 }),
    empty: JSON.stringify({}),
    unknownKeyOnly: JSON.stringify({ foo: 1 }),
    // Beyond the brief: shapes a client could plausibly send.
    huge: JSON.stringify({ maxConcurrentSessions: 1e308 }),
    array: JSON.stringify({ maxConcurrentSessions: [3] }),
    object: JSON.stringify({ maxConcurrentSessions: { value: 3 } }),
    bodyIsArray: JSON.stringify([]),
    bodyIsNull: 'null',
  }
  const invalid: Record<string, unknown> = {}
  for (const [name, body] of Object.entries(invalidBodies)) {
    await updateSystemSettings({ maxConcurrentSessions: 7 })
    const res = await request('PATCH', body)
    invalid[name] = {
      status: res.status,
      body: res.body,
      storedAfter: await storedValue(),
      getAfter: (await request('GET')).body,
    }
  }
  facts.invalid = invalid

  // Rejected with no row at all: a 400 must not create one either.
  await clearRow()
  const zeroOnEmpty = await request('PATCH', JSON.stringify({ maxConcurrentSessions: 0 }))
  facts.invalidOnEmpty = { status: zeroOnEmpty.status, storedAfter: await storedValue() }

  // A PATCH with no body at all.
  await updateSystemSettings({ maxConcurrentSessions: 7 })
  const noBody = await app.request('/api/system/settings', { method: 'PATCH' })
  facts.noBody = {
    status: noBody.status,
    body: await noBody.text(),
    storedAfter: await storedValue(),
  }

  // A JSON body sent without a JSON content-type: does validation still run,
  // and does the value still land?
  for (const [name, value] of [
    ['textPlainInvalid', 0],
    ['textPlainValid', 3],
  ] as const) {
    await updateSystemSettings({ maxConcurrentSessions: 7 })
    const res = await app.request('/api/system/settings', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentSessions: value }),
      headers: { 'content-type': 'text/plain' },
    })
    facts[name] = { status: res.status, body: await res.text(), storedAfter: await storedValue() }
  }

  const valid: Record<string, unknown> = {}
  for (const value of [1, 3, 64]) {
    await clearRow()
    const patch = await request('PATCH', JSON.stringify({ maxConcurrentSessions: value }))
    valid[String(value)] = {
      patch,
      get: await request('GET'),
      stored: await storedValue(),
      jsonbType: (
        (await db.execute(
          sql`select jsonb_typeof(value) as t from system_settings where key = 'max_concurrent_sessions'`,
        )) as unknown as { t: string }[]
      )[0]?.t,
      effective: await getMaxConcurrentSessions(),
    }
  }
  facts.valid = valid

  // Equal to the default still pins it, per the route's own description.
  await clearRow()
  facts.equalToDefault = {
    patch: await request('PATCH', JSON.stringify({ maxConcurrentSessions: 2 })),
  }

  // A valid key alongside an unknown one: the unknown key is stripped, the
  // valid one applies.
  await clearRow()
  facts.validPlusUnknown = {
    patch: await request('PATCH', JSON.stringify({ maxConcurrentSessions: 4, foo: 1 })),
    stored: await storedValue(),
  }

  // Overwrite: a second save replaces the first, it does not insert a second row.
  await clearRow()
  await request('PATCH', JSON.stringify({ maxConcurrentSessions: 3 }))
  await request('PATCH', JSON.stringify({ maxConcurrentSessions: 5 }))
  const rowCount = (await db.execute(
    sql`select count(*)::int as n from system_settings`,
  )) as unknown as {
    n: number
  }[]
  facts.overwrite = {
    stored: await storedValue(),
    rows: rowCount[0]?.n,
    get: (await request('GET')).body,
  }

  // Reset.
  await updateSystemSettings({ maxConcurrentSessions: 6 })
  facts.reset = {
    patch: await request('PATCH', JSON.stringify({ maxConcurrentSessions: null })),
    stored: await storedValue(),
    get: await request('GET'),
  }
  // Reset with nothing saved is still a 200, not a 404.
  await clearRow()
  facts.resetWhenUnset = {
    patch: await request('PATCH', JSON.stringify({ maxConcurrentSessions: null })),
  }

  // --- 2. persistence --------------------------------------------------------
  await clearRow()
  await updateSystemSettings({ maxConcurrentSessions: 3 })
  const afterSave = await getMaxConcurrentSessions()
  // Changed underneath the process, by SQL alone: a cached value would still
  // say 3.
  await db.execute(
    sql`update system_settings set value = '9'::jsonb where key = 'max_concurrent_sessions'`,
  )
  const afterExternalWrite = await getMaxConcurrentSessions()
  await db.execute(sql`delete from system_settings where key = 'max_concurrent_sessions'`)
  const afterExternalDelete = await getMaxConcurrentSessions()
  facts.persistence = { afterSave, afterExternalWrite, afterExternalDelete }

  // updated_at moves on a re-save of the same value.
  await clearRow()
  await updateSystemSettings({ maxConcurrentSessions: 3 })
  const [first] = (await db.execute(
    sql`select updated_at from system_settings where key = 'max_concurrent_sessions'`,
  )) as unknown as { updated_at: string }[]
  await Bun.sleep(20)
  await updateSystemSettings({ maxConcurrentSessions: 3 })
  const [second] = (await db.execute(
    sql`select updated_at from system_settings where key = 'max_concurrent_sessions'`,
  )) as unknown as { updated_at: string }[]
  facts.updatedAt = {
    first: String(first?.updated_at),
    second: String(second?.updated_at),
    moved: new Date(String(second?.updated_at)) > new Date(String(first?.updated_at)),
  }

  // Malformed rows, written directly so the write path's validation never saw them.
  const malformedLiterals: Record<string, string> = {
    string: '"abc"',
    zero: '0',
    negative: '-4',
    fraction: '1.5',
    tooHigh: '65',
    jsonNull: 'null',
    object: '{"value": 3}',
    array: '[3]',
    boolean: 'true',
  }
  const malformed: Record<string, unknown> = {}
  for (const [name, literal] of Object.entries(malformedLiterals)) {
    await writeRaw(literal)
    const { result, warnings } = await capturingWarnings(async () => ({
      get: await request('GET'),
      effective: await getMaxConcurrentSessions(),
    }))
    const pair = fakePair(2)
    const applied = await syncSessionConcurrency(pair.worker, pair.queue)
    malformed[name] = {
      ...result,
      warnings,
      enforcement: { applied, local: pair.worker.concurrency, globals: pair.globals },
    }
  }
  facts.malformed = malformed

  // A valid save over a malformed row replaces it; a reset deletes it.
  await writeRaw('"abc"')
  const saveOverMalformed = await request('PATCH', JSON.stringify({ maxConcurrentSessions: 4 }))
  await writeRaw('"abc"')
  const resetOverMalformed = await request('PATCH', JSON.stringify({ maxConcurrentSessions: null }))
  facts.overMalformed = {
    save: saveOverMalformed,
    reset: resetOverMalformed,
    storedAfterReset: await storedValue(),
  }

  // --- 3. enforcement plumbing ----------------------------------------------
  const enforcement: Record<string, unknown> = {}
  for (const [name, row, initialLocal] of [
    ['noRow', undefined, env.WORKER_CONCURRENCY],
    ['row1', 1, env.WORKER_CONCURRENCY],
    // From a local number that is not already the target, so the write is seen.
    ['row1FromFour', 1, 4],
    ['row3', 3, env.WORKER_CONCURRENCY],
  ] as const) {
    await clearRow()
    if (row !== undefined) await updateSystemSettings({ maxConcurrentSessions: row })
    // Constructed as startSessionRunWorker does: at env.WORKER_CONCURRENCY.
    const pair = fakePair(initialLocal)
    const applied = await syncSessionConcurrency(pair.worker, pair.queue)
    enforcement[name] = {
      applied,
      local: pair.worker.concurrency,
      globals: pair.globals,
      events: pair.events,
    }
  }
  facts.enforcement = enforcement

  // A setting that changes between ticks is followed in both directions, and
  // an unchanged one is still re-asserted globally (self-heal) without
  // rewriting the local number.
  {
    await clearRow()
    const pair = fakePair(env.WORKER_CONCURRENCY)
    await updateSystemSettings({ maxConcurrentSessions: 3 })
    await syncSessionConcurrency(pair.worker, pair.queue)
    await syncSessionConcurrency(pair.worker, pair.queue)
    await updateSystemSettings({ maxConcurrentSessions: 1 })
    await syncSessionConcurrency(pair.worker, pair.queue)
    await updateSystemSettings({ maxConcurrentSessions: null })
    await syncSessionConcurrency(pair.worker, pair.queue)
    facts.followsChanges = { events: pair.events, local: pair.worker.concurrency }
  }

  // A database read that fails leaves the last applied values alone. The
  // failure is real: the table is renamed out from under the query.
  {
    await clearRow()
    await updateSystemSettings({ maxConcurrentSessions: 3 })
    const pair = fakePair(env.WORKER_CONCURRENCY)
    const firstApplied = await syncSessionConcurrency(pair.worker, pair.queue)
    const eventsBefore = [...pair.events]
    await db.execute(sql`alter table system_settings rename to system_settings_away`)
    let threw = ''
    let failedApplied: number | undefined | 'unset' = 'unset'
    let warnings: string[] = []
    try {
      const captured = await capturingWarnings(() =>
        syncSessionConcurrency(pair.worker, pair.queue),
      )
      failedApplied = captured.result
      warnings = captured.warnings
    } catch (error) {
      threw = String(error)
    } finally {
      await db.execute(sql`alter table system_settings_away rename to system_settings`)
    }
    // And the next good tick picks up where it left off.
    const recoveredApplied = await syncSessionConcurrency(pair.worker, pair.queue)
    facts.dbFailure = {
      firstApplied,
      eventsBefore,
      failedApplied: failedApplied === undefined ? 'undefined' : failedApplied,
      threw,
      warnings,
      localAfterFailure: pair.worker.concurrency,
      eventsAfter: pair.events,
      recoveredApplied,
    }
  }

  // apply rejects when setGlobalConcurrency rejects; the local number was
  // still set first.
  {
    const worker = { concurrency: 2 }
    let rejected = ''
    try {
      await applySessionConcurrency(
        worker,
        {
          async setGlobalConcurrency() {
            throw new Error('redis down')
          },
        },
        5,
      )
    } catch (error) {
      rejected = String(error)
    }
    facts.applyRejects = { rejected, local: worker.concurrency }
  }

  // --- the watcher: overlap, rejection, interval, stop ----------------------
  //
  // setInterval is swapped for one that only records its callback, so ticks
  // happen exactly when this file calls them, never on a wall clock.
  {
    await clearRow()
    await updateSystemSettings({ maxConcurrentSessions: 3 })

    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    let captured: (() => void) | undefined
    let intervalMs: number | undefined
    let unrefCalled = false
    const handle = {
      unref() {
        unrefCalled = true
        return handle
      },
    }
    const cleared: unknown[] = []
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      captured = fn
      intervalMs = ms
      return handle
    }) as unknown as typeof setInterval
    globalThis.clearInterval = ((h: unknown) => {
      cleared.push(h)
    }) as typeof clearInterval

    const releases: (() => void)[] = []
    const globals: number[] = []
    const worker = { concurrency: env.WORKER_CONCURRENCY }
    const hangingQueue = {
      setGlobalConcurrency(value: number) {
        globals.push(value)
        return new Promise<number>((resolve) => releases.push(() => resolve(1)))
      },
    }

    let stop: () => void = () => {}
    try {
      stop = watchSessionConcurrency(worker, hangingQueue)
    } finally {
      globalThis.setInterval = realSetInterval
    }
    const callsAtReturn = globals.length
    // The immediate tick reads the database first, then hangs in Redis.
    await until(() => globals.length === 1)
    const tick = captured as () => void
    tick()
    tick()
    await Bun.sleep(150) // long enough for a non-skipped tick's DB read to land
    const callsWhileHung = globals.length
    releases[0]?.()
    await Bun.sleep(20)
    tick()
    await until(() => globals.length === 2)
    releases[1]?.()
    await Bun.sleep(20)
    stop()
    globalThis.clearInterval = realClearInterval

    facts.watchOverlap = {
      intervalMs,
      refreshConstant: SESSION_CONCURRENCY_REFRESH_MS,
      unrefCalled,
      callsAtReturn,
      callsWhileHung,
      callsAfterRelease: globals.length,
      globals,
      local: worker.concurrency,
      stopClearedHandle: cleared.includes(handle),
    }
  }

  {
    // A tick whose apply rejects is caught (no unhandled rejection) and
    // does not wedge the in-flight guard.
    const realSetInterval = globalThis.setInterval
    let captured: (() => void) | undefined
    const handle = { unref: () => handle }
    globalThis.setInterval = ((fn: () => void) => {
      captured = fn
      return handle
    }) as unknown as typeof setInterval
    const unhandled: string[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(String(reason))
    process.on('unhandledRejection', onUnhandled)
    let calls = 0
    const worker = { concurrency: 2 }
    let warnings: string[] = []
    try {
      const run = await capturingWarnings(async () => {
        watchSessionConcurrency(worker, {
          async setGlobalConcurrency() {
            calls++
            throw new Error('redis refused')
          },
        })
        await until(() => calls === 1)
        await Bun.sleep(20)
        captured?.()
        await until(() => calls === 2)
        await Bun.sleep(20)
      })
      warnings = run.warnings
    } finally {
      globalThis.setInterval = realSetInterval
      process.off('unhandledRejection', onUnhandled)
    }
    facts.watchRejects = { calls, unhandled, warnings }
  }

  await clearRow()
  facts.finalGet = { get: await getSystemSettings() }
}

async function main() {
  if (MODE === 'envDefault') await envDefaultScenarios()
  else await fullScenarios()
  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
