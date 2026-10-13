// The project Sessions page's table, grouped by last activity
// (features/sessions/components/sessions-table.tsx over
// features/sessions/lib/session-groups.ts and the DataTable `groupBy` prop):
//
//   - rows sorted by `lastMessageAt ?? createdAt`, whatever order the API
//     answered in, under Today / Yesterday / "Oct 7"-style day / Older
//     headings — each a `th[scope=rowgroup]` spanning all four columns;
//   - the "Last updated" column shows only the time under Today, Yesterday
//     and a day heading, the full date and time under Older, with the full
//     date and time in a `title` on an inner span either way;
//   - search filters first, so a heading whose sessions all failed the
//     search goes too, and nothing matching says so;
//   - the Russian bundle's headings, column header and date order.
//
// Timestamps are built relative to the real clock (local day starts, not
// "now minus N hours"), or are years in the past for Older, so the expected
// headings stay right on any day the suite runs — except within the few
// milliseconds around local midnight between building the fixture and
// rendering it.
//
// Mounted through the real router and the app's own i18n singleton, the way
// tests/project-sessions-page.test.tsx mounts the same page; only the
// generated clients are mocked. Expected labels are literals (month tables
// below), not re-derived through the formatter under test. Assertions compare
// primitives, never DOM nodes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session } from '../src/features/sessions/hooks/use-sessions'
import { mockModule } from './mock-module'

const LIST_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'
const DELETE_CLIENT = '@/shared/api/generated/clients/deleteApiSessionsId'

let sessions: Session[] = []

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({ data: sessions }),
}))
await mockModule(DELETE_CLIENT, () => ({
  deleteApiSessionsId: async () => ({ data: { ok: true } }),
}))

const { routeTree } = await import('../src/app/router')
const { i18n } = await import('../src/shared/i18n')

afterAll(async () => {
  // The app's i18n singleton is shared with every later file in this process.
  await i18n.changeLanguage('en')
})

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  automationId: null,
  title: 'A session',
  status: 'idle',
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
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
  lastMessageAt: null,
  ...overrides,
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
  path: '/srv/alpha',
  createdAt: '',
  updatedAt: '',
}

// --- literal expectations ------------------------------------------------------

const EN_MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
// date-fns 4's Russian *formatting* (genitive) abbreviations.
const RU_MONTHS = 'янв. фев. мар. апр. мая июн. июл. авг. сент. окт. нояб. дек.'.split(' ')
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const enFull = (d: Date) =>
  `${EN_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hhmm(d)}`
const ruFull = (d: Date) =>
  `${d.getDate()} ${RU_MONTHS[d.getMonth()]} ${d.getFullYear()} г., ${hhmm(d)}`
const enDay = (d: Date) => `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`
const ruDay = (d: Date) => `${d.getDate()} ${RU_MONTHS[d.getMonth()]}`

/** A fixture whose groups are fixed relative to the real local day. */
function mixedFixture() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const startOfToday = new Date(y, m, d)
  // Strictly between local midnight and now: always today, never the future.
  const todayLate = new Date(
    startOfToday.getTime() + Math.floor((now.getTime() - startOfToday.getTime()) / 2),
  )
  const at = {
    todayLate,
    todayMidnight: startOfToday,
    yesterday: new Date(y, m, d - 1, 12, 0),
    threeDaysAgo: new Date(y, m, d - 3, 9, 15),
    olderSpoke: new Date(2020, 2, 14, 8, 5),
    olderCreated: new Date(2019, 6, 1, 17, 40),
  }
  // Deliberately not in display order — the table sorts for itself.
  const list = [
    session({
      id: 'older-created',
      title: 'Alpha archive',
      createdAt: at.olderCreated.toISOString(),
    }),
    session({
      id: 'yesterday',
      title: 'Bravo yesterday',
      createdAt: '2019-01-01T00:00:00.000Z',
      lastMessageAt: at.yesterday.toISOString(),
    }),
    session({
      id: 'today-midnight',
      title: 'Charlie midnight',
      createdAt: at.todayMidnight.toISOString(),
    }),
    session({
      id: 'older-spoke',
      title: 'Delta older',
      createdAt: '2018-01-01T00:00:00.000Z',
      lastMessageAt: at.olderSpoke.toISOString(),
    }),
    session({
      id: 'three-days',
      title: 'Echo three days',
      createdAt: at.threeDaysAgo.toISOString(),
    }),
    session({
      // Created years ago, spoke today: grouped by its last message.
      id: 'today-late',
      title: 'Alpha today',
      createdAt: '2017-05-05T00:00:00.000Z',
      lastMessageAt: at.todayLate.toISOString(),
    }),
  ]
  return { at, list }
}

// --- mounting ------------------------------------------------------------------

let container: HTMLDivElement
let client: QueryClient
let root: Root

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/sessions'] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/library/agents' }], [])
  root = createRoot(container)
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
  if (!table()) throw new Error('sessions table never rendered')
}

beforeEach(async () => {
  localStorage.clear()
  sessions = []
  await i18n.changeLanguage('en')
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  document.body.replaceChildren()
})

// --- reading the table -----------------------------------------------------------

