// What `?after=` the stream reconnects with, and whether a bad cursor can ever
// get there — the deploy-order question behind the backend now rejecting a
// non-finite `after` with a 400 instead of silently replaying the whole
// transcript.
//
// The two behaviours interact, and neither file tested the pair before:
//
//  1. `connect()` re-reads `lastSeq.current`, which is *not* reset between
//     connections. So whatever cursor a connection failed on is exactly the
//     cursor the retry three seconds later will use again. Under the old
//     backend a non-finite `after` was coerced to -1 and the stream recovered
//     by replaying everything; under the new one it is a 400, EventSource
//     raises `error`, and the hook schedules another attempt with the same
//     rejected value. That is a permanent 3-second retry loop with a dead
//     transcript, not a recovery — so the only thing standing between a user
//     and that loop is the cursor never going non-finite in the first place.
//
//  2. Which is what `parseStreamedMessage` now guarantees: a frame that does
//     not carry an integer `seq` never reaches `append`, so
//     `Math.max(lastSeq, seq)` cannot be handed a `NaN`. Test 2 below pins
//     that at the hook level rather than at the parser's, because it is the
//     hook that owns the cursor.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionStream } from '../src/features/sessions/hooks/use-session-stream'
import type { MessagesData } from '../src/features/sessions/lib/message-cache'
import { sessionMessagesKey } from '../src/features/sessions/lib/message-cache'
import { logger } from '../src/shared/lib/logger'

type M = {
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

const msg = (seq: number, o: Partial<M> = {}): M => ({
  id: `m${seq}`,
  sessionId: 's1',
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: {},
  createdAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

class FakeEventSource {
  static opened: FakeEventSource[] = []
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Set<(e: Event) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn)
  }
  close() {
    this.closed = true
  }
  /** Deliver one frame verbatim, so a test can send a shape the backend would
   *  never send as easily as one it would. */
  raw(data: string) {
    this.emit('message', new MessageEvent('message', { data }))
  }
  emit(type: string, event: Event = new Event(type)) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
const MESSAGES_KEY = sessionMessagesKey('s1')

const page = (messages: M[]): MessagesData => ({
  pages: [{ messages, hasOlder: false }],
  pageParams: [undefined],
})

let client: QueryClient
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  FakeEventSource.opened = []
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  client.clear()
})

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

function Probe({ id }: { id: string }) {
  useSessionStream(id, true)
  return null
}

async function mount(id = 's1') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe id={id} />
      </QueryClientProvider>,
    )
  })
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** Polls rather than sleeping a fixed amount — the reconnect is a real 3s
 *  `setTimeout` in the hook, and a fixed sleep either flakes or wastes time. */
async function until(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !cond()) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

const source = (i = 0) => {
  const s = FakeEventSource.opened[i]
  if (!s) throw new Error(`no EventSource #${i} was constructed`)
  return s
}

const cursorOf = (url: string) => url.slice(url.indexOf('after=') + 'after='.length)

// --- 1. the retry reuses the cursor it failed on ------------------------------

test('the reconnect after an error asks for the same after= the failed connection used', async () => {
  // The property that turns a rejected cursor into a permanent loop rather
  // than a one-off failure: nothing between attempts revises it.
  client.setQueryData(MESSAGES_KEY, page([msg(41)]))
  await mount()
  expect(source(0).url).toBe('/api/sessions/s1/events?after=41')

  source(0).emit('error')
  await until(() => FakeEventSource.opened.length > 1)

  expect(FakeEventSource.opened.length).toBeGreaterThan(1)
  expect(source(1).url).toBe('/api/sessions/s1/events?after=41')
  await unmount()
}, 15_000)

test('a reconnect after messages arrived advances the cursor past them', async () => {
  // The other half: the cursor is not frozen, it is just never revised
  // *downward* or away from a value the server refused.
  client.setQueryData(MESSAGES_KEY, page([msg(41)]))
  await mount()

  source(0).raw(JSON.stringify({ message: msg(42) }))
  source(0).raw(JSON.stringify({ message: msg(43) }))
  source(0).emit('error')
  await until(() => FakeEventSource.opened.length > 1)

  expect(source(1).url).toBe('/api/sessions/s1/events?after=43')
  await unmount()
}, 15_000)

// --- 2. the cursor cannot go non-finite --------------------------------------

test('a frame with a NaN seq never moves the cursor, so after= can never be NaN', async () => {
  // Before the boundary check this frame reached `append` and made
  // `Math.max(lastSeq, NaN)` = NaN, which the old backend forgave (coerced to
  // -1, full replay) and the new one 400s. Both outcomes are wrong; not
  // producing the value is the fix.
  const warn = spyOnWarn()
  client.setQueryData(MESSAGES_KEY, page([msg(7)]))
  await mount()

  // `seq: null` survives JSON and is exactly what Math.max would poison on.
  source(0).raw(JSON.stringify({ message: { ...msg(0), seq: null } }))
  source(0).raw(JSON.stringify({ message: { ...msg(0), seq: 'nine' } }))
  source(0).emit('error')
  await until(() => FakeEventSource.opened.length > 1)

  const cursor = cursorOf(source(1).url)
  expect(cursor).toBe('7')
  expect(Number.isFinite(Number(cursor))).toBe(true)
  expect(warn.calls).toBeGreaterThan(0)
  warn.restore()
  await unmount()
}, 15_000)

test('an empty cache plus only malformed frames still asks for after=-1, never after=NaN', async () => {
  // -1 is a value the backend explicitly still accepts (it is the "my cache is
  // empty, send everything" case); NaN is the one it now rejects.
  const warn = spyOnWarn()
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount()

  source(0).raw('not json at all')
  source(0).raw(JSON.stringify({ message: { seq: Number.NaN } }))
  source(0).emit('error')
  await until(() => FakeEventSource.opened.length > 1)

  expect(source(1).url).toBe('/api/sessions/s1/events?after=-1')
  warn.restore()
  await unmount()
}, 15_000)

/** Silences the drop warnings these tests deliberately provoke, while still
 *  letting a test assert one happened. */
function spyOnWarn() {
  const original = logger.warn
  let calls = 0
  logger.warn = ((...args: unknown[]) => {
    calls++
    void args
  }) as typeof logger.warn
  return {
    get calls() {
      return calls
    },
    restore() {
      logger.warn = original
    },
  }
}
