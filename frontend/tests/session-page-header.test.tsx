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
// A fresh store per test — see tests/session-page-scroll.test.tsx's own
// comment on the same wrapping, for the same reason: `useAttachmentUploads`'s
// tray (use-session-files.ts) is a module-level per-session atom keyed by session
// id, and every test in this file mounts session id 's1'.
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
            <Toaster />
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
  currentMessages = []
  interruptCalls = []
  interruptReject = null
  interruptGate = null
  sends = []
  store = createStore()
  // The composer's draft (use-session-draft.ts) persists to localStorage
  // keyed by session id — see tests/session-page-scroll.test.tsx's own
  // comment on the same clear, for the same reason.
  localStorage.clear()
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

test('the header shows no orchestrator, branch, cost or live-status text', async () => {
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
  // The Live/Reconnecting indicator is gone from the header entirely — see
  // app/status-bar.tsx's own "Reconnecting…" line instead.
  expect(/sessions\.(live|reconnecting)/.test(text)).toBe(false)
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

// --- 11. no live-status indicator next to the title -------------------------
//
// The Live/Reconnecting text and its StatusDot left the header: a dropped
// stream now shows up in the status bar instead (app/status-bar.tsx, see
// tests/status-bar-reconnecting.test.tsx). What stays: the status badge (whose
// own dot is the only dot in the header), the title, the details trigger and
// the actions menu.

/** Every StatusDot in `scope` — shared/components/status-dot.tsx's round
 *  `span[aria-hidden]`. */
const dotsIn = (scope: ParentNode) => [
  ...scope.querySelectorAll('span.rounded-full[aria-hidden="true"]'),
]

/** Opens as soon as it is constructed, so the hook's `connected` goes true —
 *  the state that used to render "Live". */
class OpeningEventSource {
  static opens = 0
  private readonly listeners = new Map<string, Set<(e: Event) => void>>()
  constructor(readonly url: string) {
    setTimeout(() => {
      const fns = [...(this.listeners.get('open') ?? [])]
      if (fns.length > 0) OpeningEventSource.opens++
      for (const fn of fns) fn(new Event('open'))
    }, 0)
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener() {}
  close() {}
}

test('the header keeps the badge, title, details trigger and actions menu', async () => {
  currentSession = session({ status: 'running' })
  await mount()
  const h = header()
  expect(h.querySelectorAll('[data-slot="badge"]').length).toBe(1)
  expect(h.querySelector('[data-slot="badge"]')?.textContent).toBe('sessions.status.running')
  expect(h.querySelector('h1')?.textContent).toBe('A session')
  expect(detailsTrigger().getAttribute('aria-label')).toBe('sessions.details')
  const actions = [...h.querySelectorAll('button')].filter(
    (b) => b.getAttribute('aria-label') === 'sessions.actionsFor',
  )
  expect(actions.length).toBe(1)
})

test("the header's only StatusDot is the one inside the status badge", async () => {
  currentSession = session({ status: 'running' })
  await mount()
  const h = header()
  const badge = h.querySelector('[data-slot="badge"]')
  const dots = dotsIn(h)
  expect(dots.length).toBe(1)
  expect(badge?.contains(dots[0] ?? null)).toBe(true)
})

test('nothing between the title and the action group: the title is followed directly by the actions', async () => {
  await mount()
  const title = header().querySelector('h1')
  const next = title?.nextElementSibling
  // The action group (details trigger lives in it), not a status span.
  expect(next?.contains(detailsTrigger())).toBe(true)
  expect(dotsIn(next ?? document.createElement('div')).length).toBe(0)
})

test('with the stream actually open, the header still shows no live text and no extra dot', async () => {
  ;(globalThis as { EventSource?: unknown }).EventSource = OpeningEventSource
  OpeningEventSource.opens = 0
  try {
    currentSession = session({ status: 'running' })
    await mount()
    await settle()
    // The page really did open a stream: this is the connected state.
    expect(OpeningEventSource.opens).toBeGreaterThanOrEqual(1)
    const text = header().textContent ?? ''
    expect(text).not.toContain('sessions.live')
    expect(text).not.toContain('sessions.reconnecting')
    expect(dotsIn(header()).length).toBe(1)
  } finally {
    ;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
  }
})

// --- 12. Docker / Editor links carry tooltips, and are still links ----------
//
// session-page.tsx wraps each isolated-session header link in a Base UI
// Tooltip (`TooltipTrigger render={<Link …/>}`). Focus opens a Base UI
// tooltip immediately (hover waits on the Root's default delay without the
// app's TooltipProvider — see tests/composer-tooltips.test.tsx), so focus,
// inside act(), is the trigger used here. Tooltips portal to <body>.

const headerLink = (text: string) => {
  const found = [...header().querySelectorAll('a')].filter((a) => a.textContent?.trim() === text)
  if (found.length !== 1) throw new Error(`expected one "${text}" link, got ${found.length}`)
  return found[0] as HTMLAnchorElement
}
const openTooltips = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"][data-open]')].map(
    (el) => el.textContent ?? '',
  )
async function focusIn(el: HTMLElement) {
  await act(async () => {
    el.focus()
  })
  await settle(1)
}
async function blurOut(el: HTMLElement) {
  await act(async () => {
    el.blur()
  })
  await settle(2)
}

test('an isolated session: Docker and Editor are still links, with their hrefs, Editor opening a new tab', async () => {
  currentSession = session({ id: 's1', projectId: 'p1', isolated: true, worktreePath: '/srv/wt' })
  await mount()
  const docker = headerLink('sessions.docker')
  const editor = headerLink('sessions.editor')
  expect(docker.tagName).toBe('A')
  expect(docker.getAttribute('href')).toBe('/projects/p1/sessions/s1/docker')
  expect(docker.hasAttribute('target')).toBe(false)
  expect(editor.tagName).toBe('A')
  expect(editor.getAttribute('href')).toBe('/projects/p1/sessions/s1/editor')
  expect(editor.getAttribute('target')).toBe('_blank')
  expect(editor.getAttribute('rel')).toBe('noopener noreferrer')
  // Not turned into <button>s, nor nested in one, by the tooltip wrapping.
  for (const a of [docker, editor]) {
    expect(a.closest('button')).toBeNull()
    expect(a.querySelector('button')).toBeNull()
  }
})

test('focusing the Docker link opens sessions.dockerTooltip; the Editor link sessions.editorTooltip', async () => {
  currentSession = session({ isolated: true, worktreePath: '/srv/wt' })
  await mount()
  expect(openTooltips()).toEqual([])
  const docker = headerLink('sessions.docker')
  await focusIn(docker)
  expect(openTooltips()).toEqual(['sessions.dockerTooltip'])
  await blurOut(docker)
  expect(openTooltips()).toEqual([])
  await focusIn(headerLink('sessions.editor'))
  expect(openTooltips()).toEqual(['sessions.editorTooltip'])
})

test('the link text, not the tooltip, is what the Docker and Editor links read as', async () => {
  currentSession = session({ isolated: true, worktreePath: '/srv/wt' })
  await mount()
  await focusIn(headerLink('sessions.docker'))
  // The tooltip portals out of the header, and the link text is unchanged.
  expect(header().textContent ?? '').not.toContain('sessions.dockerTooltip')
  expect(headerLink('sessions.docker').textContent).toBe('sessions.docker')
})

test('a non-isolated session renders neither link nor either tooltip', async () => {
  currentSession = session({ isolated: false })
  await mount()
  const texts = [...header().querySelectorAll('a')].map((a) => a.textContent?.trim())
  expect(texts).not.toContain('sessions.docker')
  expect(texts).not.toContain('sessions.editor')
  expect(document.body.textContent ?? '').not.toContain('sessions.dockerTooltip')
})
