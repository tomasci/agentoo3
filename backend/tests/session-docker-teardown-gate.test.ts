// The docker-containers gate `deleteSession` runs immediately before removing
// a session's worktree (sessions/service.ts) -- refusing rather than a
// best-effort `compose down`, because every docker mutation in this feature
// runs on the worker, never in a request handler, and enqueuing one here
// would race the `git worktree remove --force` that follows.
//
// The real `listScopeContainers` runs underneath this gate -- only the
// docker CLI is faked, not this feature's own container-listing logic --
// which is what lets this file actually pin the property that matters most:
// a down or absent docker daemon must never make a session undeletable. A
// version of this file that stubbed `listScopeContainers` itself (as this
// file used to) cannot test that at all, since the stub never sees what the
// CLI returned.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>
const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const WORKTREE_PATH = '/tmp/agentoo-test-worktrees/22222222-2222-4222-8222-222222222222'
const SUFFIX = SESSION_ID.replace(/-/g, '').slice(0, 12)

// Spread into a plain object at capture time, not held as the module
// namespace: a namespace is a *live* view, so `mock.module(spec, () => ns)`
// in afterAll would hand back the mock it is meant to undo. Restoring from a
// snapshot is what actually puts the real module back for later files.
const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
  editorEnabled: boolean
}
const testEnv = { ...realEnv.env, DOCKER_ENABLED: true }
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

let sessionRow: Row | undefined
const projectRow: Row = { id: PROJECT_ID, name: 'Demo', slug: 'demo', path: '/tmp/does-not-matter' }
let deletedSessionIds: string[] = []

const db = {
  select: () => ({
    from: (t: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table(t) === 'projects') return [projectRow]
          if (table(t) === 'sessions') return sessionRow ? [sessionRow] : []
          return []
        },
      }),
    }),
  }),
  delete: (t: unknown) => ({
    where: async () => {
      if (table(t) === 'sessions') deletedSessionIds.push(SESSION_ID)
      return []
    },
  }),
}
mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

// The real listScopeContainers runs against this fake CLI -- exactly what
// distinguishes this file from a stub of listScopeContainers itself. `mode`
// switches what the fake daemon reports; see each test below for which mode
// exercises which of this gate's properties.
type Mode =
  | 'daemon-down'
  | 'binary-missing'
  | 'garbage'
  | 'exited-container'
  | 'created-container'
  | 'other-scope-only'
  | 'no-containers'
let mode: Mode = 'no-containers'

// Ordering evidence for the editor-removal tests below: every 'ps'/'inspect'
// call the docker CONTAINER GATE makes, and every 'rm' call removeEditor makes,
// is pushed here in the order it actually happened.
let callOrder: string[] = []

