// The system-wide Docker page: the pure owner matcher and port dedupe first
// (no I/O at all — the brief's own emphasis on keeping this testable without
// Postgres), then the two service functions (getSystemDockerState,
// stopSystemContainer) against a fake DockerCli, with projects/sessions/
// operations mocked the same way docker-operation-gates.test.ts already does
// for service.ts (system.ts pulls in service.ts's own transitive graph just
// to reuse its exported recovery-command constants — see system.ts's header).
//
// `mock.module` is process-global in bun's shared test process, so every
// specifier mocked below is restored in afterAll, exactly like every other
// file in this suite that touches the same modules.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import type { DockerCli, DockerResult, DockerStream } from '../src/features/docker/cli'
import type { ContainerOwnerCandidate } from '../src/features/docker/names'
import type { OwnerProjectRow, OwnerSessionRow } from '../src/features/docker/system'
import { distinctHostPorts, resolveContainerOwners } from '../src/features/docker/system'

// ==============================================================================
// Part 1: the pure owner matcher and port dedupe — no mocking, no I/O.
// ==============================================================================

const PROJECT_A: OwnerProjectRow = { id: 'p-a', slug: 'demo', name: 'Demo' }
const PROJECT_B: OwnerProjectRow = { id: 'p-b', slug: 'other', name: 'Other' }
const PROJECTS = [PROJECT_A, PROJECT_B]

const SESSION_A: OwnerSessionRow = {
  id: '33333333-3333-4333-8333-333333333333',
  projectId: 'p-a',
  title: 'Session A',
  branch: 'agentoo/s-33333333',
  worktreePath: '/opt/agentoo/projects/demo/worktrees/33333333-3333-4333-8333-333333333333',
}
const SESSION_SHARED: OwnerSessionRow = {
  id: '44444444-4444-4444-8444-444444444444',
  projectId: 'p-a',
  title: 'Shared checkout session',
  branch: null,
  worktreePath: null, // not isolated: shares the project's repo/ checkout
}

const candidate = (over: Partial<ContainerOwnerCandidate>): ContainerOwnerCandidate => ({
  kind: 'dockerfile',
  slug: 'demo',
  sessionId: null,
  sessionPrefix: null,
  ...over,
})

test('repo scope (no session part) resolves to the project alone', () => {
  const [owner] = resolveContainerOwners([candidate({})], PROJECTS, [SESSION_A])
  expect(owner).toEqual({
    kind: 'dockerfile',
    projectId: 'p-a',
    projectName: 'Demo',
    projectSlug: 'demo',
    sessionId: null,
    sessionTitle: null,
    branch: null,
  })
})

test('session scope resolves by exact id (dockerfile/editor) when the session is isolated', () => {
  const [owner] = resolveContainerOwners(
    [candidate({ kind: 'editor', sessionId: SESSION_A.id })],
    PROJECTS,
    [SESSION_A],
  )
  expect(owner).toEqual({
    kind: 'editor',
    projectId: 'p-a',
    projectName: 'Demo',
    projectSlug: 'demo',
    sessionId: SESSION_A.id,
    sessionTitle: 'Session A',
    branch: 'agentoo/s-33333333',
  })
})

test('session scope resolves by hex12 prefix (compose) when exactly one session matches', () => {
  const prefix = SESSION_A.id.replace(/-/g, '').slice(0, 12)
  const [owner] = resolveContainerOwners(
    [candidate({ kind: 'compose', sessionPrefix: prefix })],
    PROJECTS,
    [SESSION_A],
  )
  expect(owner?.sessionId).toBe(SESSION_A.id)
})

