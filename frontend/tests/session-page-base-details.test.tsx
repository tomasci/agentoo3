// The single-session page's "Session details" popover, for the three fields
// the sessions list stopped showing when it became a four-column table:
// Base commit (`baseSha`, abbreviated to 7 characters), Base branch
// (`baseBranch`), and the `baseNote` warning. Each appears only when the
// session actually has it.
//
// Same harness as tests/session-page-header.test.tsx — the real
// `SessionPage` inside a minimal memory router, real hooks and query client,
// the generated clients mocked per-file through ./mock-module, and a private
// `cimode` i18n instance so every label is its bare key. That file pins the
// popover's other rows (orchestrator, branch, worktree, cost) and their exact
// order; this one only asserts presence/absence and values of the new ones,
// so it does not care where in the list they sit.
//
// Assertions compare primitives, never DOM nodes.

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
import { mockModule } from './mock-module'

// Never `.use(initReactI18next)` — see tests/session-page-scroll.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-09-04T10:00:00.000Z'
const SHA = '0123456789abcdef0123456789abcdef01234567'

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
  createdAt: T,
  updatedAt: T,
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
  const rootRoute = createRootRoute({
    component: () => <SessionPage projectId="p1" sessionId="s1" />,
  })
  const router = createRouter({
    routeTree: rootRoute,
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

beforeEach(() => {
  currentSession = session()
  store = createStore()
  localStorage.clear()
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

async function openDetails() {
  expect(popover()).toBeNull()
  const header = container.querySelector('header')
  const trigger = [...(header?.querySelectorAll('button') ?? [])].find(
    (b) => b.getAttribute('aria-label') === 'sessions.details',
  )
  if (!trigger) throw new Error('no details trigger')
  await act(async () => {
    trigger.click()
  })
  await settle(3)
  const p = popover()
  if (!p) throw new Error('details popover did not open')
  return p as HTMLElement
}

/** The popover's rows as a term → description map. */
const rowsOf = (p: Element) =>
  Object.fromEntries(
    [...p.querySelectorAll('dl > div')].map((row) => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]),
  )

test('baseSha set: a Base commit row with the first 7 characters, not the full sha', async () => {
  currentSession = session({ baseSha: SHA })
  await mount()
  const p = await openDetails()
  expect(rowsOf(p)['sessions.meta.baseSha']).toBe('0123456')
  expect(p.textContent ?? '').not.toContain(SHA.slice(0, 8))
})

test('baseBranch set: a Base branch row with the branch name', async () => {
  currentSession = session({ baseBranch: 'release/9' })
  await mount()
  const p = await openDetails()
  expect(rowsOf(p)['sessions.meta.baseBranch']).toBe('release/9')
})

test('both set: both rows, alongside the always-present cost row', async () => {
  currentSession = session({ baseSha: SHA, baseBranch: 'main' })
  await mount()
  const rows = rowsOf(await openDetails())
  expect(rows['sessions.meta.baseSha']).toBe('0123456')
  expect(rows['sessions.meta.baseBranch']).toBe('main')
  expect(rows['sessions.detailsFields.cost']).toBe('$0.0000')
})

test('both null: neither row', async () => {
  currentSession = session({ baseSha: null, baseBranch: null })
  await mount()
  const p = await openDetails()
  expect(Object.keys(rowsOf(p))).toEqual(['sessions.detailsFields.cost'])
  expect(p.textContent ?? '').not.toContain('sessions.meta.baseSha')
  expect(p.textContent ?? '').not.toContain('sessions.meta.baseBranch')
})

test('only one of the two set: only that row', async () => {
  currentSession = session({ baseSha: SHA, baseBranch: null })
  await mount()
  const keys = Object.keys(rowsOf(await openDetails()))
  expect(keys).toContain('sessions.meta.baseSha')
  expect(keys).not.toContain('sessions.meta.baseBranch')
})

test('baseNote set: shown inside the popover, not in the page header', async () => {
  const note = 'Could not fetch origin/main before starting; the worktree may be behind.'
  currentSession = session({ baseNote: note })
  await mount()
  // Popover closed: the note is nowhere on the page.
  expect(document.body.textContent ?? '').not.toContain(note)
  const p = await openDetails()
  expect(p.textContent ?? '').toContain(note)
  expect(container.querySelector('header')?.textContent ?? '').not.toContain(note)
})

test('baseNote null: no note and no alert in the popover', async () => {
  currentSession = session({ baseNote: null, baseSha: SHA, baseBranch: 'main' })
  await mount()
  const p = await openDetails()
  expect(p.querySelectorAll('[role="status"], [role="alert"], [data-slot="alert"]').length).toBe(0)
})
