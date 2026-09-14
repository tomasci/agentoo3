// Everything requestDockerUp/Stop/Restart/Down refuses before a job is ever
// queued, and what it puts in the job when it does not refuse.
//
// This is the layer docker-state.test.ts does not reach (it only exercises the
// read path) and docker-cleanup-safety.test.ts starts after (it begins with a
// job already built). The interesting properties here are the port-resolution
// precedence the DTO documents, the 503/403/409 gates, and the "a broken
// compose file must not strand running containers" asymmetry the feature's own
// schema description promises.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { AppError, notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-docker-gates-'))

// Spread into a plain object at capture time, not held as the module
// namespace: a namespace is a *live* view, so `mock.module(spec, () => ns)`
// in afterAll would hand back the mock it is meant to undo. Restoring from a
// snapshot is what actually puts the real module back for later files.
const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
}
const testEnv = { ...realEnv.env, PROJECTS_DIR: TEST_PROJECTS_DIR, DOCKER_ENABLED: true }
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
}))

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SLUG = 'demo'
const REPO = join(TEST_PROJECTS_DIR, SLUG, 'repo')

const projectDto = {
  id: PROJECT_ID,
  name: 'Demo',
  slug: SLUG,
  source: 'clone' as const,
  remoteUrl: 'https://example.com/demo.git',
  sourceName: null,
  sshKeyId: null,
  defaultBranch: null,
  status: 'ready' as const,
  lastError: null,
  recoveryCommands: null,
  path: REPO,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

// Spread from the real module, not hand-rolled: `mock.module` replaces this
// specifier for the whole test process, and projects/service.ts has real
// consumers elsewhere in this suite that need every one of its exports, not
// only getProject/listProjects. Restored in afterAll for the same reason.
const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  getProject: async (id: string) => {
    if (id !== PROJECT_ID) throw notFound('Project')
    return projectDto
  },
  listProjects: async () => [projectDto],
}))

// A session belonging to this project, controllable per test — see the
// worktree-scope tests below. `sessionsById` starts empty; each worktree-scope
// test registers exactly the session it needs.
interface SessionRow {
  id: string
  projectId: string
  worktreePath: string | null
}
let sessionsById: Record<string, SessionRow> = {}
// Spread from the real module, not a bare `{ getSessionLocation }`:
// sessions/service.ts exports far more than this (createSession,
// deleteSession, ...), and `mock.module` replaces this specifier for the
// whole test process -- a bare replace here used to leave any later file that
// imports one of those other exports failing with a `SyntaxError` the moment
// it happened to run in the same process as this one (session-stream.test.ts,
// session-export.test.ts, session-docker-teardown-gate.test.ts). Restored in
// afterAll for the same reason docker-scope.test.ts's own copy of this
// pattern gives.
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  getSessionLocation: async (id: string) => {
    const row = sessionsById[id]
    if (!row) throw notFound('Session')
    return row
  },
}))

// Captured before it is replaced, and restored in afterAll: `mock.module` is
// process-global, and a later file that exercises the real host-address path
// would otherwise silently get this canned empty list instead.
const realHosts = { ...(await import(`${B}/features/docker/hosts.ts`)) } as Record<string, unknown>
mock.module(`${B}/features/docker/hosts.ts`, () => ({
  ...realHosts,
  getHostAddresses: async () => [],
}))

const enqueued: Record<string, unknown>[] = []
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  QUEUE_IDEA_PROMPT: 'idea-prompt',
  QUEUE_IDEA_HANDOFF_SWEEP: 'idea-handoff-sweep',
  QUEUE_DOCKER_OP: 'docker-op',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
  turnEndedQueue: {},
  turnReconcileQueue: {},
  ideaPromptQueue: {},
  ideaHandoffSweepQueue: {},
  dockerOpQueue: {},
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
  enqueueDockerOp: async (job: Record<string, unknown>) => {
    enqueued.push(job)
    return {}
  },
}))

