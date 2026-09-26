// The mechanisms session-page.tsx uses to keep the transcript's scroll
// position sane: the IntersectionObserver-driven "load older" trigger and its
// post-settle geometric re-check, the viewport-offset anchor that compensates
// a prepend (applied once, synchronously, at commit), the pin-to-bottom
// effect (also one write at commit), and the touch guard that suppresses it
// mid-gesture.
//
// WHAT IS SIMULATED, AND WHY IT STILL MEANS SOMETHING
//
// happy-dom performs no layout: `scrollHeight`/`clientHeight` are permanently
// 0, `getBoundingClientRect()` returns all zeroes, and its own
// `IntersectionObserver` and `ResizeObserver` are documented stubs —
// `observe`/`disconnect` are empty and the callback is never invoked. So every
// mechanism under test is inert here unless something stands in for the
// browser.
//
// This file installs the smallest such stand-ins:
//   - a height/position model on the scroll container and every
//     `[data-transcript-row]` inside it: row `i` is `ROW_HEIGHT` tall and sits
//     at `i * ROW_HEIGHT` in the document, `scrollTop` clamps to
//     `[0, scrollHeight - clientHeight]` the way a real one does, and
//     `getBoundingClientRect()` is derived from that model for both the
//     scroller and its rows — and for the sentinel, which sits at document
//     position 0 (immediately before every row), so its own viewport offset
//     is `-scrollTop`, exactly what `inLoadZone` (session-page.tsx) assumes;
//   - a recording `IntersectionObserver` that remembers its callback, the
//     options it was constructed with (including `root`), and the node it
//     was pointed at, so a test can decide when the sentinel "intersects";
//   - a recording `requestAnimationFrame`/`cancelAnimationFrame` pair, kept
//     only as a regression guard: the production code no longer schedules a
//     frame anywhere (both the prepend correction and the pin-to-bottom write
//     happen once, synchronously, inside a layout effect), so every test here
//     that touches this expects it to stay empty.
//
// The mocked backend (`respond`, set per test) is always finite: every
// `before` cursor a test hands out eventually leads to `hasOlder: false`, the
// same contract the real endpoint keeps. A backend that kept paginating
// forever would be exercising a bug this component has to survive, not one
// the mock should manufacture — the one test that hands back a page making no
// progress (section 4, below) does so once, on purpose, and asserts the chain
// ends there rather than asserts anything about what a non-terminating mock
// would do to it.
// Everything else is the real thing: the real component, the real hooks, the
// real query client, the real cache.
//
// That makes these tests about *arithmetic and flags* — given this much
// content, this scroll position, and this sequence of events, where does the
// component put the reader, and what does it schedule. What it does NOT
// verify: that a real browser delivers an IntersectionObserver callback only
// on a genuine transition into intersection (the "re-arm" rule the production
// comment relies on — here a test fires it exactly when it wants to, which
// assumes but does not prove that rule), or any of the touch/momentum/
// keyboard/overscroll behaviour a real phone actually produces. Those need a
// real browser; see the report.
//
// Class names prove nothing here — Tailwind utility classes are an
// implementation detail a later restyle can change without changing
// behaviour. The scroll container is found structurally, and rows via the
// `data-transcript-row` attribute transcript.tsx tags every top-level node
// with — the same contract session-page.tsx's own anchor selection depends
// on.

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { mockModule } from './mock-module'

// Every label this file finds a control or a state by is a raw key
// ('common.loading', 'sessions.transcript.loadOlder', 'sessions.send'…), so
// the page is rendered under a private `cimode` instance — i18next's own
// always-return-the-key mode — instead of whatever react-i18next's global
// default happens to be. That default is process-wide: the first file in the
// run to import `@/shared/i18n` (directly, or through `src/app/router`, whose
// settings page imports it) installs the real English singleton via
// `initReactI18next`, and from then on every provider-less render translates.
// Before this provider, the whole file passed alone and failed after
// tests/settings-page.test.tsx: `settle()` waited for 'common.loading' to
// disappear, which with real copy it never showed in the first place, so it
// returned before the first page landed.
//
// Never `.use(initReactI18next)` here — that would make this inert instance
// the global default for every file that runs afterwards. See
// tests/settings-page.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

type Query = Record<string, unknown> | undefined
type Row = { id: string; sessionId: string; seq: number; type: string; parentToolUseId: string | null
  title: string | null; pending: boolean; payload: unknown; createdAt: string }

let n = 0
/** A prompt row, because `buildTranscript` gives each one its own top-level
 *  node — one message, one row, so the simulated height below is a count. */
const msg = (seq: number): Row => ({
  id: `m${n++}`,
  sessionId: 's1',
  seq,
  type: 'prompt',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: { text: `message ${seq}` },
  createdAt: '2026-09-04T10:00:00.000Z',
})

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => msg(from + i))

const session = (o: Record<string, unknown> = {}) => ({
  id: 's1',
  projectId: 'p1',
  title: 'A session',
  status: 'idle',
  orchestrator: 'claude',
  branch: null,
  totalCostUsd: 0,
  pendingPrompts: 0,
  lastError: null,
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

let calls: Query[] = []
let respond: (query: Query) => { messages: Row[]; hasOlder: boolean }
let fail = false
let delay = 0
/** Every send the composer attempted. */
let sends: unknown[] = []
/**
 * A one-shot pause point the mocked backend awaits before resolving, for
 * pinning a request precisely between "the fetch has resolved" and "React has
 * committed the page it produced" — the gap `session-page.tsx`'s own
 * `loadingOlder` guard now has to stay closed across. `openGate()` arms it for
 * exactly the *next* call into the mock, whichever query that turns out to be;
 * every call after that one proceeds unimpeded, because the mock clears this
 * the moment it reads it, before ever awaiting it.
 */
let gate: Promise<void> | null = null
function openGate(): () => void {
  let release: () => void = () => {}
  gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const SEND_CLIENT = '@/shared/api/generated/clients/postApiSessionsIdMessages'
// Sending invalidates the session row, and the refetch that follows would be a
// real HTTP request out of the test process — observed as an ECONNRESET before
// this was mocked.
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
// The composer now mounts `useSessionFiles` unconditionally for its usage
// line — nothing here exercises attachments, so an empty list is the whole
// contract this needs to honour, but it still has to be mocked or every test
// in this file fires a real request the test process has no backend for.
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'

// Registered through tests/mock-module.ts rather than `mock.module` directly:
// a bare `mock.module` here would hand these four fakes to every file `bun
// test` loads afterwards, and `session-page.tsx` is on the router's static
// import graph that tests/workspace.test.tsx mounts. See that helper for why
// the undo this file used to do — saving the namespace and putting it back in
// `afterAll` — restored nothing.
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async (opts: { query?: Query }) => {
    calls.push(opts.query)
    // Read and cleared before awaiting it, not after: this is what makes the
    // gate one-shot for whichever call happens to see it armed, rather than
    // pausing every call made while a test forgets to release it.
    const currentGate = gate
    gate = null
    if (currentGate) await currentGate
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    if (fail && opts.query?.before !== undefined) throw new Error('older page failed')
    return { data: respond(opts.query) }
  },
}))

