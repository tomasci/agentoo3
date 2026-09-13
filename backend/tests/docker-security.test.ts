// The security boundary of the docker feature, exercised through the router
// rather than through the pure argv builders: what a client can put in a
// request body or a path segment, and where it ends up.
//
// Two things are pinned here that no other file pins:
//   - container ownership. GET .../containers/{id}/logs must 404 for anything
//     not labelled as belonging to *this* project, with a body indistinguishable
//     from "no such container" so it cannot be used to probe the box.
//   - argv position. Every operator-supplied value that survives validation is
//     asserted to arrive as its own array element, never adjacent to a flag and
//     never inside a shell string.
//
// `mock.module` is process-global in bun's shared test process, so every
// specifier mocked below is either restored in afterAll (env, cli) or is a
// module nothing outside this feature imports.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'
import { notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-docker-security-'))

// Forwarded in full, not rebuilt: `hasClaudeCredential` is a second export of
// this module that unrelated tests later in the same process read live.
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

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const SLUG_A = 'demo'
const SLUG_B = 'other'
const REPO_A = join(TEST_PROJECTS_DIR, SLUG_A, 'repo')
const REPO_B = join(TEST_PROJECTS_DIR, SLUG_B, 'repo')

const projectRow = (id: string, slug: string, path: string) => ({
  id,
  name: slug,
  slug,
  source: 'clone' as const,
  remoteUrl: 'https://example.com/x.git',
  sourceName: null,
  sshKeyId: null,
  defaultBranch: null,
  status: 'ready' as const,
  lastError: null,
  recoveryCommands: null,
  path,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
})

const projects = [
  projectRow(PROJECT_A, SLUG_A, REPO_A),
  projectRow(PROJECT_B, SLUG_B, REPO_B),
]

mock.module(`${B}/features/projects/service.ts`, () => ({
  getProject: async (id: string) => {
    const found = projects.find((p) => p.id === id)
    if (!found) throw notFound('Project')
    return found
  },
  listProjects: async () => projects,
}))

// Captured before it is replaced, and restored in afterAll: `mock.module` is
// process-global, and a later file that exercises the real host-address path
// would otherwise silently get this canned empty list instead.
const realHosts = { ...(await import(`${B}/features/docker/hosts.ts`)) } as Record<string, unknown>
mock.module(`${B}/features/docker/hosts.ts`, () => ({
  ...realHosts,
  getHostAddresses: async () => [],
}))

const enqueued: unknown[] = []
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
  enqueueDockerOp: async (job: unknown) => {
    enqueued.push(job)
    return {}
  },
}))

const operationRecords = new Map<string, Record<string, unknown>>()
let activeOperation: string | undefined
mock.module(`${B}/features/docker/operations.ts`, () => ({
  activeOperationForProject: async () => activeOperation,
  createOperation: async (input: { id: string; projectId: string; kind: string; services: string[] }) => {
    const record = {
      ...input,
      status: 'queued',
      exitCode: null,
      error: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    }
    operationRecords.set(input.id, record)
    return record
  },
  finishOperation: async () => undefined,
  getOperation: async (id: string) => operationRecords.get(id),
  listOperationsForProject: async () => [],
  replayOperationOutput: async () => [],
  subscribeOperationEvents: () => () => {},
}))

// --- the CLI seam ------------------------------------------------------------
//
// routes.ts reaches for `realDockerCli` directly (the logs route is the one
// code path with no injectable cli parameter), so this is the only way to
// exercise it without a daemon. Every other export of cli.ts is forwarded
// unchanged, and the whole module is restored in afterAll.

const realCliModule = { ...(await import(`${B}/features/docker/cli.ts`)) } as Record<
  string,
  unknown
>

interface RunCall {
  args: string[]
  cwd?: string
}
const runCalls: RunCall[] = []
const streamCalls: RunCall[] = []
const closedStreams: string[] = []

let containerLabelsById: Record<string, Record<string, string>> = {}
let composeServiceNames: string[] = ['web', 'db']

const VERSION_JSON = JSON.stringify({ Client: { Version: '26.1.4' }, Server: { Version: '26.1.4' } })

