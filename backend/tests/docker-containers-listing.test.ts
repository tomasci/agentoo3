// containers.ts as a leaf, with nothing mocked: `listScopeContainers` takes
// its `DockerCli` as an argument, so the whole module can be exercised by
// handing it a fake daemon -- no `mock.module`, no process-global state, no
// ordering coupling to any other file in this suite.
//
// docker-scope-isolation.test.ts already drives this same module end to end
// through service.ts for the cross-scope reachability claims. What is pinned
// here instead is the narrowing rule itself (Defect 4: membership decided by
// the `com.agentoo.session` label, never by container name) and the
// degradation paths a misbehaving daemon takes through it -- the ones the
// session-teardown gate depends on to never make a session undeletable.

import { expect, test } from 'bun:test'
import type { DockerCli, DockerResult, DockerStream } from '../src/features/docker/cli'
import { listScopeContainers } from '../src/features/docker/containers'

const SLUG = 'demo'
const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const REPO = { slug: SLUG, sessionId: null }
const SCOPE_A = { slug: SLUG, sessionId: SESSION_A }

const id = (c: string) => c.repeat(64)

interface FakeContainer {
  name: string
  labels: Record<string, string> | null
}

/**
 * A daemon that answers `ps -aq --filter <f>` from `psByFilter` and
 * `inspect ... <ids>` from `byId`. Every call it received is recorded, so a
 * test can assert on what was asked as well as what came back.
 */
