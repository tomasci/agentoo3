// The editor launcher's own gating (features/editor/components/editor-launcher.tsx):
// every state the backend's `EditorStatus` can report (GET failure, disabled,
// daemon down, stopped/starting/running/unresponsive), exactly-once auto-start
// when stopped, the running→redirect via `window.location.replace`, a failed
// start's error+log+Retry with no second auto-start, and the back-to-session
// link on every terminal state. Also covers the one label
// (`editor.launcher.opening`) that loading, starting and running all now
// share, and `StartingPanel`'s own delayed reveal of the note and log (only
// once a start is still running a few seconds in, never on a quick warm
// start, and never delayed at all once a start has actually failed). Also
// covers the launcher's place in the app around it: no shell
// (TabBar/sidebar/StatusBar) at all, and no workspace tab created by merely
// visiting it. Everything this file can prove without a real code-server
// container.
//
// Router-mounted, but through this file's OWN tiny route tree — never
// `import { routeTree } from '../src/app/router'` (contrast
// tests/docker-page.test.tsx). Bisection found that importing
// the *app's* router — which eagerly pulls in every feature page, Docker
// through the ReactFlow-based idea canvas — is itself a hazard once enough
// test files do it in the same `bun test tests/` run: `bun test` does not
// give each file an independent copy of that huge shared module graph the
// way it does most others, and past some number of files importing it, LATER
// unrelated ones (`session-page-scroll.test.tsx`, `storage-page.test.tsx`,
// `transcript-attachments.test.tsx`) started reading back a real, live
// i18next instance where their own tests deliberately check for a raw,
// untranslated key (`useTranslation()` with no `<I18nextProvider>` of their
// own — i18next's own "no instance in scope" fallback returns the key
// verbatim, and those files' assertions read that fallback itself). Adding
// this track's own real editor-page.test.tsx tipped that count over.
//
// The fix is not "avoid a router" — the launcher's own "back to session"
// control is a real `<Link>`, which needs one to resolve an `href` — it is
// "avoid *that* router": a route tree built right here, with only the two
// paths this file's own assertions touch (`/sessions/$sessionId` as the
// Link's target, `/sessions/$sessionId/editor` as where `EditorLauncher`
// itself mounts), never imports app/router.tsx or anything
// project/idea/docker/library-shaped at all, so this file cannot be "one
// more" contributor to that count. The one exception is the last section
// below, which imports `RootLayout` directly (not `app/router.tsx`, and not
// `@/shared/i18n`) to prove the launcher's own path renders with no shell —
// `RootLayout` itself pulls in nothing project/idea/docker/library-shaped
// either, only the tab bar/sidebar/status bar and the peripheral queries they
// read, which the offline transport below keeps off the network.
//
// The same reasoning is why the i18next instance below is created locally
// with `i18next.createInstance()` and handed down via `<I18nextProvider>`
// rather than `import '@/shared/i18n'` (which itself independently
// reproduces the exact same failure — see the same bisection): `.init()` on
// the app's own shared singleton, called from yet another file, is the other
// half of the same class of hazard. `<I18nextProvider>` is plain React
// context (`initReactI18next` — the one call that writes into the shared
// fallback slot — is never `.use()`d here), so this file gets its own real
// translations without touching that slot at all.
//
// CSS-module class names are `undefined` under `bun test`, so every assertion
// below is by text, attribute or DOM structure — never a generated class name.

