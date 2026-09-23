// The Editor page's own gating: every state the backend's `EditorStatus` can
// report (disabled, daemon down, stopped/starting/running/unresponsive), the
// iframe's `src`/`title`/`allow` and the absence of `sandbox`, that the
// workbench never remounts across a running→unresponsive reading, that
// start/stop carry `{ path: { id, sessionId } }` and nothing else, that
// mounting the page never itself calls start, and the insecure-context note.
// Everything this file can prove without a real code-server container.
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
// The fix is not "avoid a router" — the header's "Back to session" control is
// a real `<Link>`, which needs one to resolve an `href` — it is "avoid
// *that* router": a route tree built right here, with only the two paths
// this file's own assertions touch (`/sessions/$sessionId` as the Link's
// target, `/sessions/$sessionId/editor` as where `EditorPage` itself mounts),
// never imports app/router.tsx or anything project/idea/docker/library-shaped
// at all, so this file cannot be "one more" contributor to that count.
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
// CSS-module class names are `undefined` under `bun test` (see
// session-idea-link.test.tsx's own note), so every assertion below is by
// text, attribute or DOM structure — never a generated class name.

import { plugin } from 'bun'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx and
// tests/docker-page.test.tsx: `EditorPage` pulls in the `@/shared/ui` barrel
// too (Alert, Code, EmptyState, Stack), and whichever of them `bun test`
// evaluates first decides how those ten modules are cached for the run.
// Copied verbatim, not widened.
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

import { afterEach, beforeEach, expect, test } from 'bun:test'
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
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { EditorPage } from '../src/features/editor'
import { getApiProjectsIdSessionsSessionidEditorQueryKey } from '../src/shared/api/generated/hooks/useGetApiProjectsIdSessionsSessionidEditor'
import { getApiSessionsIdQueryKey } from '../src/shared/api/generated/hooks/useGetApiSessionsId'
import type { GetApiProjectsIdSessionsSessionidEditorStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdSessionsSessionidEditor'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

// This file's own tiny route tree — see the header comment for why it is not
// `import { routeTree } from '../src/app/router'`. Only the two paths
// `EditorPage` itself ever needs: where it mounts, and the "Back to session"
// Link's own target (rendered as a bare placeholder — no test here asserts on
// that page's own content, only on the `href` pointed at it).
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
    return <EditorPage projectId={projectId} sessionId={sessionId} />
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
const STOP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdSessionsSessionidEditorStop'
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

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'Refactor auth',
  status: 'idle',
  orchestrator: null,
  worktreePath: '/srv/worktrees/s1',
  branch: 'feature/refactor-auth',
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/worktrees/s1',
  isolated: true,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
  ...overrides,
})

let currentStatus: Status = editorStatus()
let statusReject: unknown = null
let currentSession: SessionDto = session()

type StatusCall = { path: { id: string; sessionId: string } }
let statusCalls: StatusCall[] = []

await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdSessionsSessionidEditor: async (opts: StatusCall) => {
    statusCalls.push(opts)
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

let stopCalls: Call[] = []
let stopReject: unknown = null
await mockModule(STOP_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStop: async (opts: Call) => {
    stopCalls.push(opts)
    if (stopReject) throw stopReject
    return { data: editorStatus({ state: 'stopped' }) }
  },
}))

const { Toaster, toaster } = await import('../src/shared/ui/overlay/toast')

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount(path = '/projects/p1/sessions/s1/editor') {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded directly, not mocked through the generated client: `getApiSessionsId`
  // (features/sessions' `useSession`) is already mocked by two other feature's
  // own test files (storage-page.test.tsx, session-page-scroll.test.tsx), and
  // this avoids being a third file installing/restoring `mock.module` for the
  // exact same specifier. `staleTime: Infinity` above means a seeded cache
  // entry is never refetched, so this reaches the same page state with no
  // such sharing at all.
  client.setQueryData(getApiSessionsIdQueryKey({ path: { id: 's1' } }), currentSession)

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
            <Toaster />
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
  // The toaster is a module-level singleton (toast.tsx) — clear it so a toast
  // this test raised is not still alive for the next test's mount().
  toaster.remove()
}

beforeEach(() => {
  localStorage.clear()
  currentStatus = editorStatus()
  statusReject = null
  currentSession = session()
  statusCalls = []
  startCalls = []
  startReject = null
  startResponse = null
  stopCalls = []
  stopReject = null
  ;(window as { isSecureContext?: boolean }).isSecureContext = undefined
})

afterEach(unmount)

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

test('a GET failure is reported plainly, with the API\'s own message', async () => {
  statusReject = { response: { status: 409, data: { error: 'This worktree no longer exists on disk' } } }
  await mount()

  expect(container.textContent).toContain('This worktree no longer exists on disk')
  expect(container.querySelector('iframe')).toBeNull()
})

// --- 2. disabled --------------------------------------------------------------

test('a disabled editor explains itself instead of offering a Start button', async () => {
  currentStatus = editorStatus({ enabled: false })
  await mount()

  expect(container.textContent).toContain('The editor is turned off')
  expect(findButton('Start')).toBeUndefined()
})

// --- 3. daemon down -------------------------------------------------------------

test('docker not installed explains why, distinct from daemon unreachable', async () => {
  currentStatus = editorStatus({
    daemon: daemon({ cliInstalled: false, available: false, error: 'command not found' }),
  })
  await mount()

  expect(container.textContent).toContain('Docker is not installed')
  expect(container.textContent).toContain('command not found')
  expect(findButton('Start')).toBeUndefined()
})

