// The System tab's Docker page (`/docker`, DockerSystemPage): every container
// on the host, one row each.
//
//   - status badge: running -> "Running"; exited/created/dead -> "Stopped";
//   - ports are the host port numbers joined by ", " (a dash if none), and no
//     address, arrow or protocol ever reaches the DOM;
//   - the owner cell's Open link: repo scope -> /projects/$id/docker, session
//     scope -> /projects/$id/sessions/$sid/docker, no link for owner: null;
//   - Stop only for running/restarting/paused, behind a confirm, sent with the
//     full 64-hex id, and the row flips to Stopped from the response alone;
//   - Stop disabled when `enabled: false`; a 409 raises the conflict toast;
//   - daemon-unavailable / not-installed / empty states; Refresh refetches;
//     the list polls every 5s;
//   - the System sidebar's Docker entry links to /docker.
//
// Router-mounted with a memory history, like docker-page.test.tsx and
// sessions-dashboard-page.test.tsx; the generated clients this page (and the
// project Docker page an Open link lands on) use are mocked per file through
// ./mock-module, and the shell's own queries are seeded with an infinite
// staleTime. Real i18n — see docker-page.test.tsx's header for why.
//
// Assertions compare primitives (text, href, booleans), never DOM nodes — see
// workspace.test.tsx's `ref` for why a failing matcher on a happy-dom element
// can OOM the shared process.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GetApiDockerContainersStatus200 as SystemState } from '../src/shared/api/generated/types/GetApiDockerContainers'
import type { GetApiProjectsIdDockerStatus200 as ProjectStatus } from '../src/shared/api/generated/types/GetApiProjectsIdDocker'
import { mockModule } from './mock-module'

import '@/shared/i18n'

type SystemContainer = SystemState['containers'][number]

const T = '2026-09-29T10:00:00.000Z'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '02c7a79d-6822-4344-a346-ecdf6e42de2c'
const FULL_ID = `${'ab12'.repeat(16)}`
const OTHER_ID = `${'cd34'.repeat(16)}`

const LIST_CLIENT = '@/shared/api/generated/clients/getApiDockerContainers'
const STOP_CLIENT = '@/shared/api/generated/clients/postApiDockerContainersContaineridStop'
const PROJECT_STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdDocker'
const PROJECT_SESSIONS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'

const box = (o: Partial<SystemContainer> & { id: string; name: string }): SystemContainer => ({
  shortId: o.id.slice(0, 12),
  image: 'alpine:latest',
  state: 'running',
  health: 'none',
  exitCode: 0,
  createdAt: T,
  startedAt: T,
  finishedAt: null,
  composeProject: null,
  service: null,
  ports: [],
  owner: null,
  ...o,
})

const repoOwner = {
  kind: 'compose' as const,
  projectId: PROJECT_ID,
  projectName: 'Alpha',
  projectSlug: 'alpha',
  sessionId: null,
  sessionTitle: null,
  branch: null,
}
const sessionOwner = {
  kind: 'dockerfile' as const,
  projectId: PROJECT_ID,
  projectName: 'Alpha',
  projectSlug: 'alpha',
  sessionId: SESSION_ID,
  sessionTitle: 'Docker system page',
  branch: 'agentoo/s-02c7a79d',
}

const state = (o: Partial<SystemState> = {}): SystemState => ({
  enabled: true,
  daemon: { cliInstalled: true, available: true, version: '27.0.0', error: null },
  containers: [],
  fetchedAt: T,
  ...o,
})

let current: SystemState = state()
let listCalls = 0
let stopCalls: { path: { containerId: string } }[] = []
let stopReject: unknown = null
let stopAnswer: (containerId: string) => SystemContainer | null = (id) =>
  box({ id, name: 'unused', state: 'exited', exitCode: 137, ports: [] })

await mockModule(LIST_CLIENT, () => ({
  getApiDockerContainers: async () => {
    listCalls++
    return { data: current }
  },
}))
await mockModule(STOP_CLIENT, () => ({
  postApiDockerContainersContaineridStop: async (opts: { path: { containerId: string } }) => {
    stopCalls.push(opts)
    if (stopReject) throw stopReject
    return { data: { container: stopAnswer(opts.path.containerId) } }
  },
}))