import { plugin } from 'bun'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx and
// tests/docker-page.test.tsx: `EditorLauncher` pulls in the `@/shared/ui`
// barrel too (Alert, Code, EmptyState, Stack), and whichever of them
// `bun test` evaluates first decides how those ten modules are cached for the
// run. Copied verbatim, not widened.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/
plugin({
  name: 'editor-page-test-css-module-identity',
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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { EditorLauncher } from '../src/features/editor'
import { RootLayout } from '../src/app/root-layout'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { getApiProjectsIdSessionsSessionidEditorQueryKey } from '../src/shared/api/generated/hooks/useGetApiProjectsIdSessionsSessionidEditor'
import type { GetApiProjectsIdSessionsSessionidEditorStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdSessionsSessionidEditor'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

// This file's own tiny route tree — see the header comment for why it is not
// `import { routeTree } from '../src/app/router'`. Only the two paths
// `EditorLauncher` itself ever needs: where it mounts, and the "Back to
// session" Link's own target (rendered as a bare placeholder — no test here
// asserts on that page's own content, only on the `href` pointed at it).
const rootRoute = createRootRoute({ component: () => <Outlet /> })
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: () => <Outlet />,
})
const sessionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId',
  component: () => <div>session</div>,
})
const editorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId/editor',
  component: function EditorRouteComponent() {
    const { projectId, sessionId } = useParams({ strict: false })
    if (!projectId || !sessionId) return null
    return <EditorLauncher projectId={projectId} sessionId={sessionId} />
  },
})
const routeTree = rootRoute.addChildren([projectRoute.addChildren([sessionRoute, editorRoute])])

// A private i18next instance, `.init()`-ed directly with the real English
// copy and handed to the tree below via `<I18nextProvider>` — never through
// `.use(initReactI18next)`, which is the one call that writes into the shared
// slot described above. `createInstance()` (not the module's own default
// export) keeps this from being `@/shared/i18n`'s object under another name.
const testI18n = i18next.createInstance()
testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessionsSessionidEditor'
const START_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdSessionsSessionidEditorStart'
const daemon = (o: Partial<Status['daemon']> = {}): Status['daemon'] => ({
  cliInstalled: true,
  available: true,
  error: null,
  ...o,
})

const operation = (o: Partial<NonNullable<Status['operation']>> = {}): NonNullable<Status['operation']> => ({
  id: 'op1',
  status: 'running',
  error: null,
  createdAt: T,
  startedAt: T,
  finishedAt: null,
  output: [],
  ...o,
})

/** An enabled, healthy editor with nothing running yet — every other test
 *  overrides just the field(s) it is about. */
function editorStatus(overrides: Partial<Status> = {}): Status {
  return {
    projectId: 'p1',
    sessionId: 's1',
    enabled: true,
    daemon: daemon(),
    state: 'stopped',
    proxyPath: '/api/projects/p1/sessions/s1/editor/proxy/',
    worktreePath: '/srv/worktrees/s1',
    image: 'codercom/code-server:4.138.0',
    idleTimeoutSeconds: 1800,
    container: null,
    operation: null,
    fetchedAt: T,
    ...overrides,
  }
}

let currentStatus: Status = editorStatus()
let statusReject: unknown = null
// Held pending by a test that needs to assert on the loading spinner itself
// (`status.isPending`, before the query resolves either way) — `null` means
// "resolve straight away", the default for every other test here.
let statusGate: Promise<void> | null = null

type StatusCall = { path: { id: string; sessionId: string } }
let statusCalls: StatusCall[] = []

await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdSessionsSessionidEditor: async (opts: StatusCall) => {
    statusCalls.push(opts)
    if (statusGate) await statusGate
    if (statusReject) throw statusReject
    return { data: currentStatus }
  },
}))

type Call = { path: { id: string; sessionId: string } }

let startCalls: Call[] = []
let startReject: unknown = null
let startResponse: Status | null = null
await mockModule(START_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStart: async (opts: Call) => {
    startCalls.push(opts)
    if (startReject) throw startReject
    return { data: startResponse ?? editorStatus({ state: 'starting', operation: operation({ status: 'running' }) }) }
  },
}))

/** Nothing in this file is about fetching /api/projects, /api/health,
 *  /api/ssh-keys or /api/system — but the last section below mounts the real
 *  `RootLayout`, whose tab bar/sidebar/status bar all poll them. Refusing
 *  every unmocked request at the shared transport (rather than mocking four
 *  more client modules) is the same technique tests/version-skew-alert.test.tsx
 *  uses, and it cannot collide with the `mockModule` calls above: those
 *  replace the editor's own generated client functions outright, which never
 *  reach this shared transport at all. */
