// Compacting a session, end to end through the page: click, POST, poll,
// land on the new session — and every way that can stop short of it.
//
//   - start → pending → running → succeeded lands on the new session's page
//     and marks the project's sessions list stale, with one POST and polls at
//     the hook's own interval (the one real-time test: ~3s);
//   - start → failed toasts the backend's own reason (a sentence it wrote for
//     exactly this), else a fallback, stays on the session, frees the button,
//     and a retry is a fresh POST;
//   - a 409 from the POST (a turn is running, the project is not ready) and
//     any other rejected POST toast the API's message, never start polling,
//     and leave the button usable;
//   - a poll that itself fails stops the polling and says so, rather than
//     spinning on a dead endpoint, and clicking again picks the same
//     compaction back up;
//   - a compaction that succeeded into a session since deleted (no
//     `resultSessionId`) is a failure, not a navigation to nowhere;
//   - `refetchInterval` itself: on while pending/running, off for a settled or
//     errored poll.
//
// Mounted through the real router and route tree and the real English bundle,
// the way tests/session-page-delete-orchestrator.test.tsx is, so the
// navigation really lands on — and renders — the new session. The generated
// clients are mocked per-file through ./mock-module. Polls other than the
// timing test are driven by refetching the compaction query by hand, which is
// what the interval does on each tick, without waiting for it.
//
// Assertions compare primitives, never DOM nodes: bun pretty-printing a
// happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session } from '../src/features/sessions/hooks/use-sessions'
import { getApiProjectsIdSessionsQueryKey } from '../src/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import { getSessionCompactionQueryKey } from '../src/shared/api/generated/hooks/useGetSessionCompaction'
import type { SessionCompaction } from '../src/shared/api/generated/types/SessionCompaction'
import { mockModule } from './mock-module'

const LIST_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
const CREATE_CLIENT = '@/shared/api/generated/clients/createSessionCompaction'
const GET_CLIENT = '@/shared/api/generated/clients/getSessionCompaction'

const T = '2026-10-18T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'Expensive session',
  status: 'idle',
  orchestrator: 'lead',
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

const compaction = (overrides: Partial<SessionCompaction> = {}): SessionCompaction => ({
  id: 'c1',
  sourceSessionId: 's1',
  status: 'pending',
  method: null,
  resultSessionId: null,
  error: null,
  costUsd: 0,
  createdAt: T,
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

const reject = (status: number, error?: string) => ({
  response: { status, data: error === undefined ? 'upstream exploded' : { error } },
})

let sessions: Session[] = []
let posts: { path: { id: string } }[] = []
let polls: { path: { id: string; compactionId: string } }[] = []
/** What the POST answers; reassigned per test. */
let onPost: () => Promise<{ data: SessionCompaction }>
/** What each poll answers; reassigned per test. */
let onPoll: () => Promise<{ data: SessionCompaction }>

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({ data: sessions }),
}))
await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => {
    const found = sessions.find((s) => s.id === opts.path.id)
    if (!found) throw reject(404, 'Session not found')
    return { data: found }
  },
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))
await mockModule(CREATE_CLIENT, () => ({
  createSessionCompaction: async (opts: { path: { id: string } }) => {
    posts.push({ path: { ...opts.path } })
    return onPost()
  },
}))
await mockModule(GET_CLIENT, () => ({
  getSessionCompaction: async (opts: { path: { id: string; compactionId: string } }) => {
    polls.push({ path: { ...opts.path } })
    return onPoll()
  },
}))

/** happy-dom ships no EventSource. */
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
const { Toaster, toast } = await import('../src/shared/ui/toast')

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

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root

const LIST_KEY = getApiProjectsIdSessionsQueryKey({ path: { id: 'p1' } })
const COMPACTION_KEY = getSessionCompactionQueryKey({ path: { id: 's1', compactionId: 'c1' } })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Real time passing, with React told about whatever it causes — an interval
 *  poll landing mid-wait updates state, and outside `act` that is a warning. */
