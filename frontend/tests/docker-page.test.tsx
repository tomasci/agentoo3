// The Docker page's own gating and wiring: what renders for each of the
// backend's real states (no config, daemon down, broken compose, foreign
// stacks), the stack-wide and per-service controls, the 409-conflict toast,
// the plain-Dockerfile port form, the access-URL list, and — the reason this
// file mounts through the real router rather than rendering `<DockerPage>`
// directly the way it used to — worktree scope: the scope bar's switcher,
// the banner, and that a mutation/status call carries `sessionId` only at
// session scope, never at repo scope. Everything this file can prove without
// a real docker daemon, which this host does not have. The stream hooks
// (use-operation-stream.ts, use-container-logs.ts) are exercised here only
// enough to prove they connect to the right URL at the right time; their
// frame parsing is the same boundary-validation idiom as
// sessions/lib/streamed-message.ts and is not re-proven per file.
//
// Router-mounted, same shape as tests/session-idea-link.test.tsx: a memory
// history, the generated clients mocked per-file through ./mock-module, and
// the project-shell queries seeded so nothing reaches for a backend. Needed
// here (this file used to render `<DockerPage>` directly) because the scope
// bar (docker-scope-bar.tsx) uses `useNavigate`, which throws outside a
// `RouterProvider` — and because switching scope is, correctly, a real
// navigation this file should be able to observe landing on the right route.
//
// A real i18next instance, not raw keys: `bun test` runs every file in one
// shared process (see this suite's own hazard note), and whichever file
// happens to import `@/shared/i18n` first decides whether `t()` returns a
// raw key or the real, interpolated copy for every file that runs after it
// — including this one, regardless of run order. Importing it here too
// (idempotent — i18next initialises once, module-cached) makes the outcome
// the same either way, the same reasoning tests/ui-core.test.tsx's own
// comment gives for doing it there.
//
// CSS-module class names are `undefined` under `bun test` (see
// session-idea-link.test.tsx's own note), so every assertion below is by
// text, `href`, `value` or DOM structure — never a generated class name.

