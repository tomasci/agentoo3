// message-cache.ts is the only code that knows the cached shape — an
// `InfiniteData` of `{ messages, hasOlder }` pages under one key per session.
// These tests exercise that ownership directly: the key it hands out, how it
// finds the highest loaded seq across however many pages are cached, and how
// a streamed arrival lands in the cache without disturbing pages it did not
// touch.
//
// See use-session-stream.test.ts for `mergeSessionMessages` itself (the flat,
// per-page merge this module applies to the last page), and
// use-session-stream-hook.test.tsx for the hook that drives `appendStreamedMessage`
// and `newestCachedSeq` from a live EventSource.

import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import {
  appendStreamedMessage,
  type MessagesData,
  newestCachedSeq,
  sessionMessagesKey,
} from '../src/features/sessions/lib/message-cache'

type M = Parameters<typeof appendStreamedMessage>[2][number]

let n = 0
const msg = (seq: number, o: Partial<M> = {}): M =>
  ({
    id: `m${n++}`,
    sessionId: 's1',
    seq,
    type: 'assistant',
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: {},
    createdAt: '2026-09-04T10:00:00.000Z',
    ...o,
  }) as M

const page = (messages: M[], hasOlder = false) => ({ messages, hasOlder })

const client = () => new QueryClient()

// --- the key --------------------------------------------------------------

test('the key is derived from path only, with no query folded in', () => {
  const key = sessionMessagesKey('s1')
  expect(key).toEqual([{ url: '/api/sessions/:id/messages', params: { id: 's1' } }, 'infinite'])
})

test('two different sessions get two different keys', () => {
  expect(sessionMessagesKey('s1')).not.toEqual(sessionMessagesKey('s2'))
})

// --- newestCachedSeq --------------------------------------------------------

test('nothing cached at all is -1', () => {
  expect(newestCachedSeq(client(), 's1')).toBe(-1)
})

test('a single cached page with no messages is -1', () => {
  const qc = client()
  qc.setQueryData(sessionMessagesKey('s1'), { pages: [page([])], pageParams: [undefined] })
  expect(newestCachedSeq(qc, 's1')).toBe(-1)
})

test('the highest seq wins, not the last page or the last element', () => {
  const qc = client()
  qc.setQueryData(sessionMessagesKey('s1'), {
    pages: [page([msg(9), msg(3)]), page([msg(41), msg(40)])],
    pageParams: [undefined, 9],
  })
  expect(newestCachedSeq(qc, 's1')).toBe(41)
})

test('reads the session named, not another one sharing the cache', () => {
  const qc = client()
  qc.setQueryData(sessionMessagesKey('s1'), { pages: [page([msg(2)])], pageParams: [undefined] })
  qc.setQueryData(sessionMessagesKey('s2'), { pages: [page([msg(500)])], pageParams: [undefined] })
  expect(newestCachedSeq(qc, 's1')).toBe(2)
})

// --- appendStreamedMessage ---------------------------------------------------

test('lands in the last page, leaving earlier pages untouched by reference', () => {
  const qc = client()
  const key = sessionMessagesKey('s1')
  const firstPage = page([msg(0), msg(1)], true)
  qc.setQueryData(key, { pages: [firstPage, page([msg(40), msg(41)])], pageParams: [undefined, 0] })

  appendStreamedMessage(qc, 's1', [msg(42)])

  const data = qc.getQueryData<MessagesData>(key)
  expect(data?.pages[0]).toBe(firstPage) // untouched page keeps its own reference
  expect(data?.pages[1]?.messages.map((m) => m.seq)).toEqual([40, 41, 42])
})