let activeOperation: string | undefined
const lockScopeChecks: string[] = []
// Spread from the real module (not a bare replace) and restored in afterAll:
// operations.ts exports far more than the handful this file's own tests
// reach (claimOperationLock, releaseOperationLock, markOperationRunning,
// appendOperationOutput, operationChannel, replayOperationOutput,
// subscribeOperationEvents, ...), all of which routes.ts, docker-op.worker.ts
// and other test files in this suite need untouched. Leaving this
// un-restored is the same class of hazard Defect 2 was: whichever test file
// happens to run after this one (including one that asks for the *real*
// operations.ts, like a lock-key test) would otherwise get this file's
// partial stand-in instead.
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
  createOperation: async (input: Record<string, unknown>) => ({
    ...input,
    status: 'queued',
    exitCode: null,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  }),
  finishOperation: async () => undefined,
  getOperation: async () => undefined,
  listOperationsForProject: async () => [],
}))

const {
  getProjectDockerState,
  requestDockerDown,
  requestDockerRestart,
  requestDockerStop,
  requestDockerUp,
} = await import(`${B}/features/docker/service.ts`)

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  mock.module(`${B}/features/docker/hosts.ts`, () => realHosts)
  mock.module(`${B}/features/docker/operations.ts`, () => realOperations)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

// --- the fake daemon ---------------------------------------------------------

interface CliBehaviour {
  /** Every call fails the way it does with no `docker` binary on the box. */
  allMissing?: boolean
  /** -127 is cli.ts's "docker is not installed" sentinel. */
  versionExit?: number
  serverPresent?: boolean
  /** false => `config --format json` fails, as a broken file or an old Compose does. */
  configOk?: boolean
  /** Names `config --services` still knows, even when the JSON form failed. */
  fallbackServices?: string[]
  imageExposedPorts?: string[] | null
}

let behaviour: CliBehaviour = {}

const fakeCli = {
  async run(args: string[]) {
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', exitCode: 0 })
    if (behaviour.allMissing) {
      return { ok: false, stdout: '', stderr: 'No such file or directory', exitCode: -127 }
    }
    if (args[0] === 'version') {
      const exit = behaviour.versionExit ?? 0
      const payload = JSON.stringify({
        Client: { Version: '26.1.4' },
        ...(behaviour.serverPresent === false ? {} : { Server: { Version: '26.1.4' } }),
      })
      if (exit === 0) return ok(payload)
      return {
        ok: false,
        stdout: exit === -127 ? '' : payload,
        stderr: exit === -127 ? 'No such file or directory' : 'Cannot connect to the Docker daemon',
        exitCode: exit,
      }
    }
    if (args[0] === 'compose' && args.includes('version')) return ok('{"version":"v2.24.0"}')
    if (args[0] === 'compose' && args.includes('config') && args.includes('--format')) {
      if (behaviour.configOk === false) {
        return { ok: false, stdout: '', stderr: 'yaml: line 3: did not find expected key', exitCode: 1 }
      }
      return ok(JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }))
    }
    if (args[0] === 'compose' && args.includes('--services')) {
      const names = behaviour.fallbackServices
      if (!names) return { ok: false, stdout: '', stderr: 'failed', exitCode: 1 }
      return ok(names.join('\n'))
    }
    if (args[0] === 'compose' && args.includes('ls')) return ok('[]')
    if (args[0] === 'image' && args[1] === 'inspect') {
      const ports = behaviour.imageExposedPorts
      if (!ports) return { ok: false, stdout: '', stderr: 'No such image', exitCode: 1 }
      return ok(
        JSON.stringify({
          Created: '2024-01-01T00:00:00Z',
          Config: { ExposedPorts: Object.fromEntries(ports.map((p) => [p, {}])) },
        }),
      )
    }
    if (args[0] === 'ps') return ok('')
    if (args[0] === 'inspect') return ok('')
    throw new Error(`unexpected argv in test fake: ${args.join(' ')}`)
  },
  stream(): never {
    throw new Error('stream() is not used in this file')
  },
}

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 202, message: '' }
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, message: error.message }
    throw error
  }
}

beforeEach(() => {
  enqueued.length = 0
  activeOperation = undefined
  lockScopeChecks.length = 0
  behaviour = {}
  testEnv.DOCKER_ENABLED = true
  sessionsById = {}
})