const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

// StartingPanel (editor-launcher.tsx) delays its note-and-log reveal by its
// own `START_DETAILS_DELAY_MS` (3s). Faked below the same way
// tests/use-container-logs.test.tsx fakes its hook's own retry backoff — but
// matched on this *exact* delay, not "anything at that scale": `useQuery`
// (`useEditorStatus`) schedules its own real `setTimeout`s too (query-core's
// `gcTime`, 5 minutes by default and not overridden by this file's
// `QueryClient`), and a broad `>= 1000` threshold here was catching those
// instead of the reveal timer, since both are live at once around a fresh
// mount. Matching the literal value keeps this file's own 0ms polling ticks
// (`settle`, `refetchStatus`, `mount`'s own flush loop) and every other
// timer react-query schedules on the real clock, untouched.
const REVEAL_DELAY_MS = 3000
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
interface ScheduledRevealTimer {
  id: number
  callback: () => void
}
let scheduledReveals: ScheduledRevealTimer[] = []
let nextRevealTimerId = 1
function fakeSetTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout> {
  if (delay === REVEAL_DELAY_MS) {
    const id = nextRevealTimerId++
    scheduledReveals.push({ id, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  return realSetTimeout(callback, delay)
}
function fakeClearTimeout(id?: ReturnType<typeof setTimeout>): void {
  const index = scheduledReveals.findIndex((s) => s.id === id)
  if (index !== -1) {
    scheduledReveals.splice(index, 1)
    return
  }
  realClearTimeout(id as Parameters<typeof clearTimeout>[0])
}

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount(path = '/projects/p1/sessions/s1/editor') {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })

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
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  for (let i = 0; i < 8; i++) {
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
}

let replaceCalls: string[] = []
let assignCalls: string[] = []
const realReplace = window.location.replace
const realAssign = window.location.assign

beforeEach(() => {
  localStorage.clear()
  currentStatus = editorStatus()
  statusReject = null
  statusGate = null
  statusCalls = []
  startCalls = []
  startReject = null
  startResponse = null
  replaceCalls = []
  assignCalls = []
  scheduledReveals = []
  nextRevealTimerId = 1
  globalThis.setTimeout = fakeSetTimeout as typeof setTimeout
  globalThis.clearTimeout = fakeClearTimeout as typeof clearTimeout
  // The same technique tests/version-skew-alert.test.tsx uses for
  // `window.location.reload`: happy-dom's own `location.replace`/`.assign`
  // throw "Not implemented" rather than merely navigating nowhere, so the
  // stub is not optional here.
  Object.defineProperty(window.location, 'replace', {
    configurable: true,
    value: (url: string) => {
      replaceCalls.push(url)
    },
  })
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    value: (url: string) => {
      assignCalls.push(url)
    },
  })
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(unmount)

afterAll(() => {
  Object.defineProperty(window.location, 'replace', { configurable: true, value: realReplace })
  Object.defineProperty(window.location, 'assign', { configurable: true, value: realAssign })
  apiClient.setConfig({ transport: originalTransport })
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (text: string) => buttons().find((b) => b.textContent?.includes(text))
const links = () => [...container.querySelectorAll('a')]
const findLink = (text: string) => links().find((a) => a.textContent?.includes(text))
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

/** Fires `StartingPanel`'s own reveal timer as if `START_DETAILS_DELAY_MS`
 *  had elapsed — the note and the log are absent until this runs. Throws if
 *  nothing scheduled one, which is itself useful: it means the page was not
 *  actually showing `StartingPanel` when this was called. */
const revealStartingDetails = async () => {
  const next = scheduledReveals.shift()
  if (!next) throw new Error('no starting-details reveal timer was scheduled')
  await act(async () => {
    next.callback()
  })
  await settle()
}

/** Forces the status query to refetch against whatever `currentStatus` holds
 *  right now — the same way a real poll (`useEditorStatus`'s own
 *  `refetchInterval`) or a mutation's `setQueryData` would move the page from
 *  one state to the next, but on demand rather than after a real timer. */
const refetchStatus = async () => {
  await act(async () => {
    await client.invalidateQueries({
      queryKey: getApiProjectsIdSessionsSessionidEditorQueryKey({
        path: { id: 'p1', sessionId: 's1' },
      }),
    })
  })
  await settle()
}

// --- 1. load failure ---------------------------------------------------------

test('a GET failure is reported plainly, with the API\'s own message, and a way back', async () => {
  statusReject = { response: { status: 409, data: { error: 'This worktree no longer exists on disk' } } }
  await mount()

  expect(container.textContent).toContain('This worktree no longer exists on disk')
  const back = findLink('Back to session')
  expect(back?.getAttribute('href')).toBe('/projects/p1/sessions/s1')
  expect(startCalls).toHaveLength(0)
})

// --- 2. disabled --------------------------------------------------------------

test('a disabled editor explains itself and offers the way back, not a Start button', async () => {
  currentStatus = editorStatus({ enabled: false })
  await mount()

  expect(container.textContent).toContain('The editor is turned off')
  expect(findLink('Back to session')?.getAttribute('href')).toBe('/projects/p1/sessions/s1')
  expect(startCalls).toHaveLength(0)
})

// --- 3. daemon down -------------------------------------------------------------

test('docker not installed explains why, distinct from daemon unreachable, with a way back', async () => {
  currentStatus = editorStatus({
    daemon: daemon({ cliInstalled: false, available: false, error: 'command not found' }),
  })
  await mount()

  expect(container.textContent).toContain('Docker is not installed')
  expect(container.textContent).toContain('command not found')
  expect(findLink('Back to session')?.getAttribute('href')).toBe('/projects/p1/sessions/s1')
})

test('the daemon installed but unreachable gets its own message, with a way back', async () => {
  currentStatus = editorStatus({ daemon: daemon({ available: false, error: 'connection refused' }) })
  await mount()

  expect(container.textContent).toContain('Docker daemon not reachable')
  expect(container.textContent).not.toContain('Docker is not installed')
  expect(container.textContent).toContain('connection refused')
  expect(findLink('Back to session')?.getAttribute('href')).toBe('/projects/p1/sessions/s1')
})

// --- 4. auto-start when stopped -----------------------------------------------

test('stopped auto-starts exactly once, with only the path, and shows the opening spinner alone', async () => {
  await mount()
  await settle()

  expect(startCalls).toHaveLength(1)
  expect(startCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
  expect(container.textContent).toContain('Opening the editor')
  // A warm start (the common case, and the only one this default status ever
  // exercises) never shows the note or the log at all — see the reveal-delay
  // tests below.
  expect(container.textContent).not.toContain('Waiting for output')
  // The mocked start response above moves the cache to 'starting' — further
  // ticks (standing in for `useEditorStatus`'s own polling) must not start it
  // again just because it is still not 'running' yet.
  await settle()
  await settle()
  expect(startCalls).toHaveLength(1)
})

test('running never auto-starts', async () => {
  currentStatus = editorStatus({ state: 'running' })
  await mount()
  await settle()

  expect(startCalls).toHaveLength(0)
})

test('starting, opened directly, never auto-starts a second time', async () => {
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({ status: 'running' }),
  })
  await mount()
  await settle()

  expect(startCalls).toHaveLength(0)
})

// --- 5. starting ---------------------------------------------------------------

test('starting shows only the opening spinner at first — no note, no log', async () => {
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({
      status: 'running',
      output: [{ stream: 'stdout', text: 'Pulling codercom/code-server:4.138.0', at: T }],
    }),
  })
  await mount()

  expect(container.textContent).toContain('Opening the editor')
  expect(container.textContent).not.toContain('370')
  expect(container.textContent).not.toContain('Pulling codercom/code-server:4.138.0')
  expect(container.textContent).not.toContain('Waiting for output')
})

test('the note about the image pull and the start log appear once a start is still running a few seconds in', async () => {
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({
      status: 'running',
      output: [{ stream: 'stdout', text: 'Pulling codercom/code-server:4.138.0', at: T }],
    }),
  })
  await mount()
  expect(container.textContent).not.toContain('370')

  await revealStartingDetails()

  expect(container.textContent).toContain('370')
  expect(container.textContent).toContain('Pulling codercom/code-server:4.138.0')
  // Never flashes back off once shown, even as later polling ticks keep
  // re-rendering this same 'starting' status.
  await settle()
  expect(container.textContent).toContain('370')
})