test('an ambiguous hex12 prefix (more than one match) resolves to null, never a guess', () => {
  const prefix = SESSION_A.id.replace(/-/g, '').slice(0, 12)
  // Shares SESSION_A's first 12 hex characters by construction, differing only
  // after them.
  const twin: OwnerSessionRow = {
    id: '33333333-3333-4999-8333-999999999999',
    projectId: 'p-a',
    title: 'Twin',
    branch: null,
    worktreePath: '/opt/agentoo/projects/demo/worktrees/33333333-3333-4999-8333-999999999999',
  }
  expect(twin.id.replace(/-/g, '').slice(0, 12)).toBe(prefix) // sanity-check the fixture

  const [owner] = resolveContainerOwners(
    [candidate({ kind: 'compose', sessionPrefix: prefix })],
    PROJECTS,
    [SESSION_A, twin],
  )
  expect(owner).toBeNull()
})

test('a non-isolated session (shares the project checkout) never matches, even by exact id', () => {
  const [owner] = resolveContainerOwners(
    [candidate({ sessionId: SESSION_SHARED.id })],
    PROJECTS,
    [SESSION_SHARED],
  )
  expect(owner).toBeNull()
})

test('an unresolved session part never falls back to repo scope', () => {
  const [owner] = resolveContainerOwners(
    [candidate({ sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })],
    PROJECTS,
    [SESSION_A],
  )
  expect(owner).toBeNull()
})

test('a session belonging to a different project never matches, even with the right id', () => {
  const sessionOfProjectB: OwnerSessionRow = { ...SESSION_A, projectId: 'p-b' }
  const [owner] = resolveContainerOwners(
    [candidate({ sessionId: SESSION_A.id })],
    PROJECTS,
    [sessionOfProjectB],
  )
  expect(owner).toBeNull()
})

test('a foreign/unknown slug (another install sharing this daemon) is null', () => {
  const [owner] = resolveContainerOwners(
    [candidate({ kind: 'compose', slug: 'somebody-elses-project' })],
    PROJECTS,
    [],
  )
  expect(owner).toBeNull()
})

test('a null candidate (an unrelated container) stays null, aligned with its position', () => {
  const owners = resolveContainerOwners([null, candidate({}), null], PROJECTS, [])
  expect(owners[0]).toBeNull()
  expect(owners[1]).toMatchObject({ projectSlug: 'demo' })
  expect(owners[2]).toBeNull()
})

test('distinctHostPorts dedupes IPv4 and IPv6 bindings of the same port, ascending', () => {
  const ports = [{ hostPort: 8080 }, { hostPort: 3000 }, { hostPort: 8080 }, { hostPort: 3000 }]
  expect(distinctHostPorts(ports)).toEqual([3000, 8080])
})

test('distinctHostPorts on a stopped container (no ports at all) is empty', () => {
  expect(distinctHostPorts([])).toEqual([])
})

// ==============================================================================
// Part 2: the service functions, against a fake DockerCli.
// ==============================================================================

const B = new URL('../src', import.meta.url).pathname

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
const projectDto = {
  id: PROJECT_ID,
  name: 'Demo',
  slug: 'demo',
  source: 'clone' as const,
  remoteUrl: 'https://example.com/demo.git',
  sourceName: null,
  sshKeyId: null,
  defaultBranch: null,
  status: 'ready' as const,
  lastError: null,
  recoveryCommands: null,
  path: '/opt/agentoo/projects/demo/repo',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}
let projectRows: (typeof projectDto)[] = [projectDto]

const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  listProjects: async () => projectRows,
}))

let sessionRows: OwnerSessionRow[] = []
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  listSessionsForProjects: async (projectIds: string[]) =>
    sessionRows.filter((s) => projectIds.includes(s.projectId)),
}))

