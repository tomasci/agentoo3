// The three disk-usage endpoints, driven through the real `projectsRouter`
// (mounted under a parent with the hook app.ts uses) and the real
// features/projects service, against a fake database and the real `du` on a
// temp PROJECTS_DIR.
//
// What is faked is only the bottom of the stack: three drizzle query shapes
// the service already uses (list, get-by-id, delete-by-id). Its own process
// (see run-isolated.ts) because `db/client.ts` and `queue/index.ts` are
// replaced wholesale and PROJECTS_DIR has to be this run's own before `@/env`
// first parses it.
//
// The measurement is not faked: a request here starts a real background `du`,
// and a test that wants numbers does what the UI does — polls until
// `measuring` is false.

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { Param } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname
const KIB = 1024

const SCRATCH = await mkdtemp(join(tmpdir(), 'agentoo-disk-usage-routes-'))
const PROJECTS = join(SCRATCH, 'projects')
const SOURCES = join(SCRATCH, 'sources')
await mkdir(PROJECTS, { recursive: true })
await mkdir(SOURCES, { recursive: true })
// Before anything below reaches `@/env`, which parses process.env once.
process.env.PROJECTS_DIR = PROJECTS

afterAll(() => rm(SCRATCH, { recursive: true, force: true }))

// --- a fake database -------------------------------------------------------------

type Row = {
  id: string
  name: string
  slug: string
  source: 'clone' | 'existing' | 'empty'
  remoteUrl: null
  sourceName: null
  sshKeyId: null
  defaultBranch: null
  status: 'pending' | 'cloning' | 'ready' | 'needs_manual' | 'failed'
  lastError: null
  recoveryCommands: null
  createdAt: Date
  updatedAt: Date
}

let rows: Row[] = []

/** The value `eq(column, value)` bound — the one `Param` in the condition. */
function boundValue(condition: unknown): unknown {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? []
  const param = chunks.find((chunk): chunk is Param => chunk instanceof Param)
  return param?.value
}

mock.module(`${B}/db/client.ts`, () => ({
  db: {
    select: () => ({
      from: () => ({
        // listProjects
        orderBy: async () =>
          [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        // getProject, deleteProject's lookup
        where: (condition: unknown) => ({
          limit: async () => rows.filter((row) => row.id === boundValue(condition)),
        }),
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        rows = rows.filter((row) => row.id !== boundValue(condition))
      },
    }),
  },
  closeDb: async () => {},
}))

mock.module(`${B}/queue/index.ts`, () => ({
  enqueueProjectSetup: async () => ({}),
}))

const { projectsRouter } = await import(`${B}/features/projects/routes.ts`)
const { projectDiskUsageSchema } = await import(`${B}/features/projects/schema.ts`)
const { resetDiskUsageForTests } = await import(`${B}/features/projects/disk-usage.ts`)
const { openApiValidationHook } = await import(`${B}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', projectsRouter)
app.doc('/api/openapi.json', { openapi: '3.1.0', info: { title: 'test', version: '0' } })

// --- helpers -------------------------------------------------------------------------

const ID_ONE = '11111111-1111-4111-8111-111111111111'
const ID_TWO = '22222222-2222-4222-8222-222222222222'
const ID_THREE = '33333333-3333-4333-8333-333333333333'
const ID_UNKNOWN = '99999999-9999-4999-8999-999999999999'

let clock = 0
function addProject(
  id: string,
  slug: string,
  source: Row['source'] = 'clone',
  status: Row['status'] = 'ready',
): void {
  clock += 1
  rows.push({
    id,
    name: slug,
    slug,
    source,
    remoteUrl: null,
    sourceName: null,
    sshKeyId: null,
    defaultBranch: null,
    status,
    lastError: null,
    recoveryCommands: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)),
  })
}

/** What the setup worker does to a row, from outside this process. */
function setStatus(id: string, status: Row['status']): void {
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no project ${id}`)
  row.status = status
}

async function fill(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, randomBytes(bytes))
}