const fakeRealCli = {
  async run(args: string[], options: { cwd?: string } = {}) {
    runCalls.push({ args, cwd: options.cwd })
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', exitCode: 0 })
    if (args[0] === 'version') return ok(VERSION_JSON)
    if (args[0] === 'inspect') {
      const id = args[args.length - 1] ?? ''
      const labels = containerLabelsById[id]
      if (!labels) return { ok: false, stdout: '', stderr: 'No such object', exitCode: 1 }
      return ok(JSON.stringify({ Id: id, Name: `/${id.slice(0, 6)}`, Config: { Labels: labels } }))
    }
    if (args[0] === 'compose' && args.includes('version')) return ok('{"version":"v2.24.0"}')
    if (args[0] === 'compose' && args.includes('config') && args.includes('--format')) {
      const services = Object.fromEntries(composeServiceNames.map((n) => [n, { image: 'nginx' }]))
      return ok(JSON.stringify({ services }))
    }
    if (args[0] === 'compose' && args.includes('ls')) return ok('[]')
    if (args[0] === 'ps') return ok('')
    return ok('')
  },
  stream(args: string[], options: { cwd?: string } = {}) {
    streamCalls.push({ args, cwd: options.cwd })
    const id = args[args.length - 1] ?? ''
    return {
      lines: (async function* () {
        yield { stream: 'stdout' as const, line: '2024-05-01T10:00:00Z hello' }
      })(),
      close() {
        closedStreams.push(id)
      },
      exited: Promise.resolve(0),
    }
  },
}

mock.module(`${B}/features/docker/cli.ts`, () => ({ ...realCliModule, realDockerCli: fakeRealCli }))

const { dockerRouter, resetLogStreamSlotsForTests } = await import(
  `${B}/features/docker/routes.ts`
)
const { openApiValidationHook } = await import(`${B}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', dockerRouter)

afterAll(async () => {
  mock.module(`${B}/features/docker/cli.ts`, () => realCliModule)
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/docker/hosts.ts`, () => realHosts)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