test('the daemon installed but unreachable gets its own message', async () => {
  currentStatus = editorStatus({ daemon: daemon({ available: false, error: 'connection refused' }) })
  await mount()

  expect(container.textContent).toContain('Docker daemon not reachable')
  expect(container.textContent).not.toContain('Docker is not installed')
  expect(container.textContent).toContain('connection refused')
})

// --- 4. stopped -----------------------------------------------------------------

test('stopped renders a Start button and no iframe', async () => {
  await mount()

  expect(findButton('Start')).toBeDefined()
  expect(container.querySelector('iframe')).toBeNull()
})

test("stopped with a failed last start shows that operation's error and its log", async () => {
  currentStatus = editorStatus({
    operation: operation({
      status: 'failed',
      error: 'docker pull failed: no space left on device',
      output: [{ stream: 'stderr', text: 'no space left on device', at: T }],
    }),
  })
  await mount()

  expect(container.textContent).toContain('docker pull failed: no space left on device')
  expect(container.textContent).toContain('no space left on device')
})

test('clicking Start calls the start mutation with only the path, and nothing on mount does', async () => {
  await mount()
  expect(startCalls).toHaveLength(0)

  const start = findButton('Start')
  if (!start) throw new Error('no Start button')
  await click(start)
  await settle()

  expect(startCalls).toHaveLength(1)
  expect(startCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

test('a 409 (max running editors reached) while starting is toasted with the API message', async () => {
  startReject = { response: { status: 409, data: { error: 'The maximum number of running editors has been reached' } } }
  await mount()

  const start = findButton('Start')
  if (!start) throw new Error('no Start button')
  await click(start)
  await settle()

  expect(document.body.textContent).toContain('The maximum number of running editors has been reached')
})

// --- 5. starting ------------------------------------------------------------------

test('starting shows a spinner, mentions the image pull, and renders the start log', async () => {
  currentStatus = editorStatus({
    state: 'starting',
    operation: operation({
      status: 'running',
      output: [{ stream: 'stdout', text: 'Pulling codercom/code-server:4.138.0', at: T }],
    }),
  })
  await mount()

  expect(container.textContent).toContain('370')
  expect(container.textContent).toContain('Pulling codercom/code-server:4.138.0')
  expect(container.querySelector('iframe')).toBeNull()
})

// --- 6. running -------------------------------------------------------------------

test('running mounts the iframe at proxyPath, with no sandbox attribute', async () => {
  currentStatus = editorStatus({
    state: 'running',
    container: { name: 'agentoo_editor-alpha_s-abc123', state: 'running', startedAt: T },
  })
  await mount()

  const frame = container.querySelector('iframe')
  expect(frame).not.toBeNull()
  expect(frame?.getAttribute('src')).toBe('/api/projects/p1/sessions/s1/editor/proxy/')
  expect(frame?.getAttribute('allow')).toBe('clipboard-read; clipboard-write')
  expect(frame?.hasAttribute('sandbox')).toBe(false)
  expect(frame?.getAttribute('title')).toBeTruthy()
})

test('running offers "open in new tab" at proxyPath, and a Stop button', async () => {
  currentStatus = editorStatus({ state: 'running' })
  await mount()

  const openInNewTab = findLink('Open in new tab')
  expect(openInNewTab?.getAttribute('href')).toBe('/api/projects/p1/sessions/s1/editor/proxy/')
  expect(openInNewTab?.getAttribute('target')).toBe('_blank')
  expect(openInNewTab?.getAttribute('rel')).toBe('noopener')

  const stop = findButton('Stop')
  if (!stop) throw new Error('no Stop button')
  await click(stop)
  await settle()
  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

test('the idle-timeout note names how many minutes, converted from seconds', async () => {
  currentStatus = editorStatus({ state: 'running', idleTimeoutSeconds: 1800 })
  await mount()

  expect(container.textContent).toContain('30')
})

// --- 7. unresponsive: same iframe node, Restart and Stop -------------------------

test('unresponsive shows a warning banner with Restart and Stop, but keeps the iframe mounted', async () => {
  currentStatus = editorStatus({ state: 'unresponsive' })
  await mount()

  expect(container.textContent).toContain("The editor isn't responding")
  expect(container.querySelector('iframe')).not.toBeNull()

  const restart = findButton('Restart')
  if (!restart) throw new Error('no Restart button')
  await click(restart)
  await settle()
  expect(startCalls).toHaveLength(1)
  expect(startCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

test('a running→unresponsive transition never remounts the iframe', async () => {
  currentStatus = editorStatus({ state: 'running' })
  await mount()

  const before = container.querySelector('iframe')
  expect(before).not.toBeNull()

  currentStatus = editorStatus({ state: 'unresponsive' })
  await refetchStatus()

  const after = container.querySelector('iframe')
  expect(after).not.toBeNull()
  // Identity, not just presence — a fresh element that merely looks the same
  // would still have thrown away the workbench's own in-page state.
  expect(after).toBe(before)
  expect(container.textContent).toContain("The editor isn't responding")
})

// --- 8. insecure context ------------------------------------------------------------

test('a plain-HTTP context gets a non-blocking note about webviews/preview/clipboard', async () => {
  ;(window as { isSecureContext?: boolean }).isSecureContext = false
  await mount()

  expect(container.textContent).toContain('HTTPS')
})

test('a secure context shows no such note', async () => {
  ;(window as { isSecureContext?: boolean }).isSecureContext = true
  await mount()

  expect(container.textContent).not.toContain('HTTPS')
})

// --- 9. back to session -----------------------------------------------------------

test('the header always links back to the session', async () => {
  await mount()

  const back = findLink('Back to session')
  expect(back?.getAttribute('href')).toBe('/projects/p1/sessions/s1')
})