import { plugin } from 'bun'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx and
// tests/storage-page.test.tsx: `DockerPage` pulls in the `@/shared/ui` barrel
// too, and whichever of them `bun test` evaluates first decides how those ten
// modules are cached for the run. Copied verbatim, not widened.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/
plugin({
  name: 'docker-page-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import type { GetApiProjectsIdDockerStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdDocker'
import type { GetApiProjectsIdSessionsStatus200 as SessionsStatus } from '../src/shared/api/generated/types/GetApiProjectsIdSessions'
import { mockModule } from './mock-module'

// Real translations from here on — see the header comment above.
import '@/shared/i18n'

const T = '2026-09-04T10:00:00.000Z'

const STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdDocker'
const UP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerUp'
const STOP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerStop'
const RESTART_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerRestart'
const DOWN_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerDown'
const SESSIONS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'

const daemon = (o: Partial<Status['daemon']> = {}): Status['daemon'] => ({
  cliInstalled: true,
  available: true,
  version: '27.0.0',
  composeVersion: '2.29.0',
  error: null,
  ...o,
})

/** A compose project with one running service (`web`, one container
 *  publishing a tcp and a udp port) and one never-started service (`db`).
 *  Repo scope by default (`sessionId: null`, `scopePath` == `projectPath`) —
 *  the scope tests below override both together. */
function composeStatus(overrides: Partial<Status> = {}): Status {
  return {
    projectId: 'p1',
    sessionId: null,
    projectPath: '/srv/p1',
    scopePath: '/srv/p1',
    composeProject: 'p1',
    daemon: daemon(),
    detection: {
      hasCompose: true,
      hasDockerfile: false,
      composeFile: 'docker-compose.yml',
      composeOverrideFile: null,
      dockerfile: null,
    },
    configError: null,
    services: [
      {
        name: 'web',
        image: 'web:latest',
        build: false,
        profiles: [],
        dependsOn: [],
        declaredPorts: [
          { containerPort: 80, publishedPort: 8080, publishedRange: null, protocol: 'tcp', hostIp: null },
        ],
        containerIds: ['c-web'],
        state: 'running',
      },
      {
        name: 'db',
        image: 'db:latest',
        build: false,
        profiles: [],
        dependsOn: [],
        declaredPorts: [],
        containerIds: [],
        state: 'absent',
      },
    ],
    containers: [
      {
        id: 'c-web',
        shortId: 'c-web12345',
        name: 'p1-web-1',
        service: 'web',
        image: 'web:latest',
        state: 'running',
        health: 'none',
        exitCode: null,
        createdAt: T,
        startedAt: T,
        finishedAt: null,
        ports: [
          { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
          { containerPort: 53, protocol: 'udp', hostIp: '0.0.0.0', hostPort: 5300 },
        ],
      },
    ],
    image: null,
    dockerfilePorts: [],
    foreignStacks: [],
    hosts: [{ kind: 'lan', label: 'LAN', host: '192.168.1.20' }],
    activeOperationId: null,
    fetchedAt: T,
    ...overrides,
  }
}

/** A plain-Dockerfile project with no container created yet and no port
 *  declared anywhere the server can see — the case that requires the
 *  explicit-port form. */
function dockerfileStatus(overrides: Partial<Status> = {}): Status {
  return {
    projectId: 'p1',
    sessionId: null,
    composeProject: null,
    projectPath: '/srv/p1',
    scopePath: '/srv/p1',
    daemon: daemon(),
    detection: {
      hasCompose: false,
      hasDockerfile: true,
      composeFile: null,
      composeOverrideFile: null,
      dockerfile: 'Dockerfile',
    },
    configError: null,
    services: [],
    containers: [],
    image: null,
    dockerfilePorts: [],
    foreignStacks: [],
    hosts: [],
    activeOperationId: null,
    fetchedAt: T,
    ...overrides,
  }
}

const noConfigStatus = (): Status =>
  dockerfileStatus({
    detection: {
      hasCompose: false,
      hasDockerfile: false,
      composeFile: null,
      composeOverrideFile: null,
      dockerfile: null,
    },
  })

const operation = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 'op1',
  projectId: 'p1',
  sessionId: null,
  kind: 'up',
  services: [],
  status: 'queued',
  exitCode: null,
  error: null,
  createdAt: T,
  startedAt: null,
  finishedAt: null,
  ...o,
})

type SessionDto = SessionsStatus[number]

const sessionFixture = (o: Partial<SessionDto> & { id: string }): SessionDto => ({
  projectId: 'p1',
  ideaId: null,
  title: null,
  status: 'idle',
  orchestrator: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/p1',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
  ...o,
})

let currentStatus: Status = composeStatus()
let statusReject: unknown = null
let currentSessions: SessionDto[] = []

type StatusCall = { path: { id: string }; query?: { sessionId?: string } }
let statusCalls: StatusCall[] = []

await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdDocker: async (opts: StatusCall) => {
    statusCalls.push(opts)
    if (statusReject) throw statusReject
    return { data: currentStatus }
  },
}))

await mockModule(SESSIONS_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({ data: currentSessions }),
}))

type Call = { path: { id: string }; query?: { sessionId?: string }; body?: unknown }

let upCalls: Call[] = []
let upReject: unknown = null
await mockModule(UP_CLIENT, () => ({
  postApiProjectsIdDockerUp: async (opts: Call) => {
    upCalls.push(opts)
    if (upReject) throw upReject
    return { data: operation({ kind: 'up', services: (opts.body as { services?: string[] })?.services ?? [] }) }
  },
}))

let stopCalls: Call[] = []
await mockModule(STOP_CLIENT, () => ({
  postApiProjectsIdDockerStop: async (opts: Call) => {
    stopCalls.push(opts)
    return { data: operation({ kind: 'stop' }) }
  },
}))

let restartCalls: Call[] = []
await mockModule(RESTART_CLIENT, () => ({
  postApiProjectsIdDockerRestart: async (opts: Call) => {
    restartCalls.push(opts)
    return { data: operation({ kind: 'restart' }) }
  },
}))

let downCalls: Call[] = []
await mockModule(DOWN_CLIENT, () => ({
  postApiProjectsIdDockerDown: async (opts: Call) => {
    downCalls.push(opts)
    return { data: operation({ kind: 'down' }) }
  },
}))

