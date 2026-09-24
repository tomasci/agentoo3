// listRunningEditors (features/editor/service.ts) — GET /editors's own
// orchestration: which of this install's own running editor containers are
// listed (and how their `health`/`lastActiveAt` are derived), how the
// box-wide cap count and this install's own count combine into
// `otherInstallsRunning`, and the disabled/daemon-down zero-states. Driven
// against the REAL container.ts (only `probeEditorHealth` stubbed — see its
// own comment below) and a fake, label-aware docker CLI, the same discipline
// editor-service.scenarios.ts and editor-reaper.scenarios.ts already use for
// their own reads.
//
// container.ts's own `probeEditorHealth` — the actual /healthz HTTP+JSON
// parsing (alive/expired/garbage-body/no-answer) — is exercised for real,
// against a real unix socket, in editor-healthz-probe.test.ts instead; this
// file only has to prove that whatever that function reports back is turned
// into the right `health` label and sort position.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-editor-running-'))

// Every real module this file needs is imported and snapshotted BEFORE
// 'ioredis' is mocked below — see editor-service.scenarios.ts's own header
// for why: projects/service.ts, sessions/service.ts and queue/index.ts each
// construct real BullMQ Queue objects at import time, against whatever
// 'ioredis' export is live then, and a plain object substitute crashes that
// outright.
const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
}
const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) }
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) }
const realQueue = { ...(await import(`${B}/queue/index.ts`)) }
const realContainer = { ...(await import(`${B}/features/editor/container.ts`)) } as Record<
  string,
  unknown
>

// --- ioredis: same minimal fake as editor-service.scenarios.ts's own -------
// listRunningEditors itself never touches Redis, but service.ts's own module
// scope imports operations.ts (the per-session lock), which opens a real
// connection at first use if this is not stubbed.
class FakeRedis {
  on() {
    return this
  }
  async get() {
    return null
  }
  async set() {
    return 'OK'
  }
  async eval() {
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

// --- env: PROJECTS_DIR to a real temp dir (editorInstallId's own realpath) --
// `editorEnabled` fixed true for this file's whole run — see
// editor-service-disabled.scenarios.ts's own comment for why it cannot be
// toggled mid-file; the disabled (`enabled: false`) case is covered there
// instead, alongside every other route this feature gates the same way.
const testEnv = {
  ...realEnv.env,
  PROJECTS_DIR: TEST_PROJECTS_DIR,
  DOCKER_ENABLED: true,
  EDITOR_ENABLED: true,
  EDITOR_MAX_RUNNING: 2,
}
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  editorEnabled: true,
}))

mock.module(`${B}/features/projects/service.ts`, () => realProjects)
mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
mock.module(`${B}/queue/index.ts`, () => realQueue)

// --- db: the two bulk selects sessionSummariesFor (service.ts) issues ------
// Distinguished by table identity (`getTableName`), the same technique
// system-models-contract.test.ts and session-events-query-validation.test.ts
// already use for a fake `db` — neither select's `where()` is actually
// evaluated against the ids it was given; each test sets exactly the rows its
// own scenario needs resolvable, which is enough to prove `listRunningEditors`
// joins them correctly without reimplementing drizzle's own filtering.
interface FakeSessionRow {
  id: string
  projectId: string
  title: string | null
  branch: string | null
}
interface FakeProjectRow {
  id: string
  name: string
}
let sessionRows: FakeSessionRow[] = []
let projectRows: FakeProjectRow[] = []
mock.module(`${B}/db/client.ts`, () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          getTableName(table as Parameters<typeof getTableName>[0]) === 'sessions'
            ? sessionRows
            : projectRows,
      }),
    }),
  },
  closeDb: async () => {},
}))

// --- container.ts: only probeEditorHealth is stubbed ------------------------
// Every other export (countRunningEditorContainers, listThisInstallEditor-
// ContainerIds, listThisInstallRunningEditors, editorInstallId, ...) is the
// real implementation, driven entirely by the fake DockerCli each test builds
// below — the same seam editor-service.scenarios.ts already documents for its
// own container.ts mock.
let healthBySocket = new Map<string, { answered: boolean; alive: boolean | null; lastHeartbeat: number | null }>()
mock.module(`${B}/features/editor/container.ts`, () => ({
  ...realContainer,
  probeEditorHealth: async (socketPath: string) =>
    healthBySocket.get(socketPath) ?? { answered: false, alive: null, lastHeartbeat: null },
}))

