// The running-editors panel (features/editor/components/running-editors.tsx):
// shown under the launcher's own failure message once a start has actually
// failed, whichever of the two ways that happens (a 409 on the start POST
// itself, or a 200 whose own queued operation later fails at the worker's
// cap check) — never otherwise, and never once the fetched cap is not
// actually reached. Stop (idle/unresponsive immediately, in-use behind a
// confirm), the retry-this-editor-once that follows a successful Stop, the
// otherInstalls note, the "can't list these" explanation for an empty list,
// a failed Stop's toast, and the panel's own polling starting and stopping
// with whether it is actually mounted.
//
// A dedicated file rather than an addition to tests/editor-page.test.tsx:
// same private-i18n-instance + local-route-tree approach as that file (see
// its own header comment for why — never `app/router.tsx`, never
// `@/shared/i18n`), just with its own copy of the boilerplate so this
// feature's mocks (`/api/editors`, the stop endpoint) sit next to the tests
// that exercise them instead of growing that file's own mock list further.

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
import type { GetApiEditorsStatus200 } from '../src/shared/api/generated/types/GetApiEditors'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { getApiProjectsIdSessionsSessionidEditorQueryKey } from '../src/shared/api/generated/hooks/useGetApiProjectsIdSessionsSessionidEditor'
import type { GetApiProjectsIdSessionsSessionidEditorStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdSessionsSessionidEditor'
import en from '../src/shared/i18n/locales/en.json'
import { Toaster, toast } from '../src/shared/ui/toast'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

// Same tiny route tree as tests/editor-page.test.tsx, for the same reason
// (see that file's header comment) — plus this panel's own "Open" link,
// which points at *another* project/session's editor. No extra route is
// needed for that: the pattern below matches any `$projectId`/`$sessionId`
// pair, not just this launcher's own `p1`/`s1`.
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

// A private i18next instance with the real English copy — never
// `@/shared/i18n` itself, and never `.use(initReactI18next)` here (that is
// the one call that writes into the shared fallback slot). See
// tests/editor-page.test.tsx's header comment for the full reasoning.
const testI18n = i18next.createInstance()
testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessionsSessionidEditor'
const START_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdSessionsSessionidEditorStart'
const EDITORS_CLIENT = '@/shared/api/generated/clients/getApiEditors'
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

/** This launcher's own session — always `p1`/`s1`, enabled and healthy, with
 *  nothing running yet, unless a test overrides the one field it is about. */
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

type EditorsStatus = GetApiEditorsStatus200
type RunningEditorFixture = EditorsStatus['editors'][number]

/** `GET /api/editors`'s own shape — `enabled`/`cap`/`running` default to "the
 *  cap is not reached", so a test has to opt in to the cap actually being
 *  hit, the same way `editorStatus()` above defaults to "nothing is wrong". */
function editorsStatus(overrides: Partial<EditorsStatus> = {}): EditorsStatus {
  return {
    enabled: true,
    cap: 2,
    running: 0,
    otherInstallsRunning: 0,
    editors: [],
    fetchedAt: T,
    ...overrides,
  }
}

/** One row `GET /api/editors` reports — always a *different* project/session
 *  than this launcher's own `p1`/`s1`, since a running editor never includes
 *  the one this launcher just failed to start. */
function runningEditor(overrides: Partial<RunningEditorFixture> = {}): RunningEditorFixture {
  return {
    projectId: 'p2',
    projectName: 'Project Two',
    sessionId: 's2',
    sessionTitle: 'Feature work',
    branch: 'feature/foo',
    containerName: 'agentoo_editor-two_s-s2',
    startedAt: T,
    health: 'idle',
    lastActiveAt: T,
    ...overrides,
  }
}

let currentStatus: Status = editorStatus()
let statusReject: unknown = null
type StatusCall = { path: { id: string; sessionId: string } }
let statusCalls: StatusCall[] = []
await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdSessionsSessionidEditor: async (opts: StatusCall) => {
    statusCalls.push(opts)
    if (statusReject) throw statusReject
    return { data: currentStatus }
  },
}))

type StartCall = { path: { id: string; sessionId: string } }
let startCalls: StartCall[] = []
let startReject: unknown = null
let startResponse: Status | null = null
await mockModule(START_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStart: async (opts: StartCall) => {
    startCalls.push(opts)
    if (startReject) throw startReject
    return { data: startResponse ?? editorStatus({ state: 'starting', operation: operation({ status: 'running' }) }) }
  },
}))

