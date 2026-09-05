// The two mechanisms that share `session-page.tsx`'s scroll container: the
// layout effect that compensates `scrollTop` after older messages are
// prepended, and the ResizeObserver that re-pins to the bottom while `pinned`
// is true. They can fight, and the reader is the one who notices.
//
// WHAT IS SIMULATED, AND WHY IT STILL MEANS SOMETHING
//
// happy-dom performs no layout: `scrollHeight` and `clientHeight` are
// permanently 0, and `scrollTop` is an unclamped stored number. Its
// `ResizeObserver` is a documented stub — `observe`/`disconnect` are empty and
// the callback is never invoked (see happy-dom/lib/resize-observer). So both
// mechanisms are inert here unless something stands in for the browser.
//
// This file installs the smallest such stand-in: the scroll container is given
// a height model (every top-level transcript row is ROW_HEIGHT tall, the
// viewport is VIEWPORT tall) and a `scrollTop` that clamps to
// `[0, scrollHeight - clientHeight]` the way a real one does, and the
// ResizeObserver records its callback so a test can fire it at a chosen
// moment. Everything else is the real thing: the real component, the real
// hooks, the real query client, the real cache.
//
// That makes these tests about *arithmetic and flags* — given this much
// content and this scroll position, where does the component put the reader —
// which is exactly where the two mechanisms fight. What it does NOT verify:
// when the browser would actually deliver a resize observation, whether
// `content-visibility: auto` makes `scrollHeight` an underestimate in the
// first place, or that a programmatic `scrollTop` write fires the `scroll`
// event that recomputes `pinned`. Those need a real browser; see the report.
//
// Class names prove nothing here — `bun test` resolves `.module.scss` to a
// file path, so `className={styles.scroll}` renders as no class at all (same
// note as tests/transcript-row.test.tsx). The scroll container is found
// structurally, and the content element by asking the ResizeObserver which
// node the component handed it.

import { plugin } from 'bun'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

// Saved before mocking so `afterAll` can restore them: `mock.module` replaces a
// specifier for every future importer in the process, and `session-page.tsx`
// is on the router's static import graph that tests/workspace.test.tsx mounts.
const realMessages = await import('../src/shared/api/generated/clients/getApiSessionsIdMessages')
const realSend = await import('../src/shared/api/generated/clients/postApiSessionsIdMessages')
const realSession = await import('../src/shared/api/generated/clients/getApiSessionsId')

await mock.module(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async (opts: { query?: Query }) => {
    calls.push(opts.query)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    if (fail && opts.query?.before !== undefined) throw new Error('older page failed')
    return { data: respond(opts.query) }
  },
}))

await mock.module(SEND_CLIENT, () => ({
  postApiSessionsIdMessages: async (opts: { body?: unknown }) => {
    sends.push(opts.body)
    // The real page inserts nothing on success — the message comes back over
    // the stream — so an empty 201 is the whole contract this needs to honour.
    return { data: { id: 'x', seq: 999 } }
  },
}))

await mock.module(SESSION_CLIENT, () => ({
  getApiSessionsId: async () => ({ data: session() }),
}))

afterAll(() => {
  mock.module(MESSAGES_CLIENT, () => realMessages)
  mock.module(SEND_CLIENT, () => realSend)
  mock.module(SESSION_CLIENT, () => realSession)
})

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

/** Records its callback and the node it was pointed at, so a test can say when
 *  the observation is delivered. happy-dom's own is a no-op stub. */
class RecordingResizeObserver {
  static live: RecordingResizeObserver[] = []
  node: Element | null = null
  constructor(readonly callback: () => void) {
    RecordingResizeObserver.live.push(this)
  }
  observe(node: Element) {
    this.node = node
  }
  unobserve() {}
  disconnect() {
    this.node = null
  }
}
const realResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RecordingResizeObserver

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver
})

