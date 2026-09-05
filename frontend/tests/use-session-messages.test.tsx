// `useSessionMessages`'s own wiring: what it asks the backend for on the
// initial load and on `loadOlder`, how the pages it gets back flatten, and
// the identity-stability `select` exists to guarantee.
//
// `getApiSessionsIdMessages` — the one generated client function this hook
// calls — is swapped out via `mock.module`, not the whole axios transport:
// this is the same seam kubb already exposes on every other generated call
// (`options.client`), just reached from the module side rather than a call
// site, so the request shape asserted below is the real one the hook builds,
// not a re-implementation of it. Everything else — react-query, the DOM — is
// real, matching tests/use-session-stream-hook.test.tsx's own rule about
// what gets faked and what does not.
//
// The streamed arrivals near the bottom go in through `appendStreamedMessage`
// — the real one, writing to the real client — rather than through the stream
// hook: what is under test there is what the *paginated cache* does to the
// flattened array a live arrival produces, and dragging an EventSource in
// would only add a way for the test to be about something else.

import { afterAll, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, memo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type Query = Record<string, unknown> | undefined
type Row = { id: string; sessionId: string; seq: number; type: string; parentToolUseId: string | null
  title: string | null; pending: boolean; payload: unknown; createdAt: string }

let n = 0
const msg = (seq: number): Row => ({
  id: `m${n++}`,
  sessionId: 's1',
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: {},
  createdAt: '2026-09-04T10:00:00.000Z',
})

let calls: Query[] = []
let respond: (query: Query) => { messages: Row[]; hasOlder: boolean }

const CLIENT_SPECIFIER = '@/shared/api/generated/clients/getApiSessionsIdMessages'

// Saved before mocking, so `afterAll` can put the real implementation back:
// `session-page.tsx` (and through it, `use-sessions.ts`) is on the router's
// static import graph that `workspace.test.tsx` pulls in for an unrelated
// reason, and `mock.module` replaces a specifier for every future importer in
// the process, not only this file's own dynamic import below.
const real = await import('../src/shared/api/generated/clients/getApiSessionsIdMessages')

/** Milliseconds the fake client stalls before answering. 0 for every test
 *  that is not about what happens *during* a fetch. */
let delay = 0

// Registered once, at module scope, before the dynamic import below resolves
// `use-sessions.ts` — the same ordering `tests/transcript-time.test.tsx` uses
// for its own module-identity plugin, and for the same reason: the mock has
// to be in place before anything imports the real module.
await mock.module(CLIENT_SPECIFIER, () => ({
  getApiSessionsIdMessages: async (opts: { query?: Query }) => {
    calls.push(opts.query)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    return { data: respond(opts.query) }
  },
}))

afterAll(() => {
  mock.module(CLIENT_SPECIFIER, () => real)
})

const { useSessionMessages, PAGE_SIZE } = await import('../src/features/sessions/hooks/use-sessions')
const { appendStreamedMessage, sessionMessagesKey } = await import(
  '../src/features/sessions/lib/message-cache'
)

type Result = ReturnType<typeof useSessionMessages>

let client: QueryClient
let container: HTMLDivElement
let root: Root
/** Every render of the probe, in order — including ones forced by `rerender`
 *  with nothing about the query changed, which is what the identity test
 *  needs to compare against. */
let renders: Result[]

/** Stands in for `Transcript`, which is `memo()`d on exactly this prop (see
 *  transcript.tsx). Counting its renders is the performance premise itself:
 *  a new array reference for an unchanged transcript re-renders it, and a
 *  re-render is a full `buildTranscript()` over every message in the session. */
let transcriptRenders = 0
const MemoTranscript = memo(function MemoTranscript({ messages }: { messages: Row[] }) {
  transcriptRenders++
  return <span>{messages.length}</span>
})

/** Set by the probe on every render, so a test can force a render that has
 *  nothing to do with the query — the composer keystroke, in the real page. */
let bump: (n: number) => void = () => {}

function Probe({ id }: { id: string }) {
  const result = useSessionMessages(id)
  const [unrelated, setUnrelated] = useState(0)
  bump = setUnrelated
  renders.push(result)
  return (
    <>
      <MemoTranscript messages={result.messages as Row[]} />
      <span>{unrelated}</span>
    </>
  )
}

async function mount(id = 's1') {
  n = 0
  calls = []
  renders = []
  transcriptRenders = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

/** Re-renders the same tree with nothing changed — a real render pass, not a
 *  reimplementation of one — so a claim like "the array is the same
 *  reference" is about what React actually produced. */
async function rerender(id = 's1') {
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

/** Polls rather than sleeping a fixed amount, matching every other async test
 *  in this suite: the fake queryFn resolves in a microtask, but react-query's
 *  own state update still needs a further tick to reach the rendered result. */
async function settle(until: () => boolean, ticks = 20) {
  for (let i = 0; i < ticks && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const latest = () => renders[renders.length - 1] as Result

// --- the initial load ---------------------------------------------------------

test('PAGE_SIZE is 100, the bounded-mode default the backend documents', () => {
  expect(PAGE_SIZE).toBe(100)
})

test('the initial load requests the newest PAGE_SIZE messages, with no cursor at all', async () => {
  respond = () => ({ messages: [msg(7), msg(8), msg(9)], hasOlder: false })
  await mount()

  await settle(() => latest().messages.length > 0)

  expect(calls).toEqual([{ limit: PAGE_SIZE }])
  expect(calls[0]).not.toHaveProperty('before')
  expect(latest().messages.map((m) => m.seq)).toEqual([7, 8, 9])
  expect(latest().hasOlder).toBe(false)
  expect(latest().isSuccess).toBe(true)
  await unmount()
})

// --- loadOlder, and the prepend it produces -----------------------------------

test('loadOlder requests before = the oldest loaded seq, and the pages flatten ascending', async () => {
  respond = (query) => {
    if (query?.before === undefined) {
      return { messages: [msg(100), msg(101)], hasOlder: true }
    }
    return { messages: Array.from({ length: 10 }, (_, i) => msg(90 + i)), hasOlder: false }
  }
  await mount()
  await settle(() => latest().messages.length > 0)

  expect(latest().messages.map((m) => m.seq)).toEqual([100, 101])
  expect(latest().hasOlder).toBe(true)

  const oldestSeq = latest().messages[0]?.seq
  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 2)

  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual({ before: oldestSeq, limit: PAGE_SIZE })

  // Ascending across the prepend: the older page's messages first, the page
  // that was already on screen last — never reversed, never interleaved.
  expect(latest().messages.map((m) => m.seq)).toEqual([
    90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101,
  ])
  expect(latest().hasOlder).toBe(false)
  await unmount()
})

// --- the identity-stability rule (see transcript.tsx's own memo comment) -----

test('two renders with no data change return the identical `messages` array', async () => {
  respond = () => ({ messages: [msg(1), msg(2)], hasOlder: false })
  await mount()
  await settle(() => latest().messages.length > 0)

  const before = latest().messages
  await rerender()

  // Not `toEqual`: the claim is reference identity, the property `Transcript`
  // is memoised on (see transcript.tsx) — a same-content-different-array
  // result would defeat that memo just as surely as a genuine change would.
  expect(latest().messages).toBe(before)
  // And the render actually happened, so this is not vacuously true.
  expect(renders.length).toBeGreaterThan(1)
  await unmount()
})

test('a render forced by a real data change does NOT keep the old array', async () => {
  // The converse of the test above: `select` must still recompute — not
  // cache forever — when the underlying `InfiniteData` genuinely changes.
  respond = () => ({ messages: [msg(1)], hasOlder: true })
  await mount()
  await settle(() => latest().messages.length > 0)
  const before = latest().messages

  respond = () => ({ messages: [msg(0)], hasOlder: false })
  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 1)

  expect(latest().messages).not.toBe(before)
  expect(latest().messages.map((m) => m.seq)).toEqual([0, 1])
  await unmount()
})

// --- where loadOlder stops ----------------------------------------------------

test('loadOlder with hasOlder already false asks the backend for nothing', async () => {
  respond = () => ({ messages: [msg(5)], hasOlder: false })
  await mount()
  await settle(() => latest().messages.length > 0)

  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => false, 4)

  // Still just the initial load: `getPreviousPageParam` returns undefined for
  // a first page that says there is nothing older, and react-query resolves
  // the fetch without calling the query function at all.
  expect(calls).toEqual([{ limit: PAGE_SIZE }])
  expect(latest().messages.map((m) => m.seq)).toEqual([5])
  await unmount()
})

test('an older page that comes back empty prepends nothing and ends the paging', async () => {
  // The backend cannot report `hasOlder` for a page it filled from fewer rows
  // than the limit, but it can be racing a delete: `before` returns nothing at
  // all. What must not happen is a duplicate, a reordering, or a second
  // request for the same cursor.
  respond = (query) =>
    query?.before === undefined
      ? { messages: [msg(5), msg(6)], hasOlder: true }
      : { messages: [], hasOlder: false }
  await mount()
  await settle(() => latest().messages.length > 0)

  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().hasOlder === false, 8)

  expect(calls).toEqual([{ limit: PAGE_SIZE }, { before: 5, limit: PAGE_SIZE }])
  expect(latest().messages.map((m) => m.seq)).toEqual([5, 6])
  expect(latest().hasOlder).toBe(false)

  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => false, 4)
  expect(calls).toHaveLength(2)
  await unmount()
})