let currentEditorsResponse: EditorsStatus = editorsStatus()
let editorsCalls = 0
let editorsReject: unknown = null
await mockModule(EDITORS_CLIENT, () => ({
  getApiEditors: async () => {
    editorsCalls++
    if (editorsReject) throw editorsReject
    return { data: currentEditorsResponse }
  },
}))

type StopCall = { path: { id: string; sessionId: string } }
let stopCalls: StopCall[] = []
let stopReject: unknown = null
await mockModule(STOP_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStop: async (opts: StopCall) => {
    stopCalls.push(opts)
    if (stopReject) throw stopReject
    return { data: editorStatus({ state: 'stopped' }) }
  },
}))

/** Nothing here fetches /api/projects, /api/health, /api/ssh-keys or
 *  /api/system, but `EditorLauncher` renders with no app shell at all
 *  (root-layout.tsx's `isBareShellPath`), so there is nothing that would
 *  anyway — this exists only as a guard against ever making an unmocked
 *  request, the same technique tests/version-skew-alert.test.tsx uses. */
const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

// `StartingPanel`'s own reveal timer (editor-launcher.tsx, `START_DETAILS_DELAY_MS`
// = 3000) is a real `setTimeout` no test here ever fires — nothing in this
// file asserts on the start log, so it is left to sit unfired rather than
// fully faked out (unlike tests/editor-page.test.tsx, which does assert on
// it). What this file fakes instead is `useRunningEditors`'s own polling
// interval (use-running-editors.ts, `POLL_MS` = 10_000): react-query's
// `refetchInterval` schedules through the *global* `setInterval`
// (`@tanstack/query-core`'s `timeoutManager`), so patching it here the same
// way tests/editor-page.test.tsx patches `setTimeout` lets a test fire a poll
// on demand rather than waiting out a real 10 seconds, and lets it assert
// that nothing is scheduled once the panel is unmounted.
const POLL_MS = 10_000
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
interface ScheduledPoll {
  id: number
  callback: () => void
}
let scheduledPolls: ScheduledPoll[] = []
let nextPollId = 1
function fakeSetInterval(callback: () => void, delay?: number): ReturnType<typeof setInterval> {
  if (delay === POLL_MS) {
    const id = nextPollId++
    scheduledPolls.push({ id, callback })
    return id as unknown as ReturnType<typeof setInterval>
  }
  return realSetInterval(callback, delay)
}
function fakeClearInterval(id?: ReturnType<typeof setInterval>): void {
  const index = scheduledPolls.findIndex((p) => p.id === id)
  if (index !== -1) {
    scheduledPolls.splice(index, 1)
    return
  }
  realClearInterval(id as Parameters<typeof clearInterval>[0])
}
/** Runs every poll currently scheduled, as if `POLL_MS` had elapsed. */
const firePolls = async () => {
  for (const poll of [...scheduledPolls]) poll.callback()
  await settle()
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
  // Module-level singleton (ui/toast.tsx) — see tests/storage-page.test.tsx's
  // own note on why this has to be cleared between tests.
  toast.close()
}

