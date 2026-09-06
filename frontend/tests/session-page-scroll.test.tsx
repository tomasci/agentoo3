// The mechanisms session-page.tsx uses to keep the transcript's scroll
// position sane: the IntersectionObserver-driven "load older" trigger, the
// viewport-offset anchor that compensates a prepend, the `settle`-based
// pin-to-bottom effect, and the touch guard that suppresses it mid-gesture.
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
//     scroller and its rows;
//   - a recording `IntersectionObserver` that remembers its callback, the
//     options it was constructed with (including `root`), and the node it
//     was pointed at, so a test can decide when the sentinel "intersects";
//   - a recording `requestAnimationFrame`/`cancelAnimationFrame` pair, so
//     `settle`'s follow-up passes run only when a test asks for them, and a
//     cancelled frame can be told apart from one that ran.
// Everything else is the real thing: the real component, the real hooks, the
// real query client, the real cache.
//
// That makes these tests about *arithmetic and flags* — given this much
// content, this scroll position, and this sequence of events, where does the
// component put the reader, and what does it schedule. What it does NOT
// verify: that a real browser delivers an IntersectionObserver callback only
// on a genuine transition into intersection (the "re-arm" rule the production
// comment relies on — here a test fires it exactly when it wants to, which
// assumes but does not prove that rule), that `content-visibility: auto`
// makes `scrollHeight` an underestimate in the first place, or any of the
// touch/momentum/keyboard/overscroll behaviour a real phone actually produces.
// Those need a real browser; see the report.
//
// Class names prove nothing here — `bun test` resolves `.module.scss` to a
// file path, so `className={styles.scroll}` renders as no class at all (same
// note as tests/transcript-row.test.tsx). The scroll container is found
// structurally, and rows via the `data-transcript-row` attribute
// transcript.tsx tags every top-level node with — the same contract
// session-page.tsx's own anchor selection depends on.

import { plugin } from 'bun'
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx,
// tests/transcript-time.test.tsx and tests/transcript-row.test.tsx: this file
// pulls in the `@/shared/ui` barrel too, and whichever of them `bun test`
// evaluates first decides how those ten modules are cached for the run.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'session-page-scroll-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

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
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => rowCount() * ROW_HEIGHT })
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
 */
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function (this: Element) {
  if (this === scroller) return fakeRect(0, VIEWPORT)
  if (this.hasAttribute('data-transcript-row')) {
    const index = rows().indexOf(this as HTMLElement)
    if (index !== -1) return fakeRect(index * ROW_HEIGHT - scroller.scrollTop, ROW_HEIGHT)
  }
  return realGetBoundingClientRect.call(this)
}

/** A user scroll: the position moves, then the container reports it. React
 *  attaches `onScroll` to the node itself (scroll does not bubble), so a
 *  direct dispatch is the same event the browser would deliver. */
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
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    RecordingIntersectionObserver.live.push(this)
  }
  observe(node: Element) {
    this.node = node
  }
  unobserve() {}
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
}
const realIntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = RecordingIntersectionObserver

// --- `settle`'s animation frames -------------------------------------------------

/** Records every frame `requestAnimationFrame` schedules and every one
 *  `cancelAnimationFrame` cancels, and runs nothing until a test asks it to —
 *  `settle` (session-page.tsx) schedules its next pass from inside the
 *  previous one, so "advance one frame" has to mean exactly that, not "run
 *  every frame there will ever be". */
let frameId = 0
let pendingFrames: Array<{ id: number; fn: FrameRequestCallback }> = []
let cancelledFrames: number[] = []

function fakeRequestAnimationFrame(fn: FrameRequestCallback): number {
  const id = ++frameId
  pendingFrames.push({ id, fn })
  return id
}
function fakeCancelAnimationFrame(id: number): void {
  cancelledFrames.push(id)
  pendingFrames = pendingFrames.filter((f) => f.id !== id)
}
const realRAF = globalThis.requestAnimationFrame
const realCAF = globalThis.cancelAnimationFrame
globalThis.requestAnimationFrame = fakeRequestAnimationFrame as typeof requestAnimationFrame
globalThis.cancelAnimationFrame = fakeCancelAnimationFrame as typeof cancelAnimationFrame

