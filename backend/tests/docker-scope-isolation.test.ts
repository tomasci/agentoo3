// CLAIMS 2 & 7, plus the Defect 1 collision, driven end to end through the
// real service functions -- not the router, and not a stub of
// listScopeContainers: containers.ts and service.ts run for real here, with
// only the docker CLI faked, which is what lets this file assert on
// cross-scope container reachability and the read/write env parity that a
// pure-argv test (docker-args.test.ts) or a router-level test
// (docker-security.test.ts) cannot reach on their own.
//
// The fake CLI below is keyed by a single letter per container, from which
// both a `ps -aq`-shaped 12-char short id (`SHORT`) and an `inspect`-shaped
// 64-char full id (`FULL`) are derived -- deliberately never the same string,
// matching real docker. `inspect` resolves whichever of the two it is asked
// for by prefix, exactly as the real CLI does. A version of this fake that
// handed back the same id from both calls (as this file once did) cannot
// exercise -- or catch a regression in -- any code that correlates the two,
// which is exactly how containers.ts's `composeIds.has(raw.Id)` defect (a
// `ps` short id tested against an `inspect` full id, always false) shipped
// with every test in this file green.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname
const DIR = await mkdtemp(join(tmpdir(), 'agentoo-docker-scope-isolation-'))

const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
  editorEnabled: boolean
}
const testEnv = { ...realEnv.env, PROJECTS_DIR: DIR, DOCKER_ENABLED: true }
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  // Additive: features/editor didn't exist when this file was written.
  // Kept, not spread from realEnv wholesale, for the same reason this
  // file's own `env` override isn't a spread either -- see run-isolated.ts's
  // header for why an ADDITIVE, hard-coded mock still has to carry every
  // named export another concurrently-running test file might import.
  editorEnabled: realEnv.editorEnabled,
}))

const PROJECT = '11111111-1111-4111-8111-111111111111'
const SLUG = 'demo'
const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const SUF = (id: string) => id.replace(/-/g, '').slice(0, 12)

const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  getProject: async (id: string) => {
    if (id !== PROJECT) throw notFound('Project')
    return { id: PROJECT, slug: SLUG, path: join(DIR, SLUG, 'repo') }
  },
  listProjects: async () => [],
}))

const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  getSessionLocation: async (id: string) => {
    if (id !== SESSION_A && id !== SESSION_B) throw notFound('Session')
    return { id, projectId: PROJECT, worktreePath: join(DIR, SLUG, 'worktrees', id) }
  },
}))

/** What `docker ps -aq` prints for container `c` -- docker's 12-char prefix. */
const SHORT = (c: string) => c.repeat(12)
/** What `docker inspect` reports back as `.Id` for that same container --
 * always the 64-char full id, never the short id it may have been looked up
 * by. `SHORT(c)` is a true prefix of `FULL(c)`, matching real docker. */
const FULL = (c: string) => c.repeat(64)

// Five containers: repo-scope compose, repo-scope plain, session A compose,
// session A plain, session B plain. `f` is deliberately named nothing like
// `containerName(ref)` (hand-labelled / renamed after the fact) -- see
// Defect 4 below.
const CONTAINERS: Record<string, { name: string; labels: Record<string, string> }> = {
  a: {
    name: `/agentoo-${SLUG}`,
    labels: { 'com.docker.compose.project': `agentoo-${SLUG}`, 'com.docker.compose.service': 'web' },
  },
  b: {
    name: `/agentoo-${SLUG}`,
    labels: { 'com.agentoo.project': SLUG, 'com.agentoo.managed': '1' },
  },
  c: {
    name: `/agentoo-${SLUG}_s-${SUF(SESSION_A)}-web-1`,
    labels: {
      'com.docker.compose.project': `agentoo-${SLUG}_s-${SUF(SESSION_A)}`,
      'com.docker.compose.service': 'web',
    },
  },
  d: {
    name: `/agentoo-${SLUG}_s-${SUF(SESSION_A)}`,
    labels: { 'com.agentoo.project': SLUG, 'com.agentoo.managed': '1', 'com.agentoo.session': SESSION_A },
  },
  e: {
    name: `/agentoo-${SLUG}_s-${SUF(SESSION_B)}`,
    labels: { 'com.agentoo.project': SLUG, 'com.agentoo.managed': '1', 'com.agentoo.session': SESSION_B },
  },
  // Defect 4: carries the repo-scope label combination (project label, no
  // session label) but was renamed/hand-labelled after the fact, so its name
  // does not match `containerName({ slug, sessionId: null })` at all. A name
  // comparison used to drop this from repo-scope's own listing.
  f: {
    name: '/some-operator-renamed-this',
    labels: { 'com.agentoo.project': SLUG, 'com.agentoo.managed': '1' },
  },
}