afterEach(async () => {
  await rm(join(TEST_PROJECTS_DIR, SLUG), { recursive: true, force: true })
})

async function withCompose(basename = 'compose.yaml', override?: string, dir = REPO) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, basename), 'services:\n  web:\n    image: nginx\n')
  if (override) await writeFile(join(dir, override), 'services:\n  web:\n    ports: ["80:80"]\n')
}

async function withDockerfile(text: string) {
  await mkdir(REPO, { recursive: true })
  await writeFile(join(REPO, 'Dockerfile'), text)
}

/** A session with its own worktree on disk, registered so resolveDockerScope
 * (docker/scope.ts) finds it — the worktree-scope twin of `withCompose`. */
async function withWorktree(sessionId: string, opts: { withCompose?: boolean } = {}) {
  const path = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  await mkdir(path, { recursive: true })
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: path }
  if (opts.withCompose) await withCompose('compose.yaml', undefined, path)
  return path
}

// --- the gates ---------------------------------------------------------------

test('the feature kill switch answers 403 before the project is even looked up', async () => {
  testEnv.DOCKER_ENABLED = false
  const result = await statusOf(requestDockerUp(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(403)
  expect(enqueued).toHaveLength(0)
})

test('an unknown project id is a 404', async () => {
  await withCompose()
  const result = await statusOf(
    requestDockerUp('99999999-9999-4999-8999-999999999999', undefined, {}, fakeCli),
  )
  expect(result.status).toBe(404)
})

test('a project with neither a compose file nor a Dockerfile is a 400', async () => {
  await mkdir(REPO, { recursive: true })
  const result = await statusOf(requestDockerUp(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(400)
  expect(result.message).toContain('No Dockerfile or compose file detected')
})

test('a missing docker binary is a 503 carrying install guidance, not a 500', async () => {
  await withCompose()
  behaviour = { versionExit: -127 }
  const result = await statusOf(requestDockerUp(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(503)
  expect(result.message).toContain('not installed')
  expect(enqueued).toHaveLength(0)
})

test('a docker daemon that is down is a 503 quoting its own error', async () => {
  await withCompose()
  behaviour = { versionExit: 1, serverPresent: false }
  const result = await statusOf(requestDockerUp(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(503)
  expect(result.message).toContain('Cannot connect to the Docker daemon')
})

test('a second operation while one is running is a 409 naming the first', async () => {
  await withCompose()
  activeOperation = '77777777-7777-4777-8777-777777777777'
  const result = await statusOf(requestDockerStop(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(409)
  expect(result.message).toContain('77777777-7777-4777-8777-777777777777')
  expect(enqueued).toHaveLength(0)
})

test('containerPort and hostPort are refused on a compose project', async () => {
  await withCompose()
  expect((await statusOf(requestDockerUp(PROJECT_ID, undefined, { containerPort: 3000 }, fakeCli))).status).toBe(400)
  expect((await statusOf(requestDockerUp(PROJECT_ID, undefined, { hostPort: 8080 }, fakeCli))).status).toBe(400)
  expect(enqueued).toHaveLength(0)
})

test('a services selection is refused on a plain-Dockerfile project', async () => {
  await withDockerfile('FROM nginx\nEXPOSE 80\n')
  const result = await statusOf(requestDockerStop(PROJECT_ID, undefined, { services: ['web'] }, fakeCli))
  expect(result.status).toBe(400)
  expect(result.message).toContain('only applies to a compose project')
})

test('compose wins when a project has both a compose file and a Dockerfile', async () => {
  await withCompose()
  await withDockerfile('FROM nginx\nEXPOSE 80\n')
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]?.mode).toBe('compose')
  expect(enqueued[0]?.dockerfileAbsPath).toBeUndefined()
})

// --- every compose basename reaches the job, with its override ------------------

for (const basename of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
  test(`${basename} is detected and passed as -f to the queued job`, async () => {
    await withCompose(basename)
    await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
    expect(enqueued[0]?.composeFiles).toEqual({ base: join(REPO, basename), override: undefined })
    expect(enqueued[0]?.composeProjectName).toBe('agentoo-demo')
  })
}

test('an override from the same family is paired with its base file', async () => {
  await withCompose('docker-compose.yml', 'docker-compose.override.yml')
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]?.composeFiles).toEqual({
    base: join(REPO, 'docker-compose.yml'),
    override: join(REPO, 'docker-compose.override.yml'),
  })
})

test('an override from the other family is not picked up', async () => {
  await withCompose('docker-compose.yml', 'compose.override.yaml')
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]?.composeFiles).toEqual({
    base: join(REPO, 'docker-compose.yml'),
    override: undefined,
  })
})

// --- port resolution for the plain-Dockerfile path --------------------------------

test('a Dockerfile with no EXPOSE and no built image is a 400 naming containerPort', async () => {
  await withDockerfile('FROM nginx\nCMD ["nginx"]\n')
  behaviour = { imageExposedPorts: null }
  const result = await statusOf(requestDockerUp(PROJECT_ID, undefined, {}, fakeCli))
  expect(result.status).toBe(400)
  expect(result.message).toContain('containerPort')
  expect(enqueued).toHaveLength(0)
})

test("the Dockerfile's EXPOSE is used when no image has been built", async () => {
  await withDockerfile('FROM nginx\nEXPOSE 8081/udp\n')
  behaviour = { imageExposedPorts: null }
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]).toMatchObject({ containerPort: 8081, protocol: 'udp', mode: 'dockerfile' })
})

test("a built image's ExposedPorts win over the Dockerfile's EXPOSE", async () => {
  await withDockerfile('FROM nginx\nEXPOSE 3000\n')
  behaviour = { imageExposedPorts: ['9090/tcp'] }
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]).toMatchObject({ containerPort: 9090, protocol: 'tcp' })
})