test('a no-op arrival (already-seen seq, unchanged) keeps the whole InfiniteData reference', () => {
  const qc = client()
  const key = sessionMessagesKey('s1')
  const existing = msg(5)
  qc.setQueryData(key, { pages: [page([existing])], pageParams: [undefined] })
  const before = qc.getQueryData<MessagesData>(key)

  // A distinct object, same scalars — exactly what a replayed SSE frame looks
  // like (a fresh JSON.parse of the same payload).
  appendStreamedMessage(qc, 's1', [{ ...existing }])

  expect(qc.getQueryData<MessagesData>(key)).toBe(before)
})

test('an absent cache is seeded with one page rather than the arrival being dropped', () => {
  const qc = client()
  appendStreamedMessage(qc, 's1', [msg(0), msg(1)])
  const data = qc.getQueryData<MessagesData>(sessionMessagesKey('s1'))
  expect(data?.pages).toHaveLength(1)
  expect(data?.pages[0]?.messages.map((m) => m.seq)).toEqual([0, 1])
  expect(data?.pages[0]?.hasOlder).toBe(false)
})

test('an empty arrival is a no-op, keeping the same reference', () => {
  const qc = client()
  const key = sessionMessagesKey('s1')
  qc.setQueryData(key, { pages: [page([msg(0)])], pageParams: [undefined] })
  const before = qc.getQueryData<MessagesData>(key)

  appendStreamedMessage(qc, 's1', [])

  expect(qc.getQueryData<MessagesData>(key)).toBe(before)
})

test("does not touch another session's cache entry", () => {
  const qc = client()
  const other = page([msg(500, { sessionId: 's2' })])
  qc.setQueryData(sessionMessagesKey('s2'), { pages: [other], pageParams: [undefined] })

  appendStreamedMessage(qc, 's1', [msg(0)])

  expect(qc.getQueryData<MessagesData>(sessionMessagesKey('s2'))?.pages[0]).toBe(other)
})

// --- the module's own identity contract, isolated from react-query's --------
//
// The identity assertions above are all true, but they are not proof
// that *this module* is what makes them true: `setQueryData` runs whatever the
// updater returns through `replaceEqualDeep` (structural sharing, on by
// default), which hands back the previous object whenever the new one is
// deeply equal. Rewrite `appendStreamedMessage` to rebuild the whole
// `InfiniteData` on every arrival and those tests still pass — verified by
// doing it.
//
// What that safety net costs is the thing this module exists to avoid: a deep
// walk of a freshly parsed arrival, `payload` and all, for every message a
// reconnecting stream replays. So these two pin the short-circuits directly,
// on a client with the net taken away. The app's own client keeps the default;
// `structuralSharing: false` here is the isolation, not a claim about
// production.

const bareClient = () =>
  new QueryClient({ defaultOptions: { queries: { structuralSharing: false } } })

test('a replayed arrival is short-circuited by this module, not by structural sharing', () => {
  const qc = bareClient()
  const key = sessionMessagesKey('s1')
  const existing = msg(5)
  const onlyPage = page([existing])
  qc.setQueryData(key, { pages: [onlyPage], pageParams: [undefined] })
  const before = qc.getQueryData<MessagesData>(key)

  appendStreamedMessage(qc, 's1', [{ ...existing }])

  expect(qc.getQueryData<MessagesData>(key)).toBe(before)
  expect(qc.getQueryData<MessagesData>(key)?.pages[0]).toBe(onlyPage)
})

test('an append rebuilds only the last page, again without structural sharing helping', () => {
  const qc = bareClient()
  const key = sessionMessagesKey('s1')
  const firstPage = page([msg(0), msg(1)], true)
  const lastPage = page([msg(40)])
  qc.setQueryData(key, { pages: [firstPage, lastPage], pageParams: [undefined, 0] })

  appendStreamedMessage(qc, 's1', [msg(41)])

  const data = qc.getQueryData<MessagesData>(key)
  expect(data?.pages[0]).toBe(firstPage)
  expect(data?.pages[1]).not.toBe(lastPage)
  expect(data?.pages[1]?.messages.map((m) => m.seq)).toEqual([40, 41])
})
