// getEditorStatus/requestEditorStart/requestEditorStop (features/editor/
// service.ts) — every gate the design doc's own "Start route order" and
// stop/status contracts describe, exercised against the REAL operations.ts
// (a fake ioredis underneath it, like docker-operations.test.ts) so the lock
// itself is real, not reimplemented by this file.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { AppError, notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-editor-service-'))

// Every real module this file needs is imported and snapshotted BEFORE
// 'ioredis' is mocked below — each of projects/service.ts, sessions/service.ts
// and queue/index.ts itself constructs BullMQ Queue objects at import time
// (against whatever 'ioredis' export is live then), and BullMQ's own
// RedisConnection requires a real EventEmitter-shaped client to do that — a
// plain object substitute (the FakeRedis class below) crashes it outright.
// Importing for real now, while 'ioredis' is still genuine, and only
// replacing the *specifier* afterwards (via mock.module, never re-executing
// these modules) is what avoids that crash while still letting later imports
// of these same specifiers resolve to the stand-ins defined below.
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
const realQueue = { ...(await import(`${B}/queue/index.ts`)) } as Record<string, unknown>
const realContainer = { ...(await import(`${B}/features/editor/container.ts`)) } as Record<
  string,
  unknown
>

// --- ioredis: a fake real enough for operations.ts's own lock + record ops ---
// Identical shape to docker-operations.test.ts's own FakeRedis (get/set/eval
// for the lock, rpush/ltrim/expire for the oplog) — this is what makes the
// lock behaviour below (claim, idempotent start, stop-while-starting) real
// rather than reimplemented. Only features/editor/operations.ts's own,
// not-yet-imported `redis()` singleton ever actually talks to this: every
// already-constructed Queue above keeps the real ioredis client it was built
// with, which just retries a connection nobody answers, harmlessly (the same
// background noise the rest of this test suite already tolerates).
let stored: Record<string, string> = {}
class FakeRedis {
  on() {
    return this
  }
  async get(key: string) {
    return stored[key] ?? null
  }
  async set(...args: unknown[]) {
    const [key, value] = args as [string, string]
    if (args.includes('NX') && Object.hasOwn(stored, key)) return null
    stored[key] = value
    return 'OK'
  }
  async eval(...args: unknown[]) {
    const [, , key, value] = args as [string, number, string, string]
    if (stored[key] === value) {
      delete stored[key]
      return 1
    }
    return 0
  }
  async rpush() {
    return 1
  }
  async ltrim() {
    return 'OK'
  }
  async expire() {
    return 1
  }
  async lrange() {
    return []
  }
}
const realIoredis = { ...(await import('ioredis')) } as Record<string, unknown>
mock.module('ioredis', () => ({ default: FakeRedis, Redis: FakeRedis }))

// --- env: PROJECTS_DIR to a real temp dir, flags editable per test ----------
const testEnv = {
  ...realEnv.env,
  PROJECTS_DIR: TEST_PROJECTS_DIR,
  DOCKER_ENABLED: true,
  EDITOR_ENABLED: true,
  EDITOR_MAX_RUNNING: 2,
  EDITOR_START_TIMEOUT_MS: 600_000,
  EDITOR_IMAGE: 'codercom/code-server:4.138.0',
  EDITOR_IDLE_TIMEOUT_SECONDS: 1800,
}
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  // A getter, not a static value: requestEditorStart/Stop read this export
  // directly (not env.DOCKER_ENABLED/EDITOR_ENABLED), so it has to recompute
  // from the same mutable testEnv every access, not freeze it at mock time.
  get editorEnabled() {
    return Boolean(testEnv.DOCKER_ENABLED) && Boolean(testEnv.EDITOR_ENABLED)
  },
}))

// --- projects/sessions: just enough for resolveDockerScope ------------------
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const SLUG = 'demo'
const WORKTREE = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', SESSION_ID)

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

// --- queue: capture enqueueEditorStart, forward everything else -------------
let enqueued: Record<string, unknown>[] = []
let enqueueShouldFail = false
mock.module(`${B}/queue/index.ts`, () => ({
  ...realQueue,
  enqueueEditorStart: async (job: Record<string, unknown>) => {
    if (enqueueShouldFail) throw new Error('queue unreachable')
    enqueued.push(job)
    return {}
  },
}))

// --- container.ts: only probeEditorHealthz is stubbed (no real socket) -----
// Every other export (inspectEditorContainer, countRunningEditorContainers,
// removeEditorContainer, ...) is the real implementation, driven entirely by
// the fake DockerCli each test passes explicitly into service.ts's own `cli`
// parameter — the same seam every docker-touching function in this codebase
// already exposes.
let healthy = true
mock.module(`${B}/features/editor/container.ts`, () => ({
  ...realContainer,
  probeEditorHealthz: async () => healthy,
}))