type Usage = {
  projectId: string
  totalBytes: number | null
  repoBytes: number | null
  worktreesBytes: number | null
  measuredAt: string | null
  measuring: boolean
  error: string | null
}

const request = (path: string, method = 'GET') => app.request(`/api${path}`, { method })

async function getUsage(id: string): Promise<Usage> {
  const res = await request(`/projects/${id}/disk-usage`)
  expect(res.status).toBe(200)
  return projectDiskUsageSchema.parse(await res.json())
}

/** Poll the way the UI does: until nothing is measuring. */
async function settled(id: string): Promise<Usage> {
  let usage = await getUsage(id)
  for (let i = 0; i < 300 && usage.measuring; i += 1) {
    await Bun.sleep(10)
    usage = await getUsage(id)
  }
  expect(usage.measuring).toBe(false)
  return usage
}

function expectAbout(actual: number | null, bytes: number, slack = 64 * KIB) {
  expect(actual).not.toBeNull()
  expect(actual ?? -1).toBeGreaterThanOrEqual(bytes)
  expect(actual ?? Number.POSITIVE_INFINITY).toBeLessThan(bytes + slack)
}

beforeEach(() => {
  rows = []
  resetDiskUsageForTests()
})

afterEach(async () => {
  await rm(PROJECTS, { recursive: true, force: true })
  await mkdir(PROJECTS, { recursive: true })
})

// --- GET /projects/disk-usage -----------------------------------------------------------

test('GET /projects/disk-usage reaches its own handler, not the /projects/{id} uuid check', async () => {
  const res = await request('/projects/disk-usage')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
  // ...while `{id}` itself still validates as a uuid.
  expect((await request('/projects/not-a-uuid')).status).toBe(400)
})

test('GET /projects/disk-usage answers at once for every project, in list order, and starts measuring', async () => {
  // Inserted out of order: the order is the list's (by creation time), not ours.
  addProject(ID_TWO, 'beta')
  addProject(ID_ONE, 'alpha')
  addProject(ID_THREE, 'gamma')
  await fill(join(PROJECTS, 'beta', 'repo', 'a.bin'), 128 * KIB)

  const res = await request('/projects/disk-usage')
  expect(res.status).toBe(200)
  const body: Usage[] = projectDiskUsageSchema.array().parse(await res.json())

  const listed = (await (await request('/projects')).json()) as Array<{ id: string }>
  expect(body.map((usage) => usage.projectId)).toEqual(listed.map((project) => project.id))
  expect(body.map((usage) => usage.projectId)).toEqual([ID_TWO, ID_ONE, ID_THREE])
  // Nothing has been measured, and nothing was waited for.
  for (const usage of body) {
    expect(usage).toMatchObject({
      totalBytes: null,
      repoBytes: null,
      worktreesBytes: null,
      measuredAt: null,
      measuring: true,
      error: null,
    })
  }

  const beta = await settled(ID_TWO)
  expectAbout(beta.repoBytes, 128 * KIB)
  expect(beta.worktreesBytes).toBe(0)
  expect(beta.error).toBeNull()
  expect(beta.measuredAt).not.toBeNull()

  // No folder on disk for the others: a failure, not a crash and not a zero.
  for (const id of [ID_ONE, ID_THREE]) {
    expect(await settled(id)).toEqual({
      projectId: id,
      totalBytes: null,
      repoBytes: null,
      worktreesBytes: null,
      measuredAt: null,
      measuring: false,
      error: 'Project folder not found',
    })
  }
})

