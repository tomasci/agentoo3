// The merge that every stream arrival goes through, exercised as a pure
// function.
//
// Identity is the load-bearing property, in two layers. `Transcript` is
// `memo()`d on the messages array, so a new array for a message the reader
// already had rebuilds the whole tree (`buildTranscript` over every message in
// the session). And react-query's default structural sharing —
// `replaceEqualDeep`, applied to everything `setQueryData` returns — opens with
// `if (a === b) return a` and short-circuits per element on `aItem === bItem`;
// so an array that keeps its own reference skips the deep walk entirely, and
// one that keeps its untouched *elements'* references pays a pointer compare
// per message instead of a walk of payloads that can be megabytes of Bash
// output. Allocating a new array, or new elements, defeats both.
//
// See use-session-stream-hook.test.tsx for the hook around it: gating, the
// `after=` cursor, and the per-frame coalescing.

import { expect, test } from 'bun:test'
import { mergeSessionMessages } from '../src/features/sessions/lib/message-cache'

type M = Parameters<typeof mergeSessionMessages>[1][number]

let n = 0
const msg = (o: Partial<M> & { seq: number }): M =>
  ({
    id: `m${n++}`,
    sessionId: 's',
    type: 'assistant',
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: {},
    createdAt: '2026-09-04T10:00:00.000Z',
    ...o,
  }) as M

/** A transcript of `count` messages, each with its own payload, as the initial
 *  REST fetch would leave it in the cache. */
