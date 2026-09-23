// See run-isolated.ts's own header for why this file only runs as its own
// `bun test` subprocess rather than as part of the shared `tests/` run: it
// mocks `@/env.ts`/`@/features/projects/service.ts`/`@/features/sessions/
// service.ts` wholesale, exactly like editor-service.scenarios.ts does for
// the identical reason (driving the REAL `resolveDockerScope` against
// controlled fixtures, with no real Postgres in play).
//
// The proxy itself is exercised through a small parent `OpenAPIHono` that
// mounts `editorProxyRouter` at `/api`, the same discipline
// api-error-envelope.test.ts already uses for `sessionsRouter` — booting the
// whole `createApp()` would pull in every other feature's own real
// dependencies for nothing this file is about, and (more to the point) the
// proxy's own prefix-stripping logic is built from `editorProxyPath()`,
// which always returns an `/api/...` path — so the mount has to actually be
// there for that stripping to exercise the real code path rather than a
// stand-in for it.

import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'
import { notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-editor-proxy-http-'))

// Imported for real BEFORE anything is mocked — see editor-service.scenarios.ts's
// own header for why: these modules construct real BullMQ Queue objects at
// import time, against whatever 'ioredis' export is live then.
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
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999'
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
  // A getter, not a static value — the proxy reads this export directly on
  // every request, so it has to recompute from the same mutable testEnv on
  // every access, not freeze it at mock time (same reasoning
  // editor-service.scenarios.ts's own identical getter documents).
  get editorEnabled() {
    return Boolean(testEnv.DOCKER_ENABLED) && Boolean(testEnv.EDITOR_ENABLED)
  },
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

const { editorProxyRouter, editorProxyPath, resetEditorProxyScopeCacheForTests } = await import(
  `${B}/features/editor/proxy.ts`
)
const { editorSocketPath, editorRuntimeDir } = await import(`${B}/lib/paths.ts`)

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

// --- the parent app + a fake upstream over the real unix socket path --------

const testApp = new OpenAPIHono()
testApp.route('/api', editorProxyRouter)

const BASE = editorProxyPath(PROJECT_ID, SESSION_ID).slice(0, -1) // no trailing '/'
const SOCKET_PATH = editorSocketPath(SESSION_ID)
const ECHO_BODY = 'x'.repeat(64)

function fakeUpstreamFetch(req: Request): Response {
  const url = new URL(req.url)
  if (url.pathname === '/redirect') {
    return new Response(null, { status: 302, headers: { Location: './relative?x=1' } })
  }
  if (url.pathname === '/gz') {
    const body = gzipSync(Buffer.from(ECHO_BODY))
    return new Response(body, {
      headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' },
    })
  }
  return Response.json({
    method: req.method,
    path: url.pathname,
    search: url.search,
    headers: req.headers.toJSON(),
  })
}

let upstream: ReturnType<typeof Bun.serve> | undefined

beforeAll(async () => {
  await mkdir(editorRuntimeDir(SESSION_ID), { recursive: true })
  upstream = Bun.serve({ unix: SOCKET_PATH, fetch: fakeUpstreamFetch })
})

afterAll(() => {
  upstream?.stop(true)
})

beforeEach(async () => {
  resetEditorProxyScopeCacheForTests()
  testEnv.DOCKER_ENABLED = true
  testEnv.EDITOR_ENABLED = true
  sessionRow = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: WORKTREE }
  await rm(WORKTREE, { recursive: true, force: true })
  await mkdir(WORKTREE, { recursive: true })
})

afterEach(async () => {
  await rm(WORKTREE, { recursive: true, force: true })
})

function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('host')) headers.set('host', 'myhost:3000')
  return testApp.request(path, { ...init, headers })
}

// --- prefix stripping + raw-path encoding preserved --------------------------

test('the raw path (percent-encoding intact) and query reach the upstream unchanged', async () => {
  const res = await req(`${BASE}/foo%2Fbar?x=1`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.path).toBe('/foo%2Fbar')
  expect(body.search).toBe('?x=1')
})

// --- 308 redirect, query kept -------------------------------------------------