await mkdir(REPO_A, { recursive: true })
await mkdir(REPO_B, { recursive: true })
await writeFile(join(REPO_A, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n')
await writeFile(join(REPO_B, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n')

beforeEach(() => {
  runCalls.length = 0
  streamCalls.length = 0
  closedStreams.length = 0
  enqueued.length = 0
  activeOperation = undefined
  composeServiceNames = ['web', 'db']
  resetLogStreamSlotsForTests()
  containerLabelsById = {
    // Project A's compose container.
    ['a'.repeat(64)]: { 'com.docker.compose.project': 'agentoo-demo', 'com.docker.compose.service': 'web' },
    // Project A's plain-Dockerfile container.
    ['b'.repeat(64)]: { 'com.agentoo.project': 'demo', 'com.agentoo.managed': '1' },
    // Project B's compose container.
    ['c'.repeat(64)]: { 'com.docker.compose.project': 'agentoo-other', 'com.docker.compose.service': 'web' },
    // Somebody else's container entirely.
    ['d'.repeat(64)]: { 'org.opencontainers.image.title': 'postgres' },
  }
})

const logsUrl = (projectId: string, containerId: string, query = '') =>
  `/api/projects/${projectId}/docker/containers/${containerId}${query ? `/logs?${query}` : '/logs'}`

/**
 * Reads the frames already buffered on an SSE body and then cancels it.
 *
 * Deliberately not `res.text()`: this feature's container-logs body is never
 * closed by the server even after `docker logs` has exited (see
 * docker-sse-lifecycle.test.ts, which pins that as a defect), so reading to
 * EOF here would hang this file rather than fail it.
 */
async function drain(res: Response, chunks = 1): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (let i = 0; i < chunks; i++) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return text
}

// --- container ownership -------------------------------------------------------

test("a container labelled for this project's compose stack streams its logs", async () => {
  const res = await app.request(logsUrl(PROJECT_A, 'a'.repeat(64)))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  const body = await drain(res, 3)
  expect(body).toContain('event: open')
  expect(body).toContain('"text":"hello"')
})

test('a plain-Dockerfile container carrying com.agentoo.project also streams', async () => {
  const res = await app.request(logsUrl(PROJECT_A, 'b'.repeat(64)))
  expect(res.status).toBe(200)
  await drain(res)
})

test("project A cannot read project B's container logs", async () => {
  const res = await app.request(logsUrl(PROJECT_A, 'c'.repeat(64)))
  expect(res.status).toBe(404)
  expect(streamCalls).toHaveLength(0)
})

test('an unrelated container on the box is 404, not streamed', async () => {
  const res = await app.request(logsUrl(PROJECT_A, 'd'.repeat(64)))
  expect(res.status).toBe(404)
  expect(streamCalls).toHaveLength(0)
})

test('a container that does not exist and one that belongs to another project are indistinguishable', async () => {
  const foreign = await app.request(logsUrl(PROJECT_A, 'c'.repeat(64)))
  const missing = await app.request(logsUrl(PROJECT_A, 'e'.repeat(64)))
  expect(foreign.status).toBe(missing.status)
  expect(await foreign.text()).toBe(await missing.text())
})

test('the ownership check inspects exactly the requested id, as its own argv element', async () => {
  await app.request(logsUrl(PROJECT_A, 'c'.repeat(64)))
  const inspect = runCalls.find((c) => c.args[0] === 'inspect')
  expect(inspect?.args).toEqual([
    'inspect',
    '--type',
    'container',
    '--format',
    '{{json .}}',
    'c'.repeat(64),
  ])
})

test('the logs argv places --follow/--timestamps/--tail before the id, each its own element', async () => {
  await drain(await app.request(logsUrl(PROJECT_A, 'a'.repeat(64), 'tail=100')))
  expect(streamCalls[0]?.args).toEqual([
    'logs',
    '--follow',
    '--timestamps',
    '--tail',
    '100',
    'a'.repeat(64),
  ])
})

test('since is passed as a separate argv element, never concatenated', async () => {
  await drain(
    await app.request(logsUrl(PROJECT_A, 'a'.repeat(64), 'since=2024-05-01T00%3A00%3A00Z')),
  )
  expect(streamCalls[0]?.args).toEqual([
    'logs',
    '--follow',
    '--timestamps',
    '--tail',
    '500',
    '--since',
    '2024-05-01T00:00:00Z',
    'a'.repeat(64),
  ])
})

// --- containerId validation ------------------------------------------------------

const HOSTILE_IDS = [
  '-f',
  '--tail',
  '--follow',
  '-'.repeat(12),
  `${'a'.repeat(12)};id`,
  `${'a'.repeat(12)} --follow`,
  `$(id)${'a'.repeat(12)}`,
  'A'.repeat(64),
  'a'.repeat(11),
  'a'.repeat(65),
  'g'.repeat(12),
  `${'a'.repeat(12)}\n`,
]

for (const id of HOSTILE_IDS) {
  test(`containerId ${JSON.stringify(id)} is refused before any docker call`, async () => {
    const res = await app.request(logsUrl(PROJECT_A, encodeURIComponent(id)))
    expect(res.status).toBe(400)
    expect(runCalls).toHaveLength(0)
    expect(streamCalls).toHaveLength(0)
  })
}

test('a rejected containerId names containerId as the offending field', async () => {
  const res = await app.request(logsUrl(PROJECT_A, '--follow'))
  const body = (await res.json()) as { error: string; issues?: { path: string }[] }
  expect(body.error).toBe('Validation failed')
  expect(body.issues?.map((i) => i.path)).toContain('containerId')
})

test('tail and since are range- and format-checked before the stream opens', async () => {
  for (const query of ['tail=-1', 'tail=5001', 'tail=abc', 'since=--follow', 'since=nonsense']) {
    const res = await app.request(logsUrl(PROJECT_A, 'a'.repeat(64), query))
    expect(res.status).toBe(400)
  }
  expect(streamCalls).toHaveLength(0)
})

// --- request-body validation ------------------------------------------------------

const HOSTILE_SERVICE_NAMES = [
  '-f',
  '--build',
  '-v',
  'web db',
  'web;rm -rf /',
  '$(id)',
  '`id`',
  'web\nworker',
  'web|cat',
  '',
  'w'.repeat(64),
  '.leading-dot-is-fine-but-not-this/slash',
]

for (const name of HOSTILE_SERVICE_NAMES) {
  test(`up with service ${JSON.stringify(name)} is a 400 before any docker call`, async () => {
    const res = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ services: [name] }),
    })
    expect(res.status).toBe(400)
    expect(runCalls).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
  })
}

