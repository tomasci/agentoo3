// End to end through the service layer, with a fake DockerCli standing in
// for the daemon — this host has no docker daemon and this test must not
// depend on one. Redis (operations.ts) and hosts.ts's live tailscale/network
// reads are mocked out too, so this test is hermetic regardless of what is
// actually running on the box it executes on.
//
// `mock.module` replaces a specifier for the whole test process, not just
// this file — every `mock.module` call below is chosen with that in mind.
// Project data is faked by mocking features/projects/service.ts's
// getProject/listProjects rather than `@/db/client.ts` itself: nothing else
// in this codebase imports that feature-level module, so a leftover mock of
// it cannot affect any other test, whereas `@/db/client.ts` is imported
// almost everywhere. The one shared module this file cannot avoid touching
// (`@/env.ts`, for PROJECTS_DIR) is instead forwarded faithfully — see its
// own comment below for the specific way getting that wrong once broke a
// completely unrelated test.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { notFound } from '../src/lib/errors'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

// setup-env.ts points PROJECTS_DIR at a path this process cannot write to
// (it exercises a different fallback elsewhere) — this feature needs a real,
// writable directory tree to detect files in, so this test gets its own and
// overrides PROJECTS_DIR for it. Registered before docker/service.ts (or
// anything it pulls in) is ever imported below.
const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-docker-state-'))
// Both exports captured, not just `env`: `hasClaudeCredential` is a second,
// independent export of this module, and session-run.worker.ts reads it
// live on every `runTurn` call, from *whichever* project across the whole
// process last mocked this specifier — forwarding it unchanged is what keeps
// an unrelated, later test's own session turns from suddenly finding "no
// credential" and returning before ever reaching the code it means to
// exercise. Verified the hard way: hardcoding `false` here (a copy-paste
// that never asked why) failed turn-outcome.test.ts's own claim-clears-the-
// stale-verdict assertion, nowhere near this file, by cutting its `runTurn`
// off before the update it asserts on.
// Spread into a plain object rather than held as the module namespace: a
// namespace is a *live* view of the module, so after the mock.module below it
// would report the mock's own exports — and the afterAll restore, handing that
// same namespace back, would be a no-op that leaves PROJECTS_DIR pointing at
// this file's (by then deleted) temp directory for every file loaded after it.
const real = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
}
const testEnv = { ...real.env, PROJECTS_DIR: TEST_PROJECTS_DIR, DOCKER_ENABLED: true }
mock.module(`${B}/env.ts`, () => ({ env: testEnv, hasClaudeCredential: real.hasClaudeCredential }))
afterAll(async () => {
  mock.module(`${B}/env.ts`, () => real)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/docker/operations.ts`, () => realOperations)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

const FIXTURES = join(import.meta.dir, 'fixtures', 'docker')

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SLUG = 'demo'
const PROJECT_ROOT = join(TEST_PROJECTS_DIR, SLUG)
const PROJECT_REPO = join(PROJECT_ROOT, 'repo')
const COMPOSE_FILE = join(PROJECT_REPO, 'compose.yaml')

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
  path: PROJECT_REPO,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

// Spread from the real module, not hand-rolled: `mock.module` replaces this
// specifier for the whole test process, and projects/service.ts has real
// consumers elsewhere in this suite that need every one of its exports.
// Restored in afterAll for the same reason.
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

const CANNED_HOSTS = [{ kind: 'loopback', label: 'localhost', host: '127.0.0.1' }]
mock.module(`${B}/features/docker/hosts.ts`, () => ({
  getHostAddresses: async () => CANNED_HOSTS,
}))

// docker/service.ts imports from '@/queue' at module scope (enqueueDockerOp),
// which otherwise constructs every real BullMQ Queue in queue/index.ts, each
// a live ioredis connection this test never needs and never starts a fake
// server for. Every export is stubbed, not only the ones this file's own
// code path reaches: unlike features/projects/service.ts above, this
// specifier genuinely is imported all over the app (session-run.worker.ts
// among others), so a name missing here would be a `SyntaxError` for code
// that has nothing to do with this feature. Mirrors queue/index.ts's export
// list; every value is a safe no-op, matching the convention every other
// test file in this suite already uses for this same module.
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
  enqueueDockerOp: async () => ({}),
}))

// Spread from the real module (not a bare replace) and restored in afterAll:
// operations.ts exports far more than the handful this file's own tests
// reach, and leaving this un-restored is the same class of hazard Defect 2
// was -- whichever test file happens to run after this one (including one
// that asks for the *real* operations.ts, like a lock-key test) would
// otherwise get this file's partial stand-in instead.
const realOperations = { ...(await import(`${B}/features/docker/operations.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/docker/operations.ts`, () => ({
  ...realOperations,
  activeOperationForScope: async () => undefined,
  dockerLockScope: (projectId: string, sessionId: string | null) =>
    sessionId === null ? projectId : `${projectId}:s-${sessionId}`,
  createOperation: async () => {
    throw new Error('not used in this test')
  },
  finishOperation: async () => undefined,
  getOperation: async () => undefined,
  listOperationsForProject: async () => [],
}))

const { getProjectDockerState, listDockerDetections } = await import(
  `${B}/features/docker/service.ts`
)

const inspectNdjson = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
const [webRaw, workerRaw] = inspectNdjson
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { Id: string })
const versionJson = await readFile(join(FIXTURES, 'version.json'), 'utf8')
const composeConfigJson = await readFile(join(FIXTURES, 'compose-config.json'), 'utf8')

interface FakeResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

function fakeCli(overrides: { config?: Partial<FakeResult> } = {}) {
  return {
    async run(args: string[]): Promise<FakeResult> {
      const ok = (stdout: string): FakeResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
      if (args[0] === 'version') return ok(versionJson)
      if (args[0] === 'compose' && args.includes('version')) {
        return ok(JSON.stringify({ version: 'v2.24.0' }))
      }
      if (args[0] === 'compose' && args.includes('--services')) {
        // A genuinely broken compose file fails the same way here as it did
        // for `config --format json` — this is what keeps `services: []` in
        // the "broken compose file" scenario below, per the brief's own
        // contract for GET /projects/{id}/docker.
        return overrides.config
          ? { ok: false, stdout: '', stderr: '', exitCode: 1, ...overrides.config }
          : ok('')
      }
      if (args[0] === 'compose' && args.includes('config') && args.includes('--format')) {
        return overrides.config
          ? { ok: false, stdout: '', stderr: '', exitCode: 1, ...overrides.config }
          : ok(composeConfigJson)
      }
      if (args[0] === 'compose' && args.includes('ls')) {
        return ok(
          JSON.stringify([
            { Name: 'repo', Status: 'running(2)', ConfigFiles: COMPOSE_FILE },
            { Name: 'agentoo-demo', Status: 'running(2)', ConfigFiles: COMPOSE_FILE },
          ]),
        )
      }
      if (args[0] === 'ps') {
        const filter = args[args.indexOf('--filter') + 1] ?? ''
        // `ps -aq` prints docker's 12-char short id, never the 64-char id
        // `inspect` reports back as `.Id` below -- kept deliberately distinct
        // here for fidelity to the real CLI. Note this alone does not catch
        // containers.ts's former `composeIds.has(raw.Id)` defect: at REPO
        // scope (all calls in this file) the id mismatch sends a compose
        // container down the same fallback a genuinely-owned container takes
        // (no `com.agentoo.session` label, `ref.sessionId === null`, so
        // `session === undefined` was still true), so it stayed listed by
        // coincidence. Worktree scope has no such coincidence -- see
        // docker-scope-isolation.test.ts and docker-containers-listing.test.ts,
        // which exercise a real session id and do fail against the old code.
        if (filter.includes('com.docker.compose.project')) {
          return ok(`${webRaw!.Id.slice(0, 12)}\n${workerRaw!.Id.slice(0, 12)}\n`)
        }
        return ok('') // no plain-Dockerfile-managed container for this project
      }
      if (args[0] === 'inspect') return ok(`${JSON.stringify(webRaw)}\n${JSON.stringify(workerRaw)}\n`)
      throw new Error(`unexpected argv in test fake: ${args.join(' ')}`)
    },
    stream(): never {
      throw new Error('not used in this test')
    },
  }
}

afterEach(async () => {
  await rm(PROJECT_ROOT, { recursive: true, force: true })
})

test('a compose project assembles daemon, services, containers, foreignStacks and hosts', async () => {
  await mkdir(PROJECT_REPO, { recursive: true })
  await writeFile(COMPOSE_FILE, '# placeholder — detection only stats existence\n')

  const state = await getProjectDockerState(PROJECT_ID, undefined, fakeCli())

  expect(state.projectId).toBe(PROJECT_ID)
  expect(state.projectPath).toBe(PROJECT_REPO)
  expect(state.composeProject).toBe('agentoo-demo')
  expect(state.daemon).toEqual({
    cliInstalled: true,
    available: true,
    version: '26.1.4',
    composeVersion: 'v2.24.0',
    error: null,
  })
  expect(state.detection.hasCompose).toBe(true)
  expect(state.detection.hasDockerfile).toBe(false)
  expect(state.configError).toBeNull()

  const web = state.services.find((s) => s.name === 'web')
  expect(web?.state).toBe('running')
  expect(web?.containerIds).toEqual([webRaw!.Id])

  const worker = state.services.find((s) => s.name === 'worker')
  expect(worker?.state).toBe('stopped')
  expect(worker?.containerIds).toEqual([workerRaw!.Id])

  const db = state.services.find((s) => s.name === 'db')
  expect(db?.state).toBe('absent')
  expect(db?.containerIds).toEqual([])

  expect(state.containers).toHaveLength(2)
  expect(state.containers.map((c) => c.id).sort()).toEqual([webRaw!.Id, workerRaw!.Id].sort())

  expect(state.image).toBeNull()
  expect(state.dockerfilePorts).toEqual([])

  expect(state.foreignStacks).toEqual([{ name: 'repo', status: 'running(2)', configFiles: [COMPOSE_FILE] }])

  expect(state.hosts).toEqual(CANNED_HOSTS)
  expect(state.activeOperationId).toBeNull()
  expect(typeof state.fetchedAt).toBe('string')
})

test('a broken compose file still answers with configError set and containers still populated', async () => {
  await mkdir(PROJECT_REPO, { recursive: true })
  await writeFile(COMPOSE_FILE, '# placeholder\n')

  const cli = fakeCli({ config: { stderr: 'yaml: line 3: did not find expected key' } })
  const state = await getProjectDockerState(PROJECT_ID, undefined, cli)

  expect(state.configError).toContain('did not find expected key')
  expect(state.services).toEqual([])
  // Containers still come from `docker ps`, independent of the broken config.
  expect(state.containers).toHaveLength(2)
})

test('a project with no compose file and no Dockerfile reports an empty, quiet state', async () => {
  await mkdir(PROJECT_REPO, { recursive: true })

  const cli = {
    async run(args: string[]) {
      if (args[0] === 'version') return { ok: true, stdout: versionJson, stderr: '', exitCode: 0 }
      if (args[0] === 'ps') return { ok: true, stdout: '', stderr: '', exitCode: 0 }
      // Reached only for `docker compose version` (daemon.composeVersion is
      // read whenever the CLI is installed, regardless of whether this
      // project has a compose file at all) — never for config/ls, which only
      // run when detection.hasCompose is true.
      if (args[0] === 'compose') return { ok: false, stdout: '', stderr: 'no compose here', exitCode: 1 }
      throw new Error(`unexpected argv in test fake: ${args.join(' ')}`)
    },
    stream(): never {
      throw new Error('not used in this test')
    },
  }

  const state = await getProjectDockerState(PROJECT_ID, undefined, cli)
  expect(state.detection.hasCompose).toBe(false)
  expect(state.detection.hasDockerfile).toBe(false)
  expect(state.composeProject).toBeNull()
  expect(state.services).toEqual([])
  expect(state.containers).toEqual([])
  expect(state.foreignStacks).toEqual([])
})

test('GET /docker/detection lists every project by slug when enabled', async () => {
  await mkdir(PROJECT_REPO, { recursive: true })
  await writeFile(COMPOSE_FILE, '')
  const result = await listDockerDetections()
  expect(result.enabled).toBe(true)
  expect(result.projects).toEqual([
    {
      projectId: PROJECT_ID,
      slug: SLUG,
      hasCompose: true,
      hasDockerfile: false,
      composeFile: 'compose.yaml',
      composeOverrideFile: null,
      dockerfile: null,
    },
  ])
})

test('GET /docker/detection reports enabled:false and no projects when DOCKER_ENABLED=false', async () => {
  mock.module(`${B}/env.ts`, () => ({ env: { ...testEnv, DOCKER_ENABLED: false } }))
  try {
    const result = await listDockerDetections()
    expect(result).toEqual({ enabled: false, projects: [] })
  } finally {
    // Restore so nothing imported after this file in the same test run sees
    // docker disabled by surprise.
    mock.module(`${B}/env.ts`, () => ({ env: testEnv }))
  }
})