let activeOperation: string | undefined
const lockScopeChecks: string[] = []
const realOperations = { ...(await import(`${B}/features/docker/operations.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/docker/operations.ts`, () => ({
  ...realOperations,
  activeOperationForScope: async (scope: string) => {
    lockScopeChecks.push(scope)
    return activeOperation
  },
  dockerLockScope: (projectId: string, sessionId: string | null) =>
    sessionId === null ? projectId : `${projectId}:s-${sessionId}`,
}))

// Additive, hard-coded (not spread from the real module): importing
// docker/system.ts pulls in docker/service.ts purely to reuse its exported
// recovery-command constants (see system.ts's own header), and service.ts
// itself imports '@/queue' at module scope, whose real module constructs
// live BullMQ `Queue` instances against REDIS_URL as a side effect of being
// imported at all — see docker-operation-gates.test.ts's identical stub for
// the same reasoning. Every export queue/index.ts currently has is listed so
// no concurrently-running file that imports the real module loses one.
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  QUEUE_IDEA_PROMPT: 'idea-prompt',
  QUEUE_IDEA_HANDOFF_SWEEP: 'idea-handoff-sweep',
  QUEUE_DOCKER_OP: 'docker-op',
  QUEUE_EDITOR_OP: 'editor-op',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
  turnEndedQueue: {},
  turnReconcileQueue: {},
  ideaPromptQueue: {},
  ideaHandoffSweepQueue: {},
  dockerOpQueue: {},
  editorOpQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
  enqueueTurnEnded: async () => ({}),
  enqueueTurnReconcile: async () => ({}),
  ensureTurnReconcileSchedule: async () => {},
  enqueueIdeaPrompt: async () => ({}),
  enqueueIdeaHandoffSweep: async () => ({}),
  ensureIdeaHandoffSweepSchedule: async () => {},
  enqueueDockerOp: async () => ({}),
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
}))

const { getSystemDockerState, stopSystemContainer } = await import(
  `${B}/features/docker/system.ts`
)

afterAll(() => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  mock.module(`${B}/features/docker/operations.ts`, () => realOperations)
})

// --- the fake daemon ----------------------------------------------------------

interface FakeContainer {
  id: string
  name: string
  labels?: Record<string, string>
  state?: string
  ports?: Record<string, { HostIp: string; HostPort: string }[] | null>
}

let containers: FakeContainer[] = []
let versionBehaviour: 'ok' | 'daemon-down' | 'missing-binary' = 'ok'
let stopBehaviour: 'ok' | 'no-such-container' | 'timeout' | 'other-failure' = 'ok'

function fakeCli(): DockerCli {
  return {
    async run(args: string[]): Promise<DockerResult> {
      const ok = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
      if (args[0] === 'version') {
        if (versionBehaviour === 'missing-binary') {
          return { ok: false, stdout: '', stderr: 'ENOENT', exitCode: -127 }
        }
        if (versionBehaviour === 'daemon-down') {
          return {
            ok: false,
            stdout: JSON.stringify({ Client: { Version: '26.1.4' } }),
            stderr: 'Cannot connect to the Docker daemon',
            exitCode: 1,
          }
        }
        return ok(JSON.stringify({ Client: { Version: '26.1.4' }, Server: { Version: '26.1.4' } }))
      }
      if (args[0] === 'ps') {
        return ok(containers.map((c) => c.id).join('\n'))
      }
      if (args[0] === 'inspect') {
        const ids = args.slice(5)
        const lines = ids
          .map((id) => containers.find((c) => c.id === id))
          .filter((c): c is FakeContainer => !!c)
          .map((c) =>
            JSON.stringify({
              Id: c.id,
              Name: `/${c.name}`,
              Config: { Labels: c.labels ?? {} },
              State: { Status: c.state ?? 'running' },
              NetworkSettings: { Ports: c.ports ?? {} },
            }),
          )
        return ok(lines.join('\n'))
      }
      if (args[0] === 'stop') {
        if (stopBehaviour === 'no-such-container') {
          return { ok: false, stdout: '', stderr: 'Error: No such container: x', exitCode: 1 }
        }
        if (stopBehaviour === 'timeout') {
          return { ok: false, stdout: '', stderr: '', exitCode: -1 }
        }
        if (stopBehaviour === 'other-failure') {
          return { ok: false, stdout: '', stderr: 'permission denied', exitCode: 1 }
        }
        return ok(args[1] ?? '')
      }
      throw new Error(`unexpected argv in test fake: ${args.join(' ')}`)
    },
    stream(): DockerStream {
      throw new Error('stream() is not used in this file')
    },
  }
}

