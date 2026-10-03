// Runs every GET/POST /whats-new scenario once, against the throwaway cluster
// its parent (whats-new-db.test.ts) started, and prints what happened as
// JSON — the same child/parent split system-settings-db-child.ts uses, for
// the identical reason: `@/env` parses process.env once, at first import, so
// DATABASE_URL has to be right from this process's very first line.
//
// BullMQ, ioredis and the Claude Agent SDK are faked exactly as
// system-settings-db-child.ts fakes them: createApp() reaches all three
// through other feature routers mounted alongside whatsNewRouter, and
// nothing here is testing any of them.
//
// src/mark-install.ts (a *separate* process, by its own hard constraint — see
// its header) is exercised from the parent test file directly, not from this
// child.

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
const { logger } = await import('@/lib/logger')
const { createApp } = await import('@/app')

const facts: Record<string, unknown> = {}

// The whole app, as index.ts serves it — so the 400 envelope below is the one
// a real client gets, not one rebuilt for the test.
const app = createApp()

async function request(method: 'GET' | 'POST', path: string, body?: string) {
  const res = await app.request(path, {
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

async function clearAll() {
  await db.execute(
    sql`delete from system_settings where key in ('last_install', 'whats_new_dismissed')`,
  )
}

/** Writes a raw jsonb literal for one key, bypassing the write path's own
 * validation — the only way to get a malformed row into the table at all. */
async function writeRaw(key: string, jsonLiteral: string) {
  await db.execute(
    sql`insert into system_settings (key, value) values (${key}, ${jsonLiteral}::jsonb)
        on conflict (key) do update set value = excluded.value`,
  )
}

async function storedValue(key: string): Promise<unknown> {
  const rows = (await db.execute(
    sql`select value from system_settings where key = ${key}`,
  )) as unknown as { value: unknown }[]
  return rows.length === 0 ? null : rows[0]?.value
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

async function main() {
  // --- 1. no install at all -------------------------------------------------
  await clearAll()
  facts.noInstall = await request('GET', '/api/whats-new')

  // --- 2. an install, never dismissed --------------------------------------
  await clearAll()
  await writeRaw('last_install', JSON.stringify({ version: '1.9.0', installedAt: '2026-01-01T00:00:00.000Z' }))
  facts.installNoDismissal = await request('GET', '/api/whats-new')

  // --- 3. dismiss it, matching installedAt ----------------------------------
  const dismissRes = await request(
    'POST',
    '/api/whats-new/dismiss',
    JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z' }),
  )
  facts.dismissMatching = {
    post: dismissRes,
    stored: await storedValue('whats_new_dismissed'),
    get: await request('GET', '/api/whats-new'),
  }

  // --- 4. a newer install after a dismissal re-opens the screen -------------
  await writeRaw(
    'last_install',
    JSON.stringify({ version: '1.9.1', installedAt: '2026-02-01T00:00:00.000Z' }),
  )
  facts.newInstallAfterDismissal = await request('GET', '/api/whats-new')

  // --- 5. malformed last_install is treated as absent -----------------------
  await clearAll()
  for (const [name, literal] of Object.entries({
    missingVersion: JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z' }),
    notAnObject: '"1.9.0"',
    badDatetime: JSON.stringify({ version: '1.9.0', installedAt: 'not-a-date' }),
  })) {
    await clearAll()
    await writeRaw('last_install', literal)
    const { result, warnings } = await capturingWarnings(() => request('GET', '/api/whats-new'))
    facts[`malformedInstall_${name}`] = { get: result, warnings }
  }

  // --- 6. a valid install plus a malformed dismissal is still pending ------
  await clearAll()
  await writeRaw('last_install', JSON.stringify({ version: '1.9.0', installedAt: '2026-01-01T00:00:00.000Z' }))
  await writeRaw('whats_new_dismissed', '{"installedAt": 12345}')
  {
    const { result, warnings } = await capturingWarnings(() => request('GET', '/api/whats-new'))
    facts.malformedDismissal = { get: result, warnings }
  }

  // --- 7. POST validation: no body at all -----------------------------------
  await clearAll()
  await writeRaw('last_install', JSON.stringify({ version: '1.9.0', installedAt: '2026-01-01T00:00:00.000Z' }))
  await writeRaw('whats_new_dismissed', JSON.stringify({ installedAt: 'untouched' }))
  {
    const res = await app.request('/api/whats-new/dismiss', { method: 'POST' })
    facts.noBody = {
      status: res.status,
      body: await res.text(),
      storedAfter: await storedValue('whats_new_dismissed'),
    }
  }

  // --- 8. POST validation: not a datetime -----------------------------------
  {
    const res = await request(
      'POST',
      '/api/whats-new/dismiss',
      JSON.stringify({ installedAt: 'not-a-date' }),
    )
    facts.badDatetime = { ...res, storedAfter: await storedValue('whats_new_dismissed') }
  }

  // --- 9. POST validation: missing field, empty body, wrong type -----------
  const invalid: Record<string, unknown> = {}
  for (const [name, body] of Object.entries({
    empty: '{}',
    wrongType: JSON.stringify({ installedAt: 12345 }),
    bodyIsArray: '[]',
    bodyIsNull: 'null',
  })) {
    const res = await request('POST', '/api/whats-new/dismiss', body)
    invalid[name] = { status: res.status, body: res.body, storedAfter: await storedValue('whats_new_dismissed') }
  }
  facts.invalid = invalid

  // --- 10. a dismiss is stored as-is even when it no longer matches the ----
  //     current last_install (a dismiss racing a newer install).
  await clearAll()
  await writeRaw('last_install', JSON.stringify({ version: '2.0.0', installedAt: '2026-03-01T00:00:00.000Z' }))
  const racingDismiss = await request(
    'POST',
    '/api/whats-new/dismiss',
    JSON.stringify({ installedAt: '2026-02-15T00:00:00.000Z' }),
  )
  facts.racingDismiss = {
    post: racingDismiss,
    stored: await storedValue('whats_new_dismissed'),
    // Still pending: the dismissal names an install that is not the current one.
    get: await request('GET', '/api/whats-new'),
  }

  // --- 11. a second valid dismiss replaces the first, not adds a row -------
  await clearAll()
  await writeRaw('last_install', JSON.stringify({ version: '2.0.0', installedAt: '2026-03-01T00:00:00.000Z' }))
  await request('POST', '/api/whats-new/dismiss', JSON.stringify({ installedAt: 'bogus-first' }))
  await request(
    'POST',
    '/api/whats-new/dismiss',
    JSON.stringify({ installedAt: '2026-03-01T00:00:00.000Z' }),
  )
  const rowCount = (await db.execute(
    sql`select count(*)::int as n from system_settings where key = 'whats_new_dismissed'`,
  )) as unknown as { n: number }[]
  facts.overwrite = {
    stored: await storedValue('whats_new_dismissed'),
    rows: rowCount[0]?.n,
    get: await request('GET', '/api/whats-new'),
  }

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
