// The Docker page's own gating and wiring: what renders for each of the
// backend's real states (no config, daemon down, broken compose, foreign
// stacks), the stack-wide and per-service controls, the 409-conflict toast,
// the plain-Dockerfile port form, and the access-URL list — everything this
// file can prove without a real docker daemon, which this host does not
// have. The stream hooks (use-operation-stream.ts, use-container-logs.ts)
// are exercised here only enough to prove they connect to the right URL at
// the right time; their frame parsing is the same boundary-validation idiom
// as sessions/lib/streamed-message.ts and is not re-proven per file.
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
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GetApiProjectsIdDockerStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdDocker'
import { mockModule } from './mock-module'

// Real translations from here on — see the header comment above.
import '@/shared/i18n'

const T = '2026-09-04T10:00:00.000Z'

const STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdDocker'
const UP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerUp'
const STOP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerStop'
const RESTART_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerRestart'
const DOWN_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdDockerDown'

const daemon = (o: Partial<Status['daemon']> = {}): Status['daemon'] => ({
  cliInstalled: true,
  available: true,
  version: '27.0.0',
  composeVersion: '2.29.0',
  error: null,
  ...o,
})

/** A compose project with one running service (`web`, one container
 *  publishing a tcp and a udp port) and one never-started service (`db`). */
function composeStatus(overrides: Partial<Status> = {}): Status {
  return {
    projectId: 'p1',
    projectPath: '/srv/p1',
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
    projectPath: '/srv/p1',
    composeProject: null,
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

let currentStatus: Status = composeStatus()

await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdDocker: async () => ({ data: currentStatus }),
}))

type Call = { path: { id: string }; body?: unknown }

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

const { DockerPage } = await import('../src/features/docker/components/docker-page')
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

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount() {
  ;(globalThis as { EventSource?: unknown }).EventSource = TrackedEventSource
  TrackedEventSource.opened = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Toaster />
        <DockerPage projectId="p1" />
      </QueryClientProvider>,
    )
  })
  // The status query resolves over its own chain of microtasks.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
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
  currentStatus = composeStatus()
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

// --- 6. stack-wide start/stop/restart send whole-stack bodies --------------------

test('Start all sends no services key at all — the whole-stack request', async () => {
  await mount()
  const start = findButton('Start all')
  if (!start) throw new Error('no Start all button')
  await click(start)

  expect(upCalls).toHaveLength(1)
  expect(upCalls[0]?.path).toEqual({ id: 'p1' })
  expect((upCalls[0]?.body as { services?: string[] })?.services).toBeUndefined()
})

test('Stop all sends no body at all', async () => {
  await mount()
  const stop = findButton('Stop all')
  if (!stop) throw new Error('no Stop all button')
  await click(stop)

  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.body).toBeUndefined()
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