const realCli = { ...(await import(`${B}/features/docker/cli.ts`)) } as Record<string, unknown>
const fakeCli = {
  async run(args: string[]) {
    if (args[0] === 'ps' || args[0] === 'inspect') callOrder.push(`gate:${args[0]}`)
    // Pushed unconditionally, before the mode branches below can short-circuit
    // with an early return -- the daemon-down/binary-missing tests need this
    // call recorded even though it goes on to fail.
    if (args[0] === 'rm') callOrder.push(`editor-rm:${args[2]}`)
    if (mode === 'daemon-down') {
      return { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
    }
    if (mode === 'binary-missing') return { ok: false, stdout: '', stderr: 'ENOENT', exitCode: -127 }
    if (mode === 'garbage') return { ok: true, stdout: 'not json at all\n{{{', stderr: '', exitCode: 0 }
    // `ps -aq` prints docker's 12-char short id ('f'.repeat(12)); `inspect`
    // reports back the 64-char full id ('f'.repeat(64)) for that same
    // container, never the short id it was looked up by -- kept distinct
    // here for fidelity to the real CLI (this gate's own containers carry
    // `com.agentoo.project`, never `com.docker.compose.project`, so unlike
    // containers.ts's former `composeIds.has(raw.Id)` defect this split does
    // not change what this file's tests catch -- ownership here has always
    // been decided by the `com.agentoo.session` label, never by an id
    // comparison).
    if (args[0] === 'ps') {
      const filter = args[3] ?? ''
      if (mode === 'other-scope-only') {
        // A container of the project's REPO scope, returned by the slug-only
        // label filter -- the gate for a session must not see it.
        return filter.startsWith('label=com.agentoo.project=')
          ? { ok: true, stdout: 'f'.repeat(12), stderr: '', exitCode: 0 }
          : { ok: true, stdout: '', stderr: '', exitCode: 0 }
      }
      if (mode === 'no-containers') return { ok: true, stdout: '', stderr: '', exitCode: 0 }
      // An EDITOR-labelled container never carries `com.agentoo.project` or
      // `com.docker.compose.project` (see names.ts's own header), so it can
      // never be what either of this gate's two label filters matches --
      // this mode's own `docker ps` answers empty for both, the same as
      // 'no-containers', which is the whole point: the gate must not see it.
      if (mode === 'editor-only') return { ok: true, stdout: '', stderr: '', exitCode: 0 }
      return filter.startsWith('label=com.agentoo.project=')
        ? { ok: true, stdout: 'f'.repeat(12), stderr: '', exitCode: 0 }
        : { ok: true, stdout: '', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'inspect') {
      const name = mode === 'other-scope-only' ? '/agentoo-demo' : `/agentoo-demo_s-${SUFFIX}`
      const status = mode === 'created-container' ? 'created' : 'exited'
      const labels: Record<string, string> = { 'com.agentoo.project': 'demo', 'com.agentoo.managed': '1' }
      if (mode !== 'other-scope-only') labels['com.agentoo.session'] = SESSION_ID
      return {
        ok: true,
        stdout: JSON.stringify({
          Id: 'f'.repeat(64),
          Name: name,
          Config: { Labels: labels },
          State: { Status: status, ExitCode: 0 },
        }),
        stderr: '',
        exitCode: 0,
      }
    }
    if (args[0] === 'rm') {
      // removeEditor (features/editor/container.ts): `docker rm -f <name>`.
      // Never reached by the docker CONTAINER GATE above, which only ever
      // runs `ps`/`inspect` -- so every entry pushed above is unambiguously
      // the editor removal, not the gate.
      return { ok: true, stdout: String(args[2]), stderr: '', exitCode: 0 }
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 }
  },
  stream() {
    return { lines: (async function* () {})(), close() {}, exited: Promise.resolve(0) }
  },
}
mock.module(`${B}/features/docker/cli.ts`, () => ({ ...realCli, realDockerCli: fakeCli }))

// Spread from the real module, not hand-rolled: lib/git.ts has real consumers
// elsewhere in this suite that need every one of its exports, not only
// `removeWorktree`. Restored in afterAll for the same reason.
const realGit = { ...(await import(`${B}/lib/git.ts`)) } as Record<string, unknown>
let removedWorktrees: string[] = []
mock.module(`${B}/lib/git.ts`, () => ({
  ...realGit,
  removeWorktree: async (_repo: string, path: string) => {
    callOrder.push(`worktree-remove:${path}`)
    removedWorktrees.push(path)
    return { ok: true, stderr: '' }
  },
}))

// Same reasoning as lib/git.ts above: features/attachments/storage.ts is a
// shared module with real consumers elsewhere.
const realStorage = { ...(await import(`${B}/features/attachments/storage.ts`)) } as Record<
  string,
  unknown
>
mock.module(`${B}/features/attachments/storage.ts`, () => ({
  ...realStorage,
  deleteSessionFiles: async () => {},
}))

// Every export forwarded as a safe no-op, matching the convention every other
// test file in this suite already uses for this module.
const realQueue = { ...(await import(`${B}/queue/index.ts`)) } as Record<string, unknown>
mock.module(`${B}/queue/index.ts`, () => ({ ...realQueue }))

const { deleteSession } = await import(`${B}/features/sessions/service.ts`)

afterAll(() => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/docker/cli.ts`, () => realCli)
  mock.module(`${B}/lib/git.ts`, () => realGit)
  mock.module(`${B}/features/attachments/storage.ts`, () => realStorage)
  mock.module(`${B}/queue/index.ts`, () => realQueue)
})

beforeEach(() => {
  sessionRow = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'idle',
    worktreePath: WORKTREE_PATH,
    branch: 'agentoo/s-22222222',
  }
  mode = 'no-containers'
  removedWorktrees = []
  deletedSessionIds = []
  callOrder = []
  testEnv.DOCKER_ENABLED = true
})

// --- the daemon can misbehave; a session must still be deletable ------------------

test('a docker daemon that is down never makes a session undeletable', async () => {
  mode = 'daemon-down'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

test('a missing docker binary never makes a session undeletable', async () => {
  mode = 'binary-missing'
  await deleteSession(SESSION_ID)
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

test('unparsable docker output never makes a session undeletable', async () => {
  mode = 'garbage'
  await deleteSession(SESSION_ID)
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

// --- any container state counts, not just running ---------------------------------

test('an EXITED container of this session blocks deletion (state is not filtered)', async () => {
  mode = 'exited-container'
  await expect(deleteSession(SESSION_ID)).rejects.toMatchObject({ status: 409 })
  expect(removedWorktrees).toEqual([])
  expect(deletedSessionIds).toEqual([])
})

test('a CREATED container of this session blocks deletion too', async () => {
  mode = 'created-container'
  await expect(deleteSession(SESSION_ID)).rejects.toMatchObject({ status: 409 })
  expect(deletedSessionIds).toEqual([])
})

test('the 409 names the reason, not just a status', async () => {
  mode = 'exited-container'
  await expect(deleteSession(SESSION_ID)).rejects.toMatchObject({
    message: expect.stringContaining('clean it up on the Docker page'),
  })
})

// --- the gate checks this session's own scope, never the project's repo scope ----

test("the project's own repo-scope container does NOT block deleting a session", async () => {
  mode = 'other-scope-only'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

test('no containers means the worktree is removed as before', async () => {
  mode = 'no-containers'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

// --- the argv and the surrounding gates ------------------------------------------

test('the container listing is `docker ps -aq` (all states), not running-only', async () => {
  const { psFilterArgs } = await import(`${B}/features/docker/args.ts`)
  expect(psFilterArgs('label=x')).toEqual(['ps', '-aq', '--filter', 'label=x'])
})

test('a running session is still refused before the docker gate is consulted', async () => {
  mode = 'exited-container'
  sessionRow = { ...sessionRow, status: 'running' }
  await expect(deleteSession(SESSION_ID)).rejects.toMatchObject({
    status: 409,
    message: 'Session is running; interrupt it before deleting',
  })
})

test('DOCKER_ENABLED=false skips the gate entirely, even with live containers', async () => {
  testEnv.DOCKER_ENABLED = false
  mode = 'exited-container'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

test('a session that never had a worktree never reaches the gate at all', async () => {
  sessionRow = { ...sessionRow, worktreePath: null }
  mode = 'exited-container'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([])
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

// --- editor removal: after the gate, before removeWorktree, best-effort ----

test('an editor-labelled container never blocks deletion: the gate never sees it', async () => {
  mode = 'editor-only'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
  expect(callOrder.some((c) => c.startsWith('editor-rm:'))).toBe(true)
})

test('the editor is removed strictly after the docker gate check and strictly before removeWorktree', async () => {
  mode = 'no-containers'
  await deleteSession(SESSION_ID)

  const gateIndex = callOrder.findIndex((c) => c.startsWith('gate:'))
  const editorIndex = callOrder.findIndex((c) => c.startsWith('editor-rm:'))
  const worktreeIndex = callOrder.findIndex((c) => c.startsWith('worktree-remove:'))

  expect(gateIndex).toBeGreaterThanOrEqual(0)
  expect(editorIndex).toBeGreaterThan(gateIndex)
  expect(worktreeIndex).toBeGreaterThan(editorIndex)
})

test('a down docker daemon still lets deletion proceed even though removeEditor cannot reach it', async () => {
  mode = 'daemon-down'
  await deleteSession(SESSION_ID)
  expect(removedWorktrees).toEqual([WORKTREE_PATH])
  expect(deletedSessionIds).toEqual([SESSION_ID])
  // The attempt was made (and failed) — not skipped outright.
  expect(callOrder.some((c) => c.startsWith('editor-rm:'))).toBe(true)
})

test('a missing docker binary during editor removal still lets deletion proceed', async () => {
  mode = 'binary-missing'
  await deleteSession(SESSION_ID)
  expect(deletedSessionIds).toEqual([SESSION_ID])
})

test('a refused deletion (the docker gate 409s) has no side effects at all: no editor removal, no worktree removal', async () => {
  mode = 'exited-container'
  await expect(deleteSession(SESSION_ID)).rejects.toMatchObject({ status: 409 })
  expect(callOrder.some((c) => c.startsWith('editor-rm:'))).toBe(false)
  expect(callOrder.some((c) => c.startsWith('worktree-remove:'))).toBe(false)
  expect(removedWorktrees).toEqual([])
  expect(deletedSessionIds).toEqual([])
})

test('a session with no worktree never attempts an editor removal either', async () => {
  sessionRow = { ...sessionRow, worktreePath: null }
  mode = 'no-containers'
  await deleteSession(SESSION_ID)
  expect(callOrder.some((c) => c.startsWith('editor-rm:'))).toBe(false)
  expect(deletedSessionIds).toEqual([SESSION_ID])
})
