// The hook around the merge: what it connects to, when, and how many times it
// writes to the cache.
//
// happy-dom supplies no `EventSource` (verified: `typeof EventSource ===
// 'undefined'` under this setup), so one is installed here. It is deliberately
// the *only* fake: the QueryClient is real, `requestAnimationFrame` is
// happy-dom's own, and every assertion below is about the real cache or about
// the URL the hook asked the browser for — never about the stand-in itself.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionStream } from '../src/features/sessions/hooks/use-session-stream'
import type { MessagesData } from '../src/features/sessions/lib/message-cache'
import { sessionMessagesKey } from '../src/features/sessions/lib/message-cache'
import { getApiSessionsIdQueryKey } from '../src/shared/api/generated/hooks/useGetApiSessionsId'

type M = { id: string; sessionId: string; seq: number; type: string; parentToolUseId: string | null
  title: string | null; pending: boolean; payload: unknown; createdAt: string }

const msg = (seq: number, o: Partial<M> = {}): M => ({
  id: `m${seq}`,
  sessionId: 's1',
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: { message: { content: [{ type: 'text', text: `body ${seq}` }] } },
  createdAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

// --- the stand-in for the browser's EventSource -------------------------------

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
  /** Deliver one SSE frame, in the shape the backend publishes. */
  message(message: M) {
    this.emit('message', new MessageEvent('message', { data: JSON.stringify({ message }) }))
  }
  emit(type: string, event: Event = new Event(type)) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource

const MESSAGES_KEY = sessionMessagesKey('s1')
const OTHER_KEY = sessionMessagesKey('s2')
const SESSION_KEY = getApiSessionsIdQueryKey({ path: { id: 's1' } })

/** A single-page `InfiniteData`, the shape every seed below stood in for
 *  before pagination — a stream arrival always merges into the last page
 *  (see message-cache.ts), and every test here is seeded with just the one. */
const page = (messages: M[]): MessagesData => ({
  pages: [{ messages, hasOlder: false }],
  pageParams: [undefined],
})

let client: QueryClient
let container: HTMLDivElement
let root: Root
/** Every setQueryData the hook performs, counted through the real client. */
let writes: Array<MessagesData | undefined>

beforeEach(() => {
  FakeEventSource.opened = []
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  writes = []
  const setQueryData = client.setQueryData.bind(client)
  client.setQueryData = ((...args: Parameters<typeof setQueryData>) => {
    const out = setQueryData(...args)
    writes.push(out as MessagesData | undefined)
    return out
  }) as typeof client.setQueryData
})

afterEach(() => {
  client.clear()
})

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

function Probe({ id, enabled }: { id: string; enabled: boolean }) {
  useSessionStream(id, enabled)
  return null
}

async function mount(props: { id: string; enabled: boolean }) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe {...props} />
      </QueryClientProvider>,
    )
  })
}

async function rerender(props: { id: string; enabled: boolean }) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe {...props} />
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

/** Turn the animation-frame crank. Polls rather than sleeping a fixed amount:
 *  happy-dom's rAF is a timer, and a fixed sleep would be a coin flip. */
async function frames(until: () => boolean = () => false, ticks = 60) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    if (until()) return
  }
}

/** The raw `InfiniteData` object, for assertions about the cache's own
 *  identity rather than its contents. */
const rawCached = () => client.getQueryData<MessagesData>(MESSAGES_KEY)
const cached = () => rawCached()?.pages.flatMap((p) => p.messages)
const source = (i = 0) => {
  const s = FakeEventSource.opened[i]
  if (!s) throw new Error(`no EventSource #${i} was constructed`)
  return s
}

// --- 1. the gate --------------------------------------------------------------

test('enabled: false constructs no EventSource at all', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0), msg(1)]))
  writes = []

  await mount({ id: 's1', enabled: false })
  await frames()

  expect(FakeEventSource.opened).toHaveLength(0)
  expect(writes).toHaveLength(0)
  await unmount()
})

test('flipping enabled to true opens exactly one stream, from the highest cached seq', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0), msg(1), msg(40), msg(41)]))
  writes = []

  await mount({ id: 's1', enabled: false })
  expect(FakeEventSource.opened).toHaveLength(0)

  await rerender({ id: 's1', enabled: true })

  expect(FakeEventSource.opened).toHaveLength(1)
  expect(source().url).toBe('/api/sessions/s1/events?after=41')
  // The bug being fixed: -1 is what makes the backend replay the transcript.
  expect(source().url).not.toContain('after=-1')
  await unmount()
})

test('the cursor is the highest seq, not the last element, if the cache is unsorted', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(9), msg(3), msg(7)]))
  await mount({ id: 's1', enabled: true })
  expect(source().url).toBe('/api/sessions/s1/events?after=9')
  await unmount()
})

test('an empty cache falls back to after=-1, and only then', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })
  expect(source().url).toBe('/api/sessions/s1/events?after=-1')
  await unmount()
})

test('the cursor is read from this session key, not from another session in the cache', async () => {
  client.setQueryData(OTHER_KEY, page([msg(500, { sessionId: 's2' })]))
  client.setQueryData(MESSAGES_KEY, page([msg(2)]))
  await mount({ id: 's1', enabled: true })
  expect(source().url).toBe('/api/sessions/s1/events?after=2')
  await unmount()
})

test('changing session id closes the old stream and opens the new one at its own cursor', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(4)]))
  client.setQueryData(OTHER_KEY, page([msg(11, { sessionId: 's2' })]))

  await mount({ id: 's1', enabled: true })
  expect(source(0).url).toBe('/api/sessions/s1/events?after=4')

  await rerender({ id: 's2', enabled: true })

  expect(FakeEventSource.opened).toHaveLength(2)
  expect(source(0).closed).toBe(true)
  expect(source(1).url).toBe('/api/sessions/s2/events?after=11')
  await unmount()
})

