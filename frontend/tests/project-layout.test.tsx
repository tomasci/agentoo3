// ProjectLayout (src/app/project-layout.tsx): every ordinary page under
// /projects/$projectId still waits on the project lookup — a "Loading…"
// spinner while it is pending, `projects.notFound` once it resolves without
// the project this URL names, the page itself once it resolves with it. The
// one thing this file exists to pin down is the exception carved out of that
// for the editor launcher's own bare path (shared/store/tabs.ts's
// `isBareShellPath`): that lookup must never gate it, on pain of exactly the
// bug this covers — an off-centre "Loading…" from *this* layout, then a jump
// to the launcher's own centred "Opening the editor…", and (for a project
// this list genuinely doesn't have) this layout's alert with no way back
// instead of the launcher's own 404 handling.
//
// Same approach as tests/editor-page.test.tsx: a private i18next instance and
// a local route tree, `ProjectLayout` and `EditorLauncher` imported directly
// rather than through `app/router.tsx` — see that file's own header comment
// for why. This tree nests them the same way the real router does
// (`ProjectLayout` as `/projects/$projectId`'s own component, the launcher as
// one of its children), so the ordinary `/sessions/$sessionId` route right
// beside it doubles as this file's "non-bare routes are unaffected" control.

import { plugin } from 'bun'

// Same identity-proxy loader, same allowlist, as tests/editor-page.test.tsx,
// tests/ui-core.test.tsx and tests/docker-page.test.tsx — copied verbatim,
// not widened; see any of those files' own header comments for why this
// exists at all.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/
plugin({
  name: 'project-layout-test-css-module-identity',
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
import { ProjectLayout } from '../src/app/project-layout'
import { EditorLauncher } from '../src/features/editor'
import type { Project } from '../src/features/projects'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import type { GetApiProjectsIdSessionsSessionidEditorStatus200 as Status } from '../src/shared/api/generated/types/GetApiProjectsIdSessionsSessionidEditor'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

// This file's own tiny route tree — see the header comment for why it is not
// `import { routeTree } from '../src/app/router'`. `ProjectLayout` sits where
// the real router puts it (as `/projects/$projectId`'s own component), with
// two children: the bare editor path, and an ordinary session path standing
// in for every page this layout's lookup is actually meant to gate.
const rootRoute = createRootRoute({ component: () => <Outlet /> })
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectLayout,
})
const sessionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId',
  component: () => <div>ordinary session page</div>,
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

// A private i18next instance, the same way tests/editor-page.test.tsx builds
// one — see that file's header comment for why this is never
// `import '@/shared/i18n'` or `.use(initReactI18next)`.
const testI18n = i18next.createInstance()
testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

// --- the projects list `ProjectLayout` itself reads --------------------------------

const PROJECTS_CLIENT = '@/shared/api/generated/clients/getApiProjects'
const project = (o: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project One',
  slug: 'project-one',
  source: 'existing',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: null,
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: '/srv/projects/p1',
  createdAt: T,
  updatedAt: T,
  ...o,
})

let currentProjects: Project[] = [project()]
// Held pending by a test that needs the list to still be loading — `null`
// means "resolve straight away", the default for every test here.
let projectsGate: Promise<void> | null = null

await mockModule(PROJECTS_CLIENT, () => ({
  getApiProjects: async () => {
    if (projectsGate) await projectsGate
    return { data: currentProjects }
  },
}))

// --- the editor status `EditorLauncher` itself reads --------------------------------
//
// Every test in this file puts the status straight into a terminal-ish state
// ('starting', or a GET failure) — never 'stopped' — so the auto-start effect
// never fires and there is nothing here for `useEditorStart`'s own client to
// do; it is never mocked, on purpose, the same way tests/editor-page.test.tsx
// only mocks what a given test actually exercises.