test('an explicit containerPort wins over both the image and the Dockerfile', async () => {
  await withDockerfile('FROM nginx\nEXPOSE 3000\n')
  behaviour = { imageExposedPorts: ['9090/tcp'] }
  await requestDockerUp(PROJECT_ID, undefined, { containerPort: 4000 }, fakeCli)
  expect(enqueued[0]).toMatchObject({ containerPort: 4000, protocol: 'tcp' })
})

test('hostPort is carried through untouched, and omitted means the daemon allocates', async () => {
  await withDockerfile('FROM nginx\nEXPOSE 3000\n')
  behaviour = { imageExposedPorts: null }
  await requestDockerUp(PROJECT_ID, undefined, { hostPort: 18080 }, fakeCli)
  expect(enqueued[0]?.hostPort).toBe(18080)

  enqueued.length = 0
  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  expect(enqueued[0]?.hostPort).toBeUndefined()
})

test('stop/restart/down on a Dockerfile project need no port at all', async () => {
  await withDockerfile('FROM nginx\nCMD ["nginx"]\n')
  behaviour = { imageExposedPorts: null }
  for (const request of [requestDockerStop, requestDockerRestart, requestDockerDown]) {
    enqueued.length = 0
    await request(PROJECT_ID, undefined, {}, fakeCli)
    expect(enqueued[0]?.containerPort).toBeUndefined()
  }
})

// --- membership, and what a broken compose file may still do ----------------------

test('an unknown service is refused, and a known one is accepted', async () => {
  await withCompose()
  const bad = await statusOf(requestDockerUp(PROJECT_ID, undefined, { services: ['nope'] }, fakeCli))
  expect(bad.status).toBe(400)
  expect(bad.message).toContain('Unknown service: nope')

  await requestDockerUp(PROJECT_ID, undefined, { services: ['web', 'db'] }, fakeCli)
  expect(enqueued[0]?.services).toEqual(['web', 'db'])
})

test('a broken compose file still allows a whole-stack stop and down', async () => {
  await withCompose()
  behaviour = { configOk: false }
  expect((await statusOf(requestDockerStop(PROJECT_ID, undefined, {}, fakeCli))).status).toBe(202)
  expect((await statusOf(requestDockerDown(PROJECT_ID, undefined, {}, fakeCli))).status).toBe(202)
  expect(enqueued).toHaveLength(2)
})