test('GET /projects/disk-usage with the numbers already cached starts nothing new', async () => {
  addProject(ID_ONE, 'alpha')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 64 * KIB)
  const first = await settled(ID_ONE)

  await fill(join(PROJECTS, 'alpha', 'repo', 'b.bin'), 512 * KIB)
  const res = await request('/projects/disk-usage')
  const [usage] = projectDiskUsageSchema.array().parse(await res.json())
  // Fresh, so the answer is the cached one and the new file is not seen yet.
  expect(usage).toEqual(first)
})

// --- GET /projects/{id}/disk-usage -------------------------------------------------------

test('GET /projects/{id}/disk-usage: first call is not-yet-measured and measuring, then real numbers', async () => {
  addProject(ID_ONE, 'alpha')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 256 * KIB)
  await fill(join(PROJECTS, 'alpha', 'worktrees', 's1', 'b.bin'), 128 * KIB)
  await fill(join(PROJECTS, 'alpha', 'worktrees', 's2', 'c.bin'), 64 * KIB)

  expect(await getUsage(ID_ONE)).toEqual({
    projectId: ID_ONE,
    totalBytes: null,
    repoBytes: null,
    worktreesBytes: null,
    measuredAt: null,
    measuring: true,
    error: null,
  })

  const usage = await settled(ID_ONE)
  expectAbout(usage.repoBytes, 256 * KIB)
  expectAbout(usage.worktreesBytes, 192 * KIB)
  expectAbout(usage.totalBytes, 448 * KIB)
  expect(new Date(usage.measuredAt ?? '').toISOString()).toBe(usage.measuredAt ?? '')
})

test('GET /projects/{id}/disk-usage: an adopted project counts the folder its repo/ links to', async () => {
  addProject(ID_ONE, 'adopted', 'existing')
  await fill(join(SOURCES, 'my-app', 'main.bin'), 512 * KIB)
  await mkdir(join(PROJECTS, 'adopted'), { recursive: true })
  await symlink(join(SOURCES, 'my-app'), join(PROJECTS, 'adopted', 'repo'), 'dir')
  await fill(join(PROJECTS, 'adopted', 'worktrees', 's1', 'w.bin'), 64 * KIB)
  // Only an adopted repo/ is followed: a symlink anywhere else in the project
  // pointing at a big folder must cost ~nothing.
  await fill(join(SOURCES, 'big-folder', 'big.bin'), 1024 * KIB)
  await mkdir(join(PROJECTS, 'adopted', 'links'), { recursive: true })
  await symlink(join(SOURCES, 'big-folder'), join(PROJECTS, 'adopted', 'links', 'big'), 'dir')

  await getUsage(ID_ONE)
  const usage = await settled(ID_ONE)
  expectAbout(usage.repoBytes, 512 * KIB)
  expectAbout(usage.worktreesBytes, 64 * KIB)
  expectAbout(usage.totalBytes, 576 * KIB)
})

test('GET /projects/{id}/disk-usage: 404 for an unknown project, 400 for a malformed id', async () => {
  addProject(ID_ONE, 'alpha')
  const unknown = await request(`/projects/${ID_UNKNOWN}/disk-usage`)
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({ error: 'Project not found' })

  const malformed = await request('/projects/not-a-uuid/disk-usage')
  expect(malformed.status).toBe(400)
})

// --- POST /projects/{id}/disk-usage/refresh ------------------------------------------------

test('POST refresh re-measures although the cached numbers are fresh, keeping them meanwhile', async () => {
  addProject(ID_ONE, 'alpha')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 64 * KIB)
  await getUsage(ID_ONE)
  const before = await settled(ID_ONE)
  expectAbout(before.repoBytes, 64 * KIB)

  await fill(join(PROJECTS, 'alpha', 'repo', 'b.bin'), 512 * KIB)
  // Still fresh: a plain GET does not look again.
  expect(await getUsage(ID_ONE)).toEqual(before)

  const res = await request(`/projects/${ID_ONE}/disk-usage/refresh`, 'POST')
  expect(res.status).toBe(200)
  const refreshing = projectDiskUsageSchema.parse(await res.json())
  expect(refreshing).toEqual({ ...before, measuring: true })

  const after = await settled(ID_ONE)
  expectAbout(after.repoBytes, 576 * KIB)
  expect(after.totalBytes ?? 0).toBeGreaterThan(before.totalBytes ?? 0)
})

