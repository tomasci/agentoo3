// The System Docker page's two endpoints, driven through `dockerRouter`
// mounted stand-alone (the way docker-security.test.ts mounts it) against a
// stateful fake daemon that answers the way the real one does — including
// `docker inspect a b` exiting 1 while still printing `a` when `b` is gone,
// verified against the real engine on this host. Plus the owner join
// (resolveContainerOwners) against plain rows.
//
// Its own process (see run-isolated.ts): env, both services, operations, the
// queue and the docker CLI seam are all replaced wholesale here, and
// DOCKER_ENABLED is flipped per test.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { FAKE_REDIS_PORT } from './setup-env'
import { startFakeRedis } from './fake-redis'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { OwnerProjectRow, OwnerSessionRow } from '../src/features/docker/system'

const B = new URL('../src', import.meta.url).pathname

// lib/events (reached through sessions/service.ts) opens a Redis publisher at
// import time; a local fake keeps that from retrying against nothing.
const redis = startFakeRedis(FAKE_REDIS_PORT)
afterAll(() => redis.stop())

const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
  editorEnabled: boolean
}
const testEnv = { ...realEnv.env, DOCKER_ENABLED: true }
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  editorEnabled: realEnv.editorEnabled,
}))

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const SESSION = '02c7a79d-6822-4344-a346-ecdf6e42de2c'
const OTHER_SESSION = '55555555-5555-4555-8555-555555555555'
const HEX12 = SESSION.replace(/-/g, '').slice(0, 12)

const projectDto = (id: string, slug: string, name: string) => ({
  id,
  name,
  slug,
  source: 'clone' as const,
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: null,
  status: 'ready' as const,
  lastError: null,
  recoveryCommands: null,
  path: `/srv/${slug}/repo`,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
})
const PROJECTS = [projectDto(PROJECT_ID, 'demo', 'Demo'), projectDto(OTHER_PROJECT_ID, 'other', 'Other')]

let sessionRows: OwnerSessionRow[] = []
let dbCalls = 0

const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) }
mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  listProjects: async () => {
    dbCalls++
    return PROJECTS
  },
}))
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) }
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  listSessionsForProjects: async (ids: string[]) => {
    dbCalls++
    return sessionRows.filter((s) => ids.includes(s.projectId))
  },
}))

let activeOperation: string | undefined
const realOperations = { ...(await import(`${B}/features/docker/operations.ts`)) }
mock.module(`${B}/features/docker/operations.ts`, () => ({
  ...realOperations,
  activeOperationForScope: async () => activeOperation,
  dockerLockScope: (projectId: string, sessionId: string | null) =>
    sessionId === null ? projectId : `${projectId}:s-${sessionId}`,
}))

mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_DOCKER_OP: 'docker-op',
  redisConnection: () => ({}),
  dockerOpQueue: {},
  enqueueDockerOp: async () => ({}),
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
  QUEUE_LEARNING_SCHEDULE: 'learning-schedule',
  enqueueLearningRun: async () => ({}),
}))

// --- a stateful fake daemon ------------------------------------------------------

interface FakeContainer {
  id: string
  name: string
  labels?: Record<string, string> | null
  state: string
  ports?: Record<string, { HostIp: string; HostPort: string }[] | null> | null
  autoRemove?: boolean
}

let daemon: FakeContainer[] = []
/** Ids `ps` reports that are already gone by the time `inspect` runs. */
let vanishedBeforeInspect: string[] = []
let daemonUp = true
const argvLog: string[][] = []

const resolveId = (q: string) => daemon.find((c) => c.id.startsWith(q))