const STATUS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessionsSessionidEditor'
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
function editorStatus(overrides: Partial<Status> = {}): Status {
  return {
    projectId: 'p1',
    sessionId: 's1',
    enabled: true,
    daemon: daemon(),
    state: 'starting',
    proxyPath: '/api/projects/p1/sessions/s1/editor/proxy/',
    worktreePath: '/srv/worktrees/s1',
    image: 'codercom/code-server:4.138.0',
    idleTimeoutSeconds: 1800,
    container: null,
    operation: operation(),
    fetchedAt: T,
    ...overrides,
  }
}

let currentStatus: Status = editorStatus()
let statusReject: unknown = null

await mockModule(STATUS_CLIENT, () => ({
  getApiProjectsIdSessionsSessionidEditor: async () => {
    if (statusReject) throw statusReject
    return { data: currentStatus }
  },
}))

/** Nothing in this file is about any endpoint besides the two mocked above —
 *  refusing everything else at the shared transport is the same defensive
 *  idiom tests/editor-page.test.tsx and tests/version-skew-alert.test.tsx
 *  use, cheap insurance against a hook here reaching the network by
 *  accident. */
const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount(path: string) {
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

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(() => {
  currentProjects = [project()]
  projectsGate = null
  currentStatus = editorStatus()
  statusReject = null
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(unmount)

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
})

const progressBars = () => container.querySelectorAll('[role="progressbar"]')

// --- the bare editor path: the project lookup never gates it -----------------------

test('the bare editor path renders the launcher immediately — no layout "Loading…", and its own opening spinner is the only one', async () => {
  let release: () => void = () => {
    throw new Error('release called before it was assigned')
  }
  projectsGate = new Promise((resolve) => {
    release = resolve
  })

  await mount('/projects/p1/sessions/s1/editor')

  // The projects list is still pending — if the layout's own lookup were
  // still gating this route, this would be a plain "Loading…" spinner
  // instead.
  expect(container.textContent).toContain('Opening the editor')
  expect(container.textContent).not.toContain('Loading…')
  expect(progressBars()).toHaveLength(1)

  release()
  await settle()
})

test('the bare editor path renders the launcher even for a project this list does not have at all', async () => {
  currentProjects = [project({ id: 'some-other-project' })]

  await mount('/projects/p1/sessions/s1/editor')

  expect(container.textContent).toContain('Opening the editor')
  expect(container.textContent).not.toContain('That project does not exist.')
})

test("an unknown session's own GET failure shows the launcher's error, not the layout's alert", async () => {
  // The project genuinely is not in this list either — proving the launcher's
  // own handling wins even when *both* lookups would have failed.
  currentProjects = []
  statusReject = { response: { status: 404, data: { error: 'This session no longer exists' } } }

  await mount('/projects/p1/sessions/s1/editor')

  expect(container.textContent).toContain('This session no longer exists')
  expect(container.textContent).not.toContain('That project does not exist.')
})

// --- an ordinary route, by contrast, still gets the lookup ---------------------------

test('an ordinary project route still shows the layout\'s own "Loading…" while the list is pending', async () => {
  let release: () => void = () => {
    throw new Error('release called before it was assigned')
  }
  projectsGate = new Promise((resolve) => {
    release = resolve
  })

  await mount('/projects/p1/sessions/s1')

  expect(container.textContent).toContain('Loading…')
  expect(container.textContent).not.toContain('ordinary session page')

  release()
  await settle()
  expect(container.textContent).toContain('ordinary session page')
})

test('an ordinary project route shows "That project does not exist." once the list resolves without it', async () => {
  currentProjects = [project({ id: 'some-other-project' })]

  await mount('/projects/p1/sessions/s1')

  expect(container.textContent).toContain('That project does not exist.')
  expect(container.textContent).not.toContain('ordinary session page')
})

test('an ordinary project route renders its own page once the list resolves with the project', async () => {
  await mount('/projects/p1/sessions/s1')

  expect(container.textContent).toContain('ordinary session page')
})