beforeEach(() => {
  currentStatus = editorStatus()
  statusReject = null
  statusCalls = []
  startCalls = []
  startReject = null
  startResponse = null
  currentEditorsResponse = editorsStatus()
  editorsCalls = 0
  editorsReject = null
  stopCalls = []
  stopReject = null
  scheduledPolls = []
  nextPollId = 1
  globalThis.setInterval = fakeSetInterval as typeof setInterval
  globalThis.clearInterval = fakeClearInterval as typeof clearInterval
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(unmount)

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (text: string) => buttons().find((b) => b.textContent?.includes(text))
const links = () => [...container.querySelectorAll('a')]
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

/** The one row for a given session title — `EditorRow` wraps each running
 *  editor in an `Item` (item.tsx's `data-slot="item"`), the same idiom
 *  tests/docker-page.test.tsx's own `rowFor` uses for `ServiceRow`'s
 *  `<article>`. */
const rowFor = (sessionTitle: string) => {
  const span = [...container.querySelectorAll('span')].find((s) => s.textContent === sessionTitle)
  const row = span?.closest('[data-slot="item"]')
  if (!row) throw new Error(`no row for "${sessionTitle}"`)
  return row as HTMLElement
}

/** The one `ConfirmDialog` open at a time, if any — Base UI's alert dialog
 *  unmounts its popup entirely while closed, so a bare `[role="alertdialog"]`
 *  only ever matches an open one; see tests/docker-page.test.tsx's own copy
 *  of this note. */
const dialogButtons = () => {
  const dialog = document.body.querySelector('[role="alertdialog"]')
  return dialog ? ([...dialog.querySelectorAll('button')] as HTMLElement[]) : []
}
const findDialogButton = (text: string) => dialogButtons().find((b) => b.textContent?.includes(text))

/** Forces the launcher's own status query to refetch against whatever
 *  `currentStatus` holds right now — standing in for a real poll landing
 *  on a worker-side failure, the same helper editor-page.test.tsx uses. */
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

// --- 1. the 409 path -----------------------------------------------------------

test('a 409 at the cap shows who is holding it, with badges and a working Open link', async () => {
  startReject = {
    response: { status: 409, data: { error: 'The editor container cap (2 running) is reached' } },
  }
  currentEditorsResponse = editorsStatus({
    running: 2,
    editors: [
      runningEditor({
        projectId: 'p2',
        sessionId: 's2',
        projectName: 'Project Two',
        sessionTitle: 'Idle one',
        branch: 'main',
        health: 'idle',
      }),
      runningEditor({
        projectId: 'p3',
        sessionId: 's3',
        projectName: 'Project Three',
        sessionTitle: 'Busy one',
        branch: null,
        health: 'in-use',
      }),
    ],
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('The editor container cap (2 running) is reached')
  expect(container.textContent).toContain('Running editors — 2 of 2')
  expect(container.textContent).toContain('Project Two')
  expect(container.textContent).toContain('Idle one')
  expect(container.textContent).toContain('main')
  expect(container.textContent).toContain('Idle — no open tab')
  expect(container.textContent).toContain('Project Three')
  expect(container.textContent).toContain('Busy one')
  expect(container.textContent).toContain('In use')

  const openLinks = links().filter((a) => a.textContent === 'Open')
  expect(openLinks).toHaveLength(2)
  const openIdleRow = openLinks.find((a) => a.getAttribute('href') === '/projects/p2/sessions/s2/editor')
  if (!openIdleRow) throw new Error('no Open link for the idle row')
  expect(openIdleRow.getAttribute('target')).toBe('_blank')
  expect(openIdleRow.getAttribute('rel')).toBe('noopener noreferrer')
  expect(openLinks.some((a) => a.getAttribute('href') === '/projects/p3/sessions/s3/editor')).toBe(true)
})

// --- 2. the worker-failed path ---------------------------------------------------

test('a worker-side cap failure (a 200 start whose own operation later fails) shows the panel too', async () => {
  currentEditorsResponse = editorsStatus({ running: 2, editors: [runningEditor()] })
  await mount()
  await settle()
  expect(startCalls).toHaveLength(1)

  // The queued operation the mocked 200 above returned comes back failed —
  // the same shape a real poll would report once the worker's own cap check
  // rejects it.
  currentStatus = editorStatus({
    operation: operation({
      status: 'failed',
      error: 'The editor container cap (2 running) is reached',
    }),
  })
  await refetchStatus()

  expect(container.textContent).toContain('The editor container cap (2 running) is reached')
  expect(container.textContent).toContain('Running editors — 2 of 2')
  expect(container.textContent).toContain('Project Two')
})

// --- 3. under the cap: no panel ---------------------------------------------------

test('running under the cap never shows the panel, even once a start fails', async () => {
  startReject = { response: { status: 409, data: { error: 'boom' } } }
  currentEditorsResponse = editorsStatus({ running: 1, cap: 2, editors: [runningEditor()] })
  await mount()
  await settle()

  expect(container.textContent).toContain('boom')
  expect(container.textContent).not.toContain('Running editors')
})

// --- 4. stop an idle row: stops it, refreshes, retries this editor once ----------

test('Stop on an idle row stops it immediately, refreshes the list, and retries this editor once', async () => {
  startReject = {
    response: { status: 409, data: { error: 'The editor container cap (2 running) is reached' } },
  }
  currentEditorsResponse = editorsStatus({ running: 2, editors: [runningEditor({ health: 'idle' })] })
  await mount()
  await settle()
  expect(startCalls).toHaveLength(1)
  const editorsCallsBefore = editorsCalls

  const stop = findButton('Stop')
  if (!stop) throw new Error('no Stop button')
  // Let the retry this triggers actually succeed, so it is distinguishable
  // from the first (rejected) auto-start.
  startReject = null
  await click(stop)
  await settle()

  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.path).toEqual({ id: 'p2', sessionId: 's2' })
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  expect(editorsCalls).toBeGreaterThan(editorsCallsBefore)
  expect(startCalls).toHaveLength(2)
  expect(startCalls[1]?.path).toEqual({ id: 'p1', sessionId: 's1' })
})

// --- 5. stop an in-use row: confirm first, cancel calls no stop ------------------

test('Stop on an in-use row asks for confirmation first, and Cancel calls no stop', async () => {
  startReject = { response: { status: 409, data: { error: 'cap reached' } } }
  currentEditorsResponse = editorsStatus({ running: 2, editors: [runningEditor({ health: 'in-use' })] })
  await mount()
  await settle()

  const stop = findButton('Stop')
  if (!stop) throw new Error('no Stop button')
  await click(stop)

  expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  expect(document.body.textContent).toContain(
    'Someone has this editor open in a tab. Stopping it closes their session',
  )
  expect(stopCalls).toHaveLength(0)

  const cancel = findDialogButton('Cancel')
  if (!cancel) throw new Error('no Cancel button in the confirm dialog')
  await click(cancel)

  expect(stopCalls).toHaveLength(0)
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

  // Clicking Stop again and actually confirming this time does call stop.
  const stopAgain = findButton('Stop')
  if (!stopAgain) throw new Error('no Stop button')
  await click(stopAgain)
  const confirm = findDialogButton('Stop')
  if (!confirm) throw new Error('no confirm button in the dialog')
  await click(confirm)
  await settle()

  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.path).toEqual({ id: 'p2', sessionId: 's2' })
})

// --- 6. a failed stop toasts -------------------------------------------------------

test('a failed Stop toasts the API message and leaves the row for a retry', async () => {
  startReject = { response: { status: 409, data: { error: 'cap reached' } } }
  currentEditorsResponse = editorsStatus({ running: 2, editors: [runningEditor({ health: 'idle' })] })
  stopReject = { response: { status: 500, data: { error: 'docker rm failed: permission denied' } } }
  await mount()
  await settle()

  const stop = findButton('Stop')
  if (!stop) throw new Error('no Stop button')
  await click(stop)
  await settle()

  expect(document.body.textContent).toContain('docker rm failed: permission denied')
  // Still there, and startable again — a failed Stop is not a dead end.
  expect(findButton('Stop')).toBeDefined()
})

// --- 7. other-installs note --------------------------------------------------------

test('editors running from another agentoo install show as a muted note with no controls', async () => {
  startReject = { response: { status: 409, data: { error: 'cap reached' } } }
  currentEditorsResponse = editorsStatus({
    running: 2,
    otherInstallsRunning: 1,
    editors: [runningEditor()],
  })
  await mount()
  await settle()

  expect(container.textContent).toContain(
    '1 more editor running from another agentoo installation on this machine',
  )
})

// --- 8. empty list, cap still reached ----------------------------------------------

test('an empty list with the cap still reached explains the slots are held elsewhere', async () => {
  startReject = { response: { status: 409, data: { error: 'cap reached' } } }
  currentEditorsResponse = editorsStatus({ running: 2, editors: [] })
  await mount()
  await settle()

  expect(container.textContent).toContain(
    "The available slots are held by editors this installation can't list.",
  )
  expect(findButton('Retry')).toBeDefined()
})

// --- 9. polling starts and stops with the panel's own presence ---------------------

test('the panel polls while showing, and stops once it is gone', async () => {
  currentEditorsResponse = editorsStatus({ running: 2, editors: [runningEditor({ health: 'idle' })] })
  startReject = { response: { status: 409, data: { error: 'cap reached' } } }
  await mount()
  await settle()

  expect(scheduledPolls.length).toBeGreaterThan(0)
  const callsWhileVisible = editorsCalls
  await firePolls()
  expect(editorsCalls).toBeGreaterThan(callsWhileVisible)

  // Let the next start attempt succeed, moving the launcher off the failure
  // view (and the panel with it).
  startReject = null
  const retry = findButton('Retry')
  if (!retry) throw new Error('no Retry button')
  await click(retry)
  await settle()

  expect(container.textContent).not.toContain('Running editors')
  expect(scheduledPolls).toHaveLength(0)
})