// Where an Open link lands: the project's own Docker page. Answered with a
// no-config status so that page mounts without a backend.
let projectStatusCalls: { path: { id: string }; query?: { sessionId?: string } }[] = []
const projectStatus = (sessionId: string | null): ProjectStatus => ({
  projectId: PROJECT_ID,
  sessionId,
  projectPath: '/srv/alpha/repo',
  scopePath: sessionId ? `/srv/alpha/worktrees/${sessionId}` : '/srv/alpha/repo',
  composeProject: null,
  daemon: { cliInstalled: true, available: true, version: '27.0.0', composeVersion: '2.29.0', error: null },
  detection: { hasCompose: false, hasDockerfile: false, composeFile: null, composeOverrideFile: null, dockerfile: null },
  configError: null,
  services: [],
  containers: [],
  image: null,
  dockerfilePorts: [],
  foreignStacks: [],
  hosts: [],
  activeOperationId: null,
  fetchedAt: T,
})
await mockModule(PROJECT_STATUS_CLIENT, () => ({
  getApiProjectsIdDocker: async (opts: { path: { id: string }; query?: { sessionId?: string } }) => {
    projectStatusCalls.push(opts)
    return { data: projectStatus(opts.query?.sessionId ?? null) }
  },
}))
await mockModule(PROJECT_SESSIONS_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({
    data: [
      {
        id: SESSION_ID, projectId: PROJECT_ID, ideaId: null, title: 'Docker system page', status: 'idle',
        orchestrator: null, worktreePath: `/srv/alpha/worktrees/${SESSION_ID}`, branch: 'agentoo/s-02c7a79d',
        baseBranch: 'main', baseSha: null, baseNote: null, workingDir: `/srv/alpha/worktrees/${SESSION_ID}`,
        isolated: true, sdkSessionId: null, maxBudgetUsd: null, lastError: null, messageCount: 0,
        totalCostUsd: 0, pendingPrompts: 0, createdAt: T, updatedAt: T,
      },
    ],
  }),
}))

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { routeTree } = await import('../src/app/router')
const { Toaster, toast } = await import('../src/shared/ui/toast')
const { getApiDockerContainersQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiDockerContainers'
)
const { getApiProjectsIdDockerQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiProjectsIdDocker'
)

const project = {
  id: PROJECT_ID, name: 'Alpha', slug: 'alpha', source: 'clone', remoteUrl: null, sourceName: null,
  sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null, recoveryCommands: null,
  path: '/srv/alpha/repo', createdAt: T, updatedAt: T,
}

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root | null = null

