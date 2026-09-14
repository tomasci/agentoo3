// What the worker actually executes, argv by argv — the independent pass over
// the one property in this feature that can destroy data if it is wrong:
// Cleanup must remove containers (and, for compose, the network compose made)
// and must never remove an image or a volume that was not explicitly asked
// for.
//
// docker-args.test.ts pins the pure builders. This file pins the *sequence*
// the worker assembles from them for every (mode, kind) pair, and the Redis
// lock discipline around it, by driving `runDockerOp` with a recording fake
// DockerCli. No daemon is involved and none is needed: the assertion is on
// the command line, which is the thing that would do the damage.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

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

// An in-memory stand-in for the Redis-backed operation record and lock.
// Restored in afterAll: `mock.module` is process-global, and docker-state.test.ts
// registers its own mock of this same specifier.
// Spread at capture time: a module namespace is a live view, so holding the
// namespace itself and handing it back in afterAll would restore the mock
// rather than the module.
const realOperations = { ...(await import(`${B}/features/docker/operations.ts`)) } as Record<
  string,
  unknown
>

interface LockEvent {
  kind: 'claim' | 'release'
  projectId: string
  operationId: string
  ttlMs?: number
}
const lockEvents: LockEvent[] = []
const finished: { operationId: string; status: string; exitCode: number | null; error: string | null }[] = []
const output: { operationId: string; stream: string; text: string }[] = []
let running: string[] = []
let claimAllowed = true

mock.module(`${B}/features/docker/operations.ts`, () => ({
  ...realOperations,
  claimOperationLock: async (projectId: string, operationId: string, ttlMs: number) => {
    lockEvents.push({ kind: 'claim', projectId, operationId, ttlMs })
    return claimAllowed
  },
  releaseOperationLock: async (projectId: string, operationId: string) => {
    lockEvents.push({ kind: 'release', projectId, operationId })
  },
  markOperationRunning: async (operationId: string) => {
    running.push(operationId)
    return undefined
  },
  finishOperation: async (
    operationId: string,
    status: string,
    exitCode: number | null,
    error: string | null,
  ) => {
    finished.push({ operationId, status, exitCode, error })
    return undefined
  },
  appendOperationOutput: async (operationId: string, line: { stream: string; text: string }) => {
    output.push({ operationId, ...line })
  },
}))

const { runDockerOp } = await import(`${B}/queue/docker-op.worker.ts`)
const { env } = (await import(`${B}/env.ts`)) as { env: { DOCKER_OP_TIMEOUT_MS: number } }

afterAll(() => {
  mock.module(`${B}/features/docker/operations.ts`, () => realOperations)
})

// --- the recording fake CLI ------------------------------------------------------

interface Invocation {
  args: string[]
  cwd?: string
}
let invocations: Invocation[] = []
/** Exit codes to hand back, in order; anything past the end exits 0. */
let exitCodes: number[] = []
let imageExists = false

