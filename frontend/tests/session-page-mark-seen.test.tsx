// SessionPage marking an unchecked result as seen (`POST /sessions/{id}/seen`,
// `useMarkSessionSeen` in hooks/use-sessions.ts):
//
//   - an `unchecked: true` session on a visible page sends the POST exactly
//     once, with this session's id;
//   - no second call while the first is in flight — not when the session row
//     is refetched, not on a `visibilitychange`;
//   - a hidden document sends nothing until a `visibilitychange` makes it
//     visible;
//   - `unchecked: false` sends nothing at all;
//   - on success, the session cache holds the returned DTO, and the overview
//     (every window) and *that* project's sessions list are invalidated.
//
// Rendered the way tests/session-page-header.test.tsx renders it: the real
// `SessionPage`, real hooks and query client, the generated clients mocked
// per-file through ./mock-module, a minimal memory router, and a private
// `cimode` i18n instance.
//
// `document.visibilityState` is overridden per test with a configurable
// getter and restored afterwards; `visibilitychange` is dispatched by hand.

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

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-09-04T10:00:00.000Z'
const SETTLED = '2026-09-04T11:00:00.000Z'

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'A session',
  status: 'completed',
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
  settledAt: SETTLED,
  seenAt: null,
  unchecked: true,
  createdAt: T,
  updatedAt: T,
  ...overrides,
})

/** What GET /sessions/s1 answers right now. */
let currentSession = session()
/** When set, GET /sessions/s1 waits on it, then answers whatever `currentSession` was at call time. */
let getGate: Promise<void> | null = null
let getCalls = 0

/** Every POST /sessions/{id}/seen, by id. */
let seenCalls: string[] = []
/** When set, the seen client waits on this before answering. */
let seenGate: Promise<void> | null = null
let seenReject: unknown = null
/** The DTO the seen client answers with. */
let seenAnswer: SessionDto = session({ unchecked: false, seenAt: '2026-09-04T12:00:00.000Z' })

await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async () => {
    getCalls++
    const snapshot = currentSession
    if (getGate) await getGate
    return { data: snapshot }
  },
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdSeen', () => ({
  postApiSessionsIdSeen: async (opts: { path: { id: string } }) => {
    seenCalls.push(opts.path.id)
    if (seenGate) await seenGate
    if (seenReject) throw seenReject
    return { data: seenAnswer }
  },
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

const { SessionPage } = await import('../src/features/sessions/components/session-page')
const { getApiSessionsIdQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)
const { getApiSessionsOverviewQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsOverview'
)
const { getApiProjectsIdSessionsQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiProjectsIdSessions'
)

const SESSION_KEY = getApiSessionsIdQueryKey({ path: { id: 's1' } })
const OVERVIEW_1D = getApiSessionsOverviewQueryKey({ query: { window: '1d' } })
const OVERVIEW_7D = getApiSessionsOverviewQueryKey({ query: { window: '7d' } })
const P1_SESSIONS = getApiProjectsIdSessionsQueryKey({ path: { id: 'p1' } })
const P2_SESSIONS = getApiProjectsIdSessionsQueryKey({ path: { id: 'p2' } })

let container: HTMLDivElement
let client: QueryClient
let root: Root
let store: ReturnType<typeof createStore>

const realVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
let visibility: 'visible' | 'hidden' = 'visible'
const setVisibility = async (state: 'visible' | 'hidden', dispatch = true) => {
  visibility = state
  if (dispatch) {
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
}

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** A promise plus the function that resolves it. */
const gate = () => {
  let open: () => void = () => {}
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded, unobserved: the invalidation assertions read their state.
  const overview = { running: [], unchecked: [], recent: [], window: '1d' }
  client.setQueryData(OVERVIEW_1D, overview)
  client.setQueryData(OVERVIEW_7D, { ...overview, window: '7d' })
  client.setQueryData(P1_SESSIONS, [])
  client.setQueryData(P2_SESSIONS, [])
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
  // Either title: a successful POST may already have swapped the row for
  // `seenAnswer` by the time the page is checked.
  const shown = container.textContent ?? ''
  if (!shown.includes(currentSession.title ?? '') && !shown.includes(seenAnswer.title ?? '')) {
    throw new Error('session page never rendered its title')
  }
}

/** Refetches the session row the way a stream `status` event does. */
const refetchSession = async () => {
  await act(async () => {
    void client.invalidateQueries({ queryKey: SESSION_KEY })
  })
}

beforeEach(() => {
  currentSession = session()
  getGate = null
  getCalls = 0
  seenCalls = []
  seenGate = null
  seenReject = null
  seenAnswer = session({ unchecked: false, seenAt: '2026-09-04T12:00:00.000Z' })
  store = createStore()
  localStorage.clear()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  if (realVisibility) Object.defineProperty(document, 'visibilityState', realVisibility)
  else delete (document as { visibilityState?: unknown }).visibilityState
  document.body.replaceChildren()
})

// ── sends once ──────────────────────────────────────────────────────────────

test('an unchecked session on a visible page is marked seen exactly once', async () => {
  await mount()
  expect(seenCalls).toEqual(['s1'])
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

test('a session that becomes unchecked while visible (stream refetch) is marked seen once', async () => {
  currentSession = session({ unchecked: false, status: 'running', settledAt: null })
  await mount()
  expect(seenCalls).toEqual([])

  currentSession = session({ unchecked: true })
  await refetchSession()
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

// ── no duplicate in-flight calls ────────────────────────────────────────────

test('refetching the session row while the POST is pending sends no second POST', async () => {
  const held = gate()
  seenGate = held.promise
  await mount()
  expect(seenCalls).toEqual(['s1'])

  // The server still says unchecked (the POST has not landed yet).
  const before = getCalls
  await refetchSession()
  await settle()
  await refetchSession()
  await settle()
  expect(getCalls).toBeGreaterThan(before)
  expect(seenCalls).toEqual(['s1'])

  await act(async () => {
    held.open()
  })
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

test('a visibilitychange while the POST is pending sends no second POST', async () => {
  const held = gate()
  seenGate = held.promise
  await mount()
  expect(seenCalls).toEqual(['s1'])

  await setVisibility('hidden')
  await setVisibility('visible')
  await setVisibility('visible')
  await settle()
  expect(seenCalls).toEqual(['s1'])

  await act(async () => {
    held.open()
  })
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

test('a refetch started while the POST is pending, landing after it with stale unchecked:true, sends no second POST', async () => {
  // The race the "no duplicates even if refetched while pending" rule is
  // about: GET issued before the server applied the seen write (so it still
  // reads unchecked: true), but its response lands after the POST's own.
  const post = gate()
  seenGate = post.promise
  await mount()
  expect(seenCalls).toEqual(['s1'])

  const get = gate()
  getGate = get.promise
  await refetchSession() // in flight, snapshot unchecked: true
  await settle(2)

  await act(async () => {
    post.open() // POST succeeds → cache takes seenAnswer (unchecked: false)
  })
  await settle()
  expect((client.getQueryData(SESSION_KEY) as SessionDto | undefined)?.unchecked).toBe(false)

  await act(async () => {
    get.open() // the stale GET lands: unchecked: true again
  })
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

// ── hidden ──────────────────────────────────────────────────────────────────

test('a hidden document sends nothing until a visibilitychange makes it visible', async () => {
  visibility = 'hidden'
  await mount()
  await settle()
  expect(seenCalls).toEqual([])

  // Still hidden: an event alone is not enough.
  await setVisibility('hidden')
  await settle()
  expect(seenCalls).toEqual([])

  await setVisibility('visible')
  await settle()
  expect(seenCalls).toEqual(['s1'])

  // And only once, however many more times it becomes visible.
  await setVisibility('hidden')
  await setVisibility('visible')
  await settle()
  expect(seenCalls).toEqual(['s1'])
})

// ── not unchecked ───────────────────────────────────────────────────────────

test('unchecked: false sends nothing, on mount or on visibilitychange', async () => {
  currentSession = session({ unchecked: false, seenAt: SETTLED })
  await mount()
  await setVisibility('hidden')
  await setVisibility('visible')
  await refetchSession()
  await settle()
  expect(seenCalls).toEqual([])
})

// ── on success ──────────────────────────────────────────────────────────────

test('on success the session cache takes the returned DTO', async () => {
  seenAnswer = session({
    unchecked: false,
    seenAt: '2026-09-04T12:34:56.000Z',
    title: 'Title from the seen response',
  })
  await mount()
  await settle()
  expect(client.getQueryData(SESSION_KEY)).toEqual(seenAnswer)
  expect(container.textContent).toContain('Title from the seen response')
})

test("on success the overview (every window) and that project's sessions list are invalidated", async () => {
  await mount()
  await settle()
  expect(seenCalls).toEqual(['s1'])
  expect(client.getQueryState(OVERVIEW_1D)?.isInvalidated).toBe(true)
  expect(client.getQueryState(OVERVIEW_7D)?.isInvalidated).toBe(true)
  expect(client.getQueryState(P1_SESSIONS)?.isInvalidated).toBe(true)
  // Another project's list is left alone.
  expect(client.getQueryState(P2_SESSIONS)?.isInvalidated).toBe(false)
})

test('nothing is invalidated before the POST succeeds', async () => {
  const held = gate()
  seenGate = held.promise
  await mount()
  expect(seenCalls).toEqual(['s1'])
  expect(client.getQueryState(OVERVIEW_1D)?.isInvalidated).toBe(false)
  expect(client.getQueryState(P1_SESSIONS)?.isInvalidated).toBe(false)
  await act(async () => {
    held.open()
  })
  await settle()
  expect(client.getQueryState(OVERVIEW_1D)?.isInvalidated).toBe(true)
})