test('paging twice follows the new oldest seq each time and stays contiguous', async () => {
  // Three pages, so `hasOlder` has to come from the page most recently
  // *prepended* rather than from the one that happened to be first when the
  // hook mounted — a stale read would leave this stuck at `true` at the end.
  respond = (query) => {
    if (query?.before === undefined) return { messages: [msg(20), msg(21)], hasOlder: true }
    if (query.before === 20) return { messages: [msg(18), msg(19)], hasOlder: true }
    return { messages: [msg(16), msg(17)], hasOlder: false }
  }
  await mount()
  await settle(() => latest().messages.length > 0)

  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 2)
  expect(latest().hasOlder).toBe(true)

  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 4)

  expect(calls).toEqual([
    { limit: PAGE_SIZE },
    { before: 20, limit: PAGE_SIZE },
    { before: 18, limit: PAGE_SIZE },
  ])
  expect(latest().messages.map((m) => m.seq)).toEqual([16, 17, 18, 19, 20, 21])
  expect(latest().hasOlder).toBe(false)
  await unmount()
})

test('two loadOlder calls in flight at once cost two requests but never duplicate a page', async () => {
  // react-query does not dedupe these: `fetchPreviousPage` defaults to
  // `cancelRefetch: true`, so the second call aborts the first and re-asks for
  // the same cursor. The cache survives it — which is why the duplicate is a
  // wasted round trip rather than a corrupted transcript — but the wasted trip
  // is real, and it is the reason session-page.tsx guards `requestOlder` with
  // a ref of its own rather than trusting `isLoadingOlder`. If that guard is
  // ever removed, this is the cost.
  respond = (query) =>
    query?.before === undefined
      ? { messages: [msg(10), msg(11)], hasOlder: true }
      : { messages: [msg(8), msg(9)], hasOlder: true }
  delay = 30
  await mount()
  await settle(() => latest().messages.length > 0)

  const both = [latest().loadOlder(), latest().loadOlder()]
  await act(async () => {
    await Promise.allSettled(both)
  })
  await settle(() => latest().messages.length > 2, 12)
  delay = 0

  expect(calls).toEqual([
    { limit: PAGE_SIZE },
    { before: 10, limit: PAGE_SIZE },
    { before: 10, limit: PAGE_SIZE },
  ])
  expect(latest().messages.map((m) => m.seq)).toEqual([8, 9, 10, 11])
  await unmount()
})

