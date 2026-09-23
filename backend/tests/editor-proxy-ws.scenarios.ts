// See run-isolated.ts's own header for why this file only runs as its own
// `bun test` subprocess — same reasoning, and the same env/projects/sessions
// mocking recipe, as editor-proxy-http.scenarios.ts (its own header explains
// why). This file drives the WebSocket half of the proxy end to end: a real
// `Bun.serve` for the proxy itself (needed for `server.upgrade` to exist at
// all — see proxy.ts's own `c.env` lookup) and a real `Bun.serve({ unix })`
// websocket echo server standing in for code-server on the other end.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'
import { notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-editor-proxy-ws-'))

const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
  editorEnabled: boolean
}
const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) } as Record<
  string,
  unknown
>
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) } as Record<
  string,
  unknown
>

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const SLUG = 'demo'
const WORKTREE = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', SESSION_ID)

const testEnv = {
  ...realEnv.env,
  PROJECTS_DIR: TEST_PROJECTS_DIR,
  DOCKER_ENABLED: true,
  EDITOR_ENABLED: true,
}
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  editorEnabled: true, // fixed true — see editor-proxy-http.scenarios.ts's own note on why this can't toggle mid-file
}))

mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  getProject: async (id: string) => {
    if (id !== PROJECT_ID) throw notFound('Project')
    return { id: PROJECT_ID, slug: SLUG }
  },
}))

interface SessionRow {
  id: string
  projectId: string
  worktreePath: string | null
}
let sessionRow: SessionRow | undefined
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  getSessionLocation: async (id: string) => {
    if (!sessionRow || sessionRow.id !== id) throw notFound('Session')
    return sessionRow
  },
}))

const { editorProxyRouter, editorProxyPath, editorWebSocketHandler, resetEditorProxyScopeCacheForTests } =
  await import(`${B}/features/editor/proxy.ts`)
const { editorSocketPath, editorRuntimeDir } = await import(`${B}/lib/paths.ts`)

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

// --- the real proxy server ------------------------------------------------------

const testApp = new OpenAPIHono()
testApp.route('/api', editorProxyRouter)

const proxyServer = Bun.serve({ port: 0, fetch: testApp.fetch, websocket: editorWebSocketHandler })
const wsBase = `ws://127.0.0.1:${proxyServer.port}`
const ORIGIN = `http://127.0.0.1:${proxyServer.port}`
const BASE = editorProxyPath(PROJECT_ID, SESSION_ID).slice(0, -1)

afterAll(() => {
  proxyServer.stop(true)
})

// --- the fake upstream (a code-server stand-in), over the real unix socket ------

const SOCKET_PATH = editorSocketPath(SESSION_ID)
let upstreamHeadersSeen: Record<string, string> | undefined
let upstreamSawClose: { code: number; reason: string } | undefined

// Bun.serve({ unix }) below binds synchronously at module load, so the parent
// directory has to exist *before* that call runs — a `beforeAll` (which only
// runs once the test runner starts executing tests) is too late.
await mkdir(editorRuntimeDir(SESSION_ID), { recursive: true })

const upstreamServer = Bun.serve({
  unix: SOCKET_PATH,
  fetch(req, server) {
    upstreamHeadersSeen = req.headers.toJSON()
    const ok = server.upgrade(req, { data: {} })
    if (!ok) return new Response('expected a WebSocket upgrade', { status: 400 })
    return undefined
  },
  websocket: {
    open(ws) {
      ws.send('hello-from-upstream-open')
    },
    message(ws, message) {
      if (message === '__server_close__') {
        ws.close(1000, 'server-initiated')
        return
      }
      ws.send(message)
    },
    close(_ws, code, reason) {
      upstreamSawClose = { code, reason }
    },
  },
})

afterAll(() => {
  upstreamServer.stop(true)
})

