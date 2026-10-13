// The session page's details popover gains an always-present "Created" row
// (session-page.tsx's `detailItems`), showing the session's createdAt through
// shared/lib/date.ts's formatDateTime in the reader's language, placed
// immediately before "Cost".
//
// tests/session-page-header.test.tsx already walks the popover's row set under
// a `cimode` instance (bare keys, and an expected value computed through the
// same formatDateTime). This file renders it with the real en and ru bundles
// and compares against literal strings, so it pins the visible term, the
// visible value, and that the value follows the UI language.
//
// Mounted the way session-page-header.test.tsx mounts SessionPage: real
// hooks and query client, generated clients mocked per file, a minimal memory
// router around it. Assertions compare primitives, never DOM nodes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { composerModeAtom } from '../src/shared/store/ui'
import { mockModule } from './mock-module'

// Never `.use(initReactI18next)` — see tests/session-page-scroll.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en }, ru: { translation: ru } },
  interpolation: { escapeValue: false },
})

/** 28 Sep 2026 14:32 local time, so the expected strings hold under any TZ. */
const CREATED = new Date(2026, 8, 28, 14, 32).toISOString()

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
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
  automationId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  lastMessageAt: null,
  ...overrides,
})

let currentSession = session()

await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async () => ({ data: currentSession }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
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

const { SessionPage } = await import('../src/features/sessions/components/session-page')

let container: HTMLDivElement
let client: QueryClient
let root: Root
let store: ReturnType<typeof createStore>

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <SessionPage projectId="p1" sessionId="s1" />,
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  if (!container.textContent?.includes(currentSession.title ?? '')) {
    throw new Error('session page never rendered its title')
  }
}

beforeEach(async () => {
  currentSession = session()
  store = createStore()
  localStorage.clear()
  store.set(composerModeAtom, 'raw')
  await testI18n.changeLanguage('en')
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  document.body.replaceChildren()
})

const popover = () => document.querySelector('[data-slot="popover-content"]')

async function openDetails(label: string) {
  const triggers = [...container.querySelectorAll<HTMLButtonElement>('header button')].filter(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (triggers.length !== 1) throw new Error(`expected one "${label}" trigger`)
  await act(async () => {
    triggers[0]?.click()
  })
  await settle(3)
  const p = popover()
  if (!p) throw new Error('details popover did not open')
  return p
}

const rowsOf = (p: Element) =>
  [...p.querySelectorAll('dl > div')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ])

test('a bare session: "Created" with its formatted date-time, then "Cost"', async () => {
  await mount()
  expect(rowsOf(await openDetails('Session details'))).toEqual([
    ['Created', 'Sep 28, 2026, 14:32'],
    ['Cost', '$0.0000'],
  ])
})

test('a fully-configured session: Created sits immediately before Cost, after the rest', async () => {
  currentSession = session({
    orchestrator: 'claude',
    branch: 'agentoo/s-x',
    isolated: true,
    worktreePath: '/srv/wt/s-x',
    totalCostUsd: 1.5,
  })
  await mount()
  const rows = rowsOf(await openDetails('Session details'))
  const terms = rows.map(([term]) => term)
  expect(terms.slice(-2)).toEqual(['Created', 'Cost'])
  expect(terms.filter((t) => t === 'Created').length).toBe(1)
  expect(terms.indexOf('Created')).toBe(terms.length - 2)
  expect(rows.find(([term]) => term === 'Created')?.[1]).toBe('Sep 28, 2026, 14:32')
})

test('shows createdAt, not updatedAt or lastMessageAt', async () => {
  currentSession = session({
    updatedAt: new Date(2026, 9, 1, 9, 0).toISOString(),
    lastMessageAt: new Date(2026, 9, 2, 10, 0).toISOString(),
  })
  await mount()
  const rows = rowsOf(await openDetails('Session details'))
  expect(rows.find(([term]) => term === 'Created')?.[1]).toBe('Sep 28, 2026, 14:32')
})

test('in Russian: "Создана" with the Russian date, before "Стоимость"', async () => {
  await testI18n.changeLanguage('ru')
  await mount()
  expect(rowsOf(await openDetails('Сведения о сессии'))).toEqual([
    ['Создана', '28 сент. 2026 г., 14:32'],
    ['Стоимость', '$0.0000'],
  ])
})

test('an unparsable createdAt keeps the row, empty, rather than breaking the page', async () => {
  currentSession = session({ createdAt: 'not-a-date' })
  await mount()
  expect(rowsOf(await openDetails('Session details'))).toEqual([
    ['Created', ''],
    ['Cost', '$0.0000'],
  ])
})