const { SessionPage } = await import('../src/features/sessions/components/session-page')
const { appendStreamedMessage } = await import('../src/features/sessions/lib/message-cache')
const { getApiSessionsIdQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)

// --- the simulated viewport ---------------------------------------------------

const ROW_HEIGHT = 100
const VIEWPORT = 300

let client: QueryClient
let container: HTMLDivElement
let root: Root
let scroller: HTMLElement
let content: HTMLElement

/** One wrapper per top-level transcript node — the grid is the content
 *  element's last child, the load-older control (when shown) its first. */
const rowCount = () => content.lastElementChild?.children.length ?? 0

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

/** A user scroll: the position moves, then the container reports it. React
 *  attaches `onScroll` to the node itself (scroll does not bubble), so a
 *  direct dispatch is the same event the browser would deliver. */
async function scrollTo(top: number) {
  await act(async () => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

/** Delivers a resize observation to the transcript content, which is what the
 *  browser does after layout settles or the content grows. */
async function resizeContent() {
  const observer = RecordingResizeObserver.live.find((o) => o.node === content)
  if (!observer) throw new Error('the transcript content is not being observed')
  await act(async () => {
    observer.callback()
  })
}

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
  RecordingResizeObserver.live = []
})

/** Mounts the page and waits for the first transcript page to land, then wires
 *  the simulated geometry — after mount, so nothing has measured 0 yet. */
async function mount(sessionOverrides: Record<string, unknown> = {}) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded, so the session row never reaches for a backend of its own.
  client.setQueryData(getApiSessionsIdQueryKey({ path: { id: 's1' } }), session(sessionOverrides))
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

  // The content element replaces the loading spinner only once the first page
  // has landed, and it is the callback ref on it that registers the observer.
  // Matched by parentage, not by being the only observer: the composer's
  // autoresizing textarea registers one of its own, immediately, at mount.
  const observing = () => RecordingResizeObserver.live.find((o) => o.node?.parentElement === scroller)
  await settle(() => observing() !== undefined)
  const observed = observing()
  if (!observed?.node) throw new Error('the transcript content was never observed')
  content = observed.node as HTMLElement
  simulateLayout(scroller)
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

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

test('the transcript is observed once, and the observer is let go on unmount', async () => {
  // A callback ref that forgets to return its cleanup leaks a ResizeObserver
  // per session opened, each one still holding the container and still
  // entitled to re-pin it.
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  const watching = () =>
    RecordingResizeObserver.live.filter((o) => o.node?.parentElement === scroller)

  expect(watching()).toHaveLength(1)

  // A render that changes nothing about the transcript must not add another.
  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  expect(watching()).toHaveLength(1)

  await unmount()
  expect(watching()).toHaveLength(0)
})

// --- 2. pin to the bottom, and letting go of it -------------------------------

test('a transcript taller than the viewport opens at the bottom', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()

  await resizeContent()

  // Not `scrollHeight`: a browser clamps the pin to the last scrollable pixel.
  expect(scroller.scrollTop).toBe(200)
  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

test('a message arriving while the reader has scrolled up does not move them', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await resizeContent()

  // Away from the bottom by more than the 80px slack the component allows.
  await scrollTo(20)
  expect(scroller.scrollTop).toBe(20)

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  await resizeContent()

  expect(rowCount()).toBe(6)
  expect(scroller.scrollTop).toBe(20)
  await unmount()
})

test('a message arriving while the reader is at the bottom follows it down', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await resizeContent()
  await scrollTo(bottom())

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  await resizeContent()

  expect(scroller.scrollTop).toBe(300)
  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

test('within 80px of the bottom still counts as being at the bottom', async () => {
  // The slack exists because a reader who nudges the wheel one notch has not
  // asked to stop following the transcript.
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await resizeContent()
  await scrollTo(bottom() - 40)

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(6)])
  })
  await settle(() => rowCount() === 6)
  await resizeContent()

  expect(scroller.scrollTop).toBe(bottom())
  await unmount()
})