const fakeCli = {
  async run(args: string[], options: { cwd?: string } = {}) {
    invocations.push({ args, cwd: options.cwd })
    if (args[0] === 'image' && args[1] === 'inspect') {
      return imageExists
        ? { ok: true, stdout: JSON.stringify({ Created: '2024-01-01T00:00:00Z' }), stderr: '', exitCode: 0 }
        : { ok: false, stdout: '', stderr: 'No such image', exitCode: 1 }
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 }
  },
  stream(args: string[], options: { cwd?: string } = {}) {
    invocations.push({ args, cwd: options.cwd })
    const code = exitCodes.length > 0 ? (exitCodes.shift() ?? 0) : 0
    return {
      lines: (async function* () {
        yield { stream: 'stdout' as const, line: `ran ${args.slice(0, 2).join(' ')}` }
      })(),
      close() {},
      exited: Promise.resolve(code),
    }
  },
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_PATH = '/projects/demo/repo'
const COMPOSE_BASE = `${PROJECT_PATH}/compose.yaml`
const COMPOSE_OVERRIDE = `${PROJECT_PATH}/compose.override.yaml`

type Job = Parameters<typeof runDockerOp>[0]

function composeJob(overrides: Partial<Job> = {}): Job {
  return {
    operationId: '33333333-3333-4333-8333-333333333333',
    projectId: PROJECT_ID,
    sessionId: null,
    slug: 'demo',
    mode: 'compose',
    kind: 'down',
    services: [],
    projectPath: PROJECT_PATH,
    composeProjectName: 'agentoo-demo',
    composeFiles: { base: COMPOSE_BASE },
    ...overrides,
  } as Job
}

function dockerfileJob(overrides: Partial<Job> = {}): Job {
  return {
    operationId: '44444444-4444-4444-8444-444444444444',
    projectId: PROJECT_ID,
    sessionId: null,
    slug: 'demo',
    mode: 'dockerfile',
    kind: 'down',
    services: [],
    projectPath: PROJECT_PATH,
    dockerfileAbsPath: `${PROJECT_PATH}/Dockerfile`,
    ...overrides,
  } as Job
}

/** Every argv the worker ran, excluding the read-only `image inspect` probe
 *  the dockerfile `up` path makes before deciding whether to build. */
function mutations(): string[][] {
  return invocations
    .filter((i) => !(i.args[0] === 'image' && i.args[1] === 'inspect'))
    .map((i) => i.args)
}

/** Nothing the worker runs may remove an image or a volume unless the request
 *  explicitly asked for it. */
function assertNothingDestructive(argvs: string[][]) {
  const destructive = ['--rmi', 'rmi', '-v', '--volumes', 'prune', 'rmv']
  for (const argv of argvs) {
    for (const token of destructive) {
      // Reported as an object so a failure names the argv and the token,
      // rather than only "true is not false".
      expect({ argv, token, present: argv.includes(token) }).toEqual({ argv, token, present: false })
    }
    // `docker volume rm` / `docker image rm` are two-word subcommands.
    expect({ argv, pair: argv.slice(0, 2).join(' ') }).not.toEqual({ argv, pair: 'volume rm' })
    expect({ argv, pair: argv.slice(0, 2).join(' ') }).not.toEqual({ argv, pair: 'image rm' })
  }
}

beforeEach(() => {
  invocations = []
  exitCodes = []
  lockEvents.length = 0
  finished.length = 0
  output.length = 0
  running = []
  claimAllowed = true
  imageExists = false
})

// --- compose cleanup --------------------------------------------------------------

test('compose down removes containers and the network, and nothing else', async () => {
  await runDockerOp(composeJob(), fakeCli)
  expect(mutations()).toEqual([
    ['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo', 'down'],
  ])
  assertNothingDestructive(mutations())
  expect(finished).toEqual([
    { operationId: composeJob().operationId, status: 'succeeded', exitCode: 0, error: null },
  ])
})

test('compose down with an override file passes both -f, base first', async () => {
  await runDockerOp(
    composeJob({ composeFiles: { base: COMPOSE_BASE, override: COMPOSE_OVERRIDE } }),
    fakeCli,
  )
  expect(mutations()[0]).toEqual([
    'compose',
    '-f',
    COMPOSE_BASE,
    '-f',
    COMPOSE_OVERRIDE,
    '-p',
    'agentoo-demo',
    'down',
  ])
})

test('compose down scoped to services leaves the rest of the stack alone', async () => {
  await runDockerOp(composeJob({ services: ['web', 'worker'] }), fakeCli)
  expect(mutations()[0]).toEqual([
    'compose',
    '-f',
    COMPOSE_BASE,
    '-p',
    'agentoo-demo',
    'down',
    'web',
    'worker',
  ])
  assertNothingDestructive(mutations())
})

test('removeVolumes and removeImages appear only when the request asked for them', async () => {
  await runDockerOp(composeJob({ removeVolumes: false, removeImages: false }), fakeCli)
  expect(mutations()[0]).toEqual(['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo', 'down'])

  invocations = []
  await runDockerOp(composeJob({ removeVolumes: true, removeImages: true }), fakeCli)
  expect(mutations()[0]).toEqual([
    'compose',
    '-f',
    COMPOSE_BASE,
    '-p',
    'agentoo-demo',
    'down',
    '-v',
    '--rmi',
    'all',
  ])
})

test('every compose subcommand carries -f and -p explicitly', async () => {
  for (const kind of ['up', 'stop', 'restart', 'down'] as const) {
    invocations = []
    await runDockerOp(composeJob({ kind }), fakeCli)
    const argv = mutations()[0] ?? []
    expect(argv.slice(0, 5)).toEqual(['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo'])
    expect(argv[5]).toBe(kind)
  }
})

test('compose up is detached and carries no flag it was not asked for', async () => {
  await runDockerOp(composeJob({ kind: 'up' }), fakeCli)
  expect(mutations()[0]).toEqual(['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo', 'up', '-d'])
  assertNothingDestructive(mutations())
})

test('compose up runs in the project directory', async () => {
  await runDockerOp(composeJob({ kind: 'up' }), fakeCli)
  expect(invocations[0]?.cwd).toBe(PROJECT_PATH)
})

test('compose stop never removes anything', async () => {
  await runDockerOp(composeJob({ kind: 'stop', services: ['db'] }), fakeCli)
  expect(mutations()).toEqual([
    ['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo', 'stop', 'db'],
  ])
  assertNothingDestructive(mutations())
})

// --- the plain-Dockerfile path ------------------------------------------------------

test('dockerfile cleanup is stop then rm, and never touches the built image', async () => {
  await runDockerOp(dockerfileJob({ kind: 'down' }), fakeCli)
  expect(mutations()).toEqual([
    ['stop', 'agentoo-demo'],
    ['rm', 'agentoo-demo'],
  ])
  assertNothingDestructive(mutations())
  expect(mutations().flat()).not.toContain('agentoo/demo:latest')
})

test('a failing docker stop stops the sequence rather than forcing rm', async () => {
  exitCodes = [1]
  await runDockerOp(dockerfileJob({ kind: 'down' }), fakeCli)
  expect(mutations()).toEqual([['stop', 'agentoo-demo']])
  expect(finished[0]).toEqual({
    operationId: dockerfileJob().operationId,
    status: 'failed',
    exitCode: 1,
    error: 'docker stop exited with code 1',
  })
})

test('dockerfile up with no image built yet builds first, then runs', async () => {
  imageExists = false
  await runDockerOp(
    dockerfileJob({ kind: 'up', containerPort: 3000, protocol: 'tcp' }),
    fakeCli,
  )
  expect(mutations()).toEqual([
    ['build', '-t', 'agentoo/demo:latest', '-f', `${PROJECT_PATH}/Dockerfile`, PROJECT_PATH],
    [
      'run',
      '-d',
      '--name',
      'agentoo-demo',
      '--label',
      'com.agentoo.project=demo',
      '--label',
      'com.agentoo.managed=1',
      '-p',
      '0:3000/tcp',
      'agentoo/demo:latest',
    ],
  ])
})

test('dockerfile up with an existing image and no --build skips the build', async () => {
  imageExists = true
  await runDockerOp(dockerfileJob({ kind: 'up', containerPort: 3000, protocol: 'tcp' }), fakeCli)
  expect(mutations().map((a) => a[0])).toEqual(['run'])
})

test('dockerfile up with build requested rebuilds even when an image exists', async () => {
  imageExists = true
  await runDockerOp(
    dockerfileJob({ kind: 'up', containerPort: 3000, protocol: 'tcp', build: true }),
    fakeCli,
  )
  expect(mutations().map((a) => a[0])).toEqual(['build', 'run'])
})

test('an explicit hostPort is published instead of letting the daemon allocate', async () => {
  imageExists = true
  await runDockerOp(
    dockerfileJob({ kind: 'up', containerPort: 3000, hostPort: 18080, protocol: 'udp' }),
    fakeCli,
  )
  expect(mutations()[0]).toContain('18080:3000/udp')
})

test('a run never carries a restart policy', async () => {
  imageExists = true
  await runDockerOp(dockerfileJob({ kind: 'up', containerPort: 3000, protocol: 'tcp' }), fakeCli)
  expect(mutations()[0]).not.toContain('--restart')
})

test('dockerfile restart restarts the container, removing nothing', async () => {
  await runDockerOp(dockerfileJob({ kind: 'restart' }), fakeCli)
  expect(mutations()).toEqual([['restart', 'agentoo-demo']])
  assertNothingDestructive(mutations())
})

// --- the per-project lock -------------------------------------------------------------

test('the lock is claimed with the operation timeout and released on success', async () => {
  const job = composeJob()
  await runDockerOp(job, fakeCli)
  expect(lockEvents).toEqual([
    { kind: 'claim', projectId: PROJECT_ID, operationId: job.operationId, ttlMs: env.DOCKER_OP_TIMEOUT_MS },
    { kind: 'release', projectId: PROJECT_ID, operationId: job.operationId },
  ])
})

test('the lock is released when a step fails', async () => {
  exitCodes = [17]
  const job = composeJob()
  await runDockerOp(job, fakeCli)
  expect(lockEvents.filter((e) => e.kind === 'release')).toHaveLength(1)
  expect(finished[0]?.status).toBe('failed')
  expect(finished[0]?.exitCode).toBe(17)
})

test('the lock is released when the operation throws before any docker call', async () => {
  // A compose job with no files at all: stepsFor throws, inside the try, so
  // only the `finally` can release the lock.
  const job = composeJob({ composeFiles: undefined, composeProjectName: undefined })
  await runDockerOp(job, fakeCli)
  expect(mutations()).toEqual([])
  expect(finished[0]?.status).toBe('failed')
  expect(finished[0]?.error).toContain('missing project name or files')
  expect(lockEvents.filter((e) => e.kind === 'release')).toHaveLength(1)
})

test('a dockerfile up job that lost its resolved port fails without running anything', async () => {
  const job = dockerfileJob({ kind: 'up', containerPort: undefined, protocol: undefined })
  await runDockerOp(job, fakeCli)
  expect(mutations()).toEqual([])
  expect(finished[0]?.status).toBe('failed')
  expect(finished[0]?.error).toContain('missing containerPort/protocol')
  expect(lockEvents.filter((e) => e.kind === 'release')).toHaveLength(1)
})

test('an operation that cannot claim the lock runs no docker command at all', async () => {
  claimAllowed = false
  const job = composeJob({ kind: 'down', removeVolumes: true })
  await runDockerOp(job, fakeCli)
  expect(invocations).toEqual([])
  expect(running).toEqual([])
  expect(finished).toEqual([
    {
      operationId: job.operationId,
      status: 'failed',
      exitCode: null,
      error: 'Another docker operation claimed this project first',
    },
  ])
  // Nothing to release: the lock was never this operation's to hold.
  expect(lockEvents.filter((e) => e.kind === 'release')).toHaveLength(0)
})

test('a later operation proceeds once the lock is free again', async () => {
  claimAllowed = false
  await runDockerOp(composeJob({ operationId: '55555555-5555-4555-8555-555555555555' }), fakeCli)
  expect(invocations).toEqual([])

  claimAllowed = true
  await runDockerOp(composeJob({ operationId: '66666666-6666-4666-8666-666666666666' }), fakeCli)
  expect(mutations()).toEqual([['compose', '-f', COMPOSE_BASE, '-p', 'agentoo-demo', 'down']])
  expect(finished.map((f) => f.status)).toEqual(['failed', 'succeeded'])
})

test('every line a step emits is appended to the operation log as it arrives', async () => {
  const job = composeJob({ kind: 'up' })
  await runDockerOp(job, fakeCli)
  expect(output).toEqual([
    { operationId: job.operationId, stream: 'stdout', text: 'ran compose -f' },
  ])
})