// --- the array identity Transcript is memoised on ------------------------------

test('a render caused by unrelated state does not re-render the memoised transcript', async () => {
  // The composer keystroke, in miniature: `SessionPage` re-renders on every
  // character typed, and each of those renders calls `useSessionMessages`
  // again. If that hands back a new array, `Transcript` re-renders and
  // rebuilds the whole tree for a transcript nothing changed about.
  respond = () => ({ messages: [msg(1), msg(2)], hasOlder: false })
  await mount()
  await settle(() => latest().messages.length > 0)

  const array = latest().messages
  const before = transcriptRenders
  const renderCount = renders.length

  await act(async () => {
    bump(1)
  })

  expect(renders.length).toBeGreaterThan(renderCount) // the render really happened
  expect(latest().messages).toBe(array)
  expect(transcriptRenders).toBe(before)
  await unmount()
})

test('a streamed message already present, unchanged, re-renders nothing at all', async () => {
  respond = () => ({ messages: [msg(1), msg(2)], hasOlder: false })
  await mount()
  await settle(() => latest().messages.length > 0)

  const array = latest().messages
  const before = transcriptRenders
  const renderCount = renders.length
  // A fresh JSON.parse of a row already cached — what a reconnecting stream
  // replays.
  const replayed = JSON.parse(JSON.stringify(array[0])) as Row

  await act(async () => {
    appendStreamedMessage(client, 's1', [replayed])
  })
  await settle(() => false, 4)

  expect(latest().messages).toBe(array)
  expect(transcriptRenders).toBe(before)
  // Not even a render of the hook's own component: the cache write returned
  // the identical `InfiniteData`, so no observer had anything to report.
  expect(renders).toHaveLength(renderCount)
  await unmount()
})