/** Advances exactly one animation frame: everything scheduled so far runs
 *  once, and anything a running callback schedules for the *next* frame
 *  waits for the next call. */
async function tick() {
  const due = pendingFrames
  pendingFrames = []
  await act(async () => {
    for (const { fn } of due) fn(0)
  })
}

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
  RecordingIntersectionObserver.live = []
  pendingFrames = []
  cancelledFrames = []
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
      <QueryClientProvider client={client}>
        <SessionPage projectId="p1" sessionId="s1" />
      </QueryClientProvider>,
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

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** The sentinel's own observer, if `messages.hasPreviousPage` has put one in
 *  the tree — matched by `root`, since the composer's textarea (Ark's own
 *  `@zag-js/auto-resize`) may register unrelated observers of its own kind but
 *  never one rooted at the scroll container. */
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

// --- 2. pin to the bottom, and letting go of it -------------------------------

test('a transcript taller than the viewport opens at the bottom', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  // The pin effect's own `fn()` runs synchronously at commit, inside the same
  // `act` the mount already awaited — unlike the ResizeObserver this replaced,
  // nothing here has to be told to fire by hand.
  // Not `scrollHeight`: a browser clamps the pin to the last scrollable pixel.
  expect(scroller.scrollTop).toBe(200)
  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

test('a message arriving while the reader has scrolled up does not move them', async () => {
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

test('a message arriving while the reader is at the bottom follows it down', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(bottom())

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)

  expect(scroller.scrollTop).toBe(300)
  expect(scroller.scrollTop).toBe(bottom())
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

test("settle's own follow-up frames are idempotent once the position is already correct", async () => {
  // Nothing in this simulated model actually grows after commit (happy-dom
  // does no layout, and the row-height model is a fixed constant), so the two
  // extra passes `settle` schedules have nothing left to do — this is the
  // idempotence the real component leans on to make them safe to run
  // unconditionally, not proof that a real placeholder ever needs them.
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  const atBottom = scroller.scrollTop
  expect(atBottom).toBe(bottom())

  expect(pendingFrames.length).toBeGreaterThan(0)
  await tick()
  expect(scroller.scrollTop).toBe(atBottom)
  await tick()
  expect(scroller.scrollTop).toBe(atBottom)
  await unmount()
})

test('a second arrival before the first one`s follow-up frames run cancels them', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  pendingFrames = []
  cancelledFrames = []

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  const firstFrame = pendingFrames[0]?.id
  expect(firstFrame).toBeDefined()

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(7)])
  })
  await settle(() => rowCount() === 7)

  // The frame the first arrival scheduled is cancelled, not left to run on
  // top of whatever the second arrival's own pass does.
  expect(cancelledFrames).toContain(firstFrame)
  await unmount()
})

test('a touch in progress suppresses the pin until it ends', async () => {
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

  await touch('touchend')
  // The 200ms window closes on a real timer — nothing here fakes it, so this
  // waits on the wall clock rather than a controllable frame.
  await settle(() => scroller.scrollTop === bottom(), 60)

  expect(scroller.scrollTop).toBe(bottom())
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

// --- 4. asking for older pages: when, and how often ---------------------------

test('a burst of intersection events near the top asks for one older page, not one each', async () => {
  // A real observer would not deliver a second callback without the sentinel
  // first leaving intersection, but the guard this exercises — `loadingOlder`
  // — exists independently of that: it is what stops re-entry from any
  // in-flight fetch, momentum-scrolling or otherwise.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: true }
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

// --- 5. sending -----------------------------------------------------------------

test('sending a message follows the transcript again, even from halfway up', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await scrollTo(20)

  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no composer')
  await type(textarea, 'do the thing')
  const send = buttons().find((b) => b.textContent === 'sessions.send')
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
