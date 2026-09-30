// The System tab's Sessions dashboard (`/sessions`, SessionsDashboardPage) and
// the System tab's own entry points to it:
//
//   - `/` lands on `/sessions`; the system sidebar's first item is Sessions,
//     and its brand link points at `/sessions` too;
//   - three sections in order — Running, Unchecked results, Recent — each with
//     its count in the heading and a one-line empty state when empty;
//   - rows link to the session, show title (untitled fallback), project name,
//     status and a time column: `updatedAt` for Running/Recent, `settledAt`
//     for Unchecked;
//   - Recent's 1d/3d/7d toggle: default 1d, a click refetches with that
//     `window`, re-clicking the pressed item keeps it pressed, and switching
//     keeps the old rows on screen (no loading flash) while the new ones load;
//   - the overview polls every 5s while the document is visible, and not
//     while it is hidden;
//   - clicking a row for a project with no open tab adopts one at the session
//     URL; with the tab already open, it is reused rather than duplicated.
//
// Mounted through the real router, the same way tests/workspace.test.tsx
// mounts the shell, so the sidebar, the tab row and the row links are the
// real ones. Only the overview client is mocked (./mock-module); everything
// the shell itself needs is seeded into the cache with an infinite
// staleTime. The session page a row click lands on has its three clients
// mocked too, so following a link never reaches for a backend.
//
// Assertions compare primitives, never DOM nodes — see workspace.test.tsx's
// `ref` for why a failing matcher on a happy-dom element is an OOM.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GetApiSessionsOverviewStatus200 as Overview } from '../src/shared/api/generated/types/GetApiSessionsOverview'
import type { OverviewSession } from '../src/shared/api/generated/types/OverviewSession'
import { mockModule } from './mock-module'

const OVERVIEW_CLIENT = '@/shared/api/generated/clients/getApiSessionsOverview'
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'

type Window = '1d' | '3d' | '7d'

const T_UPDATED = '2026-09-20T08:15:00.000Z'
const T_SETTLED = '2026-09-12T21:40:00.000Z'

const row = (overrides: Partial<OverviewSession> = {}): OverviewSession => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  projectId: 'p1',
  ideaId: null,
  title: 'A session',
  status: 'running',
  orchestrator: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/alpha',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  settledAt: null,
  seenAt: null,
  unchecked: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: T_UPDATED,
  projectName: 'Alpha',
  ...overrides,
})

const empty = (window: Window): Overview => ({ running: [], unchecked: [], recent: [], window })

/** What the mocked server answers, per window. */
let answers: Record<Window, Overview>
/** Every `window` the page asked for, in order. `undefined` = no query param. */
let calls: (string | undefined)[] = []
/** When set for a window, that window's request waits on it before answering. */
let gates: Partial<Record<Window, Promise<void>>> = {}

await mockModule(OVERVIEW_CLIENT, () => ({
  getApiSessionsOverview: async (opts: { query?: { window?: Window } }) => {
    const window = opts?.query?.window
    calls.push(window)
    const gate = window ? gates[window] : undefined
    if (gate) await gate
    return { data: answers[window ?? '1d'] }
  },
}))

// The session page a row click lands on — never under test here, only
// mounted, so it answers something plausible rather than reaching a backend.
await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: { ...row({ id: opts.path.id, status: 'idle' }), projectName: undefined },
  }),
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))

/** happy-dom ships no EventSource — see tests/session-page-scroll.test.tsx. */
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
const { formatDateTime } = await import('../src/features/sessions/lib/format')

