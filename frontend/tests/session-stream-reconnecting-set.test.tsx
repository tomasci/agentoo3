// use-session-stream.ts's half of the status bar's "Reconnecting…" line: the
// hook writes this session's id into shared/store/connection.ts's
// `reconnectingStreamsAtom` while its stream is in the "erroring, retry
// scheduled" state, and nowhere else.
//
//   - the FIRST attempt, not yet opened or errored, is merely connecting: the
//     id is not in the set;
//   - an `error` (first attempt or later) puts it in, and a retry is scheduled
//     on the hook's real 3s timer;
//   - the next `open` takes it out;
//   - unmount, a `sessionId` change or `enabled` going false take it out even
//     if it was in.
//
// Driven the way tests/session-stream-reconnect-cursor.test.tsx drives it —
// the real hook, a real QueryClient, only `EventSource` faked — plus a private
// Jotai `createStore()` behind a Provider, so the set read here is exactly the
// one the hook wrote and nothing another file left in the default store.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionStream } from '../src/features/sessions/hooks/use-session-stream'
import { sessionMessagesKey } from '../src/features/sessions/lib/message-cache'
import {
  addReconnectingStreamAtom,
  reconnectingStreamsAtom,
} from '../src/shared/store/connection'

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
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new Event(type))
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource

let client: QueryClient
let store: ReturnType<typeof createStore>
let container: HTMLDivElement
let root: Root | undefined
let lastConnected: boolean | undefined

beforeEach(() => {
  FakeEventSource.opened = []
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  store = createStore()
  lastConnected = undefined
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    container.remove()
  }
  client.clear()
})

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

function Probe({ id, enabled }: { id: string; enabled: boolean }) {
  lastConnected = useSessionStream(id, enabled).connected
  return null
}

function tree(id: string, enabled: boolean) {
  return (
    <JotaiProvider store={store}>
      <QueryClientProvider client={client}>
        <Probe id={id} enabled={enabled} />
      </QueryClientProvider>
    </JotaiProvider>
  )
}

async function mount(id = 's1', enabled = true) {
  client.setQueryData(sessionMessagesKey(id), {
    pages: [{ messages: [], hasOlder: false }],
    pageParams: [undefined],
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(tree(id, enabled))
  })
}

async function rerender(id: string, enabled = true) {
  await act(async () => {
    root?.render(tree(id, enabled))
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container.remove()
}

async function emit(s: FakeEventSource, type: string) {
  await act(async () => {
    s.emit(type)
  })
}

/** Polls rather than sleeping — the retry is a real 3s `setTimeout`. */
async function until(cond: () => boolean, ms = 6000) {
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

const reconnecting = () => [...store.get(reconnectingStreamsAtom)].sort()

// --- first attempt ------------------------------------------------------------

test('the first attempt, still connecting, does not put the id in the set', async () => {
  await mount('s1')
  expect(FakeEventSource.opened).toHaveLength(1)
  expect(reconnecting()).toEqual([])
  // Still not after some real time passes with no open/error either.
  await until(() => false, 100)
  expect(reconnecting()).toEqual([])
})

test('a first attempt that opens never puts the id in the set', async () => {
  await mount('s1')
  await emit(source(0), 'open')
  expect(reconnecting()).toEqual([])
  expect(lastConnected).toBe(true)
})

test('a first attempt that errors immediately (never opened) does count', async () => {
  await mount('s1')
  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['s1'])
  expect(lastConnected).toBe(false)
  expect(source(0).closed).toBe(true)
})

test('enabled: false opens nothing and adds nothing', async () => {
  await mount('s1', false)
  expect(FakeEventSource.opened).toHaveLength(0)
  expect(reconnecting()).toEqual([])
})

// --- error -> retry -> open ---------------------------------------------------

test('an error after a successful open puts the id in the set; the retry stays in it until its own open', async () => {
  await mount('s1')
  await emit(source(0), 'open')
  expect(lastConnected).toBe(true)

  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['s1'])
  expect(lastConnected).toBe(false)
  // No immediate reopen: the retry is on the timer.
  expect(FakeEventSource.opened).toHaveLength(1)

  const started = Date.now()
  await until(() => FakeEventSource.opened.length > 1)
  const waited = Date.now() - started
  expect(FakeEventSource.opened).toHaveLength(2)
  // ~3s: well clear of "immediately", well short of anything like 15s.
  expect(waited).toBeGreaterThanOrEqual(2500)
  expect(source(1).url).toBe('/api/sessions/s1/events?after=-1')

  // The retry is connecting, not connected: still reconnecting.
  expect(reconnecting()).toEqual(['s1'])

  await emit(source(1), 'open')
  expect(reconnecting()).toEqual([])
  expect(lastConnected).toBe(true)
}, 15_000)

test('a retry that errors again keeps the id in the set, without churning a new Set', async () => {
  await mount('s1')
  await emit(source(0), 'error')
  const first = store.get(reconnectingStreamsAtom)
  await until(() => FakeEventSource.opened.length > 1)
  await emit(source(1), 'error')
  expect(reconnecting()).toEqual(['s1'])
  expect(store.get(reconnectingStreamsAtom) === first).toBe(true)
}, 15_000)

// --- teardown -----------------------------------------------------------------

test('unmount while reconnecting removes the id', async () => {
  await mount('s1')
  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['s1'])
  await unmount()
  expect(reconnecting()).toEqual([])
})

test('an error arriving after unmount does not re-add the id', async () => {
  await mount('s1')
  const s = source(0)
  await unmount()
  await emit(s, 'error')
  expect(reconnecting()).toEqual([])
})

test('changing sessionId removes the old id, and the new first attempt is not reconnecting', async () => {
  await mount('s1')
  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['s1'])

  client.setQueryData(sessionMessagesKey('s2'), {
    pages: [{ messages: [], hasOlder: false }],
    pageParams: [undefined],
  })
  await rerender('s2')
  expect(source(0).closed).toBe(true)
  expect(source(1).url).toBe('/api/sessions/s2/events?after=-1')
  expect(reconnecting()).toEqual([])

  await emit(source(1), 'error')
  expect(reconnecting()).toEqual(['s2'])
})

test('enabled going false while reconnecting removes the id', async () => {
  await mount('s1')
  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['s1'])
  await rerender('s1', false)
  expect(reconnecting()).toEqual([])
})

test("this hook's writes never touch another stream's key", async () => {
  store.set(addReconnectingStreamAtom, 'other')
  await mount('s1')
  expect(reconnecting()).toEqual(['other'])
  await emit(source(0), 'error')
  expect(reconnecting()).toEqual(['other', 's1'])
  await unmount()
  expect(reconnecting()).toEqual(['other'])
})