await mockModule(SEND_CLIENT, () => ({
  postApiSessionsIdMessages: async (opts: { body?: unknown }) => {
    sends.push(opts.body)
    // The real page inserts nothing on success — the message comes back over
    // the stream — so an empty 201 is the whole contract this needs to honour.
    return { data: { id: 'x', seq: 999 } }
  },
}))

await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async () => ({ data: session() }),
}))

await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))

/** happy-dom ships no EventSource, and the stream is not what this file is
 *  about: an inert stand-in, so `useSessionStream` has something to construct.
 *  See tests/use-session-stream-hook.test.tsx for the stream itself. */
class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource

// --- the simulated viewport ---------------------------------------------------

const ROW_HEIGHT = 100
const VIEWPORT = 300

let client: QueryClient
let container: HTMLDivElement
let root: Root
let scroller: HTMLElement

/** Every top-level transcript row currently rendered — the same selector
 *  `pickAnchor` (session-page.tsx) queries the scroll container with. */
const rows = () => [...scroller.querySelectorAll<HTMLElement>('[data-transcript-row]')]
const rowCount = () => rows().length

/**
 * Gives the scroll container the geometry happy-dom will not: height from the
 * rows actually rendered, a fixed viewport, and a `scrollTop` clamped to the
 * scrollable range. The clamp is not decoration — `scrollTop = scrollHeight`
 * (the pin) lands at `scrollHeight - clientHeight` in a browser, and a test
 * that let it land at `scrollHeight` would be asserting a position no browser
 * ever produces.
 */
function simulateLayout(el: HTMLElement) {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => rowCount() * ROW_HEIGHT,
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, Math.max(0, el.scrollHeight - VIEWPORT)))
    },
  })
}

const bottom = () => Math.max(0, scroller.scrollHeight - VIEWPORT)

function fakeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/**
 * The one piece of geometry neither `scrollHeight` nor `clientHeight` can
 * stand in for: `offsetOf` (session-page.tsx) reads `getBoundingClientRect()`
 * on the scroll container and on individual rows, deriving a row's position
 * from the same `i * ROW_HEIGHT` document model `simulateLayout` uses for
 * `scrollHeight` — a row's viewport-relative top is its document position
 * minus however far the container has scrolled, exactly as a real layout
 * would report it for a non-scrolling ancestor pinned at the viewport's own
 * top edge (which is what treating the scroller's own rect as `{ top: 0 }`
 * below amounts to).
 *
 * The sentinel gets the same treatment, not left to fall through to
 * happy-dom's own always-zero stub: it renders immediately before every row
 * (session-page.tsx), so its own document position is a fixed 0 — a
 * viewport-relative top of `-scrollTop`, following the scroll exactly the
 * way `inLoadZone` (session-page.tsx) assumes it does. Left unhandled, this
 * fell through to the always-`{ top: 0 }` stub below regardless of
 * `scrollTop`, which made `inLoadZone` read as permanently true and every
 * "out of zone" assertion below pass for the wrong reason. Identified by
 * `RecordingIntersectionObserver`'s own record of what it is watching,
 * rather than a test-only attribute session-page.tsx would otherwise have to
 * carry for no production reason.
 */
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function (this: Element) {
  if (this === scroller) return fakeRect(0, VIEWPORT)
  if (this.hasAttribute('data-transcript-row')) {
    const index = rows().indexOf(this as HTMLElement)
    if (index !== -1) return fakeRect(index * ROW_HEIGHT - scroller.scrollTop, ROW_HEIGHT)
  }
  if (RecordingIntersectionObserver.live.some((o) => o.node === this)) {
    return fakeRect(-scroller.scrollTop, 0)
  }
  return realGetBoundingClientRect.call(this)
}

/** A user scroll: the position moves, then the container reports it. React
 *  attaches `onScroll` to the node itself (scroll does not bubble), so a
 *  direct dispatch is the same event the browser would deliver. Stands in for
 *  any input that moves `scrollTop` without a touch sequence around it —
 *  wheel, trackpad, keyboard, dragging the scrollbar — none of which this
 *  component tells apart from one another; only `onTouchStart`/`onTouchEnd`
 *  below, dispatched separately, mean "a finger is on the glass". */
