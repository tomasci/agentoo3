// `useUpdateSession()` (features/sessions/hooks/use-sessions.ts) — no
// arguments since the rename feature, so a caller holding only a session (the
// session page's own title) can use it. On success it:
//
//   - writes the PATCH response into that session's detail query, so the
//     page's heading changes without a refetch — and a detail GET already in
//     flight when the rename lands cannot put the old title back;
//   - invalidates the session list of the project named in the *response*,
//     the sessions overview (every window) and the notifications feed.
//
// A failure writes and invalidates nothing.
//
// Driven the way tests/notification-invalidation.test.tsx drives its hooks:
// a real QueryClient, the generated client mocked per-file through
// ./mock-module, and the seeded queries left unobserved so `isInvalidated`
// is the whole observable — nothing refetches them behind the assertion.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session } from '../src/features/sessions/hooks/use-sessions'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  automationId: null,
  title: 'Old name',
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
  lastMessageAt: null,
  settledAt: null,
  seenAt: null,
  unchecked: false,
  ...overrides,
})

type PatchCall = { path: { id: string }; body: { title?: string } }

let patchCalls: PatchCall[] = []
let patchFailure: unknown = null
/** The project the PATCH response names — deliberately settable apart from
 *  anything the caller passes, to prove the list key comes from the response. */
let responseProjectId = 'p1'
/** When set, the detail GET awaits this before answering. */
let getGate: Promise<void> | null = null
let getAnswer: Session = session()

await mockModule('@/shared/api/generated/clients/patchApiSessionsId', () => ({
  patchApiSessionsId: async (opts: PatchCall) => {
    patchCalls.push({ path: { ...opts.path }, body: { ...opts.body } })
    if (patchFailure) throw patchFailure
    return {
      data: session({ id: opts.path.id, projectId: responseProjectId, title: opts.body.title }),
    }
  },
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async () => {
    const answer = getAnswer
    if (getGate) await getGate
    return { data: answer }
  },
}))

const { useUpdateSession } = await import('../src/features/sessions/hooks/use-sessions')
const { getApiSessionsIdQueryKey, getApiSessionsIdQueryOptions } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)
const { getApiProjectsIdSessionsQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiProjectsIdSessions'
)
const { getApiSessionsOverviewQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsOverview'
)
const { getApiNotificationsQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiNotifications'
)

const DETAIL = getApiSessionsIdQueryKey({ path: { id: 's1' } })
const OTHER_DETAIL = getApiSessionsIdQueryKey({ path: { id: 's2' } })
const LIST_P1 = getApiProjectsIdSessionsQueryKey({ path: { id: 'p1' } })
const LIST_P2 = getApiProjectsIdSessionsQueryKey({ path: { id: 'p2' } })
const OVERVIEW_WEEK = getApiSessionsOverviewQueryKey({ query: { window: '7d' } })
const OVERVIEW_BARE = getApiSessionsOverviewQueryKey()
const FEED = getApiNotificationsQueryKey()

let container: HTMLDivElement
let client: QueryClient
let root: Root | undefined
type Mutate = ReturnType<typeof useUpdateSession>['mutateAsync']
let mutate: Mutate

async function mountHook() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(DETAIL, session())
  client.setQueryData(OTHER_DETAIL, session({ id: 's2', title: 'Untouched' }))
  client.setQueryData(LIST_P1, [session()])
  client.setQueryData(LIST_P2, [])
  client.setQueryData(OVERVIEW_WEEK, { running: [], unchecked: [], recent: [] })
  client.setQueryData(OVERVIEW_BARE, { running: [], unchecked: [], recent: [] })
  client.setQueryData(FEED, { items: [], hasUnread: false, truncated: false })
  let captured: Mutate | null = null
  function Probe() {
    captured = useUpdateSession().mutateAsync
    return null
  }
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  if (!captured) throw new Error('hook never rendered')
  mutate = captured
}

const rename = async (title: string, id = 's1') => {
  let outcome = 'ok' as 'ok' | 'error'
  await act(async () => {
    await mutate({ path: { id }, body: { title } }).catch(() => {
      outcome = 'error'
    })
  })
  return outcome
}

const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? null
const titleAt = (key: readonly unknown[]) =>
  (client.getQueryData(key) as Session | undefined)?.title

beforeEach(async () => {
  patchCalls = []
  patchFailure = null
  responseProjectId = 'p1'
  getGate = null
  getAnswer = session()
  document.body.replaceChildren()
  await mountHook()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  client.clear()
})

test('success writes the response into the session detail cache, leaving other sessions alone', async () => {
  expect(await rename('New name')).toBe('ok')
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'New name' } }])
  expect(titleAt(DETAIL)).toBe('New name')
  // The written value is the response DTO itself, not a patch of the old one.
  expect((client.getQueryData(DETAIL) as Session).projectId).toBe('p1')
  // A write, not an invalidation: nothing would refetch it.
  expect(invalidated(DETAIL)).toBe(false)
  expect(titleAt(OTHER_DETAIL)).toBe('Untouched')
})

test("success invalidates the project's list, every overview window and the notifications feed", async () => {
  await rename('New name')
  expect({
    list: invalidated(LIST_P1),
    overviewWindowed: invalidated(OVERVIEW_WEEK),
    overviewBare: invalidated(OVERVIEW_BARE),
    feed: invalidated(FEED),
  }).toEqual({ list: true, overviewWindowed: true, overviewBare: true, feed: true })
})

test('only the project named in the response has its list invalidated', async () => {
  responseProjectId = 'p2'
  await rename('Moved')
  expect({ p1: invalidated(LIST_P1), p2: invalidated(LIST_P2) }).toEqual({ p1: false, p2: true })
})

test('a failure writes nothing and invalidates nothing', async () => {
  patchFailure = { response: { status: 400, data: { error: 'nope' } } }
  expect(await rename('Rejected')).toBe('error')
  expect(titleAt(DETAIL)).toBe('Old name')
  expect({
    detail: invalidated(DETAIL),
    list: invalidated(LIST_P1),
    overview: invalidated(OVERVIEW_WEEK),
    feed: invalidated(FEED),
  }).toEqual({ detail: false, list: false, overview: false, feed: false })
})

test('a detail GET already in flight when the rename lands cannot put the old title back', async () => {
  let releaseGet: () => void = () => {}
  getGate = new Promise<void>((r) => {
    releaseGet = r
  })
  getAnswer = session({ title: 'Old name (stale GET)' })
  // A refetch dispatched before the rename landed.
  let fetching: Promise<unknown> = Promise.resolve()
  await act(async () => {
    fetching = client
      .fetchQuery({ ...getApiSessionsIdQueryOptions({ path: { id: 's1' } }), staleTime: 0 })
      .catch(() => {})
  })
  expect(client.getQueryState(DETAIL)?.fetchStatus).toBe('fetching')

  await rename('New name')
  await act(async () => {
    releaseGet()
    await fetching
    await new Promise((r) => setTimeout(r, 5))
  })
  expect(titleAt(DETAIL)).toBe('New name')
})
