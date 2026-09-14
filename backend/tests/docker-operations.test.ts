// CLAIM 1 (the lock-key half) and Defect 5: exercises the REAL
// features/docker/operations.ts against a fake ioredis, not a reimplemented
// stand-in. Every other docker test file mocks this module wholesale and
// reimplements `dockerLockScope` (see each file's own comment on why they
// spread-and-restore instead of leaving it un-restored) -- which means
// nothing anywhere else actually runs the real key-building code the brief's
// "byte-identical repo-scope lock key" promise depends on, nor the real
// getOperation that stale, pre-worktree-scope Redis records still have to
// round-trip through.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

const calls: { op: string; args: unknown[] }[] = []
let stored: Record<string, string> = {}
class FakeRedis {
  on() {
    return this
  }
  async get(key: string) {
    calls.push({ op: 'get', args: [key] })
    return stored[key] ?? null
  }
  async set(...args: unknown[]) {
    calls.push({ op: 'set', args })
    const [key, value] = args as [string, string]
    if (args.includes('NX') && Object.hasOwn(stored, key)) return null
    stored[key] = value
    return 'OK'
  }
  async eval(...args: unknown[]) {
    calls.push({ op: 'eval', args })
    // Real enough for what this file exercises: releaseOperationLock's own
    // compare-and-delete script, called as eval(script, 1, key, value).
    const [, , key, value] = args as [string, number, string, string]
    if (stored[key] === value) {
      delete stored[key]
      return 1
    }
    return 0
  }
  async hset() {
    return 1
  }
  async expire() {
    return 1
  }
  async rpush() {
    return 1
  }
  async ltrim() {
    return 'OK'
  }
  async publish() {
    return 0
  }
  async zadd() {
    return 1
  }
  async lrange(key: string) {
    calls.push({ op: 'lrange', args: [key] })
    // Every operation id this fake was given a record for, insertion-ordered
    // -- enough for listOperationsForProject, which only ever LRANGEs the
    // project's own id list and then getOperation()s each entry.
    return Object.keys(stored)
      .filter((k) => k.startsWith('agentoo:docker:op:'))
      .map((k) => k.slice('agentoo:docker:op:'.length))
  }
}
const realIoredis = { ...(await import('ioredis')) } as Record<string, unknown>
mock.module('ioredis', () => ({ default: FakeRedis, Redis: FakeRedis }))

const ops = await import(`${B}/features/docker/operations.ts`)

afterAll(() => {
  mock.module('ioredis', () => realIoredis)
})

beforeEach(() => {
  calls.length = 0
  stored = {}
})

const PROJECT = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const OP = '33333333-3333-4333-8333-333333333333'

// --- CLAIM 1: the lock key ---------------------------------------------------

test('dockerLockScope at repo scope is the bare project id', () => {
  expect(ops.dockerLockScope(PROJECT, null)).toBe(PROJECT)
})

test('the repo-scope lock key is exactly agentoo:docker:lock:<projectId>, no suffix', async () => {
  await ops.activeOperationForScope(ops.dockerLockScope(PROJECT, null))
  await ops.claimOperationLock(ops.dockerLockScope(PROJECT, null), OP, 1000)
  await ops.releaseOperationLock(ops.dockerLockScope(PROJECT, null), OP)

  expect(calls[0]).toEqual({ op: 'get', args: [`agentoo:docker:lock:${PROJECT}`] })
  expect(calls[1]).toEqual({
    op: 'set',
    args: [`agentoo:docker:lock:${PROJECT}`, OP, 'PX', 1000, 'NX'],
  })
  expect(calls[2]?.args?.[2]).toBe(`agentoo:docker:lock:${PROJECT}`)
})

test('a worktree scope uses a key nothing before this feature ever wrote', async () => {
  const scope = ops.dockerLockScope(PROJECT, SESSION)
  expect(scope).toBe(`${PROJECT}:s-${SESSION}`)
  await ops.activeOperationForScope(scope)
  expect(calls[0]).toEqual({ op: 'get', args: [`agentoo:docker:lock:${PROJECT}:s-${SESSION}`] })
  expect(calls[0]?.args?.[0]).not.toBe(`agentoo:docker:lock:${PROJECT}`)
})

test('the worktree lock key carries the FULL session id, not the 12-hex form', () => {
  expect(ops.dockerLockScope(PROJECT, SESSION)).toContain(SESSION)
})

test('claim then release actually round-trips through the real compare-and-delete script', async () => {
  const scope = ops.dockerLockScope(PROJECT, null)
  expect(await ops.claimOperationLock(scope, OP, 5000)).toBe(true)
  expect(await ops.activeOperationForScope(scope)).toBe(OP)
  // A second claim is refused: SET ... NX against a key that already exists.
  expect(await ops.claimOperationLock(scope, 'someone-else', 5000)).toBe(false)
  await ops.releaseOperationLock(scope, OP)
  expect(await ops.activeOperationForScope(scope)).toBeUndefined()
})