test('POST refresh on a never-measured project returns measuring with null numbers', async () => {
  addProject(ID_ONE, 'alpha')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 64 * KIB)
  const res = await request(`/projects/${ID_ONE}/disk-usage/refresh`, 'POST')
  expect(res.status).toBe(200)
  expect(projectDiskUsageSchema.parse(await res.json())).toMatchObject({
    projectId: ID_ONE,
    totalBytes: null,
    measuring: true,
  })
  expectAbout((await settled(ID_ONE)).repoBytes, 64 * KIB)
})

test('POST refresh: 404 for an unknown project, 400 for a malformed id', async () => {
  const unknown = await request(`/projects/${ID_UNKNOWN}/disk-usage/refresh`, 'POST')
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({ error: 'Project not found' })
  expect((await request('/projects/not-a-uuid/disk-usage/refresh', 'POST')).status).toBe(400)
})

// --- a project's status changing under the cache -------------------------------------------------

test('a project being set up is not measured by GET, list or refresh, though its folder is there', async () => {
  addProject(ID_ONE, 'alpha', 'clone', 'pending')
  addProject(ID_TWO, 'beta', 'clone', 'cloning')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 64 * KIB)
  await fill(join(PROJECTS, 'beta', 'repo', 'a.bin'), 64 * KIB)

  const nothing = (id: string): Usage => ({
    projectId: id,
    totalBytes: null,
    repoBytes: null,
    worktreesBytes: null,
    measuredAt: null,
    measuring: false,
    error: null,
  })

  const list = projectDiskUsageSchema
    .array()
    .parse(await (await request('/projects/disk-usage')).json())
  expect(list).toEqual([nothing(ID_ONE), nothing(ID_TWO)])
  expect(await getUsage(ID_ONE)).toEqual(nothing(ID_ONE))
  for (const id of [ID_ONE, ID_TWO]) {
    const res = await request(`/projects/${id}/disk-usage/refresh`, 'POST')
    expect(res.status).toBe(200)
    expect(projectDiskUsageSchema.parse(await res.json())).toEqual(nothing(id))
  }

  // Long enough for a du over a tiny tree to have finished many times over.
  await Bun.sleep(150)
  expect(await getUsage(ID_ONE)).toEqual(nothing(ID_ONE))
  expect(await getUsage(ID_TWO)).toEqual(nothing(ID_TWO))
})

test('pending, then ready: the first ready request measures, with no leftovers from before', async () => {
  addProject(ID_ONE, 'alpha', 'clone', 'pending')
  expect((await getUsage(ID_ONE)).measuring).toBe(false)

  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 128 * KIB)
  setStatus(ID_ONE, 'ready')
  expect(await getUsage(ID_ONE)).toMatchObject({ measuring: true, totalBytes: null, error: null })
  const usage = await settled(ID_ONE)
  expectAbout(usage.repoBytes, 128 * KIB)
  expect(usage.error).toBeNull()
})

test('needs_manual with no folder, then fixed and ready: the old error is gone and the folder is measured', async () => {
  addProject(ID_ONE, 'alpha', 'clone', 'needs_manual')
  await getUsage(ID_ONE)
  expect((await settled(ID_ONE)).error).toBe('Project folder not found')

  // Still needs_manual, still inside the 30s failure TTL: served as it is.
  expect(await getUsage(ID_ONE)).toMatchObject({
    error: 'Project folder not found',
    measuring: false,
  })

  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 256 * KIB)
  setStatus(ID_ONE, 'ready')
  expect(await getUsage(ID_ONE)).toMatchObject({ error: null, measuring: true })

  const usage = await settled(ID_ONE)
  expectAbout(usage.repoBytes, 256 * KIB)
  expect(usage.error).toBeNull()
})

