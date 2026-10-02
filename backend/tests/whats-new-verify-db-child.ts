// Child for whats-new-verify.test.ts: runs the gap scenarios the first
// whats-new suite does not, against the throwaway cluster its parent started,
// and prints what happened as JSON. Same split, and same fakes, as
// whats-new-db-child.ts — `@/env` parses process.env once, at first import.
//
// One scenario here (realScriptFlow) drives the real `bun run mark-install`
// as a separate process with only PATH/HOME/DATABASE_URL in its environment,
// interleaved with real HTTP calls against createApp(), so the "a re-install
// re-opens the screen" behaviour is shown end to end rather than by a direct
// DB write standing in for the script.

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
const { VERSION } = await import('@/lib/version')

const BACKEND = new URL('..', import.meta.url).pathname
const facts: Record<string, unknown> = {}
const app = createApp()

type Res = { status: number; body: unknown }

async function send(
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  contentType: string | null = 'application/json',
): Promise<Res> {
  const headers: Record<string, string> = {}
  if (body !== undefined && contentType) headers['content-type'] = contentType
  const res = await app.request(path, {
    method,
    ...(body !== undefined && { body }),
    headers,
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed }
}

const get = () => send('GET', '/api/whats-new')
const dismiss = (body: string, contentType?: string | null) =>
  send('POST', '/api/whats-new/dismiss', body, contentType)

async function clearWhatsNew() {
  await db.execute(
    sql`delete from system_settings where key in ('last_install', 'whats_new_dismissed')`,
  )
}

async function writeRaw(key: string, jsonLiteral: string) {
  await db.execute(
    sql`insert into system_settings (key, value) values (${key}, ${jsonLiteral}::jsonb)
        on conflict (key) do update set value = excluded.value`,
  )
}

async function stored(key: string): Promise<unknown> {
  const rows = (await db.execute(
    sql`select value from system_settings where key = ${key}`,
  )) as unknown as { value: unknown }[]
  return rows.length === 0 ? null : rows[0]?.value
}

async function rowCount(): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as n from system_settings`,
  )) as unknown as { n: number }[]
  return rows[0]?.n ?? -1
}

async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
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

/** The real script, the way the installer runs it: own process, PATH/HOME/DATABASE_URL only. */
async function markInstall(): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'run', 'mark-install'], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

const INSTALL_A = { version: '1.9.0', installedAt: '2026-01-01T00:00:00.000Z' }

async function main() {
  facts.version = VERSION

  // --- fresh DB: the table has no rows at all -------------------------------
  await db.execute(sql`delete from system_settings`)
  facts.freshEmpty = { rowsBefore: await rowCount(), get: await get(), rowsAfter: await rowCount() }

  // --- a dismissal row but no install row ------------------------------------
  await clearWhatsNew()
  await writeRaw('whats_new_dismissed', JSON.stringify({ installedAt: INSTALL_A.installedAt }))
  facts.dismissedNoInstall = await get()

  // --- the real script, end to end ------------------------------------------
  await clearWhatsNew()
  {
    const first = await markInstall()
    const afterFirst = await get()
    const storedFirst = await stored('last_install')
    const firstAt = (afterFirst.body as { installedAt?: string }).installedAt ?? ''
    const dismissRes = await dismiss(JSON.stringify({ installedAt: firstAt }))
    const afterDismiss = await get()
    await Bun.sleep(15) // a distinct millisecond for the second toISOString()
    const second = await markInstall()
    const afterSecond = await get()
    facts.realScriptFlow = {
      first,
      afterFirst,
      storedFirst,
      dismissRes,
      afterDismiss,
      second,
      afterSecond,
      dismissedAfterSecond: await stored('whats_new_dismissed'),
    }
  }

  // --- dismiss naming a different (valid) install ----------------------------
  await clearWhatsNew()
  await writeRaw('last_install', JSON.stringify(INSTALL_A))
  {
    const post = await dismiss(JSON.stringify({ installedAt: '2025-12-01T00:00:00.000Z' }))
    facts.nonMatchingDismiss = { post, stored: await stored('whats_new_dismissed'), get: await get() }
  }

  // --- extra keys in the body -----------------------------------------------
  await clearWhatsNew()
  await writeRaw('last_install', JSON.stringify(INSTALL_A))
  {
    const post = await dismiss(
      JSON.stringify({ installedAt: INSTALL_A.installedAt, pending: true, version: 'x', evil: { a: 1 } }),
    )
    facts.extraKeys = { post, stored: await stored('whats_new_dismissed') }
  }

  // --- same instant, different spelling --------------------------------------
  const spellings: Record<string, string> = {
    noMillis: '2026-01-01T00:00:00Z',
    plusOffset: '2026-01-01T02:00:00+02:00',
    zeroOffset: '2026-01-01T00:00:00.000+00:00',
  }
  const spelled: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(spellings)) {
    await clearWhatsNew()
    await writeRaw('last_install', JSON.stringify(INSTALL_A))
    const post = await dismiss(JSON.stringify({ installedAt: value }))
    spelled[name] = { post, stored: await stored('whats_new_dismissed'), get: await get() }
  }
  facts.spellings = spelled

  // --- transport-level bad requests -----------------------------------------
  const sentinel = JSON.stringify({ installedAt: 'untouched' })
  const transport: Record<string, unknown> = {}
  for (const [name, body, contentType] of [
    ['malformedJson', '{"installedAt": ', 'application/json'],
    ['emptyStringBody', '', 'application/json'],
    ['textPlainValid', JSON.stringify({ installedAt: INSTALL_A.installedAt }), 'text/plain'],
    ['noContentTypeValid', JSON.stringify({ installedAt: INSTALL_A.installedAt }), null],
    ['formEncoded', `installedAt=${encodeURIComponent(INSTALL_A.installedAt)}`, 'application/x-www-form-urlencoded'],
    ['emptyString', JSON.stringify({ installedAt: '' }), 'application/json'],
    ['nullValue', JSON.stringify({ installedAt: null }), 'application/json'],
    ['dateOnly', JSON.stringify({ installedAt: '2026-01-01' }), 'application/json'],
    ['bodyIsString', JSON.stringify(INSTALL_A.installedAt), 'application/json'],
  ] as const) {
    await clearWhatsNew()
    await writeRaw('last_install', JSON.stringify(INSTALL_A))
    await writeRaw('whats_new_dismissed', sentinel)
    const res = await dismiss(body, contentType)
    transport[name] = { ...res, storedAfter: await stored('whats_new_dismissed') }
  }
  {
    await writeRaw('whats_new_dismissed', sentinel)
    const res = await app.request('/api/whats-new/dismiss', { method: 'POST' })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    transport.noBodyAtAll = { status: res.status, body: parsed, storedAfter: await stored('whats_new_dismissed') }
  }
  facts.transport = transport

  // --- malformed last_install rows beyond the first suite's three -----------
  const badInstalls: Record<string, string> = {
    dateOnly: JSON.stringify({ version: '1.9.0', installedAt: '2026-01-01' }),
    rfc2822: JSON.stringify({ version: '1.9.0', installedAt: 'Thu, 01 Jan 2026 00:00:00 GMT' }),
    epochNumber: JSON.stringify({ version: '1.9.0', installedAt: 1767225600000 }),
    emptyVersion: JSON.stringify({ version: '', installedAt: INSTALL_A.installedAt }),
    numericVersion: JSON.stringify({ version: 190, installedAt: INSTALL_A.installedAt }),
    jsonNull: 'null',
    array: JSON.stringify([INSTALL_A]),
  }
  const badInstallFacts: Record<string, unknown> = {}
  for (const [name, literal] of Object.entries(badInstalls)) {
    await clearWhatsNew()
    await writeRaw('last_install', literal)
    // A dismissal for the same instant too, so "absent" can't be faked by a
    // pending computed off a half-parsed row.
    await writeRaw('whats_new_dismissed', JSON.stringify({ installedAt: INSTALL_A.installedAt }))
    const { result, warnings } = await capturingWarnings(get)
    badInstallFacts[name] = { get: result, warnings }
  }
  facts.badInstalls = badInstallFacts

  // --- malformed whats_new_dismissed rows -----------------------------------
  const badDismissals: Record<string, string> = {
    array: JSON.stringify([{ installedAt: INSTALL_A.installedAt }]),
    bareString: JSON.stringify(INSTALL_A.installedAt),
    garbageDate: JSON.stringify({ installedAt: 'yesterday' }),
    jsonNull: 'null',
  }
  const badDismissalFacts: Record<string, unknown> = {}
  for (const [name, literal] of Object.entries(badDismissals)) {
    await clearWhatsNew()
    await writeRaw('last_install', JSON.stringify(INSTALL_A))
    await writeRaw('whats_new_dismissed', literal)
    const { result, warnings } = await capturingWarnings(get)
    badDismissalFacts[name] = { get: result, warnings }
  }
  facts.badDismissals = badDismissalFacts

  // --- a dismiss over a malformed dismissal row replaces it -----------------
  await clearWhatsNew()
  await writeRaw('last_install', JSON.stringify(INSTALL_A))
  await writeRaw('whats_new_dismissed', '"garbage"')
  facts.dismissOverMalformed = {
    post: await dismiss(JSON.stringify({ installedAt: INSTALL_A.installedAt })),
    stored: await stored('whats_new_dismissed'),
  }

  // --- health still reports the same VERSION, and the doc names the routes --
  facts.health = await send('GET', '/api/health')
  {
    // Only the parts under test: the whole document is large enough that
    // printing it before process.exit() can truncate stdout.
    const doc = await send('GET', '/api/openapi.json')
    const body = doc.body as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown> }
    }
    facts.openapi = {
      status: doc.status,
      body: {
        paths: {
          '/api/whats-new': body.paths['/api/whats-new'],
          '/api/whats-new/dismiss': body.paths['/api/whats-new/dismiss'],
        },
        components: { schemas: { WhatsNewState: body.components.schemas.WhatsNewState } },
      },
    }
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