const transcript = (count: number): M[] => {
  n = 0
  return Array.from({ length: count }, (_, i) =>
    msg({
      seq: i,
      type: i % 3 === 0 ? 'assistant' : 'user',
      title: i % 4 === 0 ? `step ${i}` : null,
      payload: { message: { content: [{ type: 'text', text: `body ${i}` }] } },
      createdAt: `2026-09-04T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
    }),
  )
}

/** What a second delivery of the same rows looks like on the wire: distinct
 *  objects (a fresh `JSON.parse` per event), identical fields. */
const rewire = (list: M[]): M[] => JSON.parse(JSON.stringify(list)) as M[]

// --- 1. the replay shape ------------------------------------------------------

test('the whole cached transcript, replayed verbatim, comes back as the same array', () => {
  // Literally what `after=-1` sends: all N rows again, freshly parsed.
  const list = transcript(200)
  const replay = rewire(list)
  expect(replay[0]).not.toBe(list[0])
  expect(replay).toEqual(list)

  expect(mergeSessionMessages(list, replay)).toBe(list)
})

test('a single replayed message already present is a no-op', () => {
  const list = transcript(50)
  const one = rewire(list)[17]
  if (!one) throw new Error('fixture')
  expect(mergeSessionMessages(list, [one])).toBe(list)
})

test('one genuinely changed message in an otherwise identical batch of N', () => {
  const list = transcript(200)
  const replay = rewire(list)
  // A prompt row the worker has since answered: the one field the backend
  // does patch in place.
  const changed = replay[42]
  if (!changed) throw new Error('fixture')
  changed.pending = true

  const next = mergeSessionMessages(list, replay)

  // A new array — the reader's view of message 42 actually changed.
  expect(next).not.toBe(list)
  expect(next).toHaveLength(200)
  expect(next.map((m) => m.seq)).toEqual(list.map((m) => m.seq))
  expect(next[42]).toBe(changed)
  expect(next[42]?.pending).toBe(true)

  // ...and every message that did not change keeps its own object identity,
  // which is what lets replaceEqualDeep and any per-row memo short-circuit.
  const moved = next.filter((m, i) => m !== list[i])
  expect(moved).toEqual([changed])
})

test('a batch mixing unchanged replays with one new message keeps the old objects', () => {
  const list = transcript(20)
  const fresh = msg({ seq: 20, title: 'new' })

  const next = mergeSessionMessages(list, [...rewire(list), fresh])

  expect(next).not.toBe(list)
  expect(next).toHaveLength(21)
  for (let i = 0; i < 20; i++) expect(next[i]).toBe(list[i])
  expect(next[20]).toBe(fresh)
})

test('each of the compared scalars, changed on its own, produces a new array', () => {
  // Guards against the comparison being loosened into "always equal": every
  // field sameMessage claims to cover has to be able to force an update.
  const changes: Array<Partial<M>> = [
    { pending: true },
    { title: 'renamed' },
    { type: 'result' },
    { parentToolUseId: 'tu9' },
    { createdAt: '2999-01-01T00:00:00.000Z' },
  ]
  for (const change of changes) {
    const list = transcript(5)
    const base = list[2]
    if (!base) throw new Error('fixture')
    const updated = { ...base, ...change }
    const next = mergeSessionMessages(list, [updated])
    expect({ change, same: next === list }).toEqual({ change, same: false })
    expect(next[2]).toBe(updated)
  }
})

// --- 2. the payload contract --------------------------------------------------

test('a different payload at an existing seq is DELIBERATELY ignored', () => {
  // Documenting the contract, not endorsing it: sameMessage does not look at
  // `payload`, because the backend writes it once at insert and its only
  // in-place UPDATE on the messages table sets `pending` (session-run.worker
  // `.update(messages).set({ pending: false })`). Nothing else can make a
  // payload differ at a seq that already arrived — so the cheap comparison is
  // exact *given that backend*. If a future write patches `payload`, this
  // test is the one that will say so, and it fails loudly rather than the UI
  // silently showing stale text.
  const list = transcript(3)
  const original = list[1]
  if (!original) throw new Error('fixture')

  const rewritten = { ...original, payload: { message: { content: [{ type: 'text', text: 'REWRITTEN' }] } } }

  const next = mergeSessionMessages(list, [rewritten])

  expect(next).toBe(list)
  expect(next[1]).toBe(original)
  expect(next[1]).not.toBe(rewritten)
  expect(JSON.stringify(next[1]?.payload)).toContain('body 1')
  expect(JSON.stringify(next[1]?.payload)).not.toContain('REWRITTEN')
})

test('a payload change riding along with a scalar change is NOT lost', () => {
  // The consequence above is bounded: the message is dropped only when
  // nothing else moved. Any scalar difference takes the whole new row,
  // payload included.
  const list = transcript(3)
  const original = list[1]
  if (!original) throw new Error('fixture')
  const rewritten = { ...original, pending: true, payload: { text: 'REWRITTEN' } }

  const next = mergeSessionMessages(list, [rewritten])
  expect(next[1]).toBe(rewritten)
  expect(JSON.stringify(next[1]?.payload)).toContain('REWRITTEN')
})

// --- 3. ordering and the degenerate inputs ------------------------------------

test('an empty batch returns the very same array', () => {
  const list = transcript(10)
  expect(mergeSessionMessages(list, [])).toBe(list)
})

test('an undefined cache seeds from the batch', () => {
  const batch = transcript(4)
  const next = mergeSessionMessages(undefined, batch)
  expect(next.map((m) => m.seq)).toEqual([0, 1, 2, 3])
  expect(next[0]).toBe(batch[0])
})

test('an undefined cache and an empty batch is an empty list, not a throw', () => {
  expect(mergeSessionMessages(undefined, [])).toEqual([])
})

test('a brand new higher seq is appended, in place, without a sort', () => {
  const list = transcript(3)
  const fresh = msg({ seq: 3 })
  const next = mergeSessionMessages(list, [fresh])
  expect(next.map((m) => m.seq)).toEqual([0, 1, 2, 3])
  expect(next[3]).toBe(fresh)
  for (let i = 0; i < 3; i++) expect(next[i]).toBe(list[i])
})

test('an out-of-order arrival sorts back into ascending seq', () => {
  const list = [msg({ seq: 2 }), msg({ seq: 5 })]
  const next = mergeSessionMessages(list, [msg({ seq: 3 })])
  expect(next.map((m) => m.seq)).toEqual([2, 3, 5])
})

test('a whole batch delivered backwards still lands ascending', () => {
  const batch = [msg({ seq: 4 }), msg({ seq: 2 }), msg({ seq: 3 }), msg({ seq: 0 })]
  const next = mergeSessionMessages([msg({ seq: 1 })], batch)
  expect(next.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4])
})

test('the same seq twice inside one batch lands once', () => {
  const first = msg({ seq: 7, title: 'a' })
  const again = { ...first }
  const next = mergeSessionMessages([], [first, again])
  expect(next).toHaveLength(1)
  expect(next[0]).toBe(first)
})

test('a duplicate that also differs takes the later delivery, still once', () => {
  const first = msg({ seq: 7, pending: true })
  const settled = { ...first, pending: false }
  const next = mergeSessionMessages([], [first, settled])
  expect(next).toHaveLength(1)
  expect(next[0]).toBe(settled)
})

test('the batch is not mutated and the existing array is never written through', () => {
  const list = transcript(5)
  const before = [...list]
  const batch = [msg({ seq: 9 }), msg({ seq: 7 })]
  const batchBefore = [...batch]

  mergeSessionMessages(list, batch)

  expect(list).toEqual(before)
  expect(list.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4])
  // A merge that sorted the caller's batch in place would reorder this.
  expect(batch).toEqual(batchBefore)
})