test('a Compose too old for `config --format json` can still stop one named service', async () => {
  // The names-only fallback exists precisely for this case (see args.ts's
  // composeConfigServicesArgs and compose-config.ts's own comment): `config
  // --format json` is unavailable, `config --services` still lists the
  // services. A named service that the fallback knows about must not be
  // rejected as unverifiable.
  await withCompose()
  behaviour = { configOk: false, fallbackServices: ['web', 'db'] }
  const result = await statusOf(requestDockerStop(PROJECT_ID, undefined, { services: ['web'] }, fakeCli))
  expect(result.status).toBe(202)
})

test('a broken compose file does not strand a running container behind a syntax error', async () => {
  // The contract this feature states for itself (schema.ts's dockerStateSchema
  // description: "so stop/down stay usable even when start/restart do not").
  // Stopping one named service of a stack whose file no longer parses is the
  // case that matters: the container is already running, its name is already
  // known to the daemon, and refusing leaves the user no way to stop it from
  // the dashboard.
  await withCompose()
  behaviour = { configOk: false, fallbackServices: ['web'] }
  const stop = await statusOf(requestDockerStop(PROJECT_ID, undefined, { services: ['web'] }, fakeCli))
  const down = await statusOf(requestDockerDown(PROJECT_ID, undefined, { services: ['web'] }, fakeCli))
  expect({ stop: stop.status, down: down.status }).toEqual({ stop: 202, down: 202 })
})

test('a queued job never carries a field the request invented', async () => {
  await withCompose()
  await requestDockerUp(
    PROJECT_ID,
    undefined,
    { services: ['web'], build: true, forceRecreate: true, removeOrphans: true },
    fakeCli,
  )
  const job = enqueued[0] ?? {}
  expect(job).toMatchObject({
    projectId: PROJECT_ID,
    slug: SLUG,
    mode: 'compose',
    kind: 'up',
    services: ['web'],
    projectPath: REPO,
    build: true,
    forceRecreate: true,
    removeOrphans: true,
  })
  expect(typeof job.operationId).toBe('string')
})

// --- the read path degrades rather than failing -------------------------------------

test('a box with no docker binary still answers with a full state object', async () => {
  await withCompose()
  behaviour = { allMissing: true }
  const state = await getProjectDockerState(PROJECT_ID, undefined, fakeCli)
  expect(state.daemon).toEqual({
    cliInstalled: false,
    available: false,
    version: null,
    composeVersion: null,
    error: null,
  })
  expect(state.detection.hasCompose).toBe(true)
  expect(state.composeProject).toBe('agentoo-demo')
  expect(state.services).toEqual([])
  expect(state.containers).toEqual([])
  expect(state.foreignStacks).toEqual([])
  expect(state.configError).toBeTruthy()
})

test('a daemon that is down is reported, with the client version still surfaced', async () => {
  await withCompose()
  behaviour = { versionExit: 1, serverPresent: false, configOk: false }
  const state = await getProjectDockerState(PROJECT_ID, undefined, fakeCli)
  expect(state.daemon.cliInstalled).toBe(true)
  expect(state.daemon.available).toBe(false)
  expect(state.daemon.version).toBe('26.1.4')
  expect(state.daemon.error).toContain('Cannot connect to the Docker daemon')
  expect(state.configError).toContain('did not find expected key')
})

test('a Dockerfile-only project reports its EXPOSE ports and an unbuilt image', async () => {
  await withDockerfile('FROM nginx\nEXPOSE 8080\nEXPOSE 9090/udp\n')
  behaviour = { imageExposedPorts: null }
  const state = await getProjectDockerState(PROJECT_ID, undefined, fakeCli)
  expect(state.dockerfilePorts).toEqual([
    { containerPort: 8080, protocol: 'tcp' },
    { containerPort: 9090, protocol: 'udp' },
  ])
  expect(state.image).toEqual({
    reference: 'agentoo/demo:latest',
    exists: false,
    builtAt: null,
    exposedPorts: [],
  })
  expect(state.composeProject).toBeNull()
})