const fakeRealCli = {
  async run(args: string[]) {
    argvLog.push(args)
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', exitCode: 0 })
    if (args[0] === 'version') {
      if (!daemonUp) {
        return {
          ok: false,
          stdout: JSON.stringify({ Client: { Version: '26.1.4' } }),
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
          exitCode: 1,
        }
      }
      return ok(JSON.stringify({ Client: { Version: '26.1.4' }, Server: { Version: '26.1.4' } }))
    }
    if (args[0] === 'ps') {
      return ok([...daemon.map((c) => c.id), ...vanishedBeforeInspect].join('\n'))
    }
    if (args[0] === 'inspect') {
      const ids = args.slice(5)
      const lines: string[] = []
      const missing: string[] = []
      for (const q of ids) {
        const c = resolveId(q)
        if (!c) {
          missing.push(q)
          continue
        }
        lines.push(
          JSON.stringify({
            Id: c.id,
            Name: `/${c.name}`,
            Config: { Image: 'alpine:latest', Labels: c.labels === undefined ? {} : c.labels },
            State: { Status: c.state, ExitCode: c.state === 'running' ? 0 : 137 },
            NetworkSettings: { Ports: c.ports === undefined ? {} : c.ports },
          }),
        )
      }
      // Real engine: exit 1 and one stderr line per missing id, stdout still
      // carrying every container that did resolve.
      if (missing.length > 0) {
        return {
          ok: false,
          stdout: lines.join('\n'),
          stderr: missing.map((m) => `Error response from daemon: No such container: ${m}`).join('\n'),
          exitCode: 1,
        }
      }
      return ok(lines.join('\n'))
    }
    if (args[0] === 'stop') {
      const c = resolveId(args[args.length - 1] ?? '')
      if (!c) {
        return {
          ok: false,
          stdout: '',
          stderr: `Error response from daemon: No such container: ${args[args.length - 1]}`,
          exitCode: 1,
        }
      }
      c.state = 'exited'
      c.ports = {}
      if (c.autoRemove) daemon = daemon.filter((d) => d !== c)
      return ok(args[args.length - 1] ?? '')
    }
    throw new Error(`unexpected argv in fake daemon: ${args.join(' ')}`)
  },
  stream() {
    throw new Error('stream() is not used here')
  },
}

const realCliModule = { ...(await import(`${B}/features/docker/cli.ts`)) }
mock.module(`${B}/features/docker/cli.ts`, () => ({ ...realCliModule, realDockerCli: fakeRealCli }))

const { dockerRouter } = await import(`${B}/features/docker/routes.ts`)
const { resolveContainerOwners } = await import(`${B}/features/docker/system.ts`)
const { openApiValidationHook } = await import(`${B}/lib/openapi-hook.ts`)
const { AppError, errorBody } = await import(`${B}/lib/errors.ts`)

// Same onError as createApp() (app.ts), so an AppError becomes its status.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', dockerRouter)
app.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  return c.json({ error: 'Internal server error' }, 500)
})

const hex = (ch: string) => ch.repeat(64)
const stop = (id: string) => app.request(`/api/docker/containers/${id}/stop`, { method: 'POST' })
const list = async () => {
  const res = await app.request('/api/docker/containers')
  return { status: res.status, text: await res.text() }
}

beforeEach(() => {
  testEnv.DOCKER_ENABLED = true
  daemon = []
  vanishedBeforeInspect = []
  daemonUp = true
  argvLog.length = 0
  activeOperation = undefined
  sessionRows = []
  dbCalls = 0
})

// ==================================================================================
// POST /api/docker/containers/{containerId}/stop — validation happens before docker
// ==================================================================================

for (const bad of ['--help', 'ABC', 'ZZZ', 'abc', 'A'.repeat(64), 'a'.repeat(11), 'a'.repeat(65), `${'a'.repeat(12)}%20-t`, '%2D%2Dhelp', `${'a'.repeat(12)};ls`]) {
  test(`400 for container id ${JSON.stringify(bad)}, with no docker call at all`, async () => {
    daemon = [{ id: hex('a'), name: 'x', state: 'running' }]
    const res = await stop(bad)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string }[] }
    expect(body.error).toBe('Validation failed')
    expect(body.issues?.[0]?.path).toBe('containerId')
    expect(argvLog).toEqual([])
    expect(daemon[0]?.state).toBe('running')
  })
}

test('403 when DOCKER_ENABLED=false, through the route, with no docker call and nothing stopped', async () => {
  testEnv.DOCKER_ENABLED = false
  daemon = [{ id: hex('a'), name: 'x', state: 'running' }]
  const res = await stop(hex('a'))
  expect(res.status).toBe(403)
  expect(((await res.json()) as { error: string }).error).toBe(
    'Docker controls are disabled (DOCKER_ENABLED=false)',
  )
  expect(argvLog).toEqual([])
  expect(daemon[0]?.state).toBe('running')
})

test('400 still wins over 403: validation runs before the enabled gate', async () => {
  testEnv.DOCKER_ENABLED = false
  const res = await stop('--help')
  expect(res.status).toBe(400)
})

test('404 for a well-formed hex id the daemon does not know', async () => {
  daemon = [{ id: hex('a'), name: 'x', state: 'running' }]
  const res = await stop(hex('f'))
  expect(res.status).toBe(404)
  expect(((await res.json()) as { error: string }).error).toBe('Container not found')
  expect(argvLog.some((a) => a[0] === 'stop')).toBe(false)
})