/** Resolve an `inspect` argument (short or full id, exactly as docker itself
 * resolves either) to the container whose full id it is a prefix of. */
function findByQueryId(query: string): [string, (typeof CONTAINERS)[string]] | undefined {
  return Object.entries(CONTAINERS).find(([c]) => FULL(c).startsWith(query))
}

const runCalls: { args: string[]; env?: Record<string, string>; cwd?: string }[] = []
const streamCalls: { args: string[]; env?: Record<string, string>; cwd?: string }[] = []
const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', exitCode: 0 })

const fakeCli = {
  async run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    runCalls.push({ args, env: options.env, cwd: options.cwd })
    if (args[0] === 'inspect' && args.includes('--type')) {
      const queried = args.slice(5)
      const found = queried.map((q) => findByQueryId(q)).filter((e) => e !== undefined)
      if (found.length === 0) return { ok: false, stdout: '', stderr: 'No such object', exitCode: 1 }
      return ok(
        found
          .map(([c, data]) =>
            JSON.stringify({
              Id: FULL(c),
              Name: data.name,
              Config: { Labels: data.labels },
              State: { Status: 'running' },
            }),
          )
          .join('\n'),
      )
    }
    if (args[0] === 'ps') {
      const filter = args[3] ?? ''
      const ids = Object.entries(CONTAINERS)
        .filter(([, c]) => {
          if (filter.startsWith('label=com.docker.compose.project=')) {
            return c.labels['com.docker.compose.project'] === filter.split('=').slice(2).join('=')
          }
          if (filter.startsWith('label=com.agentoo.project=')) {
            return c.labels['com.agentoo.project'] === filter.split('=').slice(2).join('=')
          }
          return false
        })
        .map(([c]) => SHORT(c))
      return ok(ids.join('\n'))
    }
    if (args[0] === 'version') return ok('{"Client":{"Version":"26.1.4"},"Server":{"Version":"26.1.4"}}')
    if (args[0] === 'compose' && args.includes('version')) return ok('{"version":"v2.24.0"}')
    if (args[0] === 'compose' && args.includes('config') && args.includes('--format')) {
      return ok(JSON.stringify({ services: { web: { image: 'nginx' } } }))
    }
    if (args[0] === 'compose' && args.includes('config')) return ok('web')
    if (args[0] === 'compose' && args.includes('ls')) return ok('[]')
    if (args[0] === 'image') return { ok: false, stdout: '', stderr: 'no such image', exitCode: 1 }
    return ok('')
  },
  stream(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    streamCalls.push({ args, env: options.env, cwd: options.cwd })
    return { lines: (async function* () {})(), close() {}, exited: Promise.resolve(0) }
  },
}

const realHosts = { ...(await import(`${B}/features/docker/hosts.ts`)) } as Record<string, unknown>
mock.module(`${B}/features/docker/hosts.ts`, () => ({ ...realHosts, getHostAddresses: async () => [] }))

const realOps = { ...(await import(`${B}/features/docker/operations.ts`)) } as Record<string, unknown>
mock.module(`${B}/features/docker/operations.ts`, () => ({
  ...realOps,
  activeOperationForScope: async () => undefined,
  createOperation: async (i: Record<string, unknown>) => ({ ...i, status: 'queued' }),
  finishOperation: async () => undefined,
  getOperation: async () => undefined,
  listOperationsForProject: async () => [],
  claimOperationLock: async () => true,
  releaseOperationLock: async () => undefined,
  markOperationRunning: async () => undefined,
  appendOperationOutput: async () => undefined,
}))

const { containerBelongsToScope, getProjectDockerState } = await import(`${B}/features/docker/service.ts`)
const { listScopeContainers } = await import(`${B}/features/docker/containers.ts`)
const { runDockerOp } = await import(`${B}/queue/docker-op.worker.ts`)
const { composeEnvFor } = await import(`${B}/features/docker/compose-env.ts`)