test("a built image's exposed ports are reported alongside the Dockerfile's", async () => {
  await withDockerfile('FROM nginx\nEXPOSE 3000\n')
  behaviour = { imageExposedPorts: ['9090/tcp'] }
  const state = await getProjectDockerState(PROJECT_ID, undefined, fakeCli)
  expect(state.dockerfilePorts).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
  expect(state.image?.exists).toBe(true)
  expect(state.image?.exposedPorts).toEqual([{ containerPort: 9090, protocol: 'tcp' }])
})

// --- worktree scope: the same gates, one scope over -----------------------------

const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_PROJECT_SESSION_ID = '44444444-4444-4444-8444-444444444444'

test('up in a session scope reads the compose file from that worktree, not the repo', async () => {
  const worktree = await withWorktree(SESSION_ID, { withCompose: true })
  await withCompose('compose.yaml') // a different repo/ file — must not be the one used
  await requestDockerUp(PROJECT_ID, SESSION_ID, {}, fakeCli)
  expect(enqueued[0]?.projectPath).toBe(worktree)
  expect(enqueued[0]?.composeFiles).toEqual({ base: join(worktree, 'compose.yaml'), override: undefined })
  expect(enqueued[0]?.sessionId).toBe(SESSION_ID)
  expect(enqueued[0]?.slug).toBe(SLUG)
})

test('a session with no worktree of its own is a 400, not a silent fall-back to the repo', async () => {
  sessionsById[SESSION_ID] = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: null }
  const result = await statusOf(requestDockerUp(PROJECT_ID, SESSION_ID, {}, fakeCli))
  expect(result.status).toBe(400)
  expect(result.message).toContain('has no worktree of its own')
  expect(enqueued).toHaveLength(0)
})

test("a session belonging to a different project is a 404, the same as an unknown session", async () => {
  sessionsById[OTHER_PROJECT_SESSION_ID] = {
    id: OTHER_PROJECT_SESSION_ID,
    projectId: '99999999-9999-4999-8999-999999999999',
    worktreePath: '/tmp/somewhere',
  }
  await withCompose()
  const crossProject = await statusOf(
    requestDockerUp(PROJECT_ID, OTHER_PROJECT_SESSION_ID, {}, fakeCli),
  )
  const unknown = await statusOf(
    requestDockerUp(PROJECT_ID, '55555555-5555-4555-8555-555555555555', {}, fakeCli),
  )
  expect(crossProject.status).toBe(404)
  expect(crossProject).toEqual(unknown)
})

test('a worktree that is no longer on disk is a 409, not a 404', async () => {
  const path = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', SESSION_ID)
  sessionsById[SESSION_ID] = { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: path }
  // Deliberately never created on disk.
  await withCompose()
  const result = await statusOf(requestDockerUp(PROJECT_ID, SESSION_ID, {}, fakeCli))
  expect(result.status).toBe(409)
  expect(result.message).toContain('no longer on disk')
})

test("a session's operation lock is keyed independently of the project's repo scope", async () => {
  await withWorktree(SESSION_ID, { withCompose: true })
  await withCompose()

  await requestDockerUp(PROJECT_ID, undefined, {}, fakeCli)
  await requestDockerUp(PROJECT_ID, SESSION_ID, {}, fakeCli)

  expect(lockScopeChecks).toEqual([PROJECT_ID, `${PROJECT_ID}:s-${SESSION_ID}`])
})

test('getProjectDockerState in a session scope reports that session, not the repo', async () => {
  const worktree = await withWorktree(SESSION_ID, { withCompose: true })
  await withCompose() // the repo/'s own, unrelated compose file
  const state = await getProjectDockerState(PROJECT_ID, SESSION_ID, fakeCli)
  expect(state.sessionId).toBe(SESSION_ID)
  expect(state.scopePath).toBe(worktree)
  expect(state.projectPath).toBe(REPO)
  expect(state.composeProject).toBe(`agentoo-demo_s-${SESSION_ID.replace(/-/g, '').slice(0, 12)}`)
})
