// SessionPage's header, details popover, composer stop control and the
// transcript wrapper's empty-state class — the parts of session-page.tsx the
// "Claude-style composer" change moved around:
//
//   - the stop control left the header and now lives in the composer, shown
//     only while the session is `queued`/`running`, calling the interrupt
//     client with this session's id and toasting a failure;
//   - orchestrator / branch / worktree / cost left the header row and now
//     live behind a `sessions.details` popover trigger, each row gated on the
//     session actually having one (cost always, formatted `$x.xxxx`);
//   - the scroll container's transcript wrapper gets `flex h-full flex-col`
//     only for an empty transcript, so the empty state can centre itself —
//     and no class at all otherwise, which the scroll-anchoring code in
//     tests/session-page-scroll.test.tsx depends on.
//
// Rendered the way tests/session-page-scroll.test.tsx renders it — the real
// `SessionPage`, real hooks, real query client, the generated clients mocked
// per-file through ./mock-module — under a private `cimode` i18n instance so
// every label is its bare key. Unlike that file it sits inside a minimal
// memory router: an isolated session's header renders `<Link>`s (Docker,
// Editor), and a Link outside any router throws.
//
// Toasts are observed the way tests/session-idea-link.test.tsx observes them:
// the real `<Toaster />` mounted beside the page, its rendered text read back
// off `document.body`.
//
// Assertions compare primitives (strings, counts, booleans), never DOM
// nodes: bun pretty-printing a happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { mockModule } from './mock-module'

// Never `.use(initReactI18next)` — see tests/session-page-scroll.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-09-04T10:00:00.000Z'

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

type Row = {
  id: string
  sessionId: string
  seq: number
  type: string
  parentToolUseId: string | null
  title: string | null
  pending: boolean
  payload: unknown
  createdAt: string
}
const prompt = (seq: number): Row => ({
  id: `m${seq}`,
  sessionId: 's1',
  seq,
  type: 'prompt',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: { text: `message ${seq}` },
  createdAt: T,
})

let currentSession = session()
let currentMessages: Row[] = []

// The exact client `useInterruptSession` (hooks/use-sessions.ts) reaches,
// through `postApiSessionsIdInterruptMutationOptions`
// (generated/hooks/usePostApiSessionsIdInterrupt.ts).
const INTERRUPT_CLIENT = '@/shared/api/generated/clients/postApiSessionsIdInterrupt'
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
const SEND_CLIENT = '@/shared/api/generated/clients/postApiSessionsIdMessages'

type InterruptCall = { path: { id: string } }
let interruptCalls: InterruptCall[] = []
let interruptReject: unknown = null
/** When set, the interrupt client awaits this before settling — for seeing
 *  the page while the mutation is still pending. */
let interruptGate: Promise<void> | null = null
let sends: unknown[] = []

await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async () => ({ data: currentSession }),
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({
    data: { messages: currentMessages, hasOlder: false },
  }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))
await mockModule(SEND_CLIENT, () => ({
  postApiSessionsIdMessages: async (opts: { body?: unknown }) => {
    sends.push(opts.body)
    return { data: { id: 'x', seq: 999 } }
  },
}))
await mockModule(INTERRUPT_CLIENT, () => ({
  postApiSessionsIdInterrupt: async (opts: InterruptCall) => {
    interruptCalls.push({ path: { ...opts.path } })
    if (interruptGate) await interruptGate
    if (interruptReject) throw interruptReject
    return { data: { ok: true } }
  },
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
const { Toaster, toast } = await import('../src/shared/ui/toast')

let container: HTMLDivElement
let client: QueryClient
let root: Root

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
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
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
  currentMessages = []
  interruptCalls = []
  interruptReject = null
  interruptGate = null
  sends = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  // Module-level singleton — see tests/session-idea-link.test.tsx.
  toast.close()
  document.body.replaceChildren()
})

const STOP = 'sessions.stop'
const DETAILS = 'sessions.details'

const header = () => {
  const headers = [...container.querySelectorAll('header')]
  if (headers.length !== 1) throw new Error(`expected one header, got ${headers.length}`)
  return headers[0] as HTMLElement
}
/** The composer: the `<footer>` that holds the textarea. */
const composer = () => {
  const f = [...container.querySelectorAll('footer')].find((el) => el.querySelector('textarea'))
  if (!f) throw new Error('no composer footer')
  return f as HTMLElement
}
const stopIn = (scope: ParentNode) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.getAttribute('aria-label') === STOP,
  )