test('a half-cloned tree measured under failed is replaced by the real one once ready', async () => {
  addProject(ID_ONE, 'alpha', 'clone', 'failed')
  await fill(join(PROJECTS, 'alpha', 'repo', 'partial.bin'), 64 * KIB)
  await getUsage(ID_ONE)
  expectAbout((await settled(ID_ONE)).repoBytes, 64 * KIB)

  await fill(join(PROJECTS, 'alpha', 'repo', 'rest.bin'), 512 * KIB)
  setStatus(ID_ONE, 'ready')
  // Five minutes have not passed, yet the old figure is not served as current.
  const first = await getUsage(ID_ONE)
  expect(first.measuring).toBe(true)
  expectAbout(first.repoBytes, 64 * KIB) // stale-while-revalidate
  expectAbout((await settled(ID_ONE)).repoBytes, 576 * KIB)
})

// --- deleting a project ------------------------------------------------------------------------

test('deleting a project drops its cached numbers and its row from the list', async () => {
  addProject(ID_ONE, 'alpha')
  addProject(ID_TWO, 'beta')
  await fill(join(PROJECTS, 'alpha', 'repo', 'a.bin'), 64 * KIB)
  await getUsage(ID_ONE)
  expect((await settled(ID_ONE)).totalBytes).not.toBeNull()

  expect((await request(`/projects/${ID_ONE}`, 'DELETE')).status).toBe(204)
  expect((await request(`/projects/${ID_ONE}/disk-usage`)).status).toBe(404)
  const list: Usage[] = projectDiskUsageSchema
    .array()
    .parse(await (await request('/projects/disk-usage')).json())
  expect(list.map((usage) => usage.projectId)).toEqual([ID_TWO])

  // The same id reappearing must not be served the deleted project's numbers.
  addProject(ID_ONE, 'alpha')
  expect(await getUsage(ID_ONE)).toMatchObject({
    totalBytes: null,
    measuredAt: null,
    measuring: true,
  })
})

// --- the declared contract ------------------------------------------------------------------------

test('the OpenAPI document declares the three operations and the ProjectDiskUsage component', async () => {
  const doc = (await (await app.request('/api/openapi.json')).json()) as {
    paths: Record<
      string,
      Record<string, { operationId?: string; tags?: string[]; responses: Record<string, unknown> }>
    >
    components: {
      schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }>
    }
  }

  const list = doc.paths['/api/projects/disk-usage']?.get
  expect(list?.operationId).toBe('getProjectsDiskUsage')
  const one = doc.paths['/api/projects/{id}/disk-usage']?.get
  expect(one?.operationId).toBe('getProjectDiskUsage')
  const refresh = doc.paths['/api/projects/{id}/disk-usage/refresh']?.post
  expect(refresh?.operationId).toBe('refreshProjectDiskUsage')
  for (const operation of [list, one, refresh]) expect(operation?.tags).toEqual(['projects'])

  // Every status the handlers can actually return is declared.
  expect(Object.keys(list?.responses ?? {})).toEqual(['200'])
  expect(Object.keys(one?.responses ?? {}).sort()).toEqual(['200', '404'])
  expect(Object.keys(refresh?.responses ?? {}).sort()).toEqual(['200', '404'])

  const component = doc.components.schemas.ProjectDiskUsage
  expect(Object.keys(component?.properties ?? {}).sort()).toEqual(
    [
      'error',
      'measuredAt',
      'measuring',
      'projectId',
      'repoBytes',
      'totalBytes',
      'worktreesBytes',
    ].sort(),
  )
  // Nullability is part of the contract: every field is required, some may be null.
  expect([...(component?.required ?? [])].sort()).toEqual(
    Object.keys(component?.properties ?? {}).sort(),
  )
})
