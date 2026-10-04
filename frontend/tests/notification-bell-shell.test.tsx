// Where the notification bell lives in the shell (app/tab-bar.tsx, rendered by
// root-layout.tsx's Shell): exactly once in every shell mode — the system tab,
// a project tab and an empty new tab — at desktop and phone widths, as the
// header's last child outside both tab `nav`s; and nowhere on the bare editor
// launcher route, which has no shell at all (`isBareShellPath`).
//
// Mounted the way tests/shell.test.tsx mounts the whole app at a URL: the real
// route tree, every query the shell reads seeded, `<body>` and `localStorage`
// emptied first, and the shared API transport refusing every request so an
// unseeded query fails fast instead of reaching whatever listens on
// localhost. The shell renders under the app's own English bundle (installed
// by src/app/router's import graph), so labels are read from en.json.
//
// happy-dom evaluates no media query, so "shows at phone width" is asserted
// the only way it can be here: the bell is in the DOM at that viewport and
// neither it nor any ancestor up to <header> carries a `hidden` utility.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import type { NotificationFeed } from '../src/shared/api/generated/types/NotificationFeed'
import en from '../src/shared/i18n/locales/en.json'

const PROJECTS = [
  {
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
    path: '/srv/alpha',
    createdAt: '',
    updatedAt: '',
  },
]

const EMPTY_FEED: NotificationFeed = { items: [], hasUnread: false, truncated: false }
const UNREAD_FEED: NotificationFeed = {
  items: [
    {
      source: 'session',
      id: 'sess-one',
      at: '2026-09-04T12:00:00.000Z',
      unread: true,
      projectId: 'p1',
      projectName: 'Alpha',
      title: 'Fix the login bug',
      status: 'completed',
    },
  ],
  hasUnread: true,
  truncated: false,
}

const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource

type HappyWindow = { happyDOM: { setViewport(v: { width: number; height: number }): void } }
const setViewport = (width: number, height: number) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height })

let container: HTMLDivElement
let root: Root | undefined
let router: ReturnType<typeof createRouter>

async function mount(path: string, feed: NotificationFeed = EMPTY_FEED) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/whats-new' }], {
    installedVersion: null,
    installedAt: null,
    pending: false,
  })
  client.setQueryData([{ url: '/api/notifications' }], feed)
  client.setQueryData([{ url: '/api/system' }], {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
  client.setQueryData(
    [{ url: '/api/system/prompts/:name', params: { name: 'session-learning' } }],
    {
      name: 'session-learning',
      body: 'Built-in default instruction.',
      path: '/opt/agentoo/library/prompts/session-learning.md',
      source: 'default',
    },
  )
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const BELL_LABELS = [en.notifications.bell, en.notifications.bellUnread]
/** Every bell in the whole document, not just `container`. */
const bells = () =>
  [...document.querySelectorAll<HTMLElement>('[aria-label]')].filter((el) =>
    BELL_LABELS.includes(el.getAttribute('aria-label') ?? ''),
  )
const classesOf = (el: Element | null | undefined) =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
/** Any `hidden` utility, under any variant prefix (`hidden`, `md:hidden`, `max-md:hidden`). */
const hidingClasses = (el: Element) => classesOf(el).filter((c) => /(^|:)hidden$/.test(c))

/** The one bell's placement: in the shell's top bar, its last child, outside both navs. */
function expectPlacedInHeader(bell: HTMLElement) {
  const header = bell.closest('header')
  expect(header == null).toBe(false)
  // The shell's own top bar, not a page's <header> inside the inset.
  expect(header?.closest('[data-slot="sidebar-inset"]') == null).toBe(true)
  expect(header?.lastElementChild === bell).toBe(true)
  expect(bell.closest('nav') == null).toBe(true)
  // Nothing between the bell and <header> hides it at any breakpoint.
  const hiding: string[] = []
  for (let el: Element | null = bell; el && el !== header; el = el.parentElement) {
    hiding.push(...hidingClasses(el))
  }
  expect(hiding).toEqual([])
}

beforeEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  setViewport(1024, 768)
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  localStorage.clear()
  document.documentElement.className = ''
})

const MODES = [
  ['the system tab', '/library'],
  ['a project tab', '/projects/p1/sessions'],
  ['an empty new tab', '/tab/new-1'],
] as const
const WIDTHS = [
  ['desktop', 1024, 768],
  ['phone', 375, 800],
] as const

for (const [mode, path] of MODES) {
  for (const [width, w, h] of WIDTHS) {
    test(`the bell renders exactly once on ${mode} at ${width} width, last in the top bar`, async () => {
      setViewport(w, h)
      await mount(path)
      // The shell really is there (and the URL stuck), so a count of one is
      // about the bell, not about a page that failed to mount.
      expect(router.state.location.pathname).toBe(path)
      expect(document.querySelectorAll('[data-slot="sidebar-wrapper"]').length).toBe(1)
      const found = bells()
      expect(found).toHaveLength(1)
      const bell = found[0] as HTMLElement
      expect(bell.tagName).toBe('BUTTON')
      expect(bell.getAttribute('aria-label')).toBe(en.notifications.bell)
      expectPlacedInHeader(bell)
    })
  }
}

test('in the shell an unread feed lights the dot and switches the label', async () => {
  await mount('/library', UNREAD_FEED)
  const found = bells()
  expect(found).toHaveLength(1)
  expect(found[0]?.getAttribute('aria-label')).toBe(en.notifications.bellUnread)
  expect(found[0]?.querySelector('[data-fixed-tone].bg-destructive') == null).toBe(false)
  expect(found[0]?.textContent ?? '').not.toMatch(/\d/)
})

for (const [width, w, h] of WIDTHS) {
  test(`the bare editor launcher has no bell at ${width} width`, async () => {
    setViewport(w, h)
    await mount('/projects/p1/sessions/s1/editor', UNREAD_FEED)
    expect(router.state.location.pathname).toBe('/projects/p1/sessions/s1/editor')
    // No shell, by design — and something did render.
    expect(document.querySelectorAll('[data-slot="sidebar-wrapper"]').length).toBe(0)
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(bells()).toHaveLength(0)
  })
}