/** React-reported problems (act warnings, render errors) fail the test. */
const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount(path = '/docker') {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    // Not infinite for the system list — it is the query under test and
    // must actually be fetched. The shell's own queries are seeded.
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  // The status bar's version button and the "what's new" screen
  // (app/root-layout.tsx's Shell) query this on every mount — seeded for the
  // same reason as every other query here, not because this file has
  // anything of its own to say about that screen.
  client.setQueryData(
    [{ url: '/api/whats-new' }],
    { installedVersion: null, installedAt: null, pending: false },
  )
  // The notification bell (app/tab-bar.tsx) polls this on every shell
  // mount too — seeded for the same reason as every other query here.
  client.setQueryData(
    [{ url: '/api/notifications' }],
    { items: [], hasUnread: false, truncated: false },
  )
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const main = () => container.querySelector('main') as HTMLElement
const sidebar = () => container.querySelector('[data-slot="sidebar"]')
const at = () => router.state.location.pathname
/** The body row whose first cell starts with the container name. */
const rowFor = (name: string) => {
  const tr = [...main().querySelectorAll('tbody tr')].find((r) =>
    text(r.querySelector('td')).startsWith(name),
  )
  if (!tr) throw new Error(`no row for "${name}"`)
  return tr as HTMLElement
}
const cells = (name: string) => [...rowFor(name).querySelectorAll('td')].map(text)
const rowNames = () =>
  [...main().querySelectorAll('tbody tr')].map((r) => {
    const first = r.querySelector('td span')
    return text(first)
  })
const stopButton = (name: string) =>
  [...rowFor(name).querySelectorAll('button')].find((b) => text(b) === 'Stop') as
    | HTMLButtonElement
    | undefined
const rowLinks = (name: string) => [...rowFor(name).querySelectorAll('a')].map((a) => a.getAttribute('href'))
const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const dialog = () => document.body.querySelector('[role="alertdialog"]')
const dialogButton = (label: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => text(b) === label)
const refreshButton = () =>
  [...main().querySelectorAll('button')].find((b) => text(b) === 'Refresh') as HTMLButtonElement | undefined

beforeEach(() => {
  localStorage.clear()
  problems.length = 0
  document.body.innerHTML = ''
  current = state()
  listCalls = 0
  stopCalls = []
  stopReject = null
  projectStatusCalls = []
  stopAnswer = (id) => {
    const before = current.containers.find((c) => c.id === id)
    return { ...(before ?? box({ id, name: 'unknown' })), state: 'exited', exitCode: 137, ports: [], finishedAt: T }
  }
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  toast.close()
  document.body.innerHTML = ''
  client?.clear()
})

const MIXED = () => [
  box({ id: FULL_ID, name: 'web', state: 'running', ports: [5432, 8080], owner: sessionOwner }),
  box({ id: OTHER_ID, name: 'db', state: 'exited', exitCode: 0, ports: [], owner: repoOwner, composeProject: 'agentoo-alpha' }),
  box({ id: 'e'.repeat(64), name: 'created-one', state: 'created', exitCode: null }),
  box({ id: 'f'.repeat(64), name: 'dead-one', state: 'dead', exitCode: 1 }),
  box({ id: '1'.repeat(64), name: 'paused-one', state: 'paused' }),
  box({ id: '2'.repeat(64), name: 'restarting-one', state: 'restarting' }),
  box({ id: '3'.repeat(64), name: 'removing-one', state: 'removing' }),
]

// ── rows, status, ports ─────────────────────────────────────────────────────

test('every container renders a row; running reads "Running", exited/created/dead read "Stopped"', async () => {
  current = state({ containers: MIXED() })
  await mount()
  expect(rowNames().sort()).toEqual(
    ['created-one', 'db', 'dead-one', 'paused-one', 'removing-one', 'restarting-one', 'web'].sort(),
  )
  expect(cells('web')[1]).toBe('Running')
  for (const name of ['db', 'created-one', 'dead-one']) {
    expect(cells(name)[1]?.startsWith('Stopped')).toBe(true)
  }
  expect(cells('paused-one')[1]).toBe('Paused')
  expect(cells('restarting-one')[1]).toBe('Restarting')
  expect(problems).toEqual([])
})

test('a created container reads plain "Stopped", never "Stopped (exit 0)" — it has never run', async () => {
  current = state({
    containers: [box({ id: FULL_ID, name: 'never-started', state: 'created', exitCode: 0 })],
  })
  await mount()
  expect(cells('never-started')[1]).toBe('Stopped')
})

test('the health badge only shows while a container is running — a stale post-exit health status shows no badge', async () => {
  // Docker keeps a container's last State.Health.Status after it exits, so
  // an exited container can still read `health: 'unhealthy'` from whatever
  // check last ran while it was up.
  current = state({
    containers: [
      box({ id: FULL_ID, name: 'stale-health', state: 'exited', exitCode: 255, health: 'unhealthy' }),
      box({ id: OTHER_ID, name: 'live-health', state: 'running', health: 'healthy' }),
    ],
  })
  await mount()
  expect(cells('stale-health')[1]).toBe('Stopped (exit 255)')
  expect(cells('live-health')[1]).toContain('Healthy')
})

test('the name cell shows the image and, for a compose container, its compose project', async () => {
  current = state({ containers: MIXED() })
  await mount()
  const spans = (name: string) => [...(rowFor(name).querySelector('td')?.querySelectorAll('span') ?? [])].map(text)
  expect(spans('db')).toEqual(['db', 'alpine:latest', 'agentoo-alpha'])
  expect(spans('web')).toEqual(['web', 'alpine:latest'])
})

test('ports render as "5432, 8080", a dash when none, and no address/arrow/protocol reaches the DOM', async () => {
  current = state({ containers: MIXED() })
  await mount()
  expect(cells('web')[2]).toBe('5432, 8080')
  expect(cells('db')[2]).toBe('—')
  const html = document.body.innerHTML
  for (const needle of ['0.0.0.0', '->', '/tcp', '/udp', '[::]', 'hostIp']) {
    expect(html.includes(needle)).toBe(false)
  }
})

// ── owner links ─────────────────────────────────────────────────────────────

test('a repo-scope owner links to the project Docker page; a session owner to that session', async () => {
  current = state({ containers: MIXED() })
  await mount()
  expect(rowLinks('db')).toEqual([`/projects/${PROJECT_ID}/docker`])
  expect(rowLinks('web')).toEqual([`/projects/${PROJECT_ID}/sessions/${SESSION_ID}/docker`])
  expect(cells('web')[3]).toContain('Alpha')
  expect(cells('web')[3]).toContain('Docker system page')
})

test('owner: null renders no link at all', async () => {
  current = state({ containers: MIXED() })
  await mount()
  expect(rowLinks('created-one')).toEqual([])
  expect(cells('created-one')[3]).toBe('—')
})

test("clicking a session owner's Open lands on that session's Docker page, scoped to it", async () => {
  current = state({ containers: MIXED() })
  await mount()
  const open = [...rowFor('web').querySelectorAll('a')].find((a) => text(a) === 'Open')
  await click(open, 'Open link')
  await settle()
  expect(at()).toBe(`/projects/${PROJECT_ID}/sessions/${SESSION_ID}/docker`)
  expect(projectStatusCalls.at(-1)?.query?.sessionId).toBe(SESSION_ID)
  const trigger = container.querySelector('[data-slot="select-trigger"]')
  expect(text(trigger)).toContain('Docker system page')
})

test("clicking a repo-scope owner's Open lands on the project Docker page, with no sessionId", async () => {
  current = state({ containers: MIXED() })
  await mount()
  const open = [...rowFor('db').querySelectorAll('a')].find((a) => text(a) === 'Open')
  await click(open, 'Open link')
  await settle()
  expect(at()).toBe(`/projects/${PROJECT_ID}/docker`)
  expect(projectStatusCalls.at(-1)?.query?.sessionId).toBeUndefined()
})

// ── stop ────────────────────────────────────────────────────────────────────

test('Stop is offered only for running, restarting and paused containers', async () => {
  current = state({ containers: MIXED() })
  await mount()
  const withStop = rowNames().filter((n) => stopButton(n) !== undefined)
  expect(withStop.sort()).toEqual(['paused-one', 'restarting-one', 'web'])
})

test('Stop confirms first, sends the full 64-hex id, and flips the row to Stopped from the response', async () => {
  current = state({ containers: MIXED() })
  await mount()
  const callsBefore = listCalls

  await click(stopButton('web'), 'Stop button')
  expect(stopCalls).toEqual([])
  expect(text(dialog())).toContain('Stop web?')

  await click(dialogButton('Stop'), 'confirm Stop')
  await settle()
  expect(stopCalls.map((c) => c.path)).toEqual([{ containerId: FULL_ID }])
  expect(FULL_ID).toMatch(/^[a-f0-9]{64}$/)
  expect(cells('web')[1]?.startsWith('Stopped')).toBe(true)
  expect(cells('web')[2]).toBe('—')
  expect(stopButton('web')).toBeUndefined()
  // From the response alone: the list was not fetched again.
  expect(listCalls).toBe(callsBefore)
  expect(dialog()).toBeNull()
  expect(document.body.textContent).toContain('Stopped web')
})

test('cancelling the confirm dialog sends nothing', async () => {
  current = state({ containers: MIXED() })
  await mount()
  await click(stopButton('web'), 'Stop button')
  await click(dialogButton('Cancel'), 'Cancel')
  expect(stopCalls).toEqual([])
  expect(cells('web')[1]).toBe('Running')
})

test('with enabled: false, Stop is disabled and the disabled notice shows', async () => {
  current = state({ enabled: false, containers: MIXED() })
  await mount()
  expect(stopButton('web')?.disabled).toBe(true)
  expect(main().textContent).toContain('Docker controls are disabled on this install')
  await click(stopButton('web'), 'Stop button')
  expect(dialog()).toBeNull()
  expect(stopCalls).toEqual([])
})

test('a 409 on stop raises the conflict toast, and the row stays Running', async () => {
  stopReject = { response: { status: 409, data: { error: 'Another docker operation (x) is already running' } } }
  current = state({ containers: MIXED() })
  await mount()
  await click(stopButton('web'), 'Stop button')
  await click(dialogButton('Stop'), 'confirm Stop')
  await settle()
  expect(document.body.textContent).toContain(
    "Another Docker operation is already in progress for this container's project. Try again shortly.",
  )
  expect(cells('web')[1]).toBe('Running')
})

test('a non-409 stop failure shows the server message', async () => {
  stopReject = { response: { status: 502, data: { error: 'docker stop failed: permission denied' } } }
  current = state({ containers: MIXED() })
  await mount()
  await click(stopButton('web'), 'Stop button')
  await click(dialogButton('Stop'), 'confirm Stop')
  await settle()
  expect(document.body.textContent).toContain('docker stop failed: permission denied')
})

test('a null stop response (the daemon auto-removed the container) drops the row, still toasts success, and never writes null into the list', async () => {
  current = state({ containers: MIXED() })
  // A `docker run --rm` container: the daemon has already removed it by the
  // time the stop response comes back, so the real backend's own next GET
  // would no longer list it either — mirrored here so the invalidate this
  // triggers (asserted below) reads a consistent world.
  stopAnswer = (id) => {
    current = { ...current, containers: current.containers.filter((c) => c.id !== id) }
    return null
  }
  await mount()

  await click(stopButton('web'), 'Stop button')
  await click(dialogButton('Stop'), 'confirm Stop')
  await settle()

  expect(stopCalls.map((c) => c.path)).toEqual([{ containerId: FULL_ID }])
  expect(rowNames()).not.toContain('web')
  expect(document.body.textContent).toContain('Stopped web')
  // No `null` ever lands in the cached `containers[]`.
  const cached = client.getQueryData(getApiDockerContainersQueryKey()) as SystemState
  expect(cached.containers.every((c) => c !== null)).toBe(true)
})

test("a null stop response still invalidates the removed row's own project Docker status, read off the row before it's dropped", async () => {
  current = state({ containers: MIXED() })
  stopAnswer = (id) => {
    current = { ...current, containers: current.containers.filter((c) => c.id !== id) }
    return null
  }
  await mount()
  // Seed a cache entry for the session-scoped project status query — the
  // scope `web`'s own owner (sessionOwner) names — so invalidating it is
  // observable even with that page never mounted.
  const projectDockerKey = getApiProjectsIdDockerQueryKey({
    path: { id: PROJECT_ID },
    query: { sessionId: SESSION_ID },
  })
  client.setQueryData(projectDockerKey, projectStatus(SESSION_ID))

  await click(stopButton('web'), 'Stop button')
  await click(dialogButton('Stop'), 'confirm Stop')
  await settle()

  expect(client.getQueryState(projectDockerKey)?.isInvalidated).toBe(true)
})

// ── daemon / empty states ───────────────────────────────────────────────────

test('daemon unavailable: the alert names it, shows the daemon error, and the empty state shows', async () => {
  current = state({
    daemon: { cliInstalled: true, available: false, version: null, error: 'Cannot connect to the Docker daemon' },
  })
  await mount()
  const t = main().textContent ?? ''
  expect(t).toContain('Docker daemon not reachable')
  expect(t).toContain('Cannot connect to the Docker daemon')
  expect(t).toContain('No containers')
  expect(main().querySelectorAll('tbody tr')).toHaveLength(0)
})

test('docker not installed shows its own title', async () => {
  current = state({ daemon: { cliInstalled: false, available: false, version: null, error: null } })
  await mount()
  expect(main().textContent).toContain('Docker is not installed')
})

test('an empty host shows the empty state and no daemon alert', async () => {
  await mount()
  const t = main().textContent ?? ''
  expect(t).toContain('No containers')
  expect(t).not.toContain('Docker daemon not reachable')
})

// ── refresh, polling, sidebar ───────────────────────────────────────────────

test('Refresh triggers another GET and renders what it returns', async () => {
  current = state({ containers: [box({ id: FULL_ID, name: 'web' })] })
  await mount()
  expect(listCalls).toBe(1)
  current = state({ containers: [box({ id: FULL_ID, name: 'web' }), box({ id: OTHER_ID, name: 'newcomer' })] })
  await click(refreshButton(), 'Refresh')
  await settle()
  expect(listCalls).toBe(2)
  expect(rowNames().sort()).toEqual(['newcomer', 'web'])
})

test('the list polls every 5s on its own', async () => {
  current = state({ containers: [box({ id: FULL_ID, name: 'web' })] })
  await mount()
  const q = client.getQueryCache().find({ queryKey: [{ url: '/api/docker/containers' }] })
  expect(q?.observers[0]?.options.refetchInterval).toBe(5000)
  expect(q?.observers[0]?.options.refetchIntervalInBackground).toBe(false)
  const before = listCalls
  current = state({ containers: [] })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5600))
  })
  await settle()
  expect(listCalls).toBeGreaterThan(before)
  expect(main().textContent).toContain('No containers')
}, 15000)

test('the System sidebar has a Docker entry linking to /docker, current on /docker', async () => {
  await mount('/sessions')
  const link = [...(sidebar()?.querySelectorAll('[data-slot="sidebar-content"] a') ?? [])].find(
    (a) => text(a) === 'Docker',
  )
  expect(link?.getAttribute('href')).toBe('/docker')
  await click(link, 'Docker sidebar link')
  expect(at()).toBe('/docker')
  const again = [...(sidebar()?.querySelectorAll('[data-slot="sidebar-content"] a') ?? [])].find(
    (a) => text(a) === 'Docker',
  )
  expect(again?.getAttribute('aria-current')).toBe('page')
  expect(main().textContent).toContain('Every container on this host')
})