const { REPO_SCOPE } = await import('../src/features/docker/components/docker-scope-bar')
const { Toaster, toaster } = await import('../src/shared/ui/overlay/toast')

/** happy-dom ships no `EventSource` (verified in
 *  use-session-stream-hook.test.tsx's own note); tracked rather than fully
 *  inert so the "only stream a container's logs while its pane is open"
 *  behaviour (use-container-logs.ts) can be asserted on by URL. */
class TrackedEventSource {
  static opened: string[] = []
  readonly url: string
  constructor(url: string) {
    this.url = url
    TrackedEventSource.opened.push(url)
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const project = {
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  source: 'clone',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: '/srv/p1',
  createdAt: T,
  updatedAt: T,
}

let client: QueryClient
let container: HTMLDivElement
let root: Root

/** Mounts the real router at `path` — see the header comment for why this
 *  file needs one at all now. Returns the router itself so a scope-switch
 *  test can confirm where a navigation actually landed. */
async function mount(path = '/projects/p1/docker') {
  ;(globalThis as { EventSource?: unknown }).EventSource = TrackedEventSource
  TrackedEventSource.opened = []
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })

  container = document.createElement('div')
  document.body.append(container)

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()

  root = createRoot(container)
  await act(async () => {
    root.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  // The status/sessions queries resolve over their own chain of microtasks.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
  return router
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  // The toaster is a module-level singleton (toast.tsx) — clear it so a
  // toast this test raised is not still alive for the next test's mount().
  toaster.remove()
}

beforeEach(() => {
  // tabsAtom (shared/store/tabs.ts) is backed by real localStorage, and
  // persists across every test in this shared `bun test` process otherwise.
  localStorage.clear()
  currentStatus = composeStatus()
  statusReject = null
  currentSessions = []
  statusCalls = []
  upCalls = []
  upReject = null
  stopCalls = []
  restartCalls = []
  downCalls = []
})

afterEach(unmount)

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (text: string) => buttons().find((b) => b.textContent?.includes(text))
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** The one row for a given service/heading name — `h4` is each `ServiceRow`'s
 *  own name element, and `Card` (its ancestor) renders as a `<section>`. */
const rowFor = (heading: string) => {
  const h4 = [...container.querySelectorAll('h4')].find((h) => h.textContent === heading)
  const row = h4?.closest('section')
  if (!row) throw new Error(`no row for "${heading}"`)
  return row
}

/** Ark's Dialog renders through a Portal onto `document.body`, and
 *  `ConfirmDialog` never unmounts its `Content` on close (dialog.tsx's own
 *  note) — `data-state="open"` is load-bearing, not decoration. */
const dialogButtons = () => {
  const dialog = document.body.querySelector('[role="alertdialog"][data-state="open"]')
  return dialog ? ([...dialog.querySelectorAll('button')] as HTMLElement[]) : []
}
const findDialogButton = (text: string) => dialogButtons().find((b) => b.textContent?.includes(text))

/** The scope switcher's own hidden native `<select>` (see select.tsx's
 *  `ArkSelect.HiddenSelect`) — one per page, always present once the page has
 *  data, so no further scoping is needed. Its `<option value>`s are real
 *  session ids (or `REPO_SCOPE`), never translated text, so a test can drive
 *  it without depending on copy. */
const scopeSelect = () => {
  const select = container.querySelector('select')
  if (!select) throw new Error('no scope select rendered')
  return select as HTMLSelectElement
}
const chooseScope = async (value: string) => {
  const select = scopeSelect()
  select.value = value
  await act(async () => {
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

// --- 1. no config detected ------------------------------------------------------

test('no docker configuration detected renders an empty state and no run controls at all', async () => {
  currentStatus = noConfigStatus()
  await mount()

  expect(container.textContent).toContain('No Docker configuration detected')
  expect(findButton('Start all')).toBeUndefined()
  expect(findButton('Clean up')).toBeUndefined()
})

// --- 2. docker config found: stack controls + one row per service ---------------

test('a compose project renders stack-wide controls and one row per service', async () => {
  await mount()

  expect(findButton('Start all')).toBeDefined()
  expect(findButton('Stop all')).toBeDefined()
  expect(findButton('Restart all')).toBeDefined()
  expect(findButton('Clean up')).toBeDefined()
  expect(container.textContent).toContain('web')
  expect(container.textContent).toContain('db')
})

// --- 3. daemon unavailable --------------------------------------------------------

test('docker not installed explains why and disables every control', async () => {
  currentStatus = composeStatus({ daemon: daemon({ cliInstalled: false, available: false, error: 'command not found' }) })
  await mount()

  expect(container.textContent).toContain('Docker is not installed')
  expect(container.textContent).toContain('command not found')
  expect(findButton('Start all')?.hasAttribute('disabled')).toBe(true)
  expect(findButton('Stop all')?.hasAttribute('disabled')).toBe(true)
  expect(findButton('Clean up')?.hasAttribute('disabled')).toBe(true)
})

test('the daemon installed but unreachable gets its own message, distinct from "not installed"', async () => {
  currentStatus = composeStatus({ daemon: daemon({ available: false, error: 'connection refused' }) })
  await mount()

  expect(container.textContent).toContain('Docker daemon not reachable')
  expect(container.textContent).not.toContain('Docker is not installed')
  expect(container.textContent).toContain('connection refused')
})

// --- 4. broken compose file: start/restart off, stop/cleanup stay on -------------

test('a broken compose file disables start and restart but leaves stop and cleanup enabled', async () => {
  currentStatus = composeStatus({ configError: 'yaml: line 4: mapping values are not allowed here' })
  await mount()

  expect(container.textContent).toContain('docker-compose.yml could not be parsed')
  expect(container.textContent).toContain('mapping values are not allowed here')
  expect(findButton('Start all')?.hasAttribute('disabled')).toBe(true)
  expect(findButton('Restart all')?.hasAttribute('disabled')).toBe(true)
  expect(findButton('Stop all')?.hasAttribute('disabled')).toBe(false)
  expect(findButton('Clean up')?.hasAttribute('disabled')).toBe(false)
})

// --- 5. foreign stacks --------------------------------------------------------------

test('a stack running under another name is named as a warning, not adopted', async () => {
  currentStatus = composeStatus({
    foreignStacks: [{ name: 'p1-manual', status: 'running', configFiles: ['docker-compose.yml'] }],
  })
  await mount()

  expect(container.textContent).toContain('Also running under a different name')
  expect(container.textContent).toContain('p1-manual')
})

// --- 6. stack-wide start/stop/restart send whole-stack bodies, repo scope sends no sessionId ---

test('Start all sends no services key and no sessionId — the whole-stack, repo-scope request', async () => {
  await mount()
  const start = findButton('Start all')
  if (!start) throw new Error('no Start all button')
  await click(start)

  expect(upCalls).toHaveLength(1)
  expect(upCalls[0]?.path).toEqual({ id: 'p1' })
  expect(upCalls[0]?.query).toBeUndefined()
  expect((upCalls[0]?.body as { services?: string[] })?.services).toBeUndefined()
})

test('Stop all sends no body at all', async () => {
  await mount()
  const stop = findButton('Stop all')
  if (!stop) throw new Error('no Stop all button')
  await click(stop)

  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.body).toBeUndefined()
  expect(stopCalls[0]?.query).toBeUndefined()
})

// --- 7. per-service start is scoped to that one service ---------------------------

test("a service row's own Start button is scoped to that service only", async () => {
  await mount()
  const row = rowFor('db')
  const rowStart = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Start')
  if (!rowStart) throw new Error('no row-level Start button for db')
  await click(rowStart)

  expect(upCalls).toHaveLength(1)
  expect((upCalls[0]?.body as { services?: string[] })?.services).toEqual(['db'])
})

// --- 8. 409 conflict is surfaced plainly, not as a generic failure ---------------

test('a 409 while starting is reported as "another operation is already running"', async () => {
  upReject = { response: { status: 409, data: { error: 'an "up" operation is already running' } } }
  await mount()
  const start = findButton('Start all')
  if (!start) throw new Error('no Start all button')
  await click(start)
  await settle()

  expect(document.body.textContent).toContain('Another operation is already running for this project.')
})

// --- 9. the plain-Dockerfile explicit-port form -----------------------------------

test('a Dockerfile project with no declared port pre-fills 3000 and sends it on Start', async () => {
  currentStatus = dockerfileStatus()
  await mount()

  const portInput = [...container.querySelectorAll('input')].find((i) => i.value === '3000')
  expect(portInput).toBeDefined()

  // Scoped to the one synthetic row ("Application") rather than found by
  // plain text: the stack-level button also contains the word "Start"
  // ("Start all"), so an unscoped lookup would find the wrong control.
  const row = rowFor('Application')
  const start = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Start')
  if (!start) throw new Error('no row-level Start button')
  await click(start)

  expect(upCalls).toHaveLength(1)
  const body = upCalls[0]?.body as { services?: string[]; containerPort?: number }
  expect(body.containerPort).toBe(3000)
  expect(body.services).toBeUndefined()
})

test('a Dockerfile project whose image already declares a port shows no port form', async () => {
  currentStatus = dockerfileStatus({
    image: { reference: 'app:latest', exists: true, builtAt: T, exposedPorts: [{ containerPort: 3000, protocol: 'tcp' }] },
  })
  await mount()

  expect(container.querySelector('input[value="3000"]')).toBeNull()
})

// --- 10. access URLs ----------------------------------------------------------------

test('a running container\'s tcp port renders as a clickable link; its udp port is annotated, not linked', async () => {
  await mount()

  const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href')?.includes('8080'))
  expect(link).toBeDefined()
  expect(link?.getAttribute('target')).toBe('_blank')
  expect(link?.getAttribute('rel')).toBe('noreferrer')

  expect(container.textContent).toContain('UDP — not reachable from a browser')
  expect([...container.querySelectorAll('a')].some((a) => a.getAttribute('href')?.includes('5300'))).toBe(false)
})

test('no running container with a published port shows the empty state, not an empty list', async () => {
  currentStatus = composeStatus({ containers: [] })
  await mount()
  expect(container.textContent).toContain('Start something with a published port to see how to reach it.')
})

// --- 11. cleanup is confirmed and never asks to remove volumes/images -----------

test('Clean up asks for confirmation, and sends no removeVolumes/removeImages', async () => {
  await mount()
  const cleanup = findButton('Clean up')
  if (!cleanup) throw new Error('no Clean up button')
  await click(cleanup)

  expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).not.toBeNull()
  expect(downCalls).toHaveLength(0)

  const confirm = findDialogButton('Clean up')
  if (!confirm) throw new Error('no confirm button in the cleanup dialog')
  await click(confirm)

  expect(downCalls).toHaveLength(1)
  expect(downCalls[0]?.body).toBeUndefined()
})

// --- 12. container logs only stream once their pane is open ----------------------

test("a container's logs only start streaming once its own pane is opened", async () => {
  await mount()

  const logStreams = () => TrackedEventSource.opened.filter((u) => u.includes('/logs?'))
  expect(logStreams()).toHaveLength(0)

  const trigger = [...container.querySelectorAll('button[data-part="trigger"]')].find((b) =>
    b.textContent?.includes('p1-web-1'),
  )
  if (!trigger) throw new Error('no collapsible trigger for the web container')
  await click(trigger)

  expect(logStreams()).toHaveLength(1)
  expect(logStreams()[0]).toContain('/projects/p1/docker/containers/c-web/logs')
})

// --- 13. worktree scope: the switcher, the banner, and what each scope sends -----

test('at repo scope, the switcher offers only the project checkout when no session is isolated', async () => {
  currentSessions = [sessionFixture({ id: 's2', title: 'Shared session', isolated: false })]
  await mount()

  expect(container.textContent).toContain("the project's own repo/ checkout")
  const options = [...scopeSelect().querySelectorAll('option')]
  expect(options).toHaveLength(1)
  expect(options[0]?.value).toBe(REPO_SCOPE)
  expect(scopeSelect().value).toBe(REPO_SCOPE)
})

test('an isolated session is offered in the switcher; a shared-checkout one is not', async () => {
  currentSessions = [
    sessionFixture({ id: 's1', title: 'Refactor auth', branch: 'feature/refactor-auth', isolated: true }),
    sessionFixture({ id: 's2', title: 'Shared session', isolated: false }),
  ]
  await mount()

  const values = [...scopeSelect().querySelectorAll('option')].map((o) => o.value)
  expect(values).toEqual([REPO_SCOPE, 's1'])
})

test("session scope's status call, and every mutation it triggers, carry that session's id — repo scope never does", async () => {
  currentSessions = [sessionFixture({ id: 's1', title: 'Refactor auth', isolated: true })]
  currentStatus = composeStatus({ sessionId: 's1', scopePath: '/srv/worktrees/s1' })
  await mount('/projects/p1/sessions/s1/docker')

  expect(statusCalls.at(-1)?.query).toEqual({ sessionId: 's1' })

  const start = findButton('Start all')
  if (!start) throw new Error('no Start all button')
  await click(start)

  expect(upCalls).toHaveLength(1)
  expect(upCalls[0]?.query).toEqual({ sessionId: 's1' })
})

test('the banner names the session and its branch at session scope, distinct from the repo-scope wording', async () => {
  currentSessions = [
    sessionFixture({ id: 's1', title: 'Refactor auth', branch: 'feature/refactor-auth', isolated: true }),
  ]
  currentStatus = composeStatus({ sessionId: 's1', scopePath: '/srv/worktrees/s1' })
  await mount('/projects/p1/sessions/s1/docker')

  expect(container.textContent).toContain('Refactor auth (feature/refactor-auth)')
  expect(container.textContent).not.toContain("the project's own repo/ checkout")
})

test('the empty state shows scopePath, not projectPath, so a reader knows where to drop a gitignored .env', async () => {
  currentSessions = [sessionFixture({ id: 's1', isolated: true })]
  currentStatus = noConfigStatus()
  currentStatus = { ...currentStatus, sessionId: 's1', scopePath: '/srv/worktrees/s1' }
  await mount('/projects/p1/sessions/s1/docker')

  expect(container.textContent).toContain('/srv/worktrees/s1')
  expect(container.textContent).not.toContain('/srv/p1 ')
})

test('picking a session from the switcher navigates to that session\'s own Docker page and re-scopes every call', async () => {
  currentSessions = [sessionFixture({ id: 's1', title: 'Refactor auth', isolated: true })]
  const router = await mount('/projects/p1/docker')

  await chooseScope('s1')
  await settle()

  expect(router.state.location.pathname).toBe('/projects/p1/sessions/s1/docker')
  expect(statusCalls.at(-1)?.query).toEqual({ sessionId: 's1' })
})

test('picking the project checkout from a session scope navigates back to the project-level Docker page', async () => {
  currentSessions = [sessionFixture({ id: 's1', title: 'Refactor auth', isolated: true })]
  currentStatus = composeStatus({ sessionId: 's1', scopePath: '/srv/worktrees/s1' })
  const router = await mount('/projects/p1/sessions/s1/docker')

  await chooseScope(REPO_SCOPE)
  await settle()

  expect(router.state.location.pathname).toBe('/projects/p1/docker')
})

test('a session the project no longer lists still shows a selectable placeholder, not a blank trigger', async () => {
  currentSessions = []
  currentStatus = composeStatus({ sessionId: 'ghost', scopePath: '/srv/worktrees/ghost' })
  await mount('/projects/p1/sessions/ghost/docker')

  expect(scopeSelect().value).toBe('ghost')
  expect(container.textContent).toContain('This session')
})

test('a session that shares the project checkout (no worktree) is reported plainly, not as a generic load failure', async () => {
  currentSessions = [sessionFixture({ id: 's1', isolated: true })]
  statusReject = {
    response: {
      status: 400,
      data: { error: 'This session shares the project checkout; it has no worktree of its own to run docker in' },
    },
  }
  await mount('/projects/p1/sessions/s1/docker')

  expect(container.textContent).toContain(
    'This session shares the project checkout; it has no worktree of its own to run docker in',
  )
})