beforeEach(async () => {
  resetEditorProxyScopeCacheForTests()
  upstreamHeadersSeen = undefined
  upstreamSawClose = undefined
  sessionRow = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: WORKTREE }
  await rm(WORKTREE, { recursive: true, force: true })
  await mkdir(WORKTREE, { recursive: true })
})

afterEach(async () => {
  await rm(WORKTREE, { recursive: true, force: true })
})

// --- small event-driven helpers ----------------------------------------------

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket error before open')), {
      once: true,
    })
  })
}

function onceMessage(ws: WebSocket): Promise<string | Buffer> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (event) => resolve(event.data as string | Buffer), {
      once: true,
    })
  })
}

function onceClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }), {
      once: true,
    })
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// --- tests ---------------------------------------------------------------------

test('a message the upstream sends immediately on open reaches the client, unlost', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: ORIGIN } })
  await onceOpen(client)
  const first = await onceMessage(client)
  expect(first).toBe('hello-from-upstream-open')
  client.close(1000, 'done')
  await onceClose(client)
})

test('text and binary frames round-trip byte for byte through the proxy', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: ORIGIN } })
  await onceOpen(client)
  await onceMessage(client) // discard the immediate hello

  client.send('plain-text-message')
  const textEcho = await onceMessage(client)
  expect(textEcho).toBe('plain-text-message')

  const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  client.send(bytes)
  const binEcho = await onceMessage(client)
  expect(Buffer.isBuffer(binEcho)).toBe(true)
  expect(new Uint8Array(binEcho as Buffer)).toEqual(bytes)

  client.close(1000, 'done')
  await onceClose(client)
})

test('a client-initiated close reaches the upstream', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: ORIGIN } })
  await onceOpen(client)
  await onceMessage(client) // discard the immediate hello

  client.close(1000, 'client-done')
  await onceClose(client)
  await waitUntil(() => upstreamSawClose !== undefined)
  expect(upstreamSawClose?.code).toBe(1000)
})

test('an upstream-initiated close reaches the client', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: ORIGIN } })
  await onceOpen(client)
  await onceMessage(client) // discard the immediate hello

  client.send('__server_close__')
  const closeInfo = await onceClose(client)
  expect(closeInfo.code).toBe(1000)
})

test('the upstream receives both Origin and X-Forwarded-Host over ws+unix', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: ORIGIN } })
  await onceOpen(client)
  await onceMessage(client) // discard the immediate hello
  expect(upstreamHeadersSeen?.origin).toBe(ORIGIN)
  expect(upstreamHeadersSeen?.['x-forwarded-host']).toBe(new URL(ORIGIN).host)
  client.close(1000, 'done')
  await onceClose(client)
})

test('an Origin mismatch is refused before the upgrade — a failed handshake, not an open socket', async () => {
  const client = new WebSocket(`${wsBase}${BASE}/`, { headers: { origin: 'http://evil-host:1' } })
  let openFired = false
  client.addEventListener('open', () => {
    openFired = true
  })
  const closeInfo = await onceClose(client).catch(() => undefined)
  expect(openFired).toBe(false)
  // Never reached the fake upstream at all — proof the 403 fired before any dial.
  expect(upstreamHeadersSeen).toBeUndefined()
  void closeInfo
})

test('the upstream being down is a 502, refused before the upgrade', async () => {
  const deadSessionId = '55555555-5555-4555-8555-555555555555'
  const deadWorktree = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', deadSessionId)
  await mkdir(deadWorktree, { recursive: true })
  sessionRow = { id: deadSessionId, projectId: PROJECT_ID, worktreePath: deadWorktree }
  const deadBase = editorProxyPath(PROJECT_ID, deadSessionId).slice(0, -1)

  const client = new WebSocket(`${wsBase}${deadBase}/`, { headers: { origin: ORIGIN } })
  let openFired = false
  client.addEventListener('open', () => {
    openFired = true
  })
  await onceClose(client).catch(() => undefined)
  expect(openFired).toBe(false)
  await rm(deadWorktree, { recursive: true, force: true })
})