test('200: the response carries the FRESH (exited) state, and argv is exactly ["stop", id] (no -t)', async () => {
  daemon = [
    {
      id: hex('a'),
      name: 'systest',
      state: 'running',
      ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '32768' }] },
    },
  ]
  const res = await stop(hex('a'))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { container: { id: string; state: string; ports: number[] } }
  expect(body.container.id).toBe(hex('a'))
  expect(body.container.state).toBe('exited')
  expect(body.container.ports).toEqual([])
  expect(argvLog.filter((a) => a[0] === 'stop')).toEqual([['stop', hex('a')]])
})

test('200 with a 12-hex short id resolves to the full id in the response', async () => {
  daemon = [{ id: `abcdef012345${'0'.repeat(52)}`, name: 'short', state: 'running' }]
  const res = await stop('abcdef012345')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { container: { id: string } }
  expect(body.container.id).toBe(`abcdef012345${'0'.repeat(52)}`)
})

test('409 through the route when an operation is in flight for the owning scope; nothing stopped', async () => {
  sessionRows = [{ id: SESSION, projectId: PROJECT_ID, title: 'S', branch: 'b', worktreePath: '/w' }]
  daemon = [
    {
      id: hex('a'),
      name: `agentoo-demo_s-${HEX12}-web-1`,
      state: 'running',
      labels: { 'com.docker.compose.project': `agentoo-demo_s-${HEX12}` },
    },
  ]
  activeOperation = '77777777-7777-4777-8777-777777777777'
  const res = await stop(hex('a'))
  expect(res.status).toBe(409)
  expect(daemon[0]?.state).toBe('running')
  expect(argvLog.some((a) => a[0] === 'stop')).toBe(false)
})

test('503 through the route when the daemon is down, with recovery commands', async () => {
  daemonUp = false
  const res = await stop(hex('a'))
  expect(res.status).toBe(503)
  const body = (await res.json()) as { recoveryCommands?: string[] }
  expect(body.recoveryCommands).toContain('sudo systemctl start docker')
})

test('a successful stop of an auto-removed (--rm) container is not reported as 404', async () => {
  // `docker run --rm` containers are removed by the daemon as soon as they
  // stop; `docker stop` itself exits 0. The stop DID happen.
  daemon = [{ id: hex('a'), name: 'rm-on-stop', state: 'running', autoRemove: true }]
  const res = await stop(hex('a'))
  expect(daemon).toEqual([]) // the fake really did stop and remove it
  expect(res.status).not.toBe(404)
  expect(res.ok).toBe(true)
})

// ==================================================================================
// GET /api/docker/containers
// ==================================================================================

test('GET lists every container, ports distinct ascending across protocols, with no address anywhere', async () => {
  daemon = [
    {
      id: hex('a'),
      name: 'db',
      state: 'running',
      ports: {
        '8080/tcp': [
          { HostIp: '0.0.0.0', HostPort: '8080' },
          { HostIp: '::', HostPort: '8080' },
        ],
        '5432/tcp': [
          { HostIp: '127.0.0.1', HostPort: '5432' },
          { HostIp: '::1', HostPort: '5432' },
        ],
        '5432/udp': [{ HostIp: '0.0.0.0', HostPort: '5432' }],
        '9000/tcp': null, // exposed, never published
        '9001/tcp': [{ HostIp: '', HostPort: '' }], // declared, unbound
      },
    },
  ]
  const { status, text } = await list()
  expect(status).toBe(200)
  const body = JSON.parse(text) as { containers: { ports: number[] }[] }
  expect(body.containers[0]?.ports).toEqual([5432, 8080])
  for (const needle of ['hostIp', 'HostIp', '0.0.0.0', '127.0.0.1', '"::', '::1', '/tcp', '/udp', '->']) {
    expect(text.includes(needle)).toBe(false)
  }
})

test('GET with Labels: null and NetworkSettings.Ports: null reports owner null, ports [] and composeProject null', async () => {
  daemon = [{ id: hex('a'), name: 'bare', state: 'exited', labels: null, ports: null }]
  const { text } = await list()
  const [c] = (JSON.parse(text) as { containers: Record<string, unknown>[] }).containers
  expect(c?.owner).toBeNull()
  expect(c?.ports).toEqual([])
  expect(c?.composeProject).toBeNull()
  expect(c?.state).toBe('exited')
  // No agentoo label at all: the DB is never consulted.
  expect(dbCalls).toBe(0)
})