beforeEach(() => {
  testEnv.DOCKER_ENABLED = true
  projectRows = [projectDto]
  sessionRows = []
  containers = []
  versionBehaviour = 'ok'
  stopBehaviour = 'ok'
  activeOperation = undefined
  lockScopeChecks.length = 0
})

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 200, message: '' }
  } catch (error) {
    const { AppError } = await import(`${B}/lib/errors.ts`)
    if (error instanceof AppError) return { status: error.status, message: error.message }
    throw error
  }
}

// --- GET /docker/containers (getSystemDockerState) ----------------------------

test('lists every container on the host, ordered by name ascending', async () => {
  containers = [
    { id: 'b'.repeat(64), name: 'zeta' },
    { id: 'a'.repeat(64), name: 'alpha' },
  ]
  const state = await getSystemDockerState(fakeCli())
  expect(state.enabled).toBe(true)
  expect(state.daemon).toEqual({ cliInstalled: true, available: true, version: '26.1.4', error: null })
  expect(state.containers.map((c) => c.name)).toEqual(['alpha', 'zeta'])
})

test('a missing docker binary reports cliInstalled: false and an empty list, not a throw', async () => {
  versionBehaviour = 'missing-binary'
  const state = await getSystemDockerState(fakeCli())
  expect(state.daemon.cliInstalled).toBe(false)
  expect(state.daemon.available).toBe(false)
  expect(state.containers).toEqual([])
})

test('a daemon that is down reports available: false and an empty list, not a throw', async () => {
  versionBehaviour = 'daemon-down'
  const state = await getSystemDockerState(fakeCli())
  expect(state.daemon.cliInstalled).toBe(true)
  expect(state.daemon.available).toBe(false)
  expect(state.containers).toEqual([])
})

test('enabled: false still returns a real container list — reads are never gated', async () => {
  testEnv.DOCKER_ENABLED = false
  containers = [{ id: 'a'.repeat(64), name: 'alpha' }]
  const state = await getSystemDockerState(fakeCli())
  expect(state.enabled).toBe(false)
  expect(state.containers).toHaveLength(1)
})

test('a container carries its owner, ports (deduped, no hostIp) and raw composeProject label', async () => {
  containers = [
    {
      id: 'a'.repeat(64),
      name: 'agentoo-demo',
      labels: { 'com.agentoo.project': 'demo', 'com.agentoo.managed': '1' },
      ports: {
        '80/tcp': [
          { HostIp: '0.0.0.0', HostPort: '8080' },
          { HostIp: '::', HostPort: '8080' },
        ],
      },
    },
  ]
  const state = await getSystemDockerState(fakeCli())
  const [c] = state.containers
  expect(c?.ports).toEqual([8080])
  expect(c?.owner).toEqual({
    kind: 'dockerfile',
    projectId: PROJECT_ID,
    projectName: 'Demo',
    projectSlug: 'demo',
    sessionId: null,
    sessionTitle: null,
    branch: null,
  })
  expect(c?.composeProject).toBeNull()
  expect(JSON.stringify(c)).not.toContain('HostIp')
  expect(JSON.stringify(c)).not.toContain('hostIp')
})

test('an unowned container (foreign slug, or none at all) reports owner: null', async () => {
  containers = [
    { id: 'a'.repeat(64), name: 'postgres', labels: { 'org.opencontainers.image.title': 'postgres' } },
  ]
  const state = await getSystemDockerState(fakeCli())
  expect(state.containers[0]?.owner).toBeNull()
})

// --- POST /docker/containers/{id}/stop (stopSystemContainer) ------------------

const CID = 'a'.repeat(64)

test('403 when DOCKER_ENABLED is false, before any docker call', async () => {
  testEnv.DOCKER_ENABLED = false
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(403)
  expect(result.message).toContain('DOCKER_ENABLED=false')
})