test('the bare proxy path 308s to the trailing-slash form, keeping the query', async () => {
  const res = await req(`${BASE}?x=1&y=2`, { redirect: 'manual' })
  expect(res.status).toBe(308)
  expect(res.headers.get('location')).toBe(`${BASE}/?x=1&y=2`)
})

// --- a 3xx is passed through, relative Location untouched --------------------

test('a relative Location from the upstream is passed through byte for byte', async () => {
  const res = await req(`${BASE}/redirect`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('./relative?x=1')
})

// --- gzip bytes + content-encoding intact -------------------------------------

test('gzip content-encoding and the compressed bytes pass through intact', async () => {
  const res = await req(`${BASE}/gz`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-encoding')).toBe('gzip')
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect(gunzipSync(bytes).toString()).toBe(ECHO_BODY)
})

// --- x-forwarded-host set, hop-by-hop dropped ---------------------------------

test('x-forwarded-host/proto are set and hop-by-hop request headers are dropped', async () => {
  const res = await req(`${BASE}/echo`, {
    headers: { host: 'myhost:3000', connection: 'close', 'keep-alive': 'timeout=5' },
  })
  const body = await res.json()
  expect(body.headers['x-forwarded-host']).toBe('myhost:3000')
  expect(body.headers['x-forwarded-proto']).toBe('http')
  expect(body.headers.connection).toBeUndefined()
  expect(body.headers['keep-alive']).toBeUndefined()
  expect(body.headers.host).toBe('localhost') // Bun's own fetch sets this for the unix dial
})

// --- 502 when the socket is absent --------------------------------------------

test('a session with no socket file on disk is a 502, not a hang', async () => {
  const deadSessionId = '44444444-4444-4444-8444-444444444444'
  sessionRow = { id: deadSessionId, projectId: PROJECT_ID, worktreePath: join(TEST_PROJECTS_DIR, SLUG, 'worktrees', deadSessionId) }
  await mkdir(sessionRow.worktreePath as string, { recursive: true })
  const deadBase = editorProxyPath(PROJECT_ID, deadSessionId).slice(0, -1)
  const res = await req(`${deadBase}/anything`)
  expect(res.status).toBe(502)
})

// --- 403 when disabled ---------------------------------------------------------
//
// Deliberately NOT exercised in this file: `editorEnabled` (env.ts) is
// computed once, at module load, from `process.env` — exactly why this
// file's own env.ts mock cannot toggle it mid-run (a getter was tried; Bun's
// mock.module snapshots a mocked module's exports once, at first import,
// same as the real one always has — see editor-service.scenarios.ts's own,
// identical note). See editor-proxy-disabled.test.ts (a fixed,
// disabled-from-the-start mock) for that coverage instead.

// --- origin check on non-GET/HEAD ---------------------------------------------

test('a mismatched Origin on a POST is a 403, even same host different port', async () => {
  const res = await req(`${BASE}/echo`, {
    method: 'POST',
    headers: { host: 'myhost:3000', origin: 'http://myhost:3001' },
  })
  expect(res.status).toBe(403)
})

test('a matching Origin on a POST is forwarded, body included', async () => {
  const res = await req(`${BASE}/echo`, {
    method: 'POST',
    headers: { host: 'myhost:3000', origin: 'http://myhost:3000', 'content-type': 'text/plain' },
    body: 'hello',
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.method).toBe('POST')
})

test('a GET carries no Origin requirement at all', async () => {
  const res = await req(`${BASE}/echo`, { headers: { host: 'myhost:3000' } })
  expect(res.status).toBe(200)
})

// --- scope errors: 404 cross-project, 400 non-UUID ----------------------------

test('a session that belongs to a different project is a 404', async () => {
  const otherBase = editorProxyPath(OTHER_PROJECT_ID, SESSION_ID).slice(0, -1)
  const res = await req(`${otherBase}/echo`)
  expect(res.status).toBe(404)
})

test('a non-UUID project id is a 400 before any lookup', async () => {
  const res = await req(`/api/projects/not-a-uuid/sessions/${SESSION_ID}/editor/proxy/echo`)
  expect(res.status).toBe(400)
})

test('a non-UUID session id is a 400 before any lookup', async () => {
  const res = await req(`/api/projects/${PROJECT_ID}/sessions/not-a-uuid/editor/proxy/echo`)
  expect(res.status).toBe(400)
})