function fakeDaemon(
  byId: Record<string, FakeContainer>,
  psByFilter: (filter: string) => string[],
): { cli: DockerCli; calls: string[][] } {
  const calls: string[][] = []
  const cli: DockerCli = {
    async run(args: string[]): Promise<DockerResult> {
      calls.push(args)
      if (args[0] === 'ps') {
        return { ok: true, stdout: psByFilter(args[3] ?? '').join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'inspect') {
        const ids = args.slice(5)
        const lines = ids
          .filter((i) => byId[i])
          .map((i) =>
            JSON.stringify({
              Id: i,
              Name: byId[i]?.name,
              Config: { Labels: byId[i]?.labels },
              State: { Status: 'running' },
            }),
          )
        return { ok: true, stdout: lines.join('\n'), stderr: '', exitCode: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exitCode: 0 }
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
  return { cli, calls }
}

const PROJECT_FILTER = `label=com.agentoo.project=${SLUG}`

// --- Defect 4: membership is decided by label, never by name -------------------

test('a project-labelled container with an ARBITRARY name is listed at repo scope', async () => {
  // The exact regression: repo scope used to narrow by
  // `c.name === containerName(ref)`, which dropped every container that
  // carries this project's label but was renamed or hand-labelled.
  const { cli } = fakeDaemon(
    { [id('a')]: { name: '/nothing-like-agentoo-demo', labels: { 'com.agentoo.project': SLUG } } },
    (f) => (f === PROJECT_FILTER ? [id('a')] : []),
  )
  const listed = await listScopeContainers(REPO, cli)
  expect(listed.map((c) => c.name)).toEqual(['nothing-like-agentoo-demo'])
})

test('a worktree container is NOT visible at repo scope, even under a repo-looking name', async () => {
  const { cli } = fakeDaemon(
    {
      [id('a')]: {
        name: '/agentoo-demo', // deliberately the repo-scope name
        labels: { 'com.agentoo.project': SLUG, 'com.agentoo.session': SESSION_A },
      },
    },
    (f) => (f === PROJECT_FILTER ? [id('a')] : []),
  )
  expect(await listScopeContainers(REPO, cli)).toEqual([])
  // ...and it IS visible from its own session, despite the misleading name.
  expect((await listScopeContainers(SCOPE_A, cli)).map((c) => c.id)).toEqual([id('a')])
})

test("session B's container is not reachable from session A, by label", async () => {
  const { cli } = fakeDaemon(
    {
      [id('a')]: {
        name: `/agentoo-${SLUG}_s-aaaaaaaa1111`,
        labels: { 'com.agentoo.project': SLUG, 'com.agentoo.session': SESSION_A },
      },
      [id('b')]: {
        name: `/agentoo-${SLUG}_s-bbbbbbbb2222`,
        labels: { 'com.agentoo.project': SLUG, 'com.agentoo.session': SESSION_B },
      },
    },
    (f) => (f === PROJECT_FILTER ? [id('a'), id('b')] : []),
  )
  expect((await listScopeContainers(SCOPE_A, cli)).map((c) => c.id)).toEqual([id('a')])
  expect((await listScopeContainers({ slug: SLUG, sessionId: SESSION_B }, cli)).map((c) => c.id)).toEqual([
    id('b'),
  ])
  expect(await listScopeContainers(REPO, cli)).toEqual([])
})

test('a compose container is owned on the strength of the compose filter alone', async () => {
  // It matched `composeProjectLabelFilter`, so it is this scope's by
  // construction — no `com.agentoo.session` label is ever stamped on a
  // compose service (we never edit the user's file), and requiring one would
  // drop every compose container from every listing.
  const composeFilter = `label=com.docker.compose.project=agentoo-${SLUG}_s-aaaaaaaa1111`
  const { cli } = fakeDaemon(
    {
      [id('c')]: {
        name: `/agentoo-${SLUG}_s-aaaaaaaa1111-web-1`,
        labels: { 'com.docker.compose.service': 'web' },
      },
    },
    (f) => (f === composeFilter ? [id('c')] : []),
  )
  const listed = await listScopeContainers(SCOPE_A, cli)
  expect(listed).toHaveLength(1)
  expect(listed[0]?.service).toBe('web')
})

test('a container matching BOTH filters is returned exactly once', async () => {
  const { cli } = fakeDaemon(
    {
      [id('a')]: {
        name: `/agentoo-${SLUG}`,
        labels: { 'com.agentoo.project': SLUG, 'com.docker.compose.project': `agentoo-${SLUG}` },
      },
    },
    () => [id('a')], // every filter matches it
  )
  const listed = await listScopeContainers(REPO, cli)
  expect(listed.map((c) => c.id)).toEqual([id('a')])
})

// --- degradation: the teardown gate leans on every one of these -----------------

test('a daemon that refuses every call yields [], not a throw', async () => {
  const cli: DockerCli = {
    async run() {
      return { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
  expect(await listScopeContainers(REPO, cli)).toEqual([])
  expect(await listScopeContainers(SCOPE_A, cli)).toEqual([])
})

test('a missing docker binary (-127) yields [], not a throw', async () => {
  const cli: DockerCli = {
    async run() {
      return { ok: false, stdout: '', stderr: 'ENOENT', exitCode: -127 }
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
  expect(await listScopeContainers(SCOPE_A, cli)).toEqual([])
})

test('unparsable inspect output yields [], not a throw', async () => {
  const cli: DockerCli = {
    async run(args: string[]) {
      if (args[0] === 'ps') return { ok: true, stdout: id('a'), stderr: '', exitCode: 0 }
      return { ok: true, stdout: 'not json at all\n{{{', stderr: '', exitCode: 0 }
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
  expect(await listScopeContainers(REPO, cli)).toEqual([])
})

test('a daemon that dies BETWEEN ps and inspect yields [], not a throw', async () => {
  // `ps` succeeds and names containers; the daemon then goes away before
  // `inspect` runs. This is the only path on which `inspectContainersRaw`
  // sees a failed call at all (an empty id list never spawns it), and the
  // session-teardown gate depends on it degrading rather than throwing --
  // a throw here would make the session undeletable.
  const cli: DockerCli = {
    async run(args: string[]) {
      if (args[0] === 'ps') return { ok: true, stdout: id('a'), stderr: '', exitCode: 0 }
      return { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
  expect(await listScopeContainers(REPO, cli)).toEqual([])
  expect(await listScopeContainers(SCOPE_A, cli)).toEqual([])
})

test('ids `ps` reported but `inspect` no longer knows about are simply absent', async () => {
  // The container was removed between the two calls — a real race, not an error.
  const { cli } = fakeDaemon(
    { [id('a')]: { name: '/kept', labels: { 'com.agentoo.project': SLUG } } },
    (f) => (f === PROJECT_FILTER ? [id('a'), id('z')] : []),
  )
  expect((await listScopeContainers(REPO, cli)).map((c) => c.name)).toEqual(['kept'])
})

test('a container with a null Labels block is dropped at repo scope only if it is not compose-matched', async () => {
  // `Labels: null` is docker's shape for "no labels at all". It cannot have
  // matched `projectLabelFilter`, so reaching this code means `ps` matched it
  // on the compose filter — in which case it is owned outright.
  const composeFilter = `label=com.docker.compose.project=agentoo-${SLUG}`
  const { cli } = fakeDaemon(
    { [id('a')]: { name: '/weird', labels: null } },
    (f) => (f === composeFilter ? [id('a')] : []),
  )
  expect((await listScopeContainers(REPO, cli)).map((c) => c.name)).toEqual(['weird'])
})

test('no matching containers is an empty list and exactly two ps calls, no inspect', async () => {
  const { cli, calls } = fakeDaemon({}, () => [])
  expect(await listScopeContainers(SCOPE_A, cli)).toEqual([])
  expect(calls.map((a) => a[0])).toEqual(['ps', 'ps'])
})

// --- the argv this listing is built from ---------------------------------------

test('both filters are queried: the compose project label AND the slug-only project label', async () => {
  const { cli, calls } = fakeDaemon({}, () => [])
  await listScopeContainers(SCOPE_A, cli)
  const filters = calls.filter((a) => a[0] === 'ps').map((a) => a[3])
  expect(filters).toEqual([
    `label=com.docker.compose.project=agentoo-${SLUG}_s-aaaaaaaa1111`,
    `label=com.agentoo.project=${SLUG}`,
  ])
})

test('at repo scope the compose filter carries no scope suffix', async () => {
  const { cli, calls } = fakeDaemon({}, () => [])
  await listScopeContainers(REPO, cli)
  const filters = calls.filter((a) => a[0] === 'ps').map((a) => a[3])
  expect(filters).toEqual([
    `label=com.docker.compose.project=agentoo-${SLUG}`,
    `label=com.agentoo.project=${SLUG}`,
  ])
})

test('the DTOs returned carry no raw labels at all', async () => {
  const { cli } = fakeDaemon(
    {
      [id('a')]: {
        name: '/agentoo-demo',
        labels: {
          'com.agentoo.project': SLUG,
          'com.agentoo.managed': '1',
          'com.docker.compose.service': 'web',
        },
      },
    },
    (f) => (f === PROJECT_FILTER ? [id('a')] : []),
  )
  const [dto] = await listScopeContainers(REPO, cli)
  expect(dto?.service).toBe('web') // the one derived value that IS exposed
  expect(JSON.stringify(dto)).not.toContain('com.agentoo')
  expect(JSON.stringify(dto)).not.toContain('com.docker.compose.project')
})
