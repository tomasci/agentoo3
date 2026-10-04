// A project tab after the Overview → Settings move:
//
//   - a freshly opened project tab lands on /projects/<id>/sessions, and a
//     bare /projects/<id> redirects there;
//   - the old Overview page (details, SSH key, retry, delete) renders at
//     /projects/<id>/settings;
//   - the project sidebar lists Sessions, Docker, Ideas, Library in that
//     order, with Settings alone in the sidebar *footer* — a sibling after the
//     flex-1 content column, which is what pins it to the bottom;
//   - Sessions stays current on a session's own page; Settings is current on
//     /settings and nothing else is;
//   - deleting the project from Settings still closes its tab.
//
// Mounted through the real router, the way tests/workspace.test.tsx mounts
// the shell. The delete and project-list clients are mocked (./mock-module)
// because the delete's own `onSuccess` refetches the list; the session page
// the "session's own page" case lands on has its clients mocked too.
//
// What happy-dom cannot show: whether the footer is *visually* at the bottom.
// There is no layout engine, so that part is checked structurally only — the
// footer is the inner column's last child, after a `flex-1` content block.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const project = (id: string, name: string) => ({
  id, name, slug: name.toLowerCase(), source: 'clone', remoteUrl: `git@github.com:acme/${name.toLowerCase()}.git`,
  sourceName: null, sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null,
  recoveryCommands: null, path: `/srv/${name.toLowerCase()}`, createdAt: '', updatedAt: '',
})
const ALPHA = project('p1', 'Alpha')
const BETA = project('p2', 'Beta')

/** What the mocked server's project list returns right now. */
let serverProjects = [ALPHA, BETA]
let deleteCalls: { id: string; removeFiles?: string }[] = []
/** When true, GET /projects keeps answering with the full original list even
 *  after a delete — so the shell's own pruning of a vanished project's tab
 *  (use-tabs.ts) cannot be what closes it. Not "never answers": the delete
 *  hook's own `onSuccess` returns the list invalidation's promise, and
 *  TanStack Query awaits that before the per-call `onSuccess` (Settings'
 *  `onDeleted`) runs at all, so a list that never answers never closes the
 *  tab either — by design, not a defect of this change. */
let staleProjectList = false

await mockModule('@/shared/api/generated/clients/getApiProjects', () => ({
  getApiProjects: async () => ({ data: staleProjectList ? [ALPHA, BETA] : serverProjects }),
}))
await mockModule('@/shared/api/generated/clients/deleteApiProjectsId', () => ({
  deleteApiProjectsId: async (opts: { path: { id: string }; query?: { removeFiles?: string } }) => {
    deleteCalls.push({ id: opts.path.id, removeFiles: opts.query?.removeFiles })
    serverProjects = serverProjects.filter((p) => p.id !== opts.path.id)
    return { data: { ok: true } }
  },
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: {
      id: opts.path.id, projectId: 'p1', ideaId: null, title: 'A session', status: 'idle',
      orchestrator: null, worktreePath: null, branch: null, baseBranch: null, baseSha: null,
      baseNote: null, workingDir: '/srv/alpha', isolated: false, sdkSessionId: null,
      maxBudgetUsd: null, lastError: null, messageCount: 0, totalCostUsd: 0, pendingPrompts: 0,
      settledAt: null, seenAt: null, unchecked: false, createdAt: '', updatedAt: '',
    },
  }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
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

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
const roots: Root[] = []

const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], serverProjects)
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
  for (const p of serverProjects) {
    client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: p.id } }], [])
  }
  client.setQueryData(
    [{ url: '/api/sessions/overview' }, { window: '1d' }],
    { running: [], unchecked: [], recent: [], window: '1d' },
  )
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

const at = () => router.state.location.pathname
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const main = () => container.querySelector('main') as HTMLElement
const sidebar = () => container.querySelector('[data-slot="sidebar"]')
const inner = () => sidebar()?.querySelector('[data-slot="sidebar-inner"]')
const linksIn = (scope: Element | null | undefined) =>
  [...(scope?.querySelectorAll('a') ?? [])].map((a) => ({
    href: a.getAttribute('href'),
    label: text(a),
  }))
const currentHrefs = () =>
  [...(sidebar()?.querySelectorAll('a[aria-current="page"]') ?? [])].map((a) =>
    a.getAttribute('href'),
  )
const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const tabBar = () => container.querySelector('nav[aria-label="Workspace tabs"]')
const tabButtons = () =>
  [...(tabBar()?.querySelectorAll('ul > li') ?? [])].map(
    (li) => li.querySelector('button') as HTMLButtonElement,
  )
const tabs = () => tabButtons().map((b) => b.textContent?.trim())
const activeTab = () => {
  const current = tabButtons().filter((b) => b.getAttribute('aria-current') === 'page')
  if (current.length > 1) throw new Error(`${current.length} tabs claim aria-current`)
  return current[0]?.textContent?.trim() ?? null
}

beforeEach(() => {
  localStorage.clear()
  problems.length = 0
  document.body.innerHTML = ''
  serverProjects = [ALPHA, BETA]
  deleteCalls = []
  staleProjectList = false
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  client?.clear()
})

// ── rule 1 ──────────────────────────────────────────────────────────────────