const detailsTrigger = () => {
  const found = [...header().querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.getAttribute('aria-label') === DETAILS,
  )
  if (found.length !== 1) throw new Error(`expected one details trigger, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
const popover = () => document.querySelector('[data-slot="popover-content"]')

async function openDetails() {
  expect(popover()).toBeNull()
  await act(async () => {
    detailsTrigger().click()
  })
  await settle(3)
  const p = popover()
  if (!p) throw new Error('details popover did not open')
  return p as HTMLElement
}

/** The popover's rows as `[term, description]` pairs, in order. */
const rowsOf = (p: Element) =>
  [...p.querySelectorAll('dl > div')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ])

const scroller = () => {
  const prev = composer().previousElementSibling
  if (!prev) throw new Error('no scroll container before the composer')
  return prev as HTMLElement
}
const transcriptWrapper = () => {
  const w = scroller().firstElementChild
  if (!w) throw new Error('scroll container is empty')
  return w as HTMLElement
}

// --- 5. stop moved from header to composer ----------------------------------

for (const status of ['running', 'queued'] as const) {
  test(`a ${status} session has stop in the composer and none in the header`, async () => {
    currentSession = session({ status })
    await mount()
    expect(stopIn(header()).length).toBe(0)
    expect(stopIn(composer()).length).toBe(1)
    // And none anywhere else on the page either.
    expect(stopIn(container).length).toBe(1)
  })
}

for (const status of ['idle', 'completed', 'interrupted', 'failed'] as const) {
  test(`a ${status} session has no stop button anywhere`, async () => {
    currentSession = session({ status })
    await mount()
    expect(stopIn(header()).length).toBe(0)
    expect(stopIn(composer()).length).toBe(0)
    expect(stopIn(document.body).length).toBe(0)
  })
}

// --- 6. stop calls interrupt; failure toasts -------------------------------

test("the composer's stop calls the interrupt client once with this session's id", async () => {
  currentSession = session({ id: 's1', status: 'running' })
  await mount()
  const [stop] = stopIn(composer())
  if (!stop) throw new Error('no stop button')
  await act(async () => {
    stop.click()
  })
  await settle()
  expect(interruptCalls).toEqual([{ path: { id: 's1' } }])
  // Stopping is not sending.
  expect(sends).toEqual([])
  expect(document.body.textContent ?? '').not.toContain('sessions.stopFailed')
})

test('stop is disabled while the interrupt is in flight, and enabled again once it settles', async () => {
  currentSession = session({ status: 'running' })
  let release: () => void = () => {}
  interruptGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await act(async () => {
    stopIn(composer())[0]?.click()
  })
  await settle(3)
  expect(interruptCalls.length).toBe(1)
  expect(stopIn(composer())[0]?.disabled).toBe(true)

  await act(async () => {
    release()
  })
  await settle()
  expect(stopIn(composer())[0]?.disabled).toBe(false)
})

test('a rejected interrupt with no message of its own toasts sessions.stopFailed', async () => {
  currentSession = session({ status: 'running' })
  // Not an Error and no `response.data.error`, so `apiErrorMessage` has
  // nothing to prefer over the fallback.
  interruptReject = { response: { status: 500, data: 'upstream exploded' } }
  await mount()
  expect(document.body.textContent ?? '').not.toContain('sessions.stopFailed')
  await act(async () => {
    stopIn(composer())[0]?.click()
  })
  await settle()
  expect(interruptCalls.length).toBe(1)
  expect(document.body.textContent ?? '').toContain('sessions.stopFailed')
})

test("a rejected interrupt toasts the API's own error message when it has one", async () => {
  currentSession = session({ status: 'running' })
  interruptReject = { response: { status: 409, data: { error: 'nothing is running' } } }
  await mount()
  await act(async () => {
    stopIn(composer())[0]?.click()
  })
  await settle()
  const text = document.body.textContent ?? ''
  expect(text).toContain('nothing is running')
  expect(text).not.toContain('sessions.stopFailed')
})

// --- 7. header no longer shows orchestrator / branch / cost ---------------

test('the header shows no orchestrator, branch or cost text, but keeps the live indicator', async () => {
  currentSession = session({
    status: 'running',
    orchestrator: 'claude',
    branch: 'agentoo/s-x',
    totalCostUsd: 1.5,
    isolated: true,
    worktreePath: '/srv/wt/s-x',
  })
  await mount()
  // Popover closed: nothing portalled out, so the header's text is all of it.
  expect(popover()).toBeNull()
  const text = header().textContent ?? ''
  expect(text).toContain('A session')
  expect(text).not.toContain('claude')
  expect(text).not.toContain('agentoo/s-x')
  expect(text).not.toContain('$1.5000')
  expect(text).not.toContain('1.5')
  expect(text).not.toContain('/srv/wt/s-x')
  expect(text).not.toContain('sessions.meta.orchestrator')
  expect(text).not.toContain('sessions.meta.branch')
  // No stream connects in this harness (inert EventSource), so the indicator
  // reads "reconnecting" — either key proves it is still in the header.
  expect(/sessions\.(live|reconnecting)/.test(text)).toBe(true)
})

test('opening the popover still does not put those values into the header itself', async () => {
  currentSession = session({ orchestrator: 'claude', branch: 'agentoo/s-x', totalCostUsd: 1.5 })
  await mount()
  const p = await openDetails()
  // The popover portals out of the header, not into it.
  expect(header().contains(p)).toBe(false)
  const text = header().textContent ?? ''
  expect(text).not.toContain('claude')
  expect(text).not.toContain('agentoo/s-x')
  expect(text).not.toContain('$1.5000')
})

// --- 8. details popover ----------------------------------------------------

for (const status of ['idle', 'queued', 'running', 'interrupted', 'completed', 'failed'] as const) {
  test(`a ${status} session has exactly one details trigger in the header`, async () => {
    currentSession = session({ status })
    await mount()
    expect(detailsTrigger().tagName).toBe('BUTTON')
    expect(detailsTrigger().querySelector('svg')).not.toBeNull()
  })
}

test('the popover is titled sessions.details and lists every row a fully-configured session has', async () => {
  currentSession = session({
    orchestrator: 'claude',
    branch: 'agentoo/s-x',
    isolated: true,
    worktreePath: '/srv/wt/s-x',
    totalCostUsd: 1.5,
  })
  await mount()
  const p = await openDetails()
  expect(p.querySelector('[data-slot="popover-title"]')?.textContent).toBe(DETAILS)
  expect(rowsOf(p)).toEqual([
    ['sessions.meta.orchestrator', 'claude'],
    ['sessions.meta.branch', 'agentoo/s-x'],
    ['sessions.detailsFields.worktree', '/srv/wt/s-x'],
    ['sessions.detailsFields.cost', '$1.5000'],
  ])
})

test('a bare session shows only the cost row, as $0.0000', async () => {
  currentSession = session({
    orchestrator: null,
    branch: null,
    isolated: false,
    worktreePath: null,
    totalCostUsd: 0,
  })
  await mount()
  const p = await openDetails()
  expect(rowsOf(p)).toEqual([['sessions.detailsFields.cost', '$0.0000']])
})

test('cost is formatted with exactly four decimals, rounding past the fourth', async () => {
  currentSession = session({ totalCostUsd: 0.123456 })
  await mount()
  const p = await openDetails()
  expect(rowsOf(p).at(-1)).toEqual(['sessions.detailsFields.cost', '$0.1235'])
})

test('orchestrator only: no branch or worktree rows', async () => {
  currentSession = session({ orchestrator: 'claude', branch: null })
  await mount()
  const terms = rowsOf(await openDetails()).map(([term]) => term)
  expect(terms).toEqual(['sessions.meta.orchestrator', 'sessions.detailsFields.cost'])
})

test('branch only: no orchestrator row', async () => {
  currentSession = session({ orchestrator: null, branch: 'agentoo/s-x' })
  await mount()
  const terms = rowsOf(await openDetails()).map(([term]) => term)
  expect(terms).toEqual(['sessions.meta.branch', 'sessions.detailsFields.cost'])
})

test('a worktree path on a non-isolated session is not shown', async () => {
  currentSession = session({ isolated: false, worktreePath: '/srv/wt/s-x' })
  await mount()
  const p = await openDetails()
  expect(rowsOf(p).map(([term]) => term)).toEqual(['sessions.detailsFields.cost'])
  expect(p.textContent ?? '').not.toContain('/srv/wt/s-x')
})

test('an isolated session with no worktree path shows no worktree row', async () => {
  currentSession = session({ isolated: true, worktreePath: null })
  await mount()
  const terms = rowsOf(await openDetails()).map(([term]) => term)
  expect(terms).toEqual(['sessions.detailsFields.cost'])
})

// --- 10. transcript wrapper class -----------------------------------------

test('zero messages: the transcript wrapper is flex h-full flex-col, holding the empty state', async () => {
  currentMessages = []
  await mount()
  const w = transcriptWrapper()
  expect(w.tagName).toBe('DIV')
  expect((w.getAttribute('class') ?? '').split(/\s+/).sort()).toEqual(
    ['flex', 'flex-col', 'h-full'].sort(),
  )
  expect(w.querySelector('[data-slot="empty"]')).not.toBeNull()
})

test('with messages: the transcript wrapper carries no class attribute at all', async () => {
  currentMessages = [prompt(1), prompt(2)]
  await mount()
  const w = transcriptWrapper()
  expect(w.tagName).toBe('DIV')
  expect(w.hasAttribute('class')).toBe(false)
  expect(w.querySelector('[data-slot="empty"]')).toBeNull()
  expect(w.querySelectorAll('[data-transcript-row]').length).toBe(2)
})