// --- 3. the prepend, and the position it has to preserve ----------------------
//
// One line in `requestOlder` is deliberately NOT pinned here: `pinned.current
// = false`. With the compensation below in place there is no reachable
// position it changes. A reader near the top of an overflowing transcript is
// already un-pinned by the scroll handler, and in the case its own comment
// names — a first page shorter than the viewport, which reads as "at the
// bottom" — the compensated position (0 + everything that was added) always
// exceeds the new maximum and clamps to the bottom anyway, which is where
// pinning would have put them. Removing the line leaves every test in this
// file green; that was checked, not assumed. It is belt and braces against a
// real browser's `content-visibility` heights, which nothing here simulates.

test('older messages land above without moving what the reader is looking at', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await resizeContent()
  expect(scroller.scrollHeight).toBe(500)

  // Near the top: far enough from the bottom to have stopped following, close
  // enough to the top to ask for history.
  await scrollTo(50)
  await settle(() => rowCount() === 10)

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  expect(rowCount()).toBe(10)
  // 500px of history went in above the viewport, so the same content is under
  // the reader's eyes only if the position moved down by exactly that much.
  expect(scroller.scrollHeight).toBe(1000)
  expect(scroller.scrollTop).toBe(550)
  await unmount()
})

test('the resize the prepend itself causes does not fling the reader to the bottom', async () => {
  // The two mechanisms meeting: the prepend grew the content, which is also
  // what an arriving message does. Only the second one may follow.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await resizeContent()
  await scrollTo(50)
  await settle(() => rowCount() === 10)

  await resizeContent()

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
  await resizeContent()
  await scrollTo(0)
  await settle(() => rowCount() === 10)

  expect(scroller.scrollTop).toBe(500)
  await unmount()
})

// --- 4. asking for older pages: when, and how often ---------------------------

test('a burst of scroll events near the top asks for one older page, not one each', async () => {
  // Momentum scrolling fires many `scroll` events before react-query's own
  // loading state can reach a render, which is why the component guards this
  // with a ref rather than with `isLoadingOlder`.
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: true }
  delay = 30
  await mount()
  await resizeContent()

  await act(async () => {
    for (let i = 0; i < 6; i++) {
      scroller.scrollTop = 10 + i
      scroller.dispatchEvent(new Event('scroll'))
    }
  })
  await settle(() => rowCount() === 10)
  delay = 0

  expect(calls).toEqual([{ limit: 100 }, { before: 10, limit: 100 }])
  await unmount()
})

test('scrolling to the top of a fully loaded transcript asks for nothing', async () => {
  respond = () => ({ messages: range(1, 5), hasOlder: false })
  await mount()
  await resizeContent()

  await scrollTo(0)
  await settle()

  expect(calls).toEqual([{ limit: 100 }])
  // And the control that would ask is not offered either.
  expect(loadOlderButton()).toBeUndefined()
  await unmount()
})

test('the load-older button asks for the same page a scroll to the top would', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: range(10, 5), hasOlder: true }
      : { messages: range(5, 5), hasOlder: false }
  await mount()
  await resizeContent()
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
  await resizeContent()
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
  await resizeContent()
  await scrollTo(20)

  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no composer')
  await type(textarea, 'do the thing')
  const send = buttons().find((b) => b.textContent === 'sessions.send')
  if (!send) throw new Error(`no send button among ${buttonLabels().join(', ')}`)
  await click(send)
  await settle(() => sends.length > 0)

  expect(sends).toEqual([{ text: 'do the thing' }])
  // The reply will arrive on the stream and grow the content; the reader asked
  // for it, so they should be taken to it.
  await resizeContent()
  expect(scroller.scrollTop).toBe(bottom())

  // A successful send invalidates the session row; letting that refetch land
  // before unmounting keeps its state update inside `act` rather than leaving
  // it to arrive on a torn-down tree.
  await settle(() => client.isFetching() === 0)
  await unmount()
})