const wait = (ms: number) =>
  act(async () => {
    await sleep(ms)
  })
const closeToasts = () =>
  act(async () => {
    toast.close()
  })
const settle = async (ticks = 10) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await sleep(5)
    })
  }
}
/** Until `done()`, in real time, or fail with what was being waited for. */
async function waitFor(what: string, done: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await act(async () => {
      await sleep(25)
    })
  }
}

async function mount(path = '/projects/p1/sessions/s1') {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/library/agents' }], [])
  // Seeded so "marked stale" is observable: the list is not mounted on this
  // page, and invalidating a query nobody has cached is a no-op.
  client.setQueryData(LIST_KEY, sessions)

  root = createRoot(container)
  await act(async () => {
    root.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
  if (!h1()) throw new Error('session page never rendered')
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('agentoo:composer-mode', '"raw"')
  sessions = [session(), session({ id: 'new-1', title: 'Compacted session' })]
  posts = []
  polls = []
  onPost = async () => ({ data: compaction() })
  onPoll = async () => ({ data: compaction() })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  toast.close()
  document.body.replaceChildren()
})

// --- helpers ---------------------------------------------------------------

const pathname = () => router.state.location.pathname
const header = () =>
  [...container.querySelectorAll('header')].find((el) => el.querySelector('h1')) as HTMLElement
/** The session's own title: the real shell has an `h1` of its own (the project's name). */
const h1 = () => header()?.querySelector('h1')?.textContent
const headerButton = () => {
  const found = [...header().querySelectorAll('button')].filter((b) =>
    ['Compact session', 'Compacting…'].includes(b.textContent?.trim() ?? ''),
  )
  if (found.length !== 1) throw new Error(`expected one compact button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
const label = () => headerButton().textContent?.trim()
const screenText = () => document.body.textContent ?? ''
async function clickCompact() {
  await act(async () => {
    headerButton().click()
  })
  await settle()
}
/** One poll tick, by hand — what `refetchInterval` does on each interval. */
async function tick() {
  await act(async () => {
    await client.refetchQueries({ queryKey: COMPACTION_KEY })
  })
  await settle()
}

const FAILED_TEXT = 'Could not compact the session'

// --- the whole flow, on the real interval ----------------------------------

test('start → pending → running → succeeded lands on the new session, polling on its own', async () => {
  let pollCount = 0
  onPoll = async () => {
    pollCount++
    return {
      data:
        pollCount === 1
          ? compaction({ status: 'running', method: 'sdk_compact', startedAt: T })
          : compaction({
              status: 'succeeded',
              method: 'sdk_compact',
              resultSessionId: 'new-1',
              finishedAt: T,
            }),
    }
  }
  await mount()
  expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(false)

  await clickCompact()
  expect(posts).toEqual([{ path: { id: 's1' } }])
  expect(label()).toBe('Compacting…')
  expect(headerButton().disabled).toBe(true)
  expect(pathname()).toBe('/projects/p1/sessions/s1')

  // The first tick says running: still here, still compacting, one POST.
  await waitFor('the first poll', () => polls.length >= 1)
  await settle()
  expect(polls[0]).toEqual({ path: { id: 's1', compactionId: 'c1' } })
  expect(label()).toBe('Compacting…')
  expect(pathname()).toBe('/projects/p1/sessions/s1')

  // The second says succeeded: lands on the new session.
  await waitFor('the new session', () => pathname() === '/projects/p1/sessions/new-1')
  await settle()
  expect(h1()).toBe('Compacted session')
  expect(posts.length).toBe(1)
  // And the sessions list now knows about it.
  expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(true)
  // Polling stopped with the terminal status.
  const pollsAtEnd = polls.length
  await wait(1700)
  expect(polls.length).toBe(pollsAtEnd)
  // The new session is not shown as compacting: a fresh page, a fresh button.
  expect(label()).toBe('Compact session')
  expect(headerButton().disabled).toBe(false)
  expect(screenText()).not.toContain(FAILED_TEXT)
}, 15000)

test('a POST that already answers succeeded lands on the new session without waiting for a poll', async () => {
  onPost = async () => ({
    data: compaction({ status: 'succeeded', resultSessionId: 'new-1', finishedAt: T }),
  })
  await mount()
  await clickCompact()
  await waitFor('the new session', () => pathname() === '/projects/p1/sessions/new-1')
  await settle()
  expect(h1()).toBe('Compacted session')
  expect(posts.length).toBe(1)
  expect(polls).toEqual([])
})

// --- the compaction failed ---------------------------------------------------

test('a failed compaction toasts the backend’s reason, stays put, and frees the button', async () => {
  const reason = 'The summarizing model refused to answer.'
  onPoll = async () => ({ data: compaction({ status: 'failed', error: reason, finishedAt: T }) })
  await mount()
  await clickCompact()
  expect(label()).toBe('Compacting…')
  await tick()

  expect(screenText()).toContain(reason)
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(label()).toBe('Compact session')
  expect(headerButton().disabled).toBe(false)
  expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(false)

  // Polling stopped with it.
  const pollsAtEnd = polls.length
  await tick()
  await tick()
  expect(polls.length).toBe(pollsAtEnd + 2) // our own two manual ticks, no interval ones
})

test('a failed compaction with no reason of its own toasts the fallback', async () => {
  onPoll = async () => ({ data: compaction({ status: 'failed', error: null, finishedAt: T }) })
  await mount()
  await clickCompact()
  await tick()
  expect(screenText()).toContain(FAILED_TEXT)
  expect(pathname()).toBe('/projects/p1/sessions/s1')
})

test('after a failure the retry is a fresh POST and can succeed', async () => {
  let attempt = 0
  onPost = async () => ({ data: compaction({ id: `c${++attempt}` }) })
  onPoll = async () => ({
    data:
      attempt === 1
        ? compaction({ id: 'c1', status: 'failed', error: 'first try failed' })
        : compaction({ id: 'c2', status: 'succeeded', resultSessionId: 'new-1' }),
  })
  await mount()
  await clickCompact()
  await tick()
  expect(screenText()).toContain('first try failed')
  expect(label()).toBe('Compact session')

  await clickCompact()
  expect(posts.length).toBe(2)
  await act(async () => {
    await client.refetchQueries({
      queryKey: getSessionCompactionQueryKey({ path: { id: 's1', compactionId: 'c2' } }),
    })
  })
  await waitFor('the new session', () => pathname() === '/projects/p1/sessions/new-1')
})

test('a compaction that succeeded into a session since deleted is a failure, not a navigation', async () => {
  onPoll = async () => ({
    data: compaction({ status: 'succeeded', resultSessionId: null, finishedAt: T }),
  })
  await mount()
  await clickCompact()
  await tick()
  expect(screenText()).toContain(FAILED_TEXT)
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(label()).toBe('Compact session')
})

// --- the POST was refused ----------------------------------------------------

test('a 409 from the POST toasts the API’s message, never polls, and leaves the button usable', async () => {
  const why = 'The session is running: wait for the turn to finish or interrupt it'
  onPost = async () => {
    throw reject(409, why)
  }
  await mount()
  await clickCompact()
  expect(screenText()).toContain(why)
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(label()).toBe('Compact session')
  expect(headerButton().disabled).toBe(false)
  await wait(50)
  expect(polls).toEqual([])
})

test('a 503 and a bare network error toast their message, or the fallback when there is none', async () => {
  onPost = async () => {
    throw reject(503, 'The queue is not reachable')
  }
  await mount()
  await clickCompact()
  expect(screenText()).toContain('The queue is not reachable')
  expect(label()).toBe('Compact session')

  onPost = async () => {
    throw reject(500)
  }
  await closeToasts()
  await clickCompact()
  expect(posts.length).toBe(2)
  expect(screenText()).toContain(FAILED_TEXT)
  expect(polls).toEqual([])
})

test('a 404 from the POST (the session vanished) toasts the API’s message too', async () => {
  onPost = async () => {
    throw reject(404, 'Session not found')
  }
  await mount()
  await clickCompact()
  expect(screenText()).toContain('Session not found')
  expect(pathname()).toBe('/projects/p1/sessions/s1')
})

// --- the poll failed -----------------------------------------------------------

test('a failing poll stops the polling and says so; clicking again picks the same compaction back up', async () => {
  let failing = true
  onPost = async () => ({ data: compaction({ status: 'running' }) })
  onPoll = async () => {
    if (failing) throw reject(500, 'The database is down')
    return {
      data: compaction({ status: 'succeeded', resultSessionId: 'new-1', finishedAt: T }),
    }
  }
  await mount()
  await clickCompact()
  await tick()
  expect(screenText()).toContain('The database is down')
  expect(label()).toBe('Compact session')
  expect(headerButton().disabled).toBe(false)
  expect(pathname()).toBe('/projects/p1/sessions/s1')

  // No interval ticks after the failure: the count is what our one tick made.
  const pollsAtEnd = polls.length
  await wait(1700)
  expect(polls.length).toBe(pollsAtEnd)

  // The backend hands the running compaction back on a repeat click, so the
  // same id is attached again — with the old error cleared, not re-toasted.
  failing = false
  await closeToasts()
  await clickCompact()
  expect(posts.length).toBe(2)
  expect(label()).toBe('Compacting…')
  expect(screenText()).not.toContain('The database is down')
  await tick()
  await waitFor('the new session', () => pathname() === '/projects/p1/sessions/new-1')
}, 15000)

// --- the interval itself ----------------------------------------------------------

/** The live `Query`'s own `refetchInterval`, read off the cache and asked what
 *  react-query itself would ask on its next tick — the technique of
 *  tests/use-ideas.test.tsx. */
function intervalNow(): number | false {
  const query = client.getQueryCache().find({ queryKey: COMPACTION_KEY })
  if (!query) throw new Error('no compaction query in the cache')
  const { refetchInterval } = query.options
  if (typeof refetchInterval !== 'function') throw new Error('refetchInterval is not a function')
  return refetchInterval(query as never) as number | false
}

test('the interval is on while the compaction is pending or running, off once it is settled', async () => {
  onPost = async () => ({ data: compaction({ status: 'pending' }) })
  // Never answers on its own, so the cache holds exactly what is written below.
  onPoll = () => new Promise(() => {})
  await mount()
  await clickCompact()

  // The POST's own answer was seeded: pending, so polling.
  expect(intervalNow()).toBe(1500)
  for (const [status, expected] of [
    ['running', 1500],
    ['pending', 1500],
    ['succeeded', false],
    ['failed', false],
  ] as const) {
    await act(async () => {
      client.setQueryData(COMPACTION_KEY, compaction({ status }))
    })
    expect({ status, interval: intervalNow() }).toEqual({ status, interval: expected })
  }
})

test('the interval is off for a query that errored, whatever stale data it still holds', async () => {
  onPost = async () => ({ data: compaction({ status: 'running' }) })
  onPoll = async () => {
    throw reject(500, 'nope')
  }
  await mount()
  await clickCompact()
  const query = client.getQueryCache().find({ queryKey: COMPACTION_KEY })
  // Hold the errored state in place: the hook has already moved on from it.
  expect(query?.state.data?.status).toBe('running')
  await tick()
  const errored = client.getQueryCache().find({ queryKey: COMPACTION_KEY })
  expect(errored?.state.status).toBe('error')
  expect(errored?.state.data?.status).toBe('running')
  expect(intervalNow()).toBe(false)
})