await mkdir(join(DIR, SLUG, 'repo'), { recursive: true })
await mkdir(join(DIR, SLUG, 'worktrees', SESSION_A), { recursive: true })
await mkdir(join(DIR, SLUG, 'worktrees', SESSION_B), { recursive: true })
await Bun.write(join(DIR, SLUG, 'repo', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n')
await Bun.write(join(DIR, SLUG, 'worktrees', SESSION_A, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n')

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  mock.module(`${B}/features/docker/hosts.ts`, () => realHosts)
  mock.module(`${B}/features/docker/operations.ts`, () => realOps)
  await rm(DIR, { recursive: true, force: true })
})

beforeEach(() => {
  runCalls.length = 0
  streamCalls.length = 0
})

const REPO_COMPOSE = FULL('a')
const REPO_PLAIN = FULL('b')
const A_COMPOSE = FULL('c')
const A_PLAIN = FULL('d')
const B_PLAIN = FULL('e')
const REPO_PLAIN_RENAMED = FULL('f')

// --- CLAIM 2: ownership across scopes ------------------------------------------

test('repo-scope containers are NOT reachable with a sessionId', async () => {
  expect(await containerBelongsToScope(PROJECT, SESSION_A, REPO_COMPOSE, fakeCli)).toBe(false)
  expect(await containerBelongsToScope(PROJECT, SESSION_A, REPO_PLAIN, fakeCli)).toBe(false)
})

test('session containers are NOT reachable at repo scope', async () => {
  expect(await containerBelongsToScope(PROJECT, undefined, A_COMPOSE, fakeCli)).toBe(false)
  expect(await containerBelongsToScope(PROJECT, undefined, A_PLAIN, fakeCli)).toBe(false)
})

test("session A's containers are NOT reachable with session B's id", async () => {
  expect(await containerBelongsToScope(PROJECT, SESSION_B, A_COMPOSE, fakeCli)).toBe(false)
  expect(await containerBelongsToScope(PROJECT, SESSION_B, A_PLAIN, fakeCli)).toBe(false)
})

test('each scope can still reach its own containers', async () => {
  expect(await containerBelongsToScope(PROJECT, undefined, REPO_COMPOSE, fakeCli)).toBe(true)
  expect(await containerBelongsToScope(PROJECT, undefined, REPO_PLAIN, fakeCli)).toBe(true)
  expect(await containerBelongsToScope(PROJECT, SESSION_A, A_COMPOSE, fakeCli)).toBe(true)
  expect(await containerBelongsToScope(PROJECT, SESSION_A, A_PLAIN, fakeCli)).toBe(true)
  expect(await containerBelongsToScope(PROJECT, SESSION_B, B_PLAIN, fakeCli)).toBe(true)
})

test('each scope can still reach its own containers when asked by the SHORT id a `DockerContainer.shortId` field would carry', async () => {
  // A UI built off `DockerContainer.shortId` sends the 12-char prefix, not
  // the full id -- `CONTAINER_ID_RE` (routes.ts) accepts both shapes, and
  // real docker resolves either against the same container, which is what
  // `findByQueryId`'s prefix match above models.
  expect(await containerBelongsToScope(PROJECT, undefined, SHORT('a'), fakeCli)).toBe(true)
  expect(await containerBelongsToScope(PROJECT, SESSION_A, SHORT('c'), fakeCli)).toBe(true)
})

test('listScopeContainers returns only that scope containers', async () => {
  const repo = await listScopeContainers({ slug: SLUG, sessionId: null }, fakeCli)
  expect(repo.map((c) => c.id).sort()).toEqual([REPO_COMPOSE, REPO_PLAIN, REPO_PLAIN_RENAMED].sort())

  const a = await listScopeContainers({ slug: SLUG, sessionId: SESSION_A }, fakeCli)
  expect(a.map((c) => c.id).sort()).toEqual([A_COMPOSE, A_PLAIN].sort())

  const b = await listScopeContainers({ slug: SLUG, sessionId: SESSION_B }, fakeCli)
  expect(b.map((c) => c.id)).toEqual([B_PLAIN])
})

// --- Defect 4: label-based membership, not name-based --------------------------

test('Defect 4: a renamed/hand-labelled container is still listed at repo scope, by label alone', async () => {
  const repo = await listScopeContainers({ slug: SLUG, sessionId: null }, fakeCli)
  expect(repo.map((c) => c.id)).toContain(REPO_PLAIN_RENAMED)
})

test('Defect 4: containerBelongsToScope also accepts it, by label alone', async () => {
  expect(await containerBelongsToScope(PROJECT, undefined, REPO_PLAIN_RENAMED, fakeCli)).toBe(true)
})

// --- CLAIM 7: read path and write path share one env ----------------------------

function envOfComposeConfig(): Record<string, string> | undefined {
  return runCalls.find((c) => c.args[0] === 'compose' && c.args.includes('config'))?.env
}

test('getComposeConfig (read) and compose up (write) use identical env, repo scope', async () => {
  await getProjectDockerState(PROJECT, undefined, fakeCli)
  const readEnv = envOfComposeConfig()
  expect(readEnv).toEqual(composeEnvFor({ slug: SLUG, sessionId: null }))

  streamCalls.length = 0
  await runDockerOp(
    {
      operationId: '33333333-3333-4333-8333-333333333333',
      projectId: PROJECT,
      sessionId: null,
      slug: SLUG,
      mode: 'compose',
      kind: 'up',
      services: [],
      projectPath: join(DIR, SLUG, 'repo'),
      composeProjectName: `agentoo-${SLUG}`,
      composeFiles: { base: join(DIR, SLUG, 'repo', 'compose.yaml') },
    } as never,
    fakeCli as never,
  )
  const writeEnv = streamCalls.find((c) => c.args[0] === 'compose')?.env
  expect(writeEnv).toEqual(readEnv as Record<string, string>)
})

test('getComposeConfig (read) and compose up (write) use identical env, worktree scope', async () => {
  await getProjectDockerState(PROJECT, SESSION_A, fakeCli)
  const readEnv = envOfComposeConfig()
  expect(readEnv).toEqual(composeEnvFor({ slug: SLUG, sessionId: SESSION_A }))

  streamCalls.length = 0
  await runDockerOp(
    {
      operationId: '44444444-4444-4444-8444-444444444444',
      projectId: PROJECT,
      sessionId: SESSION_A,
      slug: SLUG,
      mode: 'compose',
      kind: 'up',
      services: [],
      projectPath: join(DIR, SLUG, 'worktrees', SESSION_A),
      composeProjectName: `agentoo-${SLUG}_s-${SUF(SESSION_A)}`,
      composeFiles: { base: join(DIR, SLUG, 'worktrees', SESSION_A, 'compose.yaml') },
    } as never,
    fakeCli as never,
  )
  const writeEnv = streamCalls.find((c) => c.args[0] === 'compose')?.env
  expect(writeEnv).toEqual(readEnv as Record<string, string>)
  expect(writeEnv?.AGENTOO_SESSION_ID).toBe(SESSION_A)
})

test('read path at worktree scope runs compose with cwd = the worktree', async () => {
  await getProjectDockerState(PROJECT, SESSION_A, fakeCli)
  const call = runCalls.find((c) => c.args[0] === 'compose' && c.args.includes('config'))
  expect(call?.cwd).toBe(join(DIR, SLUG, 'worktrees', SESSION_A))
})

// --- Defect 1: the collision, driven through the real ownership check and listing --

test("a project whose slug collides with session A's old name cannot reach session A's containers", async () => {
  // A second project, ATTACKER, whose slug is exactly `demo-s-<session A's
  // 12-hex suffix>` -- before the `_` join (names.ts), ATTACKER's *repo*
  // scope and PROJECT's *session A* scope produced the identical compose
  // project name and container name.
  const ATTACKER = '99999999-9999-4999-8999-999999999999'
  const ATTACKER_SLUG = `demo-s-${SUF(SESSION_A)}`
  mock.module(`${B}/features/projects/service.ts`, () => ({
    ...realProjects,
    getProject: async (id: string) => {
      if (id === PROJECT) return { id: PROJECT, slug: SLUG, path: join(DIR, SLUG, 'repo') }
      if (id === ATTACKER) return { id: ATTACKER, slug: ATTACKER_SLUG, path: join(DIR, ATTACKER_SLUG, 'repo') }
      throw notFound('Project')
    },
    listProjects: async () => [],
  }))
  await mkdir(join(DIR, ATTACKER_SLUG, 'repo'), { recursive: true })

  expect(await containerBelongsToScope(ATTACKER, undefined, A_COMPOSE, fakeCli)).toBe(false)
  expect(await containerBelongsToScope(ATTACKER, undefined, A_PLAIN, fakeCli)).toBe(false)
  const listed = await listScopeContainers({ slug: ATTACKER_SLUG, sessionId: null }, fakeCli)
  expect(listed.map((c) => c.id)).toEqual([])

  // Restore the plain (non-attacker) project mock for tests after this one.
  mock.module(`${B}/features/projects/service.ts`, () => ({
    ...realProjects,
    getProject: async (id: string) => {
      if (id !== PROJECT) throw notFound('Project')
      return { id: PROJECT, slug: SLUG, path: join(DIR, SLUG, 'repo') }
    },
    listProjects: async () => [],
  }))
})