async function scrollTo(top: number) {
  await act(async () => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

/** A touch lifecycle event. Unlike `scroll`, touch events do bubble, and
 *  React's listener for them is delegated at the root rather than attached to
 *  the node itself — a bare `new Event(type)` defaults to `bubbles: false`
 *  and would never reach it. */
async function touch(type: 'touchstart' | 'touchend' | 'touchcancel') {
  await act(async () => {
    scroller.dispatchEvent(new Event(type, { bubbles: true }))
  })
}

// --- the sentinel's IntersectionObserver ---------------------------------------

/** Records its callback, the options it was constructed with (including
 *  `root`), and the node it was pointed at — happy-dom's own
 *  `IntersectionObserver` is a no-op stub, same as its `ResizeObserver`. */
class RecordingIntersectionObserver {
  static live: RecordingIntersectionObserver[] = []
  node: Element | null = null
  /** Every `observe()`/`unobserve()` call in order, so a test can assert
   *  session-page.tsx's own unobserve-then-observe re-registration happened
   *  (or didn't) without inferring it from a side effect three steps removed. */
  observeLog: Array<'observe' | 'unobserve'> = []
  /** Set by every `observe()` call, consumed by `deliverFreshEntry` below —
   *  the one part of a real observer's own behaviour a hand-fired `fire()`
   *  cannot stand in for. A target newly (re-)registered — `observe()` called
   *  on it while this instance was not already watching it — is queued for
   *  its own "initial" notification at the browser's *next* intersection-
   *  checking round, evaluated against whatever is true then, not against a
   *  boolean a test hands in and not against geometry frozen at the moment
   *  `observe()` was called. A plain geometry change with no fresh `observe()`
   *  behind it delivers nothing — matching a real observer's transition-only
   *  rule for a target it is already watching. */
  private pendingFreshEntry = false
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    RecordingIntersectionObserver.live.push(this)
  }
  observe(node: Element) {
    this.node = node
    this.observeLog.push('observe')
    this.pendingFreshEntry = true
  }
  unobserve(_node: Element) {
    this.observeLog.push('unobserve')
  }
  disconnect() {
    RecordingIntersectionObserver.live = RecordingIntersectionObserver.live.filter((o) => o !== this)
    this.node = null
  }
  takeRecords() {
    return []
  }
  /** Delivers one entry the way a real observer would when the sentinel
   *  crosses the `root`'s edge. */
  fire(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting, target: this.node } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
  /** Delivers one *batch* containing an entry per state given, in order — the
   *  way a real observer can when it and the compositor never got a chance to
   *  talk between two of the sentinel's own transitions (no native scroll
   *  anchoring to smooth a page's arrival over, e.g. iOS Safari). Session-page.tsx
   *  has to act on the *last* one, not the first. */
  fireBatch(states: boolean[]) {
    this.callback(
      states.map((isIntersecting) => ({ isIntersecting, target: this.node }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }
  /** Stands in for the browser's own next intersection-checking round
   *  delivering a freshly-(re)observed target's initial entry, computed from
   *  the node's actual current geometry against the same `rootMargin`
   *  (`100%` of `root`'s height, the only margin this component ever
   *  constructs one with) the production observer uses — not a boolean the
   *  test hands in, and not whatever was true when `observe()` was called. */
  deliverFreshEntry() {
    if (!this.pendingFreshEntry || !this.node) return
    this.pendingFreshEntry = false
    const root = this.options?.root as HTMLElement | undefined
    if (!root) return
    const isIntersecting = this.node.getBoundingClientRect().top >= -root.clientHeight
    this.fire(isIntersecting)
  }
}
const realIntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = RecordingIntersectionObserver

// --- a regression guard: nothing here should ever schedule a frame -------------

/** Records every frame `requestAnimationFrame` schedules and every one
 *  `cancelAnimationFrame` cancels. Nothing in session-page.tsx calls either
 *  any more — the prepend correction and the pin-to-bottom write are each one
 *  synchronous write inside a layout effect — so every test that checks this
 *  expects it to stay empty; a regression that brings back a per-frame loop
 *  would show up here first. */
let pendingFrameIds: number[] = []
let frameId = 0
function fakeRequestAnimationFrame(): number {
  const id = ++frameId
  pendingFrameIds.push(id)
  return id
}
function fakeCancelAnimationFrame(id: number): void {
  pendingFrameIds = pendingFrameIds.filter((f) => f !== id)
}
const realRAF = globalThis.requestAnimationFrame
const realCAF = globalThis.cancelAnimationFrame
globalThis.requestAnimationFrame = fakeRequestAnimationFrame as typeof requestAnimationFrame
globalThis.cancelAnimationFrame = fakeCancelAnimationFrame as typeof cancelAnimationFrame

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realIntersectionObserver
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect
  globalThis.requestAnimationFrame = realRAF
  globalThis.cancelAnimationFrame = realCAF
})

const { SessionPage } = await import('../src/features/sessions/components/session-page')
const { appendStreamedMessage, sessionMessagesKey } = await import(
  '../src/features/sessions/lib/message-cache'
)
const { getApiSessionsIdQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)

async function settle(until: () => boolean = () => false, ticks = 12) {
  for (let i = 0; i < ticks && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const buttons = () => [...container.querySelectorAll('button')]
const buttonLabels = () => buttons().map((b) => b.textContent)
const loadOlderButton = () =>
  buttons().find((b) => b.textContent?.includes('sessions.transcript.loadOlder'))

const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/**
 * Types into a controlled field the way a browser does.
 *
 * Assigning `.value` directly is not enough: React records the last value it
 * wrote on the node and would read the assignment back as "nothing changed",
 * so `onChange` never fires and the composer stays empty. Going through the
 * prototype's own setter is what leaves React's tracker out of step, which is
 * exactly what a real keystroke does.
 */
const type = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  n = 0
  calls = []
  sends = []
  fail = false
  delay = 0
  gate = null
  RecordingIntersectionObserver.live = []
  pendingFrameIds = []
  frameId = 0
})

/**
 * Mounts the page and waits for the first transcript page to land, then wires
 * the simulated geometry — after mount, so nothing has measured 0 yet.
 *
 * `messagesSeed`, when given, pre-populates the messages query's own cache
 * the same way `sessionOverrides` above pre-populates the session's — so
 * `messages.isPending` is already `false` on the very first render, not just
 * `session.isPending`. That is the warm path a revisited session tab takes in
 * production (`staleTime: Infinity` on both queries — see `use-sessions.ts`),
 * and the one under which `.scroll`, the sentinel and the transcript all
 * mount in a single commit rather than the spinner-then-content sequence
 * every other test in this file goes through.
 */
async function mount(
  sessionOverrides: Record<string, unknown> = {},
  messagesSeed?: { messages: Row[]; hasOlder: boolean },
) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded, so the session row never reaches for a backend of its own.
  client.setQueryData(getApiSessionsIdQueryKey({ path: { id: 's1' } }), session(sessionOverrides))
  if (messagesSeed) {
    client.setQueryData(sessionMessagesKey('s1'), {
      pages: [messagesSeed],
      pageParams: [undefined],
    })
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <QueryClientProvider client={client}>
          <SessionPage projectId="p1" sessionId="s1" />
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
  const footer = container.querySelector('footer')
  if (!footer?.previousElementSibling) throw new Error('no scroll container before the composer')
  scroller = footer.previousElementSibling as HTMLElement
  // Wired up before the content lands, not after: the initial page fetch
  // resolves on a microtask the render-time `act` above does not wait out,
  // and the pin-to-bottom layout effect fires the instant that resolution
  // commits — synchronously, with no observer to fire by hand afterwards the
  // way the ResizeObserver this replaced worked. Simulated geometry has to
  // already be in place for that first commit, or the pin runs once against
  // happy-dom's own permanently-zero `scrollHeight` and this harness never
  // gets a second chance at it.
  simulateLayout(scroller)
  await settle(() => !scroller.textContent?.includes('common.loading'))
}

/**
 * Re-renders the same root with a different `sessionId` — the same component
 * instance, not a fresh mount, exactly the way `SessionRoute`
 * (app/project-routes.tsx) hands a new `sessionId` prop to this same
 * component on an ordinary in-app navigation between sessions. `mount()`'s
 * own `createRoot` call would build an entirely new instance instead, with
 * every ref back at its initial value — the opposite of what a test of *this*
 * instance's own refs surviving a switch needs.
 *
 * Both the new session's row and its first page of messages are pre-seeded —
 * a warm switch, the same cache state `mount()`'s own `messagesSeed`
 * parameter puts session s1 in for "the sentinel observer is created on a
 * warm cache" above — rather than leaving messages to load cold. On a warm
 * switch every one of this component's own layout effects, the pin-to-bottom
 * one included, fires synchronously as part of *this* commit rather than a
 * later one this function has already returned from, which is why
 * `simulateLayout` is (re)installed on `scroller` *before* triggering the
 * render below, not after: installed only afterward, that first synchronous
 * pin write would already have happened against happy-dom's own real,
 * permanently-zero `scrollHeight`, and nothing here gets a second chance at
 * it (see `mount()`'s own comment on the same requirement).
 */
async function switchSession(
  newSessionId: string,
  messagesSeed: { messages: Row[]; hasOlder: boolean },
  sessionOverrides: Record<string, unknown> = {},
) {
  client.setQueryData(
    getApiSessionsIdQueryKey({ path: { id: newSessionId } }),
    session({ id: newSessionId, ...sessionOverrides }),
  )
  client.setQueryData(sessionMessagesKey(newSessionId), {
    pages: [messagesSeed],
    pageParams: [undefined],
  })
  const scrollerBeforeSwitch = scroller
  simulateLayout(scroller)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <QueryClientProvider client={client}>
          <SessionPage projectId="p1" sessionId={newSessionId} />
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
  const footer = container.querySelector('footer')
  if (!footer?.previousElementSibling) {
    throw new Error('no scroll container before the composer after switching session')
  }
  scroller = footer.previousElementSibling as HTMLElement
  // Only reinstalled if `.scroll` turned out to be a genuinely new node:
  // `simulateLayout` closes over its own fresh `scrollTop`, starting at 0, so
  // calling it again on the *same* node here would silently throw away the
  // pin-to-bottom write the render above already made against it.
  if (scroller !== scrollerBeforeSwitch) simulateLayout(scroller)
  await settle(() => !scroller.textContent?.includes('common.loading'))
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** The sentinel's own observer, if `messages.hasPreviousPage` has put one in
 *  the tree — matched by `root` rather than assumed to be the only one live,
 *  so this stays correct the day something else in the tree registers an
 *  IntersectionObserver of its own that is not rooted at the scroll
 *  container. */
const olderObserver = () => RecordingIntersectionObserver.live.find((o) => o.options?.root === scroller)

// --- 1. the geometry these tests stand on -------------------------------------

test('the simulated container reports one row-height per rendered transcript row', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  // Anchors the height model to the real render: if `buildTranscript` ever
  // stops producing one top-level node per prompt, every number below would
  // quietly mean something else, and this is where that shows up.
  expect(rowCount()).toBe(5)
  expect(scroller.scrollHeight).toBe(500)
  expect(scroller.clientHeight).toBe(300)
  await unmount()
})

test('the load-older sentinel is observed only while there is an older page, and lets go on unmount', async () => {
  // A sentinel that outlives its own observer — or an observer nobody ever
  // disconnects — keeps re-arming a fetch nobody asked for.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()

  expect(olderObserver()).toBeDefined()

  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  // The last page said there is nothing older: the sentinel — and the
  // observer watching it — both leave the tree.
  expect(olderObserver()).toBeUndefined()

  await unmount()
})

test('the sentinel observer is also let go when the whole page unmounts', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer to unmount')

  await unmount()

  expect(observer.node).toBeNull()
})

test('the sentinel observer is created on a warm cache, where it mounts in the same commit as the scroll container', async () => {
  // Regression: refs attach bottom-up within a commit (children before
  // parents). Building the IntersectionObserver straight from the sentinel's
  // own ref callback — reading `scroller.current` there — worked only by
  // accident, on the cold-load path where the session and messages queries
  // resolve in *later* commits, after `.scroll` has long since attached its
  // own ref. Pre-seeding both caches here reproduces the warm path instead:
  // a revisited session tab (`staleTime: Infinity` on both queries) whose
  // very first render already has data, mounting `.scroll`, the sentinel and
  // the transcript all in one commit — the case in which `scroller.current`
  // is still `null` at the instant the sentinel's own ref callback runs.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount({}, { messages: range(10, 5), hasOlder: true })

  // Proves the warm path was actually exercised, not merely intended: a cold
  // mount would show the spinner inside `.scroll` while the seeded fetch
  // mock resolved, and a request would show up in `calls` — neither happens
  // here. Scoped to `scroller`, not the whole container: the composer's own
  // (unrelated) attachments-usage fetch is not pre-seeded and is genuinely
  // still pending at this point, so checking the whole page's text would
  // trip on that instead of proving anything about the messages query.
  expect(scroller.textContent?.includes('common.loading')).toBe(false)
  expect(calls).toEqual([])

  const observer = olderObserver()
  expect(observer).toBeDefined()
  expect(observer?.node).not.toBeNull()

  await unmount()
})

test('the sentinel is watched with a one-viewport prefetch margin above the top', async () => {
  // 300px used to be the margin; a normal scroll reaches the top before a
  // fetch that far out can land. `inLoadZone` (the post-settle geometric
  // re-check, exercised in section 4 below) has to agree with this exact
  // margin, or the two mechanisms disagree about what "in the zone" means.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()

  expect(olderObserver()?.options?.rootMargin).toBe('100% 0px 0px 0px')
  await unmount()
})

// --- 2. pin to the bottom, and letting go of it -------------------------------

test('a transcript taller than the viewport opens at the bottom', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  // The pin effect's own write runs synchronously at commit, inside the same
  // `act` the mount already awaited — unlike the ResizeObserver this
  // replaced, nothing here has to be told to fire by hand, and nothing here
  // schedules a frame to do it in either.
  // Not `scrollHeight`: a browser clamps the pin to the last scrollable pixel.
  expect(scroller.scrollTop).toBe(200)
  expect(scroller.scrollTop).toBe(bottom())
  expect(pendingFrameIds.length).toBe(0)
  await unmount()
})