test("GET: a com.agentoo.session label naming another project's session is owner null", async () => {
  sessionRows = [{ id: OTHER_SESSION, projectId: OTHER_PROJECT_ID, title: 'x', branch: 'b', worktreePath: '/w' }]
  daemon = [
    {
      id: hex('a'),
      name: 'agentoo-demo_s-555555555555',
      state: 'running',
      labels: {
        'com.agentoo.managed': '1',
        'com.agentoo.project': 'demo',
        'com.agentoo.session': OTHER_SESSION,
      },
    },
  ]
  const { text } = await list()
  expect((JSON.parse(text) as { containers: { owner: unknown }[] }).containers[0]?.owner).toBeNull()
})

test('GET: a session-scope compose container resolves to its session, the repo-scope one to the project', async () => {
  sessionRows = [
    { id: SESSION, projectId: PROJECT_ID, title: 'Mine', branch: 'agentoo/s-02c7a79d', worktreePath: '/w' },
  ]
  daemon = [
    { id: hex('a'), name: 'a-repo', state: 'running', labels: { 'com.docker.compose.project': 'agentoo-demo' } },
    {
      id: hex('b'),
      name: 'b-session',
      state: 'running',
      labels: { 'com.docker.compose.project': `agentoo-demo_s-${HEX12}` },
    },
  ]
  const { text } = await list()
  const owners = (JSON.parse(text) as { containers: { name: string; owner: { sessionId: string | null; projectId: string } | null }[] }).containers.map(
    (c) => [c.name, c.owner?.projectId, c.owner?.sessionId],
  )
  expect(owners).toEqual([
    ['a-repo', PROJECT_ID, null],
    ['b-session', PROJECT_ID, SESSION],
  ])
})

test('GET resolves owners in at most two DB calls however many containers there are', async () => {
  sessionRows = [{ id: SESSION, projectId: PROJECT_ID, title: 'S', branch: 'b', worktreePath: '/w' }]
  daemon = Array.from({ length: 30 }, (_, i) => ({
    id: i.toString(16).padStart(64, '0'),
    name: `c${String(i).padStart(2, '0')}`,
    state: 'running',
    labels: { 'com.docker.compose.project': i % 2 ? 'agentoo-demo' : `agentoo-demo_s-${HEX12}` },
  }))
  await list()
  expect(dbCalls).toBe(2)
})

test('GET lists all 250 containers on a host with more than the 200-id inspect chunk', async () => {
  daemon = Array.from({ length: 250 }, (_, i) => ({
    id: `${'e'.repeat(61)}${i.toString(16).padStart(3, '0')}`,
    name: `c${String(i).padStart(3, '0')}`,
    state: 'exited',
  }))
  const { text } = await list()
  const names = (JSON.parse(text) as { containers: { name: string }[] }).containers.map((c) => c.name)
  expect(names).toHaveLength(250)
  expect(new Set(names).size).toBe(250)
})

test('GET: one container removed between `ps` and `inspect` does not blank the whole listing', async () => {
  // The real engine's answer to `docker inspect a b` when b was just removed:
  // exit 1, but a is still on stdout (verified on this host). A container
  // coming or going mid-poll must not make every other container vanish.
  daemon = [
    { id: hex('a'), name: 'alpha', state: 'running' },
    { id: hex('b'), name: 'beta', state: 'running' },
  ]
  vanishedBeforeInspect = [hex('c')]
  const { status, text } = await list()
  expect(status).toBe(200)
  const names = (JSON.parse(text) as { containers: { name: string }[] }).containers.map((c) => c.name)
  expect(names).toEqual(['alpha', 'beta'])
})

test('GET with DOCKER_ENABLED=false is 200, enabled: false, and still lists containers', async () => {
  testEnv.DOCKER_ENABLED = false
  daemon = [{ id: hex('a'), name: 'alpha', state: 'running' }]
  const { status, text } = await list()
  expect(status).toBe(200)
  const body = JSON.parse(text) as { enabled: boolean; containers: unknown[] }
  expect(body.enabled).toBe(false)
  expect(body.containers).toHaveLength(1)
})

test('GET never issues a mutating docker command', async () => {
  daemon = [{ id: hex('a'), name: 'alpha', state: 'running' }]
  await list()
  expect(argvLog.map((a) => a[0])).toEqual(['version', 'ps', 'inspect'])
  expect(argvLog[1]).toEqual(['ps', '-aq'])
})