// --- 6. running ------------------------------------------------------------------

test('running redirects the whole tab to proxyPath, via location.replace', async () => {
  currentStatus = editorStatus({
    state: 'running',
    container: { name: 'agentoo_editor-alpha_s-abc123', state: 'running', startedAt: T },
  })
  await mount()

  expect(replaceCalls).toEqual(['/api/projects/p1/sessions/s1/editor/proxy/'])
  // `replace`, not `assign` — Back must not return to the launcher.
  expect(assignCalls).toEqual([])
})

// --- 7. a failed start: error, log, Retry, no second auto-start ------------------

test("the auto-start's own failure shows the error and the log, offers Retry, and never retries itself", async () => {
  await mount()
  await settle()
  expect(startCalls).toHaveLength(1)

  // The async job the auto-start kicked off comes back failed — the same
  // shape `useEditorStatus`'s own poll would report a few seconds later.
  currentStatus = editorStatus({
    operation: operation({
      status: 'failed',
      error: 'docker pull failed: no space left on device',
      output: [{ stream: 'stderr', text: 'no space left on device', at: T }],
    }),
  })
  await refetchStatus()

  // Immediately — unlike `StartingPanel`'s own delayed reveal, a failed
  // start's log is never held back. No `revealStartingDetails()` call here:
  // if this were still waiting on that timer, `Start log` would be missing.
  expect(container.textContent).toContain('Start log')
  expect(container.textContent).toContain('docker pull failed: no space left on device')
  expect(container.textContent).toContain('no space left on device')
  const retry = findButton('Retry')
  expect(retry).toBeDefined()
  // Further ticks alone must not fire the effect a second time.
  await settle()
  expect(startCalls).toHaveLength(1)

  if (!retry) throw new Error('no Retry button')
  await click(retry)
  await settle()
  expect(startCalls).toHaveLength(2)
  expect(startCalls[1]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

// --- 8. start itself rejects (409/403/503) ---------------------------------------

test('a 409 (max running editors reached) on the auto-start shows the API message and a Retry', async () => {
  startReject = { response: { status: 409, data: { error: 'The maximum number of running editors has been reached' } } }
  await mount()
  await settle()

  expect(container.textContent).toContain('The maximum number of running editors has been reached')
  expect(findButton('Retry')).toBeDefined()
  expect(startCalls).toHaveLength(1)
  // Polling alone must not retry a rejected mutate call either.
  await settle()
  expect(startCalls).toHaveLength(1)
})

// --- 9. unresponsive: Open anyway + Restart --------------------------------------

test('unresponsive offers "Open anyway" (assign) and "Restart" (calls start)', async () => {
  currentStatus = editorStatus({ state: 'unresponsive' })
  await mount()

  expect(container.textContent).toContain("The editor isn't responding")

  const openAnyway = findButton('Open anyway')
  if (!openAnyway) throw new Error('no "Open anyway" button')
  await click(openAnyway)
  expect(assignCalls).toEqual(['/api/projects/p1/sessions/s1/editor/proxy/'])
  expect(replaceCalls).toEqual([])

  const restart = findButton('Restart')
  if (!restart) throw new Error('no Restart button')
  await click(restart)
  await settle()
  expect(startCalls).toHaveLength(1)
  expect(startCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

test('unresponsive + Restart rejecting shows the API message and lets the reader retry', async () => {
  currentStatus = editorStatus({ state: 'unresponsive' })
  startReject = {
    response: { status: 409, data: { error: 'The editor container cap (2 running) is reached' } },
  }
  await mount()

  const restart = findButton('Restart')
  if (!restart) throw new Error('no Restart button')
  await click(restart)
  await settle()

  expect(container.textContent).toContain('The editor container cap (2 running) is reached')
  expect(startCalls).toHaveLength(1)

  // The error must not swallow the retry path: the same button, clicked
  // again, calls start again rather than becoming a dead end.
  const restartAgain = findButton('Restart')
  if (!restartAgain) throw new Error('no Restart button once the error is showing')
  await click(restartAgain)
  await settle()
  expect(startCalls).toHaveLength(2)
})

// --- 10. the tab's own title -------------------------------------------------------

test("sets the browser tab's own title while mounted, and restores it on unmount", async () => {
  document.title = 'agentoo'
  await mount()

  // By the time `mount` settles, the auto-start effect has already moved this
  // default status from 'stopped' to 'starting' (see the auto-start tests
  // above) — the title tracks that, same as the body does.
  expect(document.title).not.toBe('agentoo')
  expect(document.title).toBe('Opening the editor…')

  await unmount()
  expect(document.title).toBe('agentoo')
})

test('the title matches whatever error page is actually showing, not a generic "starting" one', async () => {
  statusReject = { response: { status: 409, data: { error: 'This worktree no longer exists on disk' } } }
  await mount()
  expect(document.title).toBe('Could not load the editor status')
  await unmount()

  statusReject = null
  currentStatus = editorStatus({ enabled: false })
  await mount()
  expect(document.title).toBe('The editor is turned off')
  await unmount()

  currentStatus = editorStatus({
    daemon: daemon({ cliInstalled: false, available: false, error: 'command not found' }),
  })
  await mount()
  expect(document.title).toBe('Docker is not installed')
  await unmount()

  currentStatus = editorStatus({ daemon: daemon({ available: false, error: 'connection refused' }) })
  await mount()
  expect(document.title).toBe('Docker daemon not reachable')
  await unmount()

  currentStatus = editorStatus({ state: 'unresponsive' })
  await mount()
  expect(document.title).toBe("The editor isn't responding")
  await unmount()
})

test('the loading, starting and running states all read the same "Opening the editor…" title — no other label in between', async () => {
  // Loading: the status query itself has not resolved yet.
  let release: () => void = () => {
    throw new Error('release called before it was assigned')
  }
  statusGate = new Promise((resolve) => {
    release = resolve
  })
  await mount()
  expect(container.textContent).toContain('Opening the editor')
  expect(document.title).toBe('Opening the editor…')
  release()
  await settle()
  statusGate = null
  await unmount()

  // Starting, reported directly by the backend.
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({ status: 'running' }),
  })
  await mount()
  expect(document.title).toBe('Opening the editor…')
  await unmount()

  // 'stopped' with no failure yet — the auto-start effect just fired (or is
  // about to) — reads the same as an explicit 'starting', not as idle.
  currentStatus = editorStatus()
  await mount()
  await settle()
  expect(document.title).toBe('Opening the editor…')
  await unmount()

  // Running, about to redirect.
  currentStatus = editorStatus({
    state: 'running',
    container: { name: 'agentoo_editor-alpha_s-abc123', state: 'running', startedAt: T },
  })
  await mount()
  expect(document.title).toBe('Opening the editor…')
  await unmount()
})

test('a failed start title distinguishes itself from the plain "starting" one', async () => {
  await mount()
  await settle()
  currentStatus = editorStatus({
    operation: operation({ status: 'failed', error: 'docker pull failed: no space left on device' }),
  })
  await refetchStatus()

  expect(document.title).toBe('The last start failed')
})

// --- 10b. a trailing slash on the launcher URL ------------------------------------

test('a trailing slash on the launcher URL still matches this route and renders the launcher', async () => {
  // Same route tree as every other test in this file (see the header
  // comment) — proves the router itself resolves `.../editor/` to the same
  // leaf as `.../editor`, which is what makes shared/store/tabs.ts's own
  // `isBareShellPath` fix (the trailing `/?`) actually matter: without the
  // router agreeing, there would be nothing for that fix to protect.
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({ status: 'running' }),
  })
  await mount('/projects/p1/sessions/s1/editor/')

  expect(container.textContent).toContain('Opening the editor')
  expect(statusCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

// --- 11. no shell around the launcher, and no workspace tab from visiting it -------

// `RootLayout` itself, not `app/router.tsx` — see the header comment for why
// that boundary matters. A route tree built here has exactly two leaves: the
// bare editor path, and one ordinary page, so a `<nav>`/`<aside>`/`<footer>`
// showing up for the second and not the first is a fact about `RootLayout`'s
// own branching (shared/store/tabs.ts's `isBareShellPath`), not an accident
// of this harness.
const shellRootRoute = createRootRoute({ component: RootLayout })
const bareShellRoute = createRoute({
  getParentRoute: () => shellRootRoute,
  path: '/projects/p1/sessions/s1/editor',
  component: () => <div>bare child</div>,
})
// Not `/library` — that is the system tab's own default `path`
// (shared/store/tabs.ts's `SYSTEM_HOME`), so `rememberPath` would see no
// actual change and never call `setTabs`, leaving `localStorage` untouched
// for a reason that has nothing to do with this test's own claim.
const ordinaryShellRoute = createRoute({
  getParentRoute: () => shellRootRoute,
  path: '/ssh-keys',
  component: () => <div>ordinary child</div>,
})
const shellRouteTree = shellRootRoute.addChildren([bareShellRoute, ordinaryShellRoute])

async function mountShell(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)

  const router = createRouter({
    routeTree: shellRouteTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()

  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

test('the launcher path renders with no tab bar, sidebar or status bar', async () => {
  await mountShell('/projects/p1/sessions/s1/editor')

  expect(container.textContent).toContain('bare child')
  expect(container.querySelector('nav')).toBeNull()
  expect(container.querySelector('aside')).toBeNull()
  expect(container.querySelector('footer')).toBeNull()
})

test('an ordinary page, by contrast, gets the full shell — proving the harness means something', async () => {
  await mountShell('/ssh-keys')

  expect(container.textContent).toContain('ordinary child')
  expect(container.querySelector('nav')).not.toBeNull()
  expect(container.querySelector('aside')).not.toBeNull()
  expect(container.querySelector('footer')).not.toBeNull()
})

test('visiting the launcher path adds no workspace tab — the stored row is never touched', async () => {
  await mountShell('/projects/p1/sessions/s1/editor')

  // `useWorkspaceSync` never mounts on this branch at all (root-layout.tsx),
  // so the persisted row it would otherwise adopt into is never even read.
  expect(localStorage.getItem('agentoo:tabs')).toBeNull()
})

test('an ordinary page, by contrast, does adopt itself into the stored tab row', async () => {
  await mountShell('/ssh-keys')

  expect(localStorage.getItem('agentoo:tabs')).not.toBeNull()
})

test('a trailing slash on the launcher path renders bare too, and adopts no tab', async () => {
  await mountShell('/projects/p1/sessions/s1/editor/')

  expect(container.textContent).toContain('bare child')
  expect(container.querySelector('nav')).toBeNull()
  expect(container.querySelector('aside')).toBeNull()
  expect(container.querySelector('footer')).toBeNull()
  expect(localStorage.getItem('agentoo:tabs')).toBeNull()
})