test('initial open pins to the bottom and issues no older-page request when the sentinel lands out of the zone', async () => {
  // Regression for the ordering defect: the `oldestSeq`-keyed layout effect
  // used to run its geometric re-check on the very first commit too — before
  // the pin effect had even scrolled anywhere — and would find the sentinel
  // (at `scrollTop` 0) "in zone" and fetch again, flipping `pinned` to
  // `false` before the pin effect got a chance to read it.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 10), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()

  // 10 rows of history pins at 700, which puts the sentinel (`-scrollTop`)
  // at -700 — well outside the one-viewport (-300) zone.
  expect(scroller.scrollTop).toBe(700)
  expect(scroller.scrollTop).toBe(bottom())
  expect(calls).toEqual([{ limit: 100 }])

  // Waiting longer proves this is a stop, not a fetch quietly still in
  // flight — the same shape as the other "no follow-up" tests in section 4.
  await settle(() => false, 10)
  expect(calls).toEqual([{ limit: 100 }])
  await unmount()
})

test('a message arriving while the reader has scrolled up does not move them', async () => {
  // `scrollTo` stands in for any input that moves `scrollTop` without a touch
  // sequence around it — wheel, trackpad, keyboard, the scrollbar — none of
  // which `onScroll` (session-page.tsx) tells apart; all of them clear
  // `pinned` the same way. No `touchstart`/`touchend` fire in this test at
  // all, so this is specifically the non-touch path.
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  // Away from the bottom by more than the 80px slack the component allows.
  await scrollTo(20)
  expect(scroller.scrollTop).toBe(20)

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)

  expect(rowCount()).toBe(6)
  expect(scroller.scrollTop).toBe(20)
  await unmount()
})