const { getEditorStatus, requestEditorStart, requestEditorStop } = await import(
  `${B}/features/editor/service.ts`
)
const { MISSING_BINARY_EXIT_CODE } = await import(`${B}/features/docker/cli.ts`)

afterAll(async () => {
  mock.module('ioredis', () => realIoredis)
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  mock.module(`${B}/queue/index.ts`, () => realQueue)
  mock.module(`${B}/features/editor/container.ts`, () => realContainer)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

// --- a minimal, controllable docker CLI --------------------------------------

type DaemonMode = 'ok' | 'down' | 'missing'

function fakeCli(opts: {
  daemon?: DaemonMode
  containers?: Map<string, { status: string }>
}) {
  const daemon = opts.daemon ?? 'ok'
  const containers = opts.containers ?? new Map<string, { status: string }>()
  return {
    async run(args: string[]) {
      if (args[0] === 'version') {
        if (daemon === 'missing') {
          return { ok: false, stdout: '', stderr: 'ENOENT', exitCode: MISSING_BINARY_EXIT_CODE }
        }
        if (daemon === 'down') {
          return {
            ok: false,
            stdout: JSON.stringify({ Client: { Version: '24.0.0' } }),
            stderr: 'Cannot connect to the Docker daemon',
            exitCode: 1,
          }
        }
        return {
          ok: true,
          stdout: JSON.stringify({ Client: { Version: '24.0.0' }, Server: { Version: '24.0.0' } }),
          stderr: '',
          exitCode: 0,
        }
      }
      if (args[0] === 'ps') {
        return { ok: true, stdout: [...containers.keys()].join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'inspect') {
        const ids = args.slice(4)
        const lines = ids
          .map((id) => {
            const c = containers.get(id)
            if (!c) return null
            return JSON.stringify({
              Id: id,
              Name: `/${id}`,
              Config: { Labels: {} },
              State: { Status: c.status },
            })
          })
          .filter((l): l is string => l !== null)
        return {
          ok: lines.length > 0,
          stdout: lines.join('\n'),
          stderr: lines.length > 0 ? '' : 'Error: No such container',
          exitCode: lines.length > 0 ? 0 : 1,
        }
      }
      if (args[0] === 'rm') {
        const name = args[2] as string
        if (containers.has(name)) {
          containers.delete(name)
          return { ok: true, stdout: name, stderr: '', exitCode: 0 }
        }
        return { ok: false, stdout: '', stderr: `Error: No such container: ${name}`, exitCode: 1 }
      }
      return { ok: true, stdout: '', stderr: '', exitCode: 0 }
    },
    stream() {
      throw new Error('not used in this test')
    },
  }
}

async function status(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 200, message: '' }
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, message: error.message }
    throw error
  }
}

beforeEach(async () => {
  stored = {}
  enqueued = []
  enqueueShouldFail = false
  healthy = true
  testEnv.DOCKER_ENABLED = true
  testEnv.EDITOR_ENABLED = true
  testEnv.EDITOR_MAX_RUNNING = 2
  sessionRow = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: WORKTREE }
  await rm(WORKTREE, { recursive: true, force: true })
  await mkdir(WORKTREE, { recursive: true })
})

afterEach(async () => {
  await rm(WORKTREE, { recursive: true, force: true })
})

// --- 403 (either flag off) and enabled:false on GET --------------------------
//
// Deliberately NOT exercised in this file: `editorEnabled` (env.ts) is
// computed once, at module load, from `process.env` — exactly like the real
// process boots it, and exactly why this file's own `env.ts` mock cannot
// toggle it mid-run (a getter was tried; Bun's mock.module snapshots a
// mocked module's exports once, at first import, same as the real one always
// has). See editor-service-disabled.test.ts (a fixed, disabled-from-the-start
// mock) and editor-env.test.ts (the AND itself, via subprocess, across all
// four DOCKER_ENABLED/EDITOR_ENABLED combinations) for that coverage instead.

// --- 503: docker CLI/daemon unavailable --------------------------------------

test('a missing docker binary is a 503 for start', async () => {
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ daemon: 'missing' })))
  expect(result.status).toBe(503)
})

test('a down daemon is a 503 for start', async () => {
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ daemon: 'down' })))
  expect(result.status).toBe(503)
})

test('a down daemon is a 503 for stop too', async () => {
  const result = await status(requestEditorStop(PROJECT_ID, SESSION_ID, fakeCli({ daemon: 'down' })))
  expect(result.status).toBe(503)
})

// --- 400/404/409 from resolveDockerScope -------------------------------------

test('an unknown project is a 404', async () => {
  const result = await status(requestEditorStart('99999999-9999-4999-8999-999999999999', SESSION_ID, fakeCli({})))
  expect(result.status).toBe(404)
})

