// app.ts's onError only ever mapped AppError to its own status; anything
// else — including an HTTPException Hono itself throws, before any route
// handler or openApiValidationHook runs, for a body that failed to parse as
// JSON — fell through to a bare 500 `{ error: 'Internal server error' }`.
// That is a real contract break: PATCH /api/system/settings documents a 400
// for "a value failed validation, or the body named no key at all" (see
// features/system/routes.ts), and a malformed body is exactly the same kind
// of client mistake, not a server fault.
//
// whats-new-verify.test.ts (and its own 'malformedJson'/'emptyStringBody'
// cases) pins this for POST /whats-new/dismiss; this file pins the same fix
// at the app level, against a route in a different feature entirely, so the
// mapping is shown to live in app.ts's onError rather than having been
// bolted onto one router.

import { afterAll, expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

// None of these tests ever reach a queue or the SDK — the malformed body
// never gets past Hono's own JSON parsing — but createApp() wires up every
// feature router regardless, and several of them import queue/index.ts
// (bullmq/ioredis) at module scope, which would otherwise spend this file's
// run watching ioredis retry a connection to a port nothing is listening on.
// Restored in afterAll: mock.module is process-global (see
// system-usage-verify.test.ts's identical note on its own SDK mock), and
// this is a plain *.test.ts file bun loads into the one shared test
// process — unlike the *-db-child.ts files that fake these same two modules
// from inside their own short-lived spawned process, where nothing needs
// restoring because the process just exits.
const realBullmq = { ...(await import('bullmq')) } as Record<string, unknown>
const realIoredis = { ...(await import('ioredis')) } as Record<string, unknown>

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

afterAll(() => {
  mock.module('bullmq', () => realBullmq)
  mock.module('ioredis', () => realIoredis)
})

const { createApp } = await import(`${B}/app.ts`)
const app = createApp()

async function patchSettings(body: string, contentType: string | null = 'application/json') {
  const headers: Record<string, string> = {}
  if (contentType) headers['content-type'] = contentType
  const res = await app.request('/api/system/settings', { method: 'PATCH', body, headers })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed as Record<string, unknown> }
}

function expectEnvelope400(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status).toBe(400)
  expect(typeof res.body).toBe('object')
  expect(typeof res.body.error).toBe('string')
  expect((res.body.error as string).length).toBeGreaterThan(0)
  for (const key of Object.keys(res.body)) expect(['error', 'issues', 'recoveryCommands']).toContain(key)
}

test('PATCH /api/system/settings with malformed JSON is a 400 in the standard envelope, not a 500', async () => {
  expectEnvelope400(await patchSettings('{"maxConcurrentSessions": '))
})

test('PATCH /api/system/settings with an empty string body is a 400 in the standard envelope, not a 500', async () => {
  expectEnvelope400(await patchSettings(''))
})

test('the malformed-JSON 400 is never byte-identical to the generic 500 body', async () => {
  const res = await patchSettings('{"maxConcurrentSessions": ')
  expect(res.body).not.toEqual({ error: 'Internal server error' })
})