// --- 2. coalescing: nothing lost, nothing doubled ------------------------------

test('a burst inside one frame is a single cache write carrying all of it', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0)]))
  writes = []
  await mount({ id: 's1', enabled: true })

  // Five arrivals with no frame in between, as a running agent emits them.
  for (let seq = 1; seq <= 5; seq++) source().message(msg(seq))
  expect(writes).toHaveLength(0) // nothing written yet: still buffered

  await frames(() => writes.length > 0)
  // A further settle, so a second flush would have had every chance to land.
  await frames(() => false, 12)

  expect(writes).toHaveLength(1)
  expect(cached()?.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5])
  await unmount()
})

test('two bursts separated by a frame are two writes, and nothing is duplicated', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  writes = []
  await mount({ id: 's1', enabled: true })

  source().message(msg(0))
  source().message(msg(1))
  await frames(() => writes.length > 0)

  source().message(msg(2))
  await frames(() => writes.length > 1)
  await frames(() => false, 12)

  expect(writes).toHaveLength(2)
  expect(cached()?.map((m) => m.seq)).toEqual([0, 1, 2])
  await unmount()
})

test('messages still buffered at unmount are not dropped', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0)]))
  writes = []
  await mount({ id: 's1', enabled: true })

  source().message(msg(1))
  source().message(msg(2))
  expect(cached()?.map((m) => m.seq)).toEqual([0]) // still in the ref

  await unmount()

  expect(writes).toHaveLength(1)
  expect(cached()?.map((m) => m.seq)).toEqual([0, 1, 2])
})

test('the flush at unmount does not fire a second time from the cancelled frame', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  writes = []
  await mount({ id: 's1', enabled: true })
  source().message(msg(0))
  await unmount()

  await frames(() => false, 12)
  expect(writes).toHaveLength(1)
  expect(cached()?.map((m) => m.seq)).toEqual([0])
})

test('the same message delivered twice on one connection lands once', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })

  source().message(msg(3))
  await frames(() => (cached()?.length ?? 0) > 0)
  source().message(msg(3))
  await frames(() => false, 12)

  expect(cached()?.map((m) => m.seq)).toEqual([3])
  await unmount()
})

test('out-of-order arrivals in one burst reach the cache ascending', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })

  for (const seq of [5, 2, 4, 1, 3]) source().message(msg(seq))
  await frames(() => (cached()?.length ?? 0) === 5)

  expect(cached()?.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
  await unmount()
})

test('a hundred messages across many frames arrive exactly once each', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })

  for (let seq = 0; seq < 100; seq++) {
    source().message(msg(seq))
    if (seq % 10 === 9) await frames(() => false, 1)
  }
  await frames(() => (cached()?.length ?? 0) === 100)

  const seqs = cached()?.map((m) => m.seq) ?? []
  expect(seqs).toHaveLength(100)
  expect(new Set(seqs).size).toBe(100)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  await unmount()
})

// --- 3. the error branch -------------------------------------------------------

test('an error closes the source but does not throw away what is already buffered', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  writes = []
  await mount({ id: 's1', enabled: true })

  source().message(msg(0))
  source().message(msg(1))
  source().emit('error')

  expect(source().closed).toBe(true)
  await frames(() => writes.length > 0)
  expect(cached()?.map((m) => m.seq)).toEqual([0, 1])
  await unmount()
})

test('an error does not immediately reopen: the retry is on a timer', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })
  source().emit('error')
  await frames(() => false, 12) // ~60ms, far short of the 3s backoff
  expect(FakeEventSource.opened).toHaveLength(1)
  await unmount()
})

test('unmounting after an error leaves no reconnect behind', async () => {
  client.setQueryData(MESSAGES_KEY, page([]))
  await mount({ id: 's1', enabled: true })
  source().emit('error')
  await unmount()

  await frames(() => false, 12)
  expect(FakeEventSource.opened).toHaveLength(1)
})

test('a malformed frame is not silently swallowed into the cache', async () => {
  // JSON.parse throws inside the listener; what must not happen is a partial
  // or garbage row reaching the transcript.
  client.setQueryData(MESSAGES_KEY, page([msg(0)]))
  await mount({ id: 's1', enabled: true })

  expect(() =>
    source().emit('message', new MessageEvent('message', { data: 'not json' })),
  ).toThrow()
  await frames(() => false, 8)

  expect(cached()?.map((m) => m.seq)).toEqual([0])
  await unmount()
})

test('a frame with no message field writes nothing', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0)]))
  writes = []
  await mount({ id: 's1', enabled: true })

  source().emit('message', new MessageEvent('message', { data: JSON.stringify({ kind: 'ping' }) }))
  await frames(() => false, 8)

  expect(writes).toHaveLength(0)
  expect(cached()?.map((m) => m.seq)).toEqual([0])
  await unmount()
})

// --- 4. the session row --------------------------------------------------------

test('a status event invalidates the session query, not the transcript', async () => {
  client.setQueryData(MESSAGES_KEY, page([msg(0)]))
  client.setQueryData(SESSION_KEY, { id: 's1', status: 'idle' })
  // The raw `InfiniteData` object, not `cached()`: that helper's own
  // `flatMap` allocates a fresh array on every call, so comparing its output
  // by reference would fail even when the cache was genuinely untouched.
  const before = rawCached()
  await mount({ id: 's1', enabled: true })

  source().emit('status')
  await frames(() => false, 4)

  expect(client.getQueryState(SESSION_KEY)?.isInvalidated).toBe(true)
  expect(client.getQueryState(MESSAGES_KEY)?.isInvalidated).toBe(false)
  expect(rawCached()).toBe(before)
  await unmount()
})