test('GET when the daemon is down is 200 with containers: [] and no ps/inspect', async () => {
  daemonUp = false
  const { status, text } = await list()
  expect(status).toBe(200)
  const body = JSON.parse(text) as { daemon: { available: boolean }; containers: unknown[] }
  expect(body.daemon.available).toBe(false)
  expect(body.containers).toEqual([])
  expect(argvLog.map((a) => a[0])).toEqual(['version'])
})

// ==================================================================================
// resolveContainerOwners against plain rows
// ==================================================================================

const { parseContainerOwner, composeProjectName } = await import(`${B}/features/docker/names.ts`)


const DEMO: OwnerProjectRow = { id: 'p-demo', slug: 'demo', name: 'Demo' }
const OTHER: OwnerProjectRow = { id: 'p-other', slug: 'other', name: 'Other' }

test("a com.agentoo.session label naming another project's session is null, not repo scope", () => {
  const candidate = parseContainerOwner({
    'com.agentoo.managed': '1',
    'com.agentoo.project': 'demo',
    'com.agentoo.session': SESSION,
  })
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: OTHER.id, title: 'Other session', branch: 'b', worktreePath: '/w' },
  ]
  expect(resolveContainerOwners([candidate], [DEMO, OTHER], sessions)).toEqual([null])
})

test('a hex12 prefix shared by sessions of two DIFFERENT projects still resolves within its own project', () => {
  const twinInOther = '02c7a79d-6822-4999-8999-999999999999'
  expect(twinInOther.replace(/-/g, '').slice(0, 12)).toBe(HEX12)
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: DEMO.id, title: 'Mine', branch: 'agentoo/s-02c7a79d', worktreePath: '/w1' },
    { id: twinInOther, projectId: OTHER.id, title: 'Theirs', branch: 'x', worktreePath: '/w2' },
  ]
  const candidate = parseContainerOwner({
    'com.docker.compose.project': composeProjectName({ slug: 'demo', sessionId: SESSION }),
  })
  const [owner] = resolveContainerOwners([candidate], [DEMO, OTHER], sessions)
  expect(owner?.sessionId).toBe(SESSION)
  expect(owner?.projectId).toBe(DEMO.id)
})

test('a hex12 prefix whose only match is in another project is null', () => {
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: OTHER.id, title: 'Theirs', branch: 'x', worktreePath: '/w' },
  ]
  const candidate = parseContainerOwner({
    'com.docker.compose.project': composeProjectName({ slug: 'demo', sessionId: SESSION }),
  })
  expect(resolveContainerOwners([candidate], [DEMO, OTHER], sessions)).toEqual([null])
})

test('a non-isolated twin sharing the prefix does not make an isolated match ambiguous', () => {
  const sharedTwin = '02c7a79d-6822-4999-8999-999999999999'
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: DEMO.id, title: 'Isolated', branch: 'b', worktreePath: '/w' },
    { id: sharedTwin, projectId: DEMO.id, title: 'Shared', branch: null, worktreePath: null },
  ]
  const candidate = parseContainerOwner({
    'com.docker.compose.project': composeProjectName({ slug: 'demo', sessionId: SESSION }),
  })
  const [owner] = resolveContainerOwners([candidate], [DEMO], sessions)
  expect(owner?.sessionId).toBe(SESSION)
})

test('an upper-cased session label never falls back to repo scope', () => {
  const candidate = parseContainerOwner({
    'com.agentoo.managed': '1',
    'com.agentoo.project': 'demo',
    'com.agentoo.session': SESSION.toUpperCase(),
  })
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: DEMO.id, title: 'T', branch: 'b', worktreePath: '/w' },
  ]
  const [owner] = resolveContainerOwners([candidate], [DEMO], sessions)
  // Either unowned or resolved to the exact session — never the repo scope.
  expect(owner === null || owner.sessionId === SESSION).toBe(true)
})

test('the same slug in a repo-scope and a session-scope container resolves each to its own scope', () => {
  const sessions: OwnerSessionRow[] = [
    { id: SESSION, projectId: DEMO.id, title: 'S', branch: 'b', worktreePath: '/w' },
  ]
  const owners = resolveContainerOwners(
    [
      parseContainerOwner({ 'com.docker.compose.project': 'agentoo-demo' }),
      parseContainerOwner({ 'com.docker.compose.project': `agentoo-demo_s-${HEX12}` }),
    ],
    [DEMO],
    sessions,
  )
  expect(owners.map((o) => o?.sessionId)).toEqual([null, SESSION])
})