test('a message arriving while the reader is at the bottom follows it down, in one write with no rAF', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(bottom())
  pendingFrameIds = []

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)

  expect(scroller.scrollTop).toBe(300)
  expect(scroller.scrollTop).toBe(bottom())
  // One synchronous write at commit, not a loop: nothing here ever asked for
  // a frame.
  expect(pendingFrameIds.length).toBe(0)
  await unmount()
})

test('within 80px of the bottom still counts as being at the bottom', async () => {
  // The slack exists because a reader who nudges the wheel one notch has not
  // asked to stop following the transcript.
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(bottom() - 40)

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)

  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

test('a touch in progress suppresses the pin until it ends, then catches up in one write', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(bottom())
  const wasAtBottom = scroller.scrollTop

  await touch('touchstart')

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  // The touch is still in progress: the new row is not followed yet, even
  // though the reader was at the bottom when it arrived — `bottom()` has
  // already moved to reflect the 6th row, but `scrollTop` has not.
  expect(scroller.scrollTop).toBe(wasAtBottom)
  expect(scroller.scrollTop).not.toBe(bottom())

  pendingFrameIds = []
  await touch('touchend')
  // The 200ms window closes on a real timer — nothing here fakes it, so this
  // waits on the wall clock rather than a controllable frame.
  await settle(() => scroller.scrollTop === bottom(), 60)

  expect(scroller.scrollTop).toBe(bottom())
  // The catch-up is the same single write as every other arrival, not a
  // per-frame chase.
  expect(pendingFrameIds.length).toBe(0)
  await unmount()
})

test('momentum scrolling after a touch ends keeps the guard armed', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(bottom())
  const wasAtBottom = scroller.scrollTop

  await touch('touchstart')
  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  expect(scroller.scrollTop).toBe(wasAtBottom)

  await touch('touchend')
  // ~130ms of the original 200ms window gone, then momentum carries the view
  // further down on its own — still short of the new bottom, but well inside
  // the 80px slack, so `onScroll` reads this as "still at the bottom" and
  // restarts the window rather than clearing `pinned`.
  await settle(() => false, 26)
  await scrollTo(bottom() - 10)
  // Another ~130ms: 260ms have now passed since `touchend`, which would have
  // closed the *original* window, but only ~130ms since the restart above —
  // if the restart had not taken effect, this would already show `bottom()`.
  await settle(() => false, 26)
  expect(scroller.scrollTop).toBe(bottom() - 10)

  // The restarted window does eventually close on its own, snapping the last
  // few pixels momentum had not yet covered.
  await settle(() => scroller.scrollTop === bottom(), 60)
  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

// --- 3. the prepend, and the position it has to preserve ----------------------

test('older messages land above without moving what the reader is looking at', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  expect(scroller.scrollHeight).toBe(500)

  // Near the top: far enough from the bottom to have stopped following, close
  // enough to the top to ask for history via the button (the sentinel's own
  // trigger is covered separately, below).
  await scrollTo(50)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(rowCount()).toBe(10)
  // 500px of history went in above the viewport, so the same content is under
  // the reader's eyes only if the position moved down by exactly that much.
  expect(scroller.scrollHeight).toBe(1000)
  expect(scroller.scrollTop).toBe(550)
  await unmount()
})

test('the prepend correction is applied synchronously at commit, with no rAF follow-up', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await scrollTo(50)
  pendingFrameIds = []

  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  expect(scroller.scrollTop).toBe(550)
  expect(pendingFrameIds.length).toBe(0)
  await unmount()
})

test('the sentinel crossing into view asks for the same page the button would', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  await act(async () => {
    observer.fire(true)
  })
  await settle(() => rowCount() === 10)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(rowCount()).toBe(10)
  await unmount()
})

test('the resize a prepend itself causes does not fling the reader to the bottom', async () => {
  // The two effects meeting: a prepend changes `messages.messages`' own
  // identity too, which is also what an arriving message does — only the
  // anchor compensation may move `scrollTop` here, because `requestOlder`
  // already cleared `pinned`.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await scrollTo(50)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  expect(scroller.scrollTop).toBe(550)
  expect(scroller.scrollTop).not.toBe(bottom())
  await unmount()
})

test('a prepend that lands while the reader is still at the top leaves them there', async () => {
  // scrollTop 0 with 500px of history added: the reader keeps the row they
  // were reading, which is now 500px down.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await scrollTo(0)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  expect(scroller.scrollTop).toBe(500)
  await unmount()
})

test('scrolling further while the older page is still loading is not fought', async () => {
  // `onScroll` re-records the anchor's offset while a fetch is in flight, so
  // the position it compensates for is wherever the reader ends up, not
  // wherever they were the instant the fetch started.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  delay = 30
  await mount()
  await scrollTo(50)
  await click(loadOlderButton() as Element)

  // Still mid-flight: nudge further before the older page lands.
  await scrollTo(80)
  await settle(() => rowCount() === 10)
  delay = 0

  // The anchor row was 50px into the viewport when the fetch started and 80px
  // when it landed — the compensation follows the later position.
  expect(scroller.scrollTop).toBe(580)
  await unmount()
})