// --- Defect 5: a stale, pre-worktree-scope record must not violate the schema ----

test('getOperation defaults a missing sessionId to null, not undefined', async () => {
  // Exactly the shape createOperation wrote before this feature's worktree
  // scope existed: no `sessionId` key in the JSON at all.
  stored[`agentoo:docker:op:${OP}`] = JSON.stringify({
    id: OP,
    projectId: PROJECT,
    kind: 'up',
    services: [],
    status: 'succeeded',
    exitCode: 0,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:01.000Z',
  })
  const operation = await ops.getOperation(OP)
  // dockerOperationSchema requires sessionId (nullable, not optional) --
  // `'sessionId' in operation` must be true, and the value null, not merely
  // `operation.sessionId == null` (which an absent key already satisfies).
  expect(operation).toBeDefined()
  expect('sessionId' in (operation as object)).toBe(true)
  expect(operation?.sessionId).toBeNull()
})

test('getOperation leaves an explicit sessionId (a worktree-scope record) untouched', async () => {
  stored[`agentoo:docker:op:${OP}`] = JSON.stringify({
    id: OP,
    projectId: PROJECT,
    sessionId: SESSION,
    kind: 'up',
    services: [],
    status: 'running',
    exitCode: null,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: null,
  })
  const operation = await ops.getOperation(OP)
  expect(operation?.sessionId).toBe(SESSION)
})

test('getOperation returns undefined for a key that was never written', async () => {
  expect(await ops.getOperation('does-not-exist')).toBeUndefined()
})

// --- Defect 5, the property the DTO contract actually states -------------------
//
// The tests above pin the *shape* getOperation returns. What the route
// contract requires is stronger and is asserted here directly against the
// schema the OpenAPI response is declared with: a record written before
// worktree scope existed must still validate, or GET
// /projects/{id}/docker/operations answers a body that does not match its own
// documented response for the up-to-an-hour such a record survives in Redis.

// `@hono/zod-openapi` first, and deliberately: it is what installs the
// `.openapi()` method schema.ts calls at module scope, so importing
// schema.ts on its own throws. The app gets this ordering from routes.ts.
await import('@hono/zod-openapi')
const { dockerOperationSchema } = await import(`${B}/features/docker/schema.ts`)

const PRE_WORKTREE_RECORD = {
  id: OP,
  projectId: PROJECT,
  kind: 'up',
  services: ['web'],
  status: 'succeeded',
  exitCode: 0,
  error: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  startedAt: '2024-01-01T00:00:00.000Z',
  finishedAt: '2024-01-01T00:00:01.000Z',
}

test('Defect 5: a stale record with no sessionId key still satisfies dockerOperationSchema', async () => {
  // Guard the premise first: the stored record really is missing the field,
  // so this test cannot pass by accident on a record that already had one.
  expect('sessionId' in PRE_WORKTREE_RECORD).toBe(false)
  expect(dockerOperationSchema.safeParse(PRE_WORKTREE_RECORD).success).toBe(false)

  stored[`agentoo:docker:op:${OP}`] = JSON.stringify(PRE_WORKTREE_RECORD)
  const operation = await ops.getOperation(OP)

  const parsed = dockerOperationSchema.safeParse(operation)
  expect(parsed.error?.message ?? 'ok').toBe('ok')
  expect(parsed.success).toBe(true)
  expect(parsed.data?.sessionId).toBeNull()
})

test('Defect 5: listOperationsForProject validates too, mixing stale and current records', async () => {
  const NEWER = '44444444-4444-4444-8444-444444444444'
  stored[`agentoo:docker:op:${OP}`] = JSON.stringify(PRE_WORKTREE_RECORD)
  stored[`agentoo:docker:op:${NEWER}`] = JSON.stringify({
    ...PRE_WORKTREE_RECORD,
    id: NEWER,
    sessionId: SESSION,
  })
  stored[`agentoo:docker:project-ops:${PROJECT}`] = 'unused-by-the-fake-lrange'

  const listed = await ops.listOperationsForProject(PROJECT)
  expect(listed.map((o: { id: string }) => o.id)).toEqual([OP, NEWER])
  for (const record of listed) {
    const parsed = dockerOperationSchema.safeParse(record)
    expect(parsed.error?.message ?? `ok (${record.id})`).toBe(`ok (${record.id})`)
  }
  expect(listed[0]?.sessionId).toBeNull()
  expect(listed[1]?.sessionId).toBe(SESSION)
})

test('Defect 5: an unparsable record is dropped, not returned half-built', async () => {
  stored[`agentoo:docker:op:${OP}`] = '{not json'
  expect(await ops.getOperation(OP)).toBeUndefined()
})