test('an unknown session is a 404', async () => {
  sessionRow = undefined
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({})))
  expect(result.status).toBe(404)
})

test('a session sharing the checkout (no worktree) is a 400', async () => {
  sessionRow = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: null }
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({})))
  expect(result.status).toBe(400)
})

test('a worktree missing from disk is a 409', async () => {
  await rm(WORKTREE, { recursive: true, force: true })
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({})))
  expect(result.status).toBe(409)
})

// --- cap 409 ------------------------------------------------------------------

test('EDITOR_MAX_RUNNING reached is a 409, and releases the lock it just claimed', async () => {
  // Only an OTHER session's container is on the box here — this doubles as
  // the "cap reached by other sessions alone" case: nothing of this
  // session's own is around to (wrongly) get excluded from the count.
  testEnv.EDITOR_MAX_RUNNING = 1
  const containers = new Map([['agentoo_editor-other_s-abc123456789', { status: 'running' }]])
  const result = await status(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ containers })))
  expect(result.status).toBe(409)
  expect(result.message).toContain('cap')
  expect(enqueued).toHaveLength(0)

  // The lock was released on the cap failure, so a later start (once
  // capacity frees up) is not permanently blocked by this one's own lock.
  testEnv.EDITOR_MAX_RUNNING = 2
  const dto = await requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ containers: new Map() }))
  expect(dto.state).toBe('starting')
  expect(enqueued).toHaveLength(1)
})

test("at the cap, restarting this session's own unresponsive container is accepted, not a 409", async () => {
  // Mirrors the actual bug report: cap 2, this session's own editor is
  // running but not answering /healthz (so Step 4 does not short-circuit),
  // and one OTHER session's editor also holds a slot. Counting this
  // session's own container against its own restart would always land on
  // the cap here, even though the worker's own start job removes that exact
  // container before it ever runs the same check itself.
  testEnv.EDITOR_MAX_RUNNING = 2
  const ownName = 'agentoo_editor-demo_s-' + SESSION_ID.replace(/-/g, '').slice(0, 12)
  const containers = new Map([
    [ownName, { status: 'running' }],
    ['agentoo_editor-other_s-abc123456789', { status: 'running' }],
  ])
  healthy = false
  const dto = await requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ containers }))
  expect(dto.state).toBe('starting')
  expect(enqueued).toHaveLength(1)
})

// --- idempotent start: lock held => no second enqueue ------------------------

test('a second start while one is in flight returns the same status without enqueuing again', async () => {
  const cli = fakeCli({})
  const first = await requestEditorStart(PROJECT_ID, SESSION_ID, cli)
  expect(first.state).toBe('starting')
  expect(enqueued).toHaveLength(1)

  const second = await requestEditorStart(PROJECT_ID, SESSION_ID, cli)
  expect(second.state).toBe('starting')
  expect(enqueued).toHaveLength(1) // still just the one job
})

test('a running and healthy container short-circuits start with no lock and no enqueue', async () => {
  const name = 'agentoo_editor-demo_s-' + SESSION_ID.replace(/-/g, '').slice(0, 12)
  const containers = new Map([[name, { status: 'running' }]])
  healthy = true
  const dto = await requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({ containers }))
  expect(dto.state).toBe('running')
  expect(enqueued).toHaveLength(0)
})

test('enqueue failure fails the operation and releases the lock', async () => {
  enqueueShouldFail = true
  await expect(requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({}))).rejects.toThrow(
    'queue unreachable',
  )
  // The lock must not be left held forever by a start that never actually queued.
  enqueueShouldFail = false
  const dto = await requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({}))
  expect(dto.state).toBe('starting')
  expect(enqueued).toHaveLength(1)
})

// --- stop: 409 while starting, 200 (idempotent) when absent ------------------

test('stop while a start holds the lock is a 409', async () => {
  await requestEditorStart(PROJECT_ID, SESSION_ID, fakeCli({}))
  const result = await status(requestEditorStop(PROJECT_ID, SESSION_ID, fakeCli({})))
  expect(result.status).toBe(409)
})

test('stop when no container exists at all is still 200, state stopped', async () => {
  const dto = await requestEditorStop(PROJECT_ID, SESSION_ID, fakeCli({}))
  expect(dto.state).toBe('stopped')
  expect(dto.container).toBeNull()
})

test('stop removes an existing container and reports stopped', async () => {
  const name = 'agentoo_editor-demo_s-' + SESSION_ID.replace(/-/g, '').slice(0, 12)
  const containers = new Map([[name, { status: 'running' }]])
  const dto = await requestEditorStop(PROJECT_ID, SESSION_ID, fakeCli({ containers }))
  expect(dto.state).toBe('stopped')
  expect(containers.has(name)).toBe(false)
})