test('a reader who scrolls immediately after a prepend correction is left alone', async () => {
  // With the correction now a single write at commit, there is no window
  // afterwards for a second pass to fight the reader in — this is the
  // regression guard for that: nothing here should ever move `scrollTop`
  // again on its own once the commit that applied the correction is done.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await scrollTo(50)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)
  expect(scroller.scrollTop).toBe(550)

  scroller.scrollTop = 600
  await settle(() => false, 10)

  expect(scroller.scrollTop).toBe(600)
  expect(pendingFrameIds.length).toBe(0)
  await unmount()
})

// --- 4. asking for older pages: when, how often, and when it has to stop ------

test('a burst of intersection events near the top asks for one older page, not one each', async () => {
  // A real observer would not deliver a second callback without the sentinel
  // first leaving intersection, but the guard this exercises — `loadingOlder`
  // — exists independently of that: it is what stops re-entry from any
  // in-flight fetch, momentum-scrolling or otherwise.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  delay = 30
  await mount()

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  await act(async () => {
    for (let i = 0; i < 6; i++) observer.fire(true)
  })
  await settle(() => rowCount() === 10)
  delay = 0

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('a successful prepend that leaves the sentinel inside the zone asks again, with no new intersection event', async () => {
  respond = (query) => {
    if (query?.before === undefined) return { messages: range(5, 5), hasOlder: true }
    if (query.before === 5) return { messages: [msg(4)], hasOlder: true }
    if (query.before === 4) return { messages: [msg(3)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  await mount()
  await scrollTo(50)

  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 7)

  // Two older pages landed from the one click above: a single new row barely
  // moves the sentinel, so it is still inside the one-viewport load zone once
  // the first settles, and the geometric re-check inside the correction's own
  // layout effect is what asked again — nothing here ever fired a second
  // intersection.
  expect(calls).toEqual([{ limit: 100 }, { before: 5, limit: 100 }, { before: 4, limit: 100 }])
  expect(rowCount()).toBe(7)
  await unmount()
})

test('an intersection during an in-flight load is not lost: it yields exactly one follow-up once settled, if still in range', async () => {
  respond = (query) => {
    if (query?.before === undefined) return { messages: range(20, 5), hasOlder: true }
    if (query.before === 20) return { messages: [msg(19)], hasOlder: true }
    if (query.before === 19) return { messages: [msg(18)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  delay = 30
  await mount()
  await scrollTo(50)

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  await act(async () => {
    observer.fire(true)
  })
  // Dropped outright by the `loadingOlder` guard: the fetch above is still in
  // flight, so firing again here must not queue a second request behind it.
  await act(async () => {
    observer.fire(true)
  })

  await settle(() => rowCount() === 7, 30)
  delay = 0

  // One request for each of the two older pages, plus the follow-up the
  // geometric re-check asked for once the first settled still inside the
  // zone — not a second one for the dropped intersection above.
  expect(calls).toEqual([{ limit: 100 }, { before: 20, limit: 100 }, { before: 19, limit: 100 }])
  expect(rowCount()).toBe(7)
  await unmount()
})

test('a reader at the bottom stays pinned through an auto-prefetch and follows the next arrival', async () => {
  // Regression: `requestOlder` clears `pinned` unconditionally (it has to —
  // see its own comment on why a short first page must not read as "stay
  // pinned"), and nothing used to put it back once the fetch it started
  // landed. A reader who never touched the scrollbar, sitting through a
  // first page short enough to auto-load more on open, would come out of
  // that with `pinned` stuck `false` and stop following the live session.
  respond = (query) => {
    // Exactly one viewport (3 rows @ 100px = 300px): short enough that the
    // sentinel is inside the one-viewport zone the instant it mounts, the
    // same way a real IntersectionObserver's own initial callback would
    // report it, without this test needing to fire a second one to get
    // there.
    if (query?.before === undefined) return { messages: range(8, 3), hasOlder: true }
    if (query.before === 8) return { messages: [msg(7)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  await mount()
  expect(scroller.scrollTop).toBe(bottom())

  // Stands in for the real IntersectionObserver's own initial delivery
  // (`RecordingIntersectionObserver.fire` is otherwise only ever called by
  // hand — see the file's own top comment on what a mocked observer does not
  // prove) — the one already-covered by "the sentinel is watched with a
  // one-viewport prefetch margin above the top" that a page this short falls
  // inside from the moment the sentinel mounts.
  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  await act(async () => {
    observer.fire(true)
  })
  await settle(() => rowCount() === 4)

  // The prepend's own anchor correction already kept the reader wherever
  // they were — here, the very bottom, since the whole transcript fit in one
  // viewport before this landed — and history is exhausted, so the chain
  // stopped on its own.
  expect(rowCount()).toBe(4)
  expect(scroller.scrollTop).toBe(bottom())
  expect(olderObserver()).toBeUndefined()

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(11)])
  })
  await settle(() => rowCount() === 5)

  // Still following: `pinned` was recomputed from the committed geometry
  // once the auto-prefetch settled, not left at whatever `requestOlder` set
  // it to when the fetch started.
  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

test('no follow-up once the sentinel has scrolled out of the load zone, even with more history to fetch', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: true }
  await mount()
  await scrollTo(50)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  // The 500px this prepend added carried the sentinel well outside the
  // one-viewport load zone (clientHeight 300) — `hasPreviousPage` is still
  // true and the button is still offered, but nothing here asks again on its
  // own.
  expect(scroller.scrollTop).toBe(550)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(loadOlderButton()).toBeDefined()
  await settle(() => false, 10)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('no follow-up once hasPreviousPage is false, however close the sentinel still is', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(1, 2), hasOlder: true }
      : { messages: [msg(0)], hasOlder: false }
  await mount()

  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 3)

  expect(calls).toEqual([{ limit: 100 }, { before: 1, limit: 100 }])
  // Waiting longer proves this is a stop, not a fetch still quietly in
  // flight.
  await settle(() => false, 10)
  expect(calls).toEqual([{ limit: 100 }, { before: 1, limit: 100 }])
  expect(loadOlderButton()).toBeUndefined()
  await unmount()
})

test('no follow-up when a page makes no progress, even with the sentinel in zone and more history claimed', async () => {
  // The defect this guards against: `requestOlder` used to ask again with
  // the very same cursor whenever a page failed to move `oldestSeq`, which a
  // backend that keeps answering with the same page (a real bug, but exactly
  // the shape this test simulates) turned into an unbounded loop — the one
  // that grew this file's own process past the machine's memory. A page that
  // makes no progress has to end the chain, not repeat the request that just
  // made none.
  respond = () => ({ messages: range(10, 5), hasOlder: true })
  await mount()
  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')

  await click(loadOlderButton() as Element)
  await settle(() => calls.length === 2)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  // No re-observe either: a page that made no progress is not a settle the
  // `oldestSeq` effect's own re-observe step ever runs for (`oldestSeq`
  // itself never moved), and there is nothing to look at again on purpose —
  // only the one `observe()` the sentinel's mount performed.
  expect(observer.observeLog).toEqual(['observe'])
  // Long enough that a same-cursor retry loop would already have shown up —
  // the same shape as the other "no follow-up" tests above.
  await settle(() => false, 10)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('a fully loaded transcript renders no sentinel and asks for nothing', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  expect(olderObserver()).toBeUndefined()
  expect(calls).toEqual([{ limit: 100 }])
  // And the button that would ask is not offered either.
  expect(loadOlderButton()).toBeUndefined()
  await unmount()
})

test('the load-older button asks for the same page the sentinel would', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  const button = loadOlderButton()
  if (!button) throw new Error(`no load-older button among ${buttonLabels().join(', ')}`)

  await click(button)
  await settle(() => rowCount() === 10)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(rowCount()).toBe(10)
  // The last page said there is nothing older, so the offer is withdrawn.
  expect(loadOlderButton()).toBeUndefined()
  await unmount()
})

test('a failed older page keeps the transcript and says so, and the retry works', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  fail = true

  const button = loadOlderButton()
  if (!button) throw new Error('no load-older button')
  await click(button)
  await settle(() => container.textContent?.includes('loadOlderFailed') === true)

  expect(rowCount()).toBe(5)
  expect(container.textContent).toContain('sessions.transcript.loadOlderFailed')

  fail = false
  const retry = loadOlderButton()
  if (!retry) throw new Error('the load-older button did not survive the failure')
  await click(retry)
  await settle(() => rowCount() === 10)

  expect(rowCount()).toBe(10)
  expect(container.textContent).not.toContain('sessions.transcript.loadOlderFailed')
  await unmount()
})

test('a failed fetch does not retry itself automatically, even with the sentinel still in the zone', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  fail = true

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')

  await click(loadOlderButton() as Element)
  await settle(() => container.textContent?.includes('loadOlderFailed') === true)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  // No re-observe either: `oldestSeq` never moves on an error, so the
  // `oldestSeq` effect's own re-observe step never runs for it — only the
  // sentinel's own mount-time `observe()` is on the log.
  expect(observer.observeLog).toEqual(['observe'])
  // Long enough that an automatic retry loop would have shown up by now — the
  // button and the alert are the only path back, not a background retry.
  await settle(() => false, 20)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('a manual click that makes progress re-observes the sentinel', async () => {
  // Coverage for the other half of the re-observe fix: not just "does it
  // happen for an automatic trigger" but "does it happen at all, for a
  // settle a person's own click caused" — the `oldestSeq` effect this lives
  // in does not know or care which of `requestOlder`'s three call sites
  // asked.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: true }
  await mount()
  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  expect(observer.observeLog).toEqual(['observe'])

  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  // Unobserve-then-observe, not a second independent `observe()`: that pair
  // is what forces the browser to treat the sentinel as freshly registered
  // and hand back an "initial" entry at its own next round, rather than
  // waiting on a transition that may or may not still come.
  expect(observer.observeLog).toEqual(['observe', 'unobserve', 'observe'])
  await unmount()
})

test('a page landing with the sentinel just outside the zone still gets one follow-up once the reader scrolls back in, with no intersection event of its own', async () => {
  // The stall the real-browser trace found: a page can land in a long commit
  // frame that pushes the sentinel just outside the one-viewport zone at the
  // exact instant the synchronous `inLoadZone` check runs, so the chain does
  // not continue on the spot. If the reader's own wheel or fling then carries
  // the sentinel back inside before the browser's next rendering update, a
  // plain observer never saw an "outside" state to transition *from* and has
  // nothing to call back about on its own — nothing here ever fires a second
  // intersection event. The fix is the re-observe two tests up: it forces a
  // fresh entry, evaluated against geometry as of *that* next update, which
  // is what `deliverFreshEntry` below stands in for.
  respond = (query) => {
    if (query?.before === undefined) return { messages: range(10, 7), hasOlder: true }
    if (query.before === 10) return { messages: range(7, 3), hasOlder: true }
    if (query.before === 7) return { messages: [msg(6)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  await mount()
  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  // Drains the mount's own initial entry (out of zone at `scrollTop` 400, so
  // this is a no-op) — without this, the assertion below could pass on the
  // strength of that first, unrelated `observe()` call instead of the
  // re-observe this test is actually about.
  await act(async () => {
    observer.deliverFreshEntry()
  })

  await scrollTo(50)
  await click(loadOlderButton() as Element)
  await settle(() => rowCount() === 10)

  // 300px of new history landed above a row that was 250px into the
  // viewport; the correction preserves that, which puts the sentinel (at
  // `-scrollTop`) outside the one-viewport zone by 50px — the reader had not
  // scrolled since clicking, so nothing else here could have asked again yet.
  expect(scroller.scrollTop).toBe(350)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])

  // The reader's own fling, not a click or a sentinel transition: carries the
  // sentinel back inside the zone with no `fire()` of any kind.
  await scrollTo(100)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])

  // Stands in for the browser's own next intersection-checking round, which
  // the re-observe above queued a fresh entry for — evaluated here against
  // the geometry just scrolled to, not the geometry `scrollTop` 350 the page
  // actually landed at.
  await act(async () => {
    observer.deliverFreshEntry()
  })
  await settle(() => rowCount() === 11)

  expect(calls).toEqual([
    { limit: 100 },
    { before: 10, limit: 100 },
    { before: 7, limit: 100 },
  ])
  expect(rowCount()).toBe(11)
  await unmount()
})

test("an intersection batch acts on the sentinel's own last entry, not its first", async () => {
  // The real-browser trace: a re-observe's own fresh "outside" entry and the
  // very next frame's "inside" transition can arrive together, in that order,
  // in one callback — no native scroll anchoring (iOS Safari) to smooth the
  // page's arrival over the way Chromium's own anchoring does. Reading only
  // the first entry acted on a state that was already stale by the time the
  // callback ran at all, and the reader stalled until the manual button.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')

  // [true, false]: the sentinel's own last word in this batch is "outside" —
  // nothing here has any business loading on the strength of an entry that is
  // already stale by the time this callback runs.
  await act(async () => {
    observer.fireBatch([true, false])
  })
  await settle(() => false, 5)
  expect(calls).toEqual([{ limit: 100 }])

  // [false, true]: the reverse, and the shape that actually stalled — the
  // sentinel's last word is "inside".
  await act(async () => {
    observer.fireBatch([false, true])
  })
  await settle(() => rowCount() === 10)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('a fresh entry landing after a fetch resolves but before React commits its page issues no request; the commit still gets its own anchor, and no cursor is ever requested twice', async () => {
  // The other real-browser defect: react-query writes a settled fetch's
  // result into the cache — and resolves `.then()` — before React has
  // committed the resulting page. The old code closed `loadingOlder` only
  // until the promise resolved, not until commit, so anything automatic that
  // slipped into that gap could dispatch a second request before the first
  // one's own `anchor`/`lastRequestedBefore` had even been read, corrupting
  // both: one page landing with no correction, the other correcting for a
  // cursor it never actually requested.
  respond = (query) => {
    if (query?.before === undefined) return { messages: range(10, 5), hasOlder: true }
    if (query.before === 10) return { messages: range(5, 5), hasOlder: true }
    if (query.before === 5) return { messages: [msg(4)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  await mount()
  await scrollTo(50)

  const release = openGate()
  await click(loadOlderButton() as Element)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer')
  await act(async () => {
    // Lets the gated fetch resolve, then drains enough of the microtask
    // queue for react-query's own machinery and this component's `.then()`
    // to run all the way through — a purely microtask-based drain, never a
    // macrotask (`setTimeout`) one, which is what keeps this inside `act`'s
    // own batching window: React's own scheduled re-render here runs on a
    // macrotask, so yielding to one before this callback returns would let
    // it jump the queue and commit early, defeating the very gap this models.
    release()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Modelling the gap explicitly: a fresh entry (the re-observe from a page
    // this component itself has not even committed yet, or any other
    // automatic trigger) landing in exactly this window.
    observer.fire(true)
  })
  await settle(() => rowCount() === 10)

  // The fire during the gap issued nothing: still the one request the click
  // made, and the commit that follows corrects for its own anchor (the row
  // 250px into the viewport when the click fired), not a cursor some second,
  // premature request would have overwritten it with.
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(scroller.scrollTop).toBe(550)
  expect(rowCount()).toBe(10)

  // After the commit, a fresh entry does yield exactly one follow-up.
  await act(async () => {
    observer.fire(true)
  })
  await settle(() => rowCount() === 11)
  expect(calls).toEqual([
    { limit: 100 },
    { before: 10, limit: 100 },
    { before: 5, limit: 100 },
  ])
  expect(rowCount()).toBe(11)

  // No cursor was ever asked for twice, across the whole sequence above.
  const beforeCursors = calls.map((c) => c?.before).filter((b) => b !== undefined)
  expect(new Set(beforeCursors).size).toBe(beforeCursors.length)
  await unmount()
})

test('a fetch abandoned by a session switch cannot leave the guard stuck: the button and the sentinel both still work for the new session', async () => {
  respond = (query) => {
    if (query?.before === undefined) return { messages: range(10, 5), hasOlder: true }
    if (query.before === 10) return { messages: range(5, 5), hasOlder: true }
    if (query.before === 5) return { messages: [msg(4)], hasOlder: false }
    throw new Error(`unexpected before ${query?.before}`)
  }
  await mount()

  // Superseded, not merely slow: this fetch is abandoned by the switch below
  // before it ever gets a chance to resolve.
  const release = openGate()
  await click(loadOlderButton() as Element)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])

  // A warm switch (see `switchSession`'s own comment) — the new session opens
  // with no fetch of its own, so `calls` does not grow here at all.
  await switchSession('s2', { messages: range(10, 5), hasOlder: true })
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(rowCount()).toBe(5)
  expect(scroller.scrollTop).toBe(bottom())

  // Left stuck closed by the abandoned fetch above, neither of these would
  // ever do anything again.
  const button = loadOlderButton()
  if (!button) throw new Error('no load-older button for the new session')
  await click(button)
  await settle(() => rowCount() === 10)
  expect(rowCount()).toBe(10)
  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }, { before: 10, limit: 100 }])

  const observer = olderObserver()
  if (!observer) throw new Error('no sentinel observer for the new session')
  await act(async () => {
    observer.fire(true)
  })
  await settle(() => rowCount() === 11)
  expect(rowCount()).toBe(11)
  expect(loadOlderButton()).toBeUndefined()

  // The abandoned session's own fetch finally resolving, late, touches
  // nothing: `olderRequestId` already moved on at the switch (and twice more
  // since, from the new session's own two requests above), so this stale
  // `.then()` finds itself superseded and is a no-op.
  const callsBeforeRelease = calls.length
  release()
  await settle(() => false, 10)
  expect(rowCount()).toBe(11)
  expect(scroller.scrollTop).toBe(bottom())
  expect(calls.length).toBe(callsBeforeRelease)
  await unmount()
})

// --- 5. sending -----------------------------------------------------------------

test('sending a message follows the transcript again, even from halfway up', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(20)

  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no composer')
  await type(textarea, 'do the thing')
  const send = buttons().find((b) => b.getAttribute('aria-label') === 'sessions.send')
  if (!send) throw new Error(`no send button among ${buttonLabels().join(', ')}`)
  await click(send)
  await settle(() => sends.length > 0)

  expect(sends).toEqual([{ text: 'do the thing' }])

  // `submit()` set `pinned` back to true; the reply itself arrives over the
  // stream (not through this mutation's own response), so simulating that
  // arrival is what actually exercises whether `pinned` took effect, rather
  // than merely surviving the click.
  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  expect(scroller.scrollTop).toBe(bottom())

  // A successful send invalidates the session row; letting that refetch land
  // before unmounting keeps its state update inside `act` rather than leaving
  // it to arrive on a torn-down tree.
  await settle(() => client.isFetching() === 0)
  await unmount()
})
