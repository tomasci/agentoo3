// runEditorStart (features/editor/lifecycle.ts) — the design doc's own
// numbered start steps, each pinned by name: already healthy (no-op),
// exited-then-recreated, the cap enforced at the worker (not just the
// route's fast check), pull output actually landing in the oplog, a failed
// `docker run`, a container that exits mid health-wait (with its logs
// captured), and a start that lost its own lock before ever running.
//
// operations.ts's lock/record calls are real, against a fake ioredis (same
// shape as docker-operations.test.ts's own) — this is what makes "lock lost"
// and "idempotent" behaviour genuine rather than reimplemented. Everything
// docker-shaped goes through an explicit fake DockerCli, the same seam every
// docker-touching function in this codebase already exposes. `probeHealthz`
// and `sleep` are injected via `deps` (lifecycle.ts's own seam) so the 90s
// health-wait loop never actually waits in this file.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'ed-lc-'))
const SLUG = 'demo'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const WORKTREE = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', SESSION_ID)
const REPO_GIT_DIR = join(TEST_PROJECTS_DIR, SLUG, 'repo', '.git')

/** Same shape editor-git-common-dir.test.ts's own layout() lays out, sized to
 * this file's fixed slug/session so gitCommonDir(scope.path, repoGitDir)
 * actually verifies. */
async function layoutGit() {
  const privateGitDir = join(REPO_GIT_DIR, 'worktrees', 'wt1')
  await mkdir(privateGitDir, { recursive: true })
  await writeFile(join(privateGitDir, 'commondir'), '../..\n')
  await mkdir(WORKTREE, { recursive: true })
  await writeFile(join(WORKTREE, '.git'), `gitdir: ${privateGitDir}\n`)
}

// --- ioredis: real operations.ts, fake transport (see docker-operations.test.ts) --
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
  async rpush(key: string, value: string) {
    const list = JSON.parse(stored[`list:${key}`] ?? '[]') as string[]
    list.push(value)
    stored[`list:${key}`] = JSON.stringify(list)
    return list.length
  }
  async ltrim() {
    return 'OK'
  }
  async expire() {
    return 1
  }
  async lrange(key: string) {
    return JSON.parse(stored[`list:${key}`] ?? '[]') as string[]
  }
}
const realIoredis = { ...(await import('ioredis')) } as Record<string, unknown>
mock.module('ioredis', () => ({ default: FakeRedis, Redis: FakeRedis }))

// --- env: PROJECTS_DIR + editor knobs, no queue/projects/sessions real import ---
// (Nothing here imports @/queue at runtime: lifecycle.ts's own `EditorOpJob`
// import is `import type`, erased at compile time — so, unlike
// editor-service.test.ts, there is no BullMQ-under-a-fake-ioredis hazard to
// route around here.)
const realEnv = { ...(await import(`${B}/env.ts`)) } as { env: Record<string, unknown> }
const testEnv = {
  ...realEnv.env,
  PROJECTS_DIR: TEST_PROJECTS_DIR,
  EDITOR_MAX_RUNNING: 2,
  EDITOR_START_TIMEOUT_MS: 600_000,
  EDITOR_IMAGE: 'codercom/code-server:4.138.0',
}
mock.module(`${B}/env.ts`, () => ({ env: testEnv, hasClaudeCredential: false, editorEnabled: true }))

mock.module(`${B}/features/projects/service.ts`, () => ({
  getProject: async (id: string) => {
    if (id !== PROJECT_ID) throw new Error('unknown project')
    return { id: PROJECT_ID, slug: SLUG }
  },
}))
mock.module(`${B}/features/sessions/service.ts`, () => ({
  getSessionLocation: async (id: string) => {
    if (id !== SESSION_ID) throw new Error('unknown session')
    return { id: SESSION_ID, projectId: PROJECT_ID, worktreePath: WORKTREE }
  },
}))

const { runEditorStart, HEALTHZ_INSPECT_EVERY_N_POLLS } = await import(
  `${B}/features/editor/lifecycle.ts`
)
const {
  claimEditorLock,
  createEditorOperation,
  editorLockHolder,
  getEditorOperation,
  getEditorOperationOutput,
} = await import(`${B}/features/editor/operations.ts`)
const { editorContainerName } = await import(`${B}/features/docker/names.ts`)