test('a service name that passes the regex but is not in the compose config is refused', async () => {
  const res = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ services: ['not-a-service'] }),
  })
  expect(res.status).toBe(400)
  expect((await res.json() as { error: string }).error).toContain('Unknown service')
  expect(enqueued).toHaveLength(0)
})

test('both gates exist: the regex, and membership in docker compose config', async () => {
  // Regex-legal and present in the config: accepted.
  const okRes = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ services: ['web'] }),
  })
  expect(okRes.status).toBe(202)
  expect(enqueued).toHaveLength(1)
  expect((enqueued[0] as { services: string[] }).services).toEqual(['web'])
})

test('more than 50 services is refused', async () => {
  const services = Array.from({ length: 51 }, (_, i) => `svc${i}`)
  const res = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ services }),
  })
  expect(res.status).toBe(400)
  expect(runCalls).toHaveLength(0)
})

test('a privileged hostPort is refused by the schema', async () => {
  const res = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPort: 80 }),
  })
  expect(res.status).toBe(400)
  expect(runCalls).toHaveLength(0)
})

// --- path confinement -----------------------------------------------------------

test('compose file paths come from the project row, and no request field can move them', async () => {
  const res = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      services: ['web'],
      // Every one of these is an attempt to steer the compose invocation.
      composeFiles: { base: '/etc/passwd' },
      projectPath: '/etc',
      slug: '../../etc',
      composeProjectName: 'agentoo-other',
      dockerfileAbsPath: '/etc/shadow',
    }),
  })
  expect(res.status).toBe(202)
  const job = enqueued[0] as {
    projectPath: string
    slug: string
    composeProjectName: string
    composeFiles: { base: string; override?: string }
    dockerfileAbsPath?: string
  }
  expect(job.projectPath).toBe(REPO_A)
  expect(job.slug).toBe(SLUG_A)
  expect(job.composeProjectName).toBe('agentoo-demo')
  expect(job.composeFiles.base).toBe(join(REPO_A, 'compose.yaml'))
  expect(job.composeFiles.override).toBeUndefined()
  expect(job.dockerfileAbsPath).toBeUndefined()
})

test("one project's operation is not readable through another project's id", async () => {
  const created = await app.request(`/api/projects/${PROJECT_A}/docker/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const { id } = (await created.json()) as { id: string }
  const own = await app.request(`/api/projects/${PROJECT_A}/docker/operations/${id}`)
  expect(own.status).toBe(200)
  const other = await app.request(`/api/projects/${PROJECT_B}/docker/operations/${id}`)
  expect(other.status).toBe(404)
})

// --- no shell, anywhere ----------------------------------------------------------

test('no module in the docker feature spawns through a shell', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = join(B, 'features', 'docker')
  const files = await readdir(dir)
  const sources = await Promise.all(
    files.map(async (f) => [f, await readFile(join(dir, f), 'utf8')] as const),
  )
  sources.push([
    'docker-op.worker.ts',
    await readFile(join(B, 'queue', 'docker-op.worker.ts'), 'utf8'),
  ])
  for (const [name, text] of sources) {
    expect(`${name}: ${text.includes('/bin/sh')}`).toBe(`${name}: false`)
    expect(`${name}: ${/\bsh\s+-c\b/.test(text)}`).toBe(`${name}: false`)
    expect(`${name}: ${text.includes('node:child_process')}`).toBe(`${name}: false`)
    expect(`${name}: ${/Bun\.\$/.test(text)}`).toBe(`${name}: false`)
    // Every spawn in this feature passes an array literal starting with 'docker'.
    for (const match of text.matchAll(/Bun\.spawn\(([^)]{0,20})/g)) {
      expect(`${name}: ${match[1]?.trimStart().startsWith('[')}`).toBe(`${name}: true`)
    }
  }
})