test('503 when the docker binary is missing', async () => {
  versionBehaviour = 'missing-binary'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(503)
  expect(result.message).toContain('not installed')
})

test('503 when the daemon is unreachable', async () => {
  versionBehaviour = 'daemon-down'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(503)
  expect(result.message).toContain('Cannot connect to the Docker daemon')
})

test('404 when the container does not exist', async () => {
  containers = [] // nothing to inspect
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(404)
})

test('409 when a docker operation is already in flight for the container\'s (compose/dockerfile) scope', async () => {
  containers = [
    {
      id: CID,
      name: 'agentoo-demo',
      labels: { 'com.agentoo.project': 'demo', 'com.agentoo.managed': '1' },
    },
  ]
  activeOperation = '77777777-7777-4777-8777-777777777777'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(409)
  expect(result.message).toContain('77777777-7777-4777-8777-777777777777')
  expect(lockScopeChecks).toEqual([PROJECT_ID])
})

test('200: stops an owned container and returns its fresh state', async () => {
  containers = [
    {
      id: CID,
      name: 'agentoo-demo',
      labels: { 'com.agentoo.project': 'demo', 'com.agentoo.managed': '1' },
      state: 'running',
    },
  ]
  // stopSystemContainer re-inspects after stopping; the fake daemon has no
  // state machine, so this only proves the call succeeds end to end and
  // returns the owner alongside it — state transition itself is inspect.ts's
  // own concern, covered elsewhere.
  const container = await stopSystemContainer(CID, fakeCli())
  expect(container.id).toBe(CID)
  expect(container.owner?.projectSlug).toBe('demo')
})

test('200: stopping an already-stopped container is still idempotent', async () => {
  containers = [{ id: CID, name: 'agentoo-demo', state: 'exited' }]
  const container = await stopSystemContainer(CID, fakeCli())
  expect(container.id).toBe(CID)
  expect(container.state).toBe('exited')
})

test('404 when the daemon reports "No such container" at stop time', async () => {
  containers = [{ id: CID, name: 'agentoo-demo' }]
  stopBehaviour = 'no-such-container'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(404)
})

test('502 on a stop timeout, naming that the container may still be stopping', async () => {
  containers = [{ id: CID, name: 'agentoo-demo' }]
  stopBehaviour = 'timeout'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(502)
  expect(result.message).toContain('may still be stopping')
})

test('502 on any other stop failure, quoting the daemon', async () => {
  containers = [{ id: CID, name: 'agentoo-demo' }]
  stopBehaviour = 'other-failure'
  const result = await statusOf(stopSystemContainer(CID, fakeCli()))
  expect(result.status).toBe(502)
  expect(result.message).toContain('permission denied')
})

test('no lock check at all for an unowned container — it just stops', async () => {
  containers = [{ id: CID, name: 'random-postgres' }]
  await stopSystemContainer(CID, fakeCli())
  expect(lockScopeChecks).toEqual([])
})

test('stop with a session-scoped owner checks the session-scoped lock key, not the repo one', async () => {
  const sessionId = '33333333-3333-4333-8333-333333333333'
  sessionRows = [
    {
      id: sessionId,
      projectId: PROJECT_ID,
      title: 'S',
      branch: 'agentoo/s-33333333',
      worktreePath: '/opt/agentoo/projects/demo/worktrees/33333333-3333-4333-8333-333333333333',
    },
  ]
  containers = [
    {
      id: CID,
      name: `agentoo-demo_s-${sessionId.replace(/-/g, '').slice(0, 12)}`,
      labels: {
        'com.agentoo.project': 'demo',
        'com.agentoo.managed': '1',
        'com.agentoo.session': sessionId,
      },
    },
  ]
  await stopSystemContainer(CID, fakeCli())
  expect(lockScopeChecks).toEqual([`${PROJECT_ID}:s-${sessionId}`])
})