const main = () => {
  const m = container.querySelector('main')
  if (!m) throw new Error('no <main>')
  return m as HTMLElement
}
const table = () => container.querySelector('main table')
const headerTexts = () =>
  [...(table()?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent?.trim() ?? '')

/** Each group as [heading, [titles in it]], in display order. */
const groups = () =>
  [...(table()?.querySelectorAll('tbody') ?? [])].map((tbody) => [
    tbody.querySelector('th[scope="rowgroup"]')?.textContent ?? null,
    [...tbody.querySelectorAll('tr')]
      .map((tr) => tr.querySelector('td a')?.textContent ?? null)
      .filter((t): t is string => t !== null),
  ])
const headings = () => groups().map(([h]) => h)

/** The Last-updated cell of the row titled `title`: its text and its span's title. */
const updatedCell = (title: string) => {
  const row = [...(table()?.querySelectorAll('tbody tr') ?? [])].find(
    (tr) => tr.querySelector('td a')?.textContent === title,
  )
  if (!row) throw new Error(`no row titled ${JSON.stringify(title)}`)
  const cell = row.querySelectorAll('td')[1]
  return {
    text: cell?.textContent?.trim() ?? '',
    title: cell?.querySelector('span[title]')?.getAttribute('title') ?? null,
  }
}

const searchInput = () => {
  const el = main().querySelector('input[type="search"], input[placeholder]')
  if (!el) throw new Error('no search input')
  return el as HTMLInputElement
}
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(2)
}

// --- tests -------------------------------------------------------------------------

test('a mixed list: headings in order, sessions under the right one, newest first', async () => {
  const { at, list } = mixedFixture()
  sessions = list
  await mount()
  expect(groups()).toEqual([
    ['Today', ['Alpha today', 'Charlie midnight']],
    ['Yesterday', ['Bravo yesterday']],
    [enDay(at.threeDaysAgo), ['Echo three days']],
    ['Older', ['Delta older', 'Alpha archive']],
  ])
})

test('each heading is one th[scope=rowgroup] spanning all four columns', async () => {
  sessions = mixedFixture().list
  await mount()
  const ths = [...(table()?.querySelectorAll('tbody th') ?? [])]
  expect(ths.length).toBe(4)
  for (const th of ths) {
    expect(th.getAttribute('scope')).toBe('rowgroup')
    expect(th.getAttribute('colspan')).toBe('4')
  }
})

test('the column header reads "Last updated"', async () => {
  sessions = mixedFixture().list
  await mount()
  expect(headerTexts()).toEqual(['Title', 'Last updated', 'Status', ''])
})

test('Last updated: time only under Today, Yesterday and a day; full date-time under Older', async () => {
  const { at, list } = mixedFixture()
  sessions = list
  await mount()
  expect(updatedCell('Alpha today')).toEqual({
    text: hhmm(at.todayLate),
    title: enFull(at.todayLate),
  })
  expect(updatedCell('Charlie midnight')).toEqual({
    text: '00:00',
    title: enFull(at.todayMidnight),
  })
  expect(updatedCell('Bravo yesterday')).toEqual({ text: '12:00', title: enFull(at.yesterday) })
  expect(updatedCell('Echo three days')).toEqual({
    text: '09:15',
    title: enFull(at.threeDaysAgo),
  })
  expect(updatedCell('Delta older')).toEqual({
    text: 'Mar 14, 2020, 08:05',
    title: 'Mar 14, 2020, 08:05',
  })
  // No messages: the cell is its createdAt.
  expect(updatedCell('Alpha archive')).toEqual({
    text: 'Jul 1, 2019, 17:40',
    title: 'Jul 1, 2019, 17:40',
  })
})

test('search filters first: a group whose sessions all fail it loses its heading', async () => {
  sessions = mixedFixture().list
  await mount()
  await type(searchInput(), 'alpha')
  expect(groups()).toEqual([
    ['Today', ['Alpha today']],
    ['Older', ['Alpha archive']],
  ])
  // Clearing it brings every group back.
  await type(searchInput(), '')
  expect(headings().length).toBe(4)
})

test('search leaving one group: only that heading', async () => {
  sessions = mixedFixture().list
  await mount()
  await type(searchInput(), 'bravo')
  expect(groups()).toEqual([['Yesterday', ['Bravo yesterday']]])
})

test('nothing matches: no headings, no rows, and the no-matches message', async () => {
  sessions = mixedFixture().list
  await mount()
  expect(main().textContent).not.toContain('No sessions match your search.')
  await type(searchInput(), 'zzz-nothing')
  expect(table()?.querySelectorAll('th[scope="rowgroup"]').length).toBe(0)
  expect(table()?.querySelectorAll('tbody a').length).toBe(0)
  expect(main().textContent).toContain('No sessions match your search.')
})

test('in Russian: Сегодня / Вчера / day-first label / Ранее, "Обновлено", Russian dates', async () => {
  await i18n.changeLanguage('ru')
  const { at, list } = mixedFixture()
  sessions = list
  await mount()
  expect(headings()).toEqual(['Сегодня', 'Вчера', ruDay(at.threeDaysAgo), 'Ранее'])
  expect(headerTexts()[1]).toBe('Обновлено')
  expect(updatedCell('Delta older')).toEqual({
    text: '14 мар. 2020 г., 08:05',
    title: '14 мар. 2020 г., 08:05',
  })
  expect(updatedCell('Echo three days')).toEqual({
    text: '09:15',
    title: ruFull(at.threeDaysAgo),
  })
  await type(searchInput(), 'zzz-nothing')
  expect(main().textContent).toContain('Ничего не найдено.')
})