afterAll(async () => {
  mock.module('ioredis', () => realIoredis)
  mock.module(`${B}/env.ts`, () => realEnv)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

const REF = { slug: SLUG, sessionId: SESSION_ID }
const NAME = editorContainerName(REF)
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'

interface ContainerFixture {
  status: string
}

function fakeCli(opts: {
  containers?: Map<string, ContainerFixture>
  imageExists?: boolean
  pullLines?: string[]
  pullExitCode?: number
  runOk?: boolean
  runStderr?: string
  logsText?: string
  onRun?: () => void
  /** Simulates an `rm -f` that the daemon reports as failed (or simply never
   * applies) — the call is still recorded in `calls.rm`, but the container is
   * NOT removed from the fixture, the same as lifecycle.ts's own Step 4,
   * which never checks removeEditorContainer's result before moving on. */
  rmNoop?: boolean
}) {
  const containers = opts.containers ?? new Map<string, ContainerFixture>()
  const runCalls: string[][] = []
  const rmCalls: string[] = []
  return {
    calls: { run: runCalls, rm: rmCalls },
    async run(args: string[]) {
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
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (!opts.imageExists) return { ok: false, stdout: '', stderr: 'no such image', exitCode: 1 }
        return { ok: true, stdout: JSON.stringify({ Created: '2024-01-01T00:00:00Z' }), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'run') {
        runCalls.push(args)
        opts.onRun?.()
        if (opts.runOk === false) {
          return { ok: false, stdout: '', stderr: opts.runStderr ?? 'run failed', exitCode: 1 }
        }
        // Only sets "running" if `onRun` did not already give this
        // container a different status (the "crashes immediately" fixture
        // below relies on its own onRun-set status sticking).
        if (!containers.has(NAME)) containers.set(NAME, { status: 'running' })
        return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'rm') {
        const name = args[2] as string
        rmCalls.push(name)
        if (opts.rmNoop) {
          return { ok: false, stdout: '', stderr: 'rm failed (simulated)', exitCode: 1 }
        }
        containers.delete(name)
        return { ok: true, stdout: name, stderr: '', exitCode: 0 }
      }
      if (args[0] === 'logs') {
        return { ok: true, stdout: opts.logsText ?? '', stderr: '', exitCode: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exitCode: 0 }
    },
    stream(args: string[]) {
      if (args[0] === 'pull') {
        const lines = opts.pullLines ?? []
        return {
          lines: (async function* () {
            for (const line of lines) yield { stream: 'stdout' as const, line }
          })(),
          close() {},
          exited: Promise.resolve(opts.pullExitCode ?? 0),
        }
      }
      throw new Error(`stream() not stubbed for ${args[0]}`)
    },
  }
}

const noSleep = async () => {}

beforeEach(async () => {
  stored = {}
  testEnv.EDITOR_MAX_RUNNING = 2
  testEnv.EDITOR_SETTINGS_FILE = undefined
  await rm(join(TEST_PROJECTS_DIR, SLUG), { recursive: true, force: true })
  await rm(join(TEST_PROJECTS_DIR, '.editor'), { recursive: true, force: true })
})

async function seedOperation(): Promise<void> {
  await createEditorOperation(SESSION_ID, OPERATION_ID)
  const claimed = await claimEditorLock(SESSION_ID, OPERATION_ID, 600_000)
  expect(claimed).toBe(true)
}

// --- already healthy: no-op --------------------------------------------------

test('already running and healthy: succeeds immediately, no docker run', async () => {
  await layoutGit()
  const containers = new Map([[NAME, { status: 'running' }]])
  const cli = fakeCli({ containers })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded')
  expect(cli.calls.run).toHaveLength(0)
  expect(await editorLockHolder(SESSION_ID)).toBeUndefined()
})

// --- start narration: the oplog is never empty on the ordinary path ---------
//
// Before this, ONLY a `docker pull` wrote anything to the oplog -- on the
// (common) path where the image is already local, GET .../editor's start log
// stayed empty for the whole health-wait, reading as hung rather than merely
// quiet. These stdout lines are what fix that; failure still reports through
// the operation's own `error` field and a `docker logs` tail, unchanged.

test('the oplog narrates every step even when the image is already local (no pull)', async () => {
  await layoutGit()
  const containers = new Map([[NAME, { status: 'exited' }]])
  const cli = fakeCli({ containers, imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const output = await getEditorOperationOutput(OPERATION_ID)
  const texts = output.map((l: { text: string }) => l.text)
  expect(texts.some((t: string) => t.includes('already present'))).toBe(true)
  expect(texts.some((t: string) => t.includes(`Starting container ${NAME}`))).toBe(true)
  expect(texts.some((t: string) => t.includes('Waiting for code-server'))).toBe(true)
  expect(texts.some((t: string) => /^Ready after [0-9.]+s$/.test(t))).toBe(true)
  // Narration is in the order the steps actually happened.
  const order = ['already present', 'Starting container', 'Waiting for code-server', 'Ready after']
  const indexes = order.map((needle) => texts.findIndex((t: string) => t.includes(needle)))
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  expect(indexes.every((i) => i >= 0)).toBe(true)
})

test('the oplog says "Pulling" instead of "already present" when the image is not local', async () => {
  await layoutGit()
  const cli = fakeCli({
    imageExists: false,
    pullLines: ['Status: Downloaded newer image'],
    pullExitCode: 0,
  })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const output = await getEditorOperationOutput(OPERATION_ID)
  const texts = output.map((l: { text: string }) => l.text)
  expect(texts.some((t: string) => t.startsWith('Pulling codercom/code-server'))).toBe(true)
  expect(texts.some((t: string) => t.includes('already present'))).toBe(false)
})

// --- default editor settings are seeded before docker run ---------------------
//
// features/editor/settings.ts's own unit tests (editor-settings.test.ts)
// cover the read/validate/write logic in detail; these only check that
// lifecycle.ts actually calls it, in the right place (before `docker run`,
// which the argv assertion below pins), and narrates the result the way the
// design doc's own "start-log narration" section describes.

test('the shipped default settings are seeded into the runtime dir and narrated on success', async () => {
  await layoutGit()
  const cli = fakeCli({ imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded')

  const settingsPath = join(TEST_PROJECTS_DIR, '.editor', SESSION_ID, 'data', 'User', 'settings.json')
  const written = JSON.parse(await readFile(settingsPath, 'utf8'))
  expect(written).toEqual({
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  })

  const output = await getEditorOperationOutput(OPERATION_ID)
  const texts = output.map((l: { text: string }) => l.text)
  expect(texts).toContain('Applied default editor settings from config/editor-settings.json')
  // Seeded before the container is actually started, not after.
  const applyIndex = texts.findIndex((t: string) => t.startsWith('Applied default editor settings'))
  const startIndex = texts.findIndex((t: string) => t.includes(`Starting container ${NAME}`))
  expect(applyIndex).toBeGreaterThanOrEqual(0)
  expect(applyIndex).toBeLessThan(startIndex)

  // And the argv actually passed to `docker run` points --user-data-dir at
  // this exact runtime dir's `data` subdirectory, not the old /tmp/home path.
  const runArgs = cli.calls.run[0] ?? []
  expect(runArgs[runArgs.indexOf('--user-data-dir') + 1]).toBe('/run/agentoo-editor/data')
})

test('EDITOR_SETTINGS_FILE overrides the shipped file for a seeded start', async () => {
  await layoutGit()
  const overrideDir = await mkdtemp(join(tmpdir(), 'ed-lc-override-'))
  const overridePath = join(overrideDir, 'custom.json')
  await writeFile(overridePath, JSON.stringify({ 'editor.tabSize': 4 }))
  testEnv.EDITOR_SETTINGS_FILE = overridePath

  const cli = fakeCli({ imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const settingsPath = join(TEST_PROJECTS_DIR, '.editor', SESSION_ID, 'data', 'User', 'settings.json')
  const written = JSON.parse(await readFile(settingsPath, 'utf8'))
  expect(written).toEqual({ 'editor.tabSize': 4 })

  const output = await getEditorOperationOutput(OPERATION_ID)
  const texts = output.map((l: { text: string }) => l.text)
  expect(texts).toContain(`Applied default editor settings from ${overridePath}`)

  await rm(overrideDir, { recursive: true, force: true })
})

test('an invalid EDITOR_SETTINGS_FILE still lets the start succeed, logs one stderr line, and seeds nothing', async () => {
  await layoutGit()
  const overrideDir = await mkdtemp(join(tmpdir(), 'ed-lc-override-'))
  const overridePath = join(overrideDir, 'broken.json')
  await writeFile(overridePath, '{ not valid json')
  testEnv.EDITOR_SETTINGS_FILE = overridePath

  const cli = fakeCli({ imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded') // a bad defaults file must not block the start

  const settingsPath = join(TEST_PROJECTS_DIR, '.editor', SESSION_ID, 'data', 'User', 'settings.json')
  await expect(readFile(settingsPath, 'utf8')).rejects.toThrow()

  const output = await getEditorOperationOutput(OPERATION_ID)
  const stderrLines = output.filter((l: { stream: string }) => l.stream === 'stderr')
  expect(stderrLines).toHaveLength(1)
  expect(stderrLines[0]?.text).toContain(overridePath)
  expect(stderrLines[0]?.text).toContain('invalid JSON')

  await rm(overrideDir, { recursive: true, force: true })
})

test("a previous session's stale settings.json is cleared when a restart's own override is invalid", async () => {
  // The runtime dir survives a stop — only the reaper/session-delete path
  // removes it (see settings.ts's own header) — so this is what a genuine
  // "user changed a setting, editor stopped, operator's override broke,
  // editor restarted" sequence actually leaves on disk beforehand.
  await layoutGit()
  const runtimeDir = join(TEST_PROJECTS_DIR, '.editor', SESSION_ID)
  const userDir = join(runtimeDir, 'data', 'User')
  await mkdir(userDir, { recursive: true })
  const settingsPath = join(userDir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ 'workbench.startupEditor': 'welcomePage' }))

  const overrideDir = await mkdtemp(join(tmpdir(), 'ed-lc-override-'))
  const overridePath = join(overrideDir, 'broken.json')
  await writeFile(overridePath, '{ not valid json')
  testEnv.EDITOR_SETTINGS_FILE = overridePath

  const cli = fakeCli({ imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded')
  await expect(readFile(settingsPath, 'utf8')).rejects.toThrow() // the stale file is gone, not resurrected

  const output = await getEditorOperationOutput(OPERATION_ID)
  const stderrLines = output.filter((l: { stream: string }) => l.stream === 'stderr')
  expect(stderrLines).toHaveLength(1)
  expect(stderrLines[0]?.text).toContain("cleared the previous session's settings.json")

  await rm(overrideDir, { recursive: true, force: true })
})

// --- exited-then-recreated ----------------------------------------------------

test('an exited container is removed and a fresh one started', async () => {
  await layoutGit()
  const containers = new Map([[NAME, { status: 'exited' }]])
  const cli = fakeCli({ containers, imageExists: true })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  expect(cli.calls.rm).toContain(NAME)
  expect(cli.calls.run).toHaveLength(1)
  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded')
  expect(containers.get(NAME)?.status).toBe('running')
})

// --- cap at the worker ---------------------------------------------------------

test('the cap is enforced by the worker itself, not just the route', async () => {
  // Only an OTHER session's container is on the box — this doubles as the
  // "cap reached by other sessions alone" case: nothing of this session's
  // own is around to (wrongly) get excluded from the count.
  testEnv.EDITOR_MAX_RUNNING = 1
  await mkdir(WORKTREE, { recursive: true }) // resolveDockerScope only needs the dir to exist
  const containers = new Map([['agentoo_editor-other_s-abc123456789', { status: 'running' }]])
  const cli = fakeCli({ containers })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('failed')
  expect(op?.error).toContain('cap')
  expect(cli.calls.run).toHaveLength(0) // never even got to gitCommonDir/run
})

test("this session's own container does not count against its own restart's cap check, even if it survives Step 4's rm", async () => {
  // Step 4 above always tries to remove this session's own stale container
  // before the cap check runs, but never checks whether that removal
  // actually worked. `rmNoop` simulates it silently failing, so this
  // session's own (still `running`) container is still sitting in `docker
  // ps` when Step 5 counts — exactly like the route-side check, it must not
  // count against the restart that is trying to replace it.
  await layoutGit()
  testEnv.EDITOR_MAX_RUNNING = 2
  const containers = new Map([
    [NAME, { status: 'running' }],
    ['agentoo_editor-other_s-abc123456789', { status: 'running' }],
  ])
  const cli = fakeCli({ containers, imageExists: true, rmNoop: true })
  await seedOperation()

  let probeCalls = 0
  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    {
      cli,
      // false on Step 4's own probe, so it does not short-circuit as
      // "already healthy"; true on every later one (waitForHealthy's own
      // polling, after runEditorContainer has actually been called).
      probeHealthz: async () => {
        probeCalls += 1
        return probeCalls > 1
      },
      sleep: noSleep,
    },
  )

  expect(cli.calls.rm).toContain(NAME) // Step 4 did try to remove it...
  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded') // ...but it was excluded from the cap regardless
})

// --- pull output is logged ----------------------------------------------------

test('a docker pull streams its output into the operation oplog', async () => {
  await layoutGit()
  const cli = fakeCli({
    imageExists: false,
    pullLines: ['Pulling from library/code-server', 'Status: Downloaded newer image'],
    pullExitCode: 0,
  })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const output = await getEditorOperationOutput(OPERATION_ID)
  const texts = output.map((l: { text: string }) => l.text)
  expect(texts).toContain('Pulling from library/code-server')
  expect(texts).toContain('Status: Downloaded newer image')
  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('succeeded')
})

test('a docker pull that exits non-zero fails the start', async () => {
  await layoutGit()
  const cli = fakeCli({ imageExists: false, pullLines: ['some error'], pullExitCode: 1 })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('failed')
  expect(op?.error).toContain('docker pull')
  expect(cli.calls.run).toHaveLength(0)
})

// --- docker run fails ----------------------------------------------------------

test('a failed docker run fails the operation with the daemon stderr', async () => {
  await layoutGit()
  const cli = fakeCli({ imageExists: true, runOk: false, runStderr: 'Error: port is already allocated' })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('failed')
  expect(op?.error).toContain('docker run failed')
  expect(op?.error).toContain('port is already allocated')
})

// --- container exits during the health wait: logs captured --------------------

test('a container that exits before answering /healthz fails with its logs attached', async () => {
  await layoutGit()
  const containers = new Map<string, ContainerFixture>()
  const cli = fakeCli({
    containers,
    imageExists: true,
    logsText: 'panic: could not bind socket',
    // The container "crashes" the instant it starts — every inspect from
    // then on (including the 5th-poll check inside the health wait) reports
    // `exited`, not `running`.
    onRun: () => containers.set(NAME, { status: 'exited' }),
  })
  await seedOperation()

  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => false, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('failed')
  expect(op?.error).toContain('exited')
  expect(op?.error).toContain('panic: could not bind socket')
})

test('HEALTHZ_INSPECT_EVERY_N_POLLS is 5, matching the design doc', () => {
  expect(HEALTHZ_INSPECT_EVERY_N_POLLS).toBe(5)
})

// --- lock lost: abandoned without touching the operation -----------------------

test('a start that lost its own lock leaves the operation record untouched', async () => {
  await layoutGit()
  // Seed the operation record, but claim the lock under a DIFFERENT operation
  // id — simulating this start's own lock having already expired and been
  // re-claimed by a later attempt.
  await createEditorOperation(SESSION_ID, OPERATION_ID)
  await claimEditorLock(SESSION_ID, 'someone-elses-operation-id', 600_000)

  const cli = fakeCli({ imageExists: true })
  await runEditorStart(
    { kind: 'start', operationId: OPERATION_ID, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { cli, probeHealthz: async () => true, sleep: noSleep },
  )

  const op = await getEditorOperation(OPERATION_ID)
  expect(op?.status).toBe('queued') // never touched: markEditorOperationRunning never ran
  expect(cli.calls.run).toHaveLength(0)
  expect(cli.calls.rm).toHaveLength(0)
  // The OTHER operation's lock must survive — this abandoned start must not
  // release a lock it does not actually hold.
  expect(await editorLockHolder(SESSION_ID)).toBe('someone-elses-operation-id')
})