const project = (id: string, name: string) => ({
  id, name, slug: name.toLowerCase(), source: 'clone', remoteUrl: null, sourceName: null,
  sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null, recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`, createdAt: '', updatedAt: '',
})
const PROJECTS = [project('p1', 'Alpha'), project('p2', 'Beta')]

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
const roots: Root[] = []

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

async function mount(path = '/sessions') {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    // Not an infinite staleTime for the overview — it is the query under
    // test, and it must actually be fetched. Everything else is seeded.
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  for (const p of PROJECTS) {
    client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: p.id } }], [])
  }
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
const main = () => container.querySelector('main') as HTMLElement
const sidebar = () => container.querySelector('[data-slot="sidebar"]')
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const headings = () => [...main().querySelectorAll('h2')].map(text)
/** The Card holding the section whose h2 starts with `prefix`. */
const section = (prefix: string) => {
  const h = [...main().querySelectorAll('h2')].find((el) => text(el).startsWith(prefix))
  if (!h) throw new Error(`no section "${prefix}" (have: ${headings().join(' | ')})`)
  const card = h.closest('[data-slot="card"]')
  if (!card) throw new Error(`section "${prefix}" is not inside a card`)
  return card as HTMLElement
}
/** Each body row of a section's table, as its cells' text. */
const rows = (prefix: string) =>
  [...section(prefix).querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map(text),
  )
const rowLinks = (prefix: string) =>
  [...section(prefix).querySelectorAll('tbody a')].map((a) => a.getAttribute('href'))
const windowButton = (label: string) => {
  const b = [...section('Recent').querySelectorAll('button')].find((el) => text(el) === label)
  if (!b) throw new Error(`no window button "${label}"`)
  return b as HTMLButtonElement
}
const pressed = () =>
  [...section('Recent').querySelectorAll('button')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map(text)
const loadingShown = () => main().querySelector('[role="status"]') !== null
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

const realVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  localStorage.clear()
  problems.length = 0
  document.body.innerHTML = ''
  calls = []
  gates = {}
  answers = { '1d': empty('1d'), '3d': empty('3d'), '7d': empty('7d') }
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  if (realVisibility) Object.defineProperty(document, 'visibilityState', realVisibility)
  else delete (document as { visibilityState?: unknown }).visibilityState
  document.body.innerHTML = ''
  client?.clear()
})

// ── rule 5: the System tab lands here ───────────────────────────────────────

test('`/` redirects to /sessions and renders the dashboard in the System tab', async () => {
  await mount('/')
  expect(at()).toBe('/sessions')
  expect(tabs()).toEqual(['System'])
  expect(activeTab()).toBe('System')
  expect(headings()).toEqual(['Running (0)', 'Unchecked results (0)', 'Recent (0)'])
  expect(problems).toEqual([])
})

test('the system sidebar lists Sessions first, and its brand link goes to /sessions', async () => {
  await mount('/library')
  const links = [...(sidebar()?.querySelectorAll('a') ?? [])]
  const header = sidebar()?.querySelector('[data-slot="sidebar-header"] a')
  expect(header?.getAttribute('href')).toBe('/sessions')
  const menu = [...(sidebar()?.querySelectorAll('[data-slot="sidebar-content"] a') ?? [])]
  expect(menu.map((a) => a.getAttribute('href'))[0]).toBe('/sessions')
  expect(text(menu[0])).toBe('Sessions')
  // The brand link plus nine menu items — the existing ones kept, after
  // Sessions, with Docker between Sessions and Library and Ports and Usage
  // between Storage and Prompts.
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    '/sessions',
    '/sessions',
    '/docker',
    '/library',
    '/ssh-keys',
    '/storage',
    '/ports',
    '/usage',
    '/prompts/idea-to-prompt',
    '/settings',
  ])
})

test('the Sessions item is the current one on /sessions', async () => {
  await mount('/sessions')
  const current = [
    ...(sidebar()?.querySelectorAll('[data-slot="sidebar-content"] a[aria-current="page"]') ?? []),
  ].map((a) => a.getAttribute('href'))
  expect(current).toEqual(['/sessions'])
})

// ── rule 6: sections, rows, time columns ────────────────────────────────────

test('first load asks for window=1d', async () => {
  await mount()
  expect(calls).toEqual(['1d'])
})

test('three sections in order, each with its count and its own empty line', async () => {
  await mount()
  expect(headings()).toEqual(['Running (0)', 'Unchecked results (0)', 'Recent (0)'])
  expect(text(section('Running').querySelector('p'))).toBe('Nothing running right now.')
  expect(text(section('Unchecked').querySelector('p'))).toBe('Nothing waiting on you.')
  expect(text(section('Recent').querySelector('p'))).toBe('No activity in this window.')
  // An empty section draws no table at all.
  expect(main().querySelectorAll('table')).toHaveLength(0)
})

test('only the empty section shows its empty line; the others show a table', async () => {
  answers['1d'] = {
    running: [row({ id: 'r1', title: 'Running one' })],
    unchecked: [],
    recent: [row({ id: 'r1', title: 'Running one' }), row({ id: 'r2', title: 'Other' })],
    window: '1d',
  }
  await mount()
  expect(headings()).toEqual(['Running (1)', 'Unchecked results (0)', 'Recent (2)'])
  expect(section('Running').querySelectorAll('table')).toHaveLength(1)
  expect(section('Running').textContent).not.toContain('Nothing running right now.')
  expect(section('Unchecked').querySelectorAll('table')).toHaveLength(0)
  expect(text(section('Unchecked').querySelector('p'))).toBe('Nothing waiting on you.')
  expect(section('Recent').querySelectorAll('tbody tr')).toHaveLength(2)
})

test('a row shows title, project, status and the section time; links to the session', async () => {
  const s = row({
    id: 'bbbbbbbb-1111-0000-0000-000000000002',
    projectId: 'p2',
    projectName: 'Beta',
    title: 'Fix the flaky build',
    status: 'completed',
    settledAt: T_SETTLED,
    updatedAt: T_UPDATED,
    unchecked: true,
  })
  answers['1d'] = { running: [], unchecked: [s], recent: [s], window: '1d' }
  await mount()

  // Unchecked reads settledAt …
  expect(rows('Unchecked')).toEqual([
    ['Fix the flaky build', 'Beta', 'Completed', formatDateTime(T_SETTLED)],
  ])
  // … Recent reads updatedAt, for the very same session.
  expect(rows('Recent')).toEqual([
    ['Fix the flaky build', 'Beta', 'Completed', formatDateTime(T_UPDATED)],
  ])
  const href = `/projects/p2/sessions/${s.id}`
  expect(rowLinks('Unchecked')).toEqual([href])
  expect(rowLinks('Recent')).toEqual([href])
  // The two timestamps really are different, so the assertion above can fail.
  expect(formatDateTime(T_SETTLED)).not.toBe(formatDateTime(T_UPDATED))
})

test('Running reads updatedAt, not settledAt', async () => {
  const s = row({ id: 'r1', title: 'Busy', status: 'running', settledAt: T_SETTLED })
  answers['1d'] = { ...empty('1d'), running: [s] }
  await mount()
  expect(rows('Running')).toEqual([['Busy', 'Alpha', 'Running', formatDateTime(T_UPDATED)]])
})

test('an untitled session falls back to the untitled label, still linked', async () => {
  const s = row({ id: 'cafebabe-9999-0000-0000-000000000000', title: null, status: 'queued' })
  answers['1d'] = { ...empty('1d'), running: [s] }
  await mount()
  const [cells] = rows('Running')
  // en.json's `sessions.untitled` is "Session {{id}}", with the id's first 8 chars.
  expect(cells?.[0]).toBe('Session cafebabe')
  expect(rowLinks('Running')).toEqual([`/projects/p1/sessions/${s.id}`])
})

// ── rule 7: the window toggle ───────────────────────────────────────────────

test('the toggle offers 1d/3d/7d with 1d pressed by default', async () => {
  await mount()
  const labels = [...section('Recent').querySelectorAll('button')].map(text)
  expect(labels).toEqual(['1 day', '3 days', '7 days'])
  expect(pressed()).toEqual(['1 day'])
})

test('clicking a window refetches with that window and presses it', async () => {
  answers['3d'] = { ...empty('3d'), recent: [row({ id: 'x3', title: 'From three days' })] }
  await mount()
  await click(windowButton('3 days'))
  expect(calls).toEqual(['1d', '3d'])
  expect(pressed()).toEqual(['3 days'])
  expect(rows('Recent').map((r) => r[0])).toEqual(['From three days'])

  await click(windowButton('7 days'))
  expect(calls).toEqual(['1d', '3d', '7d'])
  expect(pressed()).toEqual(['7 days'])
})

test('clicking the already-pressed window leaves it pressed and fetches nothing new', async () => {
  await mount()
  await click(windowButton('1 day'))
  expect(pressed()).toEqual(['1 day'])
  expect(calls).toEqual(['1d'])

  await click(windowButton('3 days'))
  await click(windowButton('3 days'))
  expect(pressed()).toEqual(['3 days'])
  expect(calls).toEqual(['1d', '3d'])
})

test('switching windows keeps the previous rows on screen, with no loading flash', async () => {
  answers['1d'] = { ...empty('1d'), recent: [row({ id: 'old', title: 'Yesterday' })] }
  answers['3d'] = { ...empty('3d'), recent: [row({ id: 'new', title: 'Three days ago' })] }
  let release: () => void = () => {}
  gates['3d'] = new Promise<void>((r) => {
    release = r
  })
  await mount()
  expect(rows('Recent').map((r) => r[0])).toEqual(['Yesterday'])

  await click(windowButton('3 days'))
  // The 3d request is in flight and held.
  expect(calls).toEqual(['1d', '3d'])
  expect(loadingShown()).toBe(false)
  expect(headings()).toEqual(['Running (0)', 'Unchecked results (0)', 'Recent (1)'])
  expect(rows('Recent').map((r) => r[0])).toEqual(['Yesterday'])
  expect(pressed()).toEqual(['3 days'])

  await act(async () => {
    release()
  })
  await settle()
  expect(rows('Recent').map((r) => r[0])).toEqual(['Three days ago'])
})

// ── rule 7: polling ─────────────────────────────────────────────────────────

test('the overview polls every 5s while visible, and not while hidden', async () => {
  // Real time: the refetch interval is what query-core actually schedules, so
  // it is watched firing rather than read off an option. Hidden is checked
  // first (and the timer given a full period plus slack), then visible.
  setVisibility('visible')
  await mount()
  expect(calls).toEqual(['1d'])
  const q = client.getQueryCache().find({ queryKey: [{ url: '/api/sessions/overview' }, { window: '1d' }] })
  const observer = q?.observers[0]
  expect(observer?.options.refetchInterval).toBe(5000)
  expect(observer?.options.refetchIntervalInBackground).toBe(false)

  setVisibility('hidden')
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5600))
  })
  await settle()
  expect(calls).toEqual(['1d'])

  // Visible again: the focus refetch may fire at once; after that the
  // interval keeps asking on its own.
  setVisibility('visible')
  await settle()
  const afterRefocus = calls.length
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5600))
  })
  await settle()
  expect(calls.length).toBeGreaterThan(afterRefocus)
  expect(new Set(calls)).toEqual(new Set(['1d']))
}, 20000)

// ── rule 8: a row click opens (or reuses) that project's tab ─────────────────

test('clicking a row for a project with no tab open adopts one at the session URL', async () => {
  const s = row({ id: 'dddddddd-0000-0000-0000-000000000004', projectId: 'p2', projectName: 'Beta', title: 'In Beta' })
  answers['1d'] = { ...empty('1d'), recent: [s] }
  await mount()
  expect(tabs()).toEqual(['System'])

  await click(section('Recent').querySelector('tbody a'), 'Beta row link')
  expect(at()).toBe(`/projects/p2/sessions/${s.id}`)
  expect(tabs()).toEqual(['System', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(problems).toEqual([])
})

test('clicking a row for a project whose tab is open reuses that tab', async () => {
  const s = row({ id: 'eeeeeeee-0000-0000-0000-000000000005', projectId: 'p1', projectName: 'Alpha', title: 'In Alpha' })
  answers['1d'] = { ...empty('1d'), recent: [s] }
  // Opens Alpha's tab by landing on it (a seeded page, so nothing is fetched),
  // then goes back to the System tab.
  await mount('/projects/p1/sessions')
  expect(tabs()).toEqual(['System', 'Alpha'])
  await click(tabButtons().find((b) => b.textContent?.trim() === 'System'), 'System tab')
  await click(
    [...(sidebar()?.querySelectorAll('a') ?? [])].find((a) => text(a) === 'Sessions'),
    'Sessions nav link',
  )
  expect(at()).toBe('/sessions')

  await click(section('Recent').querySelector('tbody a'), 'Alpha row link')
  expect(at()).toBe(`/projects/p1/sessions/${s.id}`)
  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(activeTab()).toBe('Alpha')
  expect(problems).toEqual([])
})
