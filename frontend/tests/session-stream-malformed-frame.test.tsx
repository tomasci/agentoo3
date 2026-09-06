// The other half of the crash question: can the *stream* put a non-array, or
// a NaN-poisoned cursor, into the cache?
//
// use-session-stream.ts's `message` listener used to do `JSON.parse(event.data)`
// and push `parsed.message` straight into the merge buffer on nothing more than
// a truthy check — no check that it was an object, that it had a `seq`, or that
// it was a single message rather than a whole page or a batch. A seq-less
// arrival made `newestCachedSeq` (message-cache.ts) return `NaN`, and the
// backend treats a non-finite `after` as `after=-1` — a full replay of the
// transcript on every reconnect from then on.
//
// streamed-message.ts closes that hole: every arrival is validated before it
// reaches `append`, and anything that fails is dropped and logged instead
// (see tests/streamed-message.test.ts for that function exercised directly,
// including the logging). What this file exercises is the fact that actually
// matters at the hook level — the effect a malformed frame has (or, now,
// doesn't have) on the real cache and the real reconnect URL — through the
// real hook, with only `EventSource` faked, matching
// tests/use-session-stream-hook.test.tsx's own rule about what gets faked and
// what does not.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionStream } from '../src/features/sessions/hooks/use-session-stream'
import {
  type MessagesData,
  newestCachedSeq,
  sessionMessagesKey,
} from '../src/features/sessions/lib/message-cache'

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
  payload: { message: { content: [{ type: 'text', text: `body ${seq}` }] } },
  createdAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

/** A raw Drizzle row: what service.ts and session-run.worker.ts actually
 *  publish, with no `files` key at all — see streamed-message.ts's own doc
 *  comment on why the schema cannot require it. */
const rawRowMsg = (seq: number): M => msg(seq)

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
  /** One frame, exactly as the wire carries it: a `data:` string, nothing more. */
  frame(data: string) {
    for (const fn of [...(this.listeners.get('message') ?? [])]) {
      fn(new MessageEvent('message', { data }))
    }
  }
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new Event(type))
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
const KEY = sessionMessagesKey('s1')

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

function Probe() {
  useSessionStream('s1', true)
  return null
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  const source = FakeEventSource.opened.at(-1)
  if (!source) throw new Error('the hook opened no EventSource')
  return source
}

async function unmount() {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** Deliver one raw frame and let the rAF-batched flush run. */
async function deliver(source: FakeEventSource, data: string) {
  await act(async () => {
    source.frame(data)
  })
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

const seedOnePage = (messages: M[]) =>
  client.setQueryData(KEY, { pages: [{ messages, hasOlder: false }], pageParams: [undefined] })

const pages = () => (client.getQueryData(KEY) as MessagesData | undefined)?.pages
const tail = () => pages()?.at(-1)?.messages as unknown

// --- what a malformed frame can no longer do to the cache ----------------------

test('a frame whose message is a page envelope is dropped, not appended verbatim', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: { messages: [msg(1)], hasOlder: false } }))

  // Rejected by streamed-message.ts (no `seq`, no `id`, ...) rather than
  // landing in the tail array as a nonsense element.
  expect(tail()).toEqual([msg(0)])

  await unmount()
})

test('a frame whose message is an ARRAY of messages is dropped, not nested as one element', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: [msg(1), msg(2)] }))

  expect(tail()).toEqual([msg(0)])

  await unmount()
})

test('a frame whose message is a bare string is dropped, not appended as a string element', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: 'hello' }))

  expect(tail()).toEqual([msg(0)])

  await unmount()
})

test('falsy and empty message values are all dropped', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  for (const data of ['{"message":null}', '{"message":0}', '{"message":""}', '{"message":false}', '{}']) {
    await deliver(source, data)
  }

  expect(tail()).toEqual([msg(0)])

  await unmount()
})

test('NO stream frame, malformed or not, ever leaves page.messages as a non-array', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  for (const data of [
    JSON.stringify({ message: { messages: [msg(1)], hasOlder: false } }),
    JSON.stringify({ message: [msg(2), msg(3)] }),
    JSON.stringify({ message: 'a string' }),
    JSON.stringify({ message: 12345 }),
    JSON.stringify({ message: true }),
    'not json at all',
  ]) {
    await deliver(source, data)
  }

  for (const page of pages() ?? []) expect(Array.isArray(page.messages)).toBe(true)
  // And nothing malformed got through at all: the seed is still all there is.
  expect(tail()).toEqual([msg(0)])

  await unmount()
})

// --- the bug the hole actually caused: the NaN reconnect cursor ---------------

test('a seq-less arrival no longer poisons the reconnect cursor: newestCachedSeq stays a real number', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  // The exact shape from the incident: a `message` with no `seq` on it.
  await deliver(source, JSON.stringify({ message: { messages: [], hasOlder: false } }))

  expect(newestCachedSeq(client, 's1')).toBe(0)
  expect(Number.isNaN(newestCachedSeq(client, 's1'))).toBe(false)

  await unmount()
})

test('after a malformed arrival, the next reconnect still asks for the real last seq, never after=NaN', async () => {
  seedOnePage([msg(0), msg(1)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: { messages: [], hasOlder: false } }))

  // Force a reconnect the way a dropped connection does.
  await act(async () => {
    source.emit('error')
  })
  await unmount()

  // Remount: the effect re-seeds lastSeq from newestCachedSeq.
  const next = await mount()
  expect(next.url).toBe('/api/sessions/s1/events?after=1')

  await unmount()
})

// --- what still lands: the fix must not take real messages down with it ------

test('a raw-row message (no files key) still lands — the shape service.ts and session-run.worker.ts actually publish', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: rawRowMsg(1) }))

  expect(tail()).toEqual([msg(0), rawRowMsg(1)])

  await unmount()
})

test('a valid message keeps advancing the reconnect cursor normally', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: msg(1) }))
  expect(newestCachedSeq(client, 's1')).toBe(1)

  await unmount()
})

test('a malformed arrival does not stop the stream: a valid message right after it still lands', async () => {
  seedOnePage([msg(0)])
  const source = await mount()

  await deliver(source, JSON.stringify({ message: { messages: [], hasOlder: false } }))
  await deliver(source, JSON.stringify({ message: msg(1) }))

  expect(tail()).toEqual([msg(0), msg(1)])

  await unmount()
})