test('a genuinely new streamed message renders once, keeping every older element', async () => {
  // The converse: identity must not be so sticky that a real arrival is
  // missed, and the messages already on screen must not be reallocated around
  // it — react-query's structural sharing and `buildTranscript` both pay per
  // element that moved.
  respond = () => ({ messages: [msg(1), msg(2)], hasOlder: false })
  await mount()
  await settle(() => latest().messages.length > 0)

  const array = latest().messages
  const before = transcriptRenders

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(3)])
  })
  await settle(() => latest().messages.length > 2, 8)

  expect(latest().messages).not.toBe(array)
  expect(latest().messages.map((m) => m.seq)).toEqual([1, 2, 3])
  expect(latest().messages[0]).toBe(array[0])
  expect(latest().messages[1]).toBe(array[1])
  expect(transcriptRenders).toBe(before + 1)
  await unmount()
})

test('a streamed message lands in the last page, not in one that was prepended', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: [msg(30), msg(31)], hasOlder: true }
      : { messages: [msg(28), msg(29)], hasOlder: false }
  await mount()
  await settle(() => latest().messages.length > 0)
  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 2)

  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(32)])
  })
  await settle(() => latest().messages.length > 4, 8)

  const pages = client.getQueryData<{ pages: { messages: Row[] }[] }>(sessionMessagesKey('s1'))
  expect(pages?.pages.map((p) => p.messages.map((m) => m.seq))).toEqual([
    [28, 29],
    [30, 31, 32],
  ])
  expect(latest().messages.map((m) => m.seq)).toEqual([28, 29, 30, 31, 32])
  await unmount()
})

test('an out-of-order streamed arrival still flattens ascending across pages', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: [msg(30), msg(31)], hasOlder: true }
      : { messages: [msg(28), msg(29)], hasOlder: false }
  await mount()
  await settle(() => latest().messages.length > 0)
  await act(async () => {
    await latest().loadOlder()
  })
  await settle(() => latest().messages.length > 2)

  // One flush carrying a burst the backend emitted in order but SSE delivered
  // shuffled.
  await act(async () => {
    appendStreamedMessage(client, 's1', [msg(34), msg(32), msg(33)])
  })
  await settle(() => latest().messages.length > 6, 8)

  expect(latest().messages.map((m) => m.seq)).toEqual([28, 29, 30, 31, 32, 33, 34])
  await unmount()
})

// --- the mid-prepend race -----------------------------------------------------

// This used to be a defect: a message that arrived on the stream while a
// `loadOlder` fetch was in flight was dropped from the transcript for good.
//
// `infiniteQueryBehavior` (query-core) captures `context.state.data.pages` when
// the fetch *starts* and, on resolution, writes `addToStart(thosePages, page)`
// — so any `setQueryData` performed in between, from anywhere, is overwritten
// no matter how soon after. There was no message that could survive: the
// stream had already advanced `lastSeq` past it, so a reconnect asked the
// backend for `after=<that seq>` and never got it again, and the messages
// query is `staleTime: Infinity` with `refetchOnWindowFocus: false`, so
// nothing else re-fetched it either.
//
// What stops it now: `appendStreamedMessage` (message-cache.ts) checks
// `isFetchingOlderPage` before it writes. While a backward fetch is in
// flight it makes no write at all — nothing for the fetch's stale snapshot
// to clobber — and re-applies itself once the query cache reports the fetch
// has settled, merging onto whatever `loadOlder` just landed. That guard
// lives in `appendStreamedMessage` itself, not only in the stream's own
// call site, which is why this test can call it directly (as the rest of
// this file does, per the note above) and still exercise the real fix
// rather than a hook-level workaround that this particular call bypasses.
// `use-session-stream.ts` additionally checks the same flag before ever
// calling in here, so in the real stream a slow fetch coalesces every
// arrival into one write instead of one deferred retry per message.
//
// Was `test.failing`, promoted now that it passes: a regression here should
// fail the suite, not quietly keep "passing" as an expected failure.
test('DEFECT: a message streamed in mid-prepend is lost from the cache', async () => {
  respond = (query) =>
    query?.before === undefined
      ? { messages: [msg(10), msg(11)], hasOlder: true }
      : { messages: [msg(8), msg(9)], hasOlder: false }
  delay = 40
  await mount()
  await settle(() => latest().messages.length > 0)

  const older = latest().loadOlder()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
  // Exactly what the stream's per-frame flush does, at exactly the wrong
  // moment.
  appendStreamedMessage(client, 's1', [msg(12)])
  await act(async () => {
    await older
  })
  await settle(() => latest().messages.length > 3, 12)
  delay = 0

  expect(latest().messages.map((m) => m.seq)).toEqual([8, 9, 10, 11, 12])
  await unmount()
})