const { listRunningEditors } = await import(`${B}/features/editor/service.ts`)
const { editorSocketPath } = await import(`${B}/lib/paths.ts`)
const { editorInstallId } = await import(`${B}/features/editor/container.ts`)

const INSTALL_ID = await editorInstallId()
const OTHER_INSTALL_ID = 'ffffffffffff'

afterAll(async () => {
  mock.module('ioredis', () => realIoredis)
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  mock.module(`${B}/queue/index.ts`, () => realQueue)
  mock.module(`${B}/features/editor/container.ts`, () => realContainer)
  mock.module(`${B}/db/client.ts`, () => ({ db: undefined, closeDb: async () => {} }))
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

// --- fixtures + a real-enough, label-aware fake docker CLI -------------------
// Reads each fixture's own labels for `docker ps --filter`, and only reports
// back the ids a `docker inspect` call actually asked for — the same
// discipline editor-reaper.scenarios.ts's own fakeCli follows, and for the
// identical reason: this is what makes the install-scoping assertions below
// (`running` vs. `otherInstallsRunning`) mean anything at all.
interface FixtureContainer {
  Id: string
  Name: string
  Config: { Labels: Record<string, string> }
  State: { Status: string; StartedAt?: string }
}

function rawContainer(
  name: string,
  status: string,
  sessionId: string | null,
  opts: { installId?: string | null; startedAt?: string } = {},
): FixtureContainer {
  const { installId = INSTALL_ID, startedAt } = opts
  const labels: Record<string, string> = { 'com.agentoo.editor': '1' }
  if (sessionId !== null) labels['com.agentoo.editor.session'] = sessionId
  if (installId !== null) labels['com.agentoo.editor.install'] = installId
  return {
    Id: name,
    Name: `/${name}`,
    Config: { Labels: labels },
    State: { Status: status, ...(startedAt ? { StartedAt: startedAt } : {}) },
  }
}

function fakeCli(fixtures: FixtureContainer[], opts: { down?: boolean } = {}) {
  return {
    async run(args: string[]) {
      if (opts.down) {
        return { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
      }
      if (args[0] === 'ps') {
        const filter = (args[3] ?? '').replace(/^label=/, '')
        const eqIdx = filter.indexOf('=')
        const key = eqIdx === -1 ? filter : filter.slice(0, eqIdx)
        const value = eqIdx === -1 ? '' : filter.slice(eqIdx + 1)
        const ids = fixtures.filter((c) => c.Config.Labels[key] === value).map((c) => c.Id)
        return { ok: true, stdout: ids.join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'inspect') {
        const requestedIds = new Set(args.slice(4))
        const matching = fixtures.filter((c) => requestedIds.has(c.Id))
        return { ok: true, stdout: matching.map((c) => JSON.stringify(c)).join('\n'), stderr: '', exitCode: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exitCode: 0 }
    },
    stream() {
      throw new Error('not used in this test')
    },
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  sessionRows = []
  projectRows = []
  healthBySocket = new Map()
})

// --- listing + joins ----------------------------------------------------------

test("lists only this install's running editors, with the joined project name, session title and branch", async () => {
  sessionRows = [{ id: SESSION_ID, projectId: PROJECT_ID, title: 'Fix the thing', branch: 'agentoo/s-1' }]
  projectRows = [{ id: PROJECT_ID, name: 'Demo Project' }]
  const container = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaaa', 'running', SESSION_ID, {
    startedAt: '2024-01-01T00:00:00Z',
  })
  healthBySocket.set(editorSocketPath(SESSION_ID), { answered: true, alive: true, lastHeartbeat: 1000 })

  const result = await listRunningEditors(fakeCli([container]) as never)

  expect(result.enabled).toBe(true)
  expect(result.cap).toBe(2)
  expect(result.running).toBe(1)
  expect(result.otherInstallsRunning).toBe(0)
  expect(result.editors).toEqual([
    {
      projectId: PROJECT_ID,
      projectName: 'Demo Project',
      sessionId: SESSION_ID,
      sessionTitle: 'Fix the thing',
      branch: 'agentoo/s-1',
      containerName: 'agentoo_editor-demo_s-aaaaaaaaaaaa',
      startedAt: '2024-01-01T00:00:00Z',
      health: 'in-use',
      lastActiveAt: new Date(1000).toISOString(),
    },
  ])
})

test('a session with no title yet reports sessionTitle: null', async () => {
  sessionRows = [{ id: SESSION_ID, projectId: PROJECT_ID, title: null, branch: null }]
  projectRows = [{ id: PROJECT_ID, name: 'Demo Project' }]
  const container = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaaa', 'running', SESSION_ID)
  healthBySocket.set(editorSocketPath(SESSION_ID), { answered: true, alive: false, lastHeartbeat: 0 })

  const result = await listRunningEditors(fakeCli([container]) as never)
  expect(result.editors[0]?.sessionTitle).toBeNull()
  expect(result.editors[0]?.branch).toBeNull()
})

// --- running counts box-wide; otherInstallsRunning is the difference --------

test("running counts box-wide, and otherInstallsRunning is this install's own running editors subtracted from it", async () => {
  sessionRows = [{ id: SESSION_ID, projectId: PROJECT_ID, title: 'Ours', branch: null }]
  projectRows = [{ id: PROJECT_ID, name: 'Demo' }]
  const ours = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaaa', 'running', SESSION_ID)
  const sibling = rawContainer(
    'agentoo_editor-other_s-bbbbbbbbbbbb',
    'running',
    '33333333-3333-4333-8333-333333333333',
    { installId: OTHER_INSTALL_ID },
  )
  healthBySocket.set(editorSocketPath(SESSION_ID), { answered: true, alive: true, lastHeartbeat: 1 })

  const result = await listRunningEditors(fakeCli([ours, sibling]) as never)

  expect(result.running).toBe(2)
  expect(result.otherInstallsRunning).toBe(1)
  expect(result.editors).toHaveLength(1)
  expect(result.editors[0]?.sessionId).toBe(SESSION_ID)
})

test('a non-running container of this install holds no slot and is not listed', async () => {
  const starting = rawContainer('agentoo_editor-demo_s-cccccccccccc', 'created', SESSION_ID)
  const result = await listRunningEditors(fakeCli([starting]) as never)
  expect(result.running).toBe(0)
  expect(result.editors).toEqual([])
})

// --- orphans: excluded from `editors`, still counted in `running` ----------

test('an orphan (session no longer resolves) is excluded from `editors` but still counted in `running`', async () => {
  // sessionRows/projectRows deliberately empty: this session id resolves to nothing.
  const orphan = rawContainer('agentoo_editor-demo_s-dddddddddddd', 'running', SESSION_ID)
  const result = await listRunningEditors(fakeCli([orphan]) as never)
  expect(result.running).toBe(1)
  expect(result.editors).toEqual([])
})

test('an orphan whose project (not the session) is gone is excluded from `editors` too', async () => {
  sessionRows = [{ id: SESSION_ID, projectId: PROJECT_ID, title: 'Still here', branch: null }]
  projectRows = [] // the project itself is gone
  const orphan = rawContainer('agentoo_editor-demo_s-eeeeeeeeeeee', 'running', SESSION_ID)
  const result = await listRunningEditors(fakeCli([orphan]) as never)
  expect(result.running).toBe(1)
  expect(result.editors).toEqual([])
})

test('a container with no session label at all is an orphan too, not a crash', async () => {
  const orphan = rawContainer('agentoo_editor-demo_s-f0f0f0f0f0f0', 'running', null)
  const result = await listRunningEditors(fakeCli([orphan]) as never)
  expect(result.running).toBe(1)
  expect(result.editors).toEqual([])
})

// --- health mapping ------------------------------------------------------------

const HEALTH_SESSIONS = {
  aliveId: '40000000-0000-4000-8000-000000000000',
  expiredId: '40000000-0000-4000-8000-000000000001',
  noAnswerId: '40000000-0000-4000-8000-000000000002',
  garbageId: '40000000-0000-4000-8000-000000000003',
}

test('health mapping: alive -> in-use, expired -> idle, no answer -> unresponsive, an unparseable body -> unresponsive', async () => {
  sessionRows = Object.values(HEALTH_SESSIONS).map((id) => ({
    id,
    projectId: PROJECT_ID,
    title: null,
    branch: null,
  }))
  projectRows = [{ id: PROJECT_ID, name: 'Demo' }]

  const containers = [
    rawContainer('agentoo_editor-demo_s-100000000000', 'running', HEALTH_SESSIONS.aliveId),
    rawContainer('agentoo_editor-demo_s-200000000000', 'running', HEALTH_SESSIONS.expiredId),
    rawContainer('agentoo_editor-demo_s-300000000000', 'running', HEALTH_SESSIONS.noAnswerId),
    rawContainer('agentoo_editor-demo_s-400000000000', 'running', HEALTH_SESSIONS.garbageId),
  ]
  healthBySocket.set(editorSocketPath(HEALTH_SESSIONS.aliveId), {
    answered: true,
    alive: true,
    lastHeartbeat: 5000,
  })
  healthBySocket.set(editorSocketPath(HEALTH_SESSIONS.expiredId), {
    answered: true,
    alive: false,
    lastHeartbeat: 1000,
  })
  healthBySocket.set(editorSocketPath(HEALTH_SESSIONS.noAnswerId), {
    answered: false,
    alive: null,
    lastHeartbeat: null,
  })
  // What container.ts's own probeEditorHealth reports for a 200 whose body did
  // not parse — `answered: true`, `alive: null` (see that function's own
  // comment); the service must treat this identically to no answer at all.
  healthBySocket.set(editorSocketPath(HEALTH_SESSIONS.garbageId), {
    answered: true,
    alive: null,
    lastHeartbeat: null,
  })

  const result = await listRunningEditors(fakeCli(containers) as never)
  const byId = new Map(result.editors.map((e) => [e.sessionId, e]))

  expect(byId.get(HEALTH_SESSIONS.aliveId)?.health).toBe('in-use')
  expect(byId.get(HEALTH_SESSIONS.expiredId)?.health).toBe('idle')
  expect(byId.get(HEALTH_SESSIONS.noAnswerId)?.health).toBe('unresponsive')
  expect(byId.get(HEALTH_SESSIONS.garbageId)?.health).toBe('unresponsive')
})

// --- sort order: idle, then unresponsive, then in-use; oldest first, nulls first --

test('editors sort idle, then unresponsive, then in-use; within a group, oldest lastActiveAt first with nulls first', async () => {
  const ids = {
    inUseNewer: '50000000-0000-4000-8000-000000000000',
    inUseOlder: '50000000-0000-4000-8000-000000000001',
    idleNull: '50000000-0000-4000-8000-000000000002',
    idleOld: '50000000-0000-4000-8000-000000000003',
    unresponsive: '50000000-0000-4000-8000-000000000004',
  }
  sessionRows = Object.values(ids).map((id) => ({ id, projectId: PROJECT_ID, title: null, branch: null }))
  projectRows = [{ id: PROJECT_ID, name: 'Demo' }]

  const containers = Object.values(ids).map((id, i) =>
    rawContainer(`agentoo_editor-demo_s-slot${i}`, 'running', id),
  )
  healthBySocket.set(editorSocketPath(ids.inUseNewer), { answered: true, alive: true, lastHeartbeat: 5000 })
  healthBySocket.set(editorSocketPath(ids.inUseOlder), { answered: true, alive: true, lastHeartbeat: 1000 })
  healthBySocket.set(editorSocketPath(ids.idleNull), { answered: true, alive: false, lastHeartbeat: 0 })
  healthBySocket.set(editorSocketPath(ids.idleOld), { answered: true, alive: false, lastHeartbeat: 2000 })
  healthBySocket.set(editorSocketPath(ids.unresponsive), { answered: false, alive: null, lastHeartbeat: null })

  const result = await listRunningEditors(fakeCli(containers) as never)
  expect(result.editors.map((e) => e.sessionId)).toEqual([
    ids.idleNull,
    ids.idleOld,
    ids.unresponsive,
    ids.inUseOlder,
    ids.inUseNewer,
  ])
})

// --- disabled: covered in editor-service-disabled.scenarios.ts instead ------
//
// `editorEnabled` is fixed true for this whole file (see this file's own env
// mock, above) — see that other file's own header for why it cannot be
// flipped mid-run, and its own test for the `enabled: false` zero-state this
// endpoint reports there instead.

// --- daemon down: 200 with zeros, never a throw ------------------------------

test('a down daemon (ps/inspect both fail) answers 200 with every count at zero, not a throw', async () => {
  sessionRows = [{ id: SESSION_ID, projectId: PROJECT_ID, title: 'Ours', branch: null }]
  projectRows = [{ id: PROJECT_ID, name: 'Demo' }]
  const container = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaaa', 'running', SESSION_ID)

  const result = await listRunningEditors(fakeCli([container], { down: true }) as never)

  expect(result.enabled).toBe(true)
  expect(result.running).toBe(0)
  expect(result.otherInstallsRunning).toBe(0)
  expect(result.editors).toEqual([])
})
