// The reconnect policy around one container's log stream: exponential
// backoff on repeated failures, reset on a successful `open`, and — the one
// behaviour that must never regress alongside it — a server-sent `end`
// staying terminal rather than being treated as just another failure to
// retry.
//
// `setTimeout`/`clearTimeout` are faked for delays at retry scale (>= 1s) so
// the ~3s-30s backoff can be asserted on without a real test actually
// waiting that long; delays below that (this file's own microtask-flushing
// `frames()`, the same idiom as use-session-stream-hook.test.tsx) still run
// on the real timer, so those keep working unmodified. happy-dom supplies no
// `EventSource` either (verified there too), hence the fake below.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useContainerLogs } from '../src/features/docker/hooks/use-container-logs'

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
  open() {
    this.emit('open')
  }
  end(o: { reason: string; message: string | null } = { reason: 'closed', message: null }) {
    this.emit('end', new MessageEvent('end', { data: JSON.stringify(o) }))
  }
  emit(type: string, event: Event = new Event(type)) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource

// --- the stand-in for setTimeout/clearTimeout, for retry-scale delays only ---

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

interface ScheduledTimer {
  id: number
  delay: number
  callback: () => void
}

let scheduled: ScheduledTimer[] = []
let nextTimerId = 1

function fakeSetTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout> {
  // Only the hook's own retry ever schedules at this scale; every flush wait
  // in this file's own `frames()` uses a delay far below it, and is left to
  // the real timer so it keeps resolving on its own.
  if ((delay ?? 0) >= 1000) {
    const id = nextTimerId++
    scheduled.push({ id, delay: delay ?? 0, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  return realSetTimeout(callback, delay)
}

function fakeClearTimeout(id?: ReturnType<typeof setTimeout>): void {
  const index = scheduled.findIndex((s) => s.id === id)
  if (index !== -1) {
    scheduled.splice(index, 1)
    return
  }
  realClearTimeout(id as Parameters<typeof clearTimeout>[0])
}

/** Fires the oldest still-scheduled retry, as if its delay had elapsed —
 *  synchronously invokes the hook's own `connect()`, which opens the next
 *  `FakeEventSource` before this returns. */
function fireOldestRetry() {
  const next = scheduled.shift()
  if (!next) throw new Error('no retry was scheduled')
  next.callback()
}

let client: QueryClient
let container: HTMLDivElement
let root: Root
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let api: ReturnType<typeof useContainerLogs>

function Probe({ containerId }: { containerId: string }) {
  api = useContainerLogs('p1', containerId)
  return null
}

async function mount(containerId = 'c-web') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe containerId={containerId} />
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

/** Turn the animation-frame/microtask crank without waiting out any real
 *  retry-scale delay — see the module header for why that is safe here. */
async function frames(ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** Wraps a synchronous `FakeEventSource`/timer trigger in `act`, the same
 *  way this repo's own `click` helpers wrap a DOM `.click()` — the state
 *  updates these cause (`setConnected`, `setReconnecting`, ...) happen
 *  synchronously inside the listener, not deferred to a later frame the way
 *  use-session-stream.ts's own buffered message flow is. */
async function fire(fn: () => void) {
  await act(async () => {
    fn()
  })
}

const source = (i: number) => {
  const s = FakeEventSource.opened[i]
  if (!s) throw new Error(`no EventSource #${i} was constructed`)
  return s
}

beforeEach(() => {
  FakeEventSource.opened = []
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  scheduled = []
  nextTimerId = 1
  globalThis.setTimeout = fakeSetTimeout as typeof setTimeout
  globalThis.clearTimeout = fakeClearTimeout as typeof clearTimeout
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  client.clear()
})

afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

// --- backoff growth ------------------------------------------------------------

test('the retry backs off exponentially, doubling each further failure, capped at 30s', async () => {
  await mount()

  await fire(() => source(0).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([3000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(1).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([6000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(2).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([12000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(3).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([24000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(4).emit('error'))
  await frames()
  // 24000 * 2 = 48000, capped at 30000.
  expect(scheduled.map((s) => s.delay)).toEqual([30000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(5).emit('error'))
  await frames()
  // Stays at the ceiling, does not keep climbing.
  expect(scheduled.map((s) => s.delay)).toEqual([30000])

  await unmount()
})

// --- reset on a successful open --------------------------------------------------

test('a successful open resets the backoff to its base value, not wherever it had grown to', async () => {
  await mount()

  await fire(() => source(0).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([3000])

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(1).emit('error'))
  await frames()
  expect(scheduled.map((s) => s.delay)).toEqual([6000])

  await fire(fireOldestRetry)
  await frames()
  // A live connection — the cap (or whatever else was wrong) has cleared.
  await fire(() => source(2).open())
  await frames()
  expect(api.connected).toBe(true)

  await fire(() => source(2).emit('error'))
  await frames()
  // Back to the base delay, not 12000 (double the pre-open backoff).
  expect(scheduled.map((s) => s.delay)).toEqual([3000])

  await unmount()
})

// --- the `reconnecting` state --------------------------------------------------

test('reconnecting is false until a failure, true while a retry is pending, false again once reconnected', async () => {
  await mount()
  expect(api.reconnecting).toBe(false)

  await fire(() => source(0).emit('error'))
  await frames()
  expect(api.reconnecting).toBe(true)
  expect(api.connected).toBe(false)

  await fire(fireOldestRetry)
  await frames()
  await fire(() => source(1).open())
  await frames()
  expect(api.reconnecting).toBe(false)
  expect(api.connected).toBe(true)

  await unmount()
})

// --- `end` is terminal, never retried -------------------------------------------

test('a server-sent end frame is terminal: no retry is scheduled, and a further error does not reopen it', async () => {
  await mount()
  await fire(() => source(0).open())
  await frames()

  await fire(() => source(0).end({ reason: 'exited', message: null }))
  await frames()

  expect(api.ended).toEqual({ reason: 'exited', message: null })
  expect(scheduled).toHaveLength(0)

  // Nothing left listening for this in production (the source is closed),
  // but confirms the hook's own `closed` guard, not just that no frame
  // arrived to trigger it.
  await fire(() => source(0).emit('error'))
  await frames()
  expect(scheduled).toHaveLength(0)
  expect(FakeEventSource.opened).toHaveLength(1)

  await unmount()
})

// --- unmounting leaves no reconnect behind --------------------------------------

test('unmounting while a retry is pending cancels it — no reconnect outlives the component', async () => {
  await mount()
  await fire(() => source(0).emit('error'))
  await frames()
  expect(scheduled).toHaveLength(1)

  await unmount()

  expect(scheduled).toHaveLength(0)
  expect(FakeEventSource.opened).toHaveLength(1)
})