test('a project picked into a fresh tab lands on its Sessions page', async () => {
  await mount('/sessions')
  await click(tabBar()?.querySelector('[aria-label="New tab"]'), 'new tab button')
  const pick = [...main().querySelectorAll('button')].find((b) => text(b) === 'Beta')
  await click(pick, 'Beta in the picker')
  expect(at()).toBe('/projects/p2/sessions')
  expect(tabs()).toEqual(['System', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(problems).toEqual([])
})

test('/projects/<id> redirects to /projects/<id>/sessions', async () => {
  await mount('/projects/p1')
  expect(at()).toBe('/projects/p1/sessions')
  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(problems).toEqual([])
})

test('/projects/<id>/ (trailing slash) redirects to Sessions too', async () => {
  await mount('/projects/p1/')
  expect(at()).toBe('/projects/p1/sessions')
})

// ── rule 2 ──────────────────────────────────────────────────────────────────

test('/projects/<id>/settings renders the old Overview page: details, SSH key, retry, delete', async () => {
  await mount('/projects/p1/settings')
  expect(at()).toBe('/projects/p1/settings')
  const body = text(main())
  expect(body).toContain('Details')
  expect(body).toContain('Authentication')
  expect(main().querySelector('[aria-label="SSH key"]') !== null).toBe(true)
  const buttons = [...main().querySelectorAll('button')].map(text)
  expect(buttons).toContain('Retry setup')
  expect(buttons).toContain('Delete project')
  expect(problems).toEqual([])
})

// ── rule 3 ──────────────────────────────────────────────────────────────────

test('project nav: Sessions, Docker, Env, Ideas, Library in the content; Settings alone in the footer', async () => {
  await mount('/projects/p1/sessions')
  const content = sidebar()?.querySelector('[data-slot="sidebar-content"]')
  const footer = sidebar()?.querySelector('[data-slot="sidebar-footer"]')
  expect(linksIn(content)).toEqual([
    { href: '/projects/p1/sessions', label: 'Sessions' },
    { href: '/projects/p1/docker', label: 'Docker' },
    { href: '/projects/p1/env', label: 'Env files' },
    { href: '/projects/p1/ideas', label: 'Ideas' },
    { href: '/projects/p1/library', label: 'Agents & skills' },
  ])
  expect(linksIn(footer)).toEqual([{ href: '/projects/p1/settings', label: 'Settings' }])
  // No leftover link to the bare project index anywhere in the sidebar.
  expect(linksIn(sidebar()).map((l) => l.href)).not.toContain('/projects/p1')
})

test('the Settings footer is pinned below a flex-1 content column', async () => {
  await mount('/projects/p1/sessions')
  const children = [...(inner()?.children ?? [])].map((el) => el.getAttribute('data-slot'))
  // Header, then the growing content, then the footer — last.
  expect(children).toEqual(['sidebar-header', 'sidebar-content', 'sidebar-footer'])
  const content = sidebar()?.querySelector('[data-slot="sidebar-content"]')
  expect(content?.classList.contains('flex-1')).toBe(true)
  expect(inner()?.classList.contains('flex-col')).toBe(true)
})

test('Sessions is the current item on the Sessions list', async () => {
  await mount('/projects/p1/sessions')
  expect(currentHrefs()).toEqual(['/projects/p1/sessions'])
})

test("Sessions stays the current item on a session's own page", async () => {
  await mount('/projects/p1/sessions/s1')
  expect(at()).toBe('/projects/p1/sessions/s1')
  expect(currentHrefs()).toEqual(['/projects/p1/sessions'])
})

test('Settings is the current item on /settings, and nothing else is', async () => {
  await mount('/projects/p1/settings')
  expect(currentHrefs()).toEqual(['/projects/p1/settings'])
})

test('clicking Settings in the footer navigates there', async () => {
  await mount('/projects/p1/sessions')
  const link = sidebar()?.querySelector('[data-slot="sidebar-footer"] a')
  await click(link, 'Settings link')
  expect(at()).toBe('/projects/p1/settings')
  expect(activeTab()).toBe('Alpha')
})

// ── rule 4 ──────────────────────────────────────────────────────────────────

const deleteFromSettings = async () => {
  await click(
    [...main().querySelectorAll('button')].find((b) => text(b) === 'Delete project'),
    'Delete project button',
  )
  const dialog = document.body.querySelector('[role="alertdialog"]')
  expect(dialog !== null).toBe(true)
  await click(
    [...(dialog?.querySelectorAll('button') ?? [])].find((b) => text(b) === 'Delete'),
    'confirm Delete',
  )
}

test('deleting the project from Settings closes its tab (itself, not via list pruning)', async () => {
  // The list refetch the delete triggers still names Alpha, so the only
  // thing that can close the tab is Settings' own `onDeleted`.
  staleProjectList = true
  await mount('/projects/p1/settings')
  expect(tabs()).toEqual(['System', 'Alpha'])

  await deleteFromSettings()

  expect(deleteCalls).toEqual([{ id: 'p1', removeFiles: 'true' }])
  expect(tabs()).toEqual(['System'])
  expect(activeTab()).toBe('System')
  expect(at().startsWith('/projects/p1')).toBe(false)
  expect(problems).toEqual([])
})

test('deleting from Settings moves to the neighbouring tab, which stays open', async () => {
  // Alpha then Beta open; delete Alpha from its Settings page.
  await mount('/projects/p2/sessions')
  await click(tabBar()?.querySelector('[aria-label="New tab"]'), 'new tab button')
  await click(
    [...main().querySelectorAll('button')].find((b) => text(b) === 'Alpha'),
    'Alpha in the picker',
  )
  expect(tabs()).toEqual(['System', 'Beta', 'Alpha'])
  await click(sidebar()?.querySelector('[data-slot="sidebar-footer"] a'), 'Settings link')
  expect(at()).toBe('/projects/p1/settings')

  await deleteFromSettings()

  expect(deleteCalls).toEqual([{ id: 'p1', removeFiles: 'true' }])
  expect(tabs()).toEqual(['System', 'Beta'])
  // Alpha had no tab to its right, so its left neighbour takes over.
  expect(activeTab()).toBe('Beta')
  expect(at()).toBe('/projects/p2/sessions')
  expect(problems).toEqual([])
})
