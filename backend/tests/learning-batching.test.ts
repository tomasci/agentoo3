// features/learning/batching.ts's greedy packer: pure, so every scenario here
// runs with no database, no queue and no model call anywhere nearby.

import { expect, test } from 'bun:test'
import './setup-env'
import { packBatches, type SessionDigest } from '@/features/learning/batching'

const digest = (sessionId: string, chars: number): SessionDigest => ({
  sessionId,
  text: 'x'.repeat(chars),
})

test('empty input packs to no batches', () => {
  expect(packBatches([], 100)).toEqual([])
})

test('everything fits in one batch when the total is under the budget', () => {
  const digests = [digest('a', 10), digest('b', 10), digest('c', 10)]
  const batches = packBatches(digests, 100)
  expect(batches).toHaveLength(1)
  expect(batches[0]?.map((d) => d.sessionId)).toEqual(['a', 'b', 'c'])
})

test('a digest that would push the running total over the budget starts a new batch', () => {
  const digests = [digest('a', 60), digest('b', 60), digest('c', 60)]
  const batches = packBatches(digests, 100)
  // a (60) alone, then b (60) would make 120 > 100 so it starts a new batch;
  // c (60) added to b's batch would make 120 > 100 too, so it also starts new.
  expect(batches.map((b) => b.map((d) => d.sessionId))).toEqual([['a'], ['b'], ['c']])
})

test('digests that fit together are packed into the same batch before moving on', () => {
  const digests = [digest('a', 30), digest('b', 30), digest('c', 30), digest('d', 30)]
  const batches = packBatches(digests, 100)
  // a+b+c = 90 <= 100, fits; d would make 120 > 100, so it starts a new batch.
  expect(batches.map((b) => b.map((d) => d.sessionId))).toEqual([['a', 'b', 'c'], ['d']])
})

test('one oversized digest (>= maxChars on its own) gets its own batch, never split or dropped', () => {
  const digests = [digest('small', 10), digest('huge', 500), digest('small2', 10)]
  const batches = packBatches(digests, 100)
  expect(batches.map((b) => b.map((d) => d.sessionId))).toEqual([['small'], ['huge'], ['small2']])
  // The oversized digest's own text is carried whole, not truncated here —
  // digest.ts's own per-session cap is what bounds its size in the first
  // place, per this module's own header.
  expect(batches[1]?.[0]?.text.length).toBe(500)
})

test('a digest exactly at maxChars counts as oversized (its own batch), not packed with a neighbour', () => {
  const digests = [digest('a', 100), digest('b', 1)]
  const batches = packBatches(digests, 100)
  expect(batches.map((b) => b.map((d) => d.sessionId))).toEqual([['a'], ['b']])
})

test('order is preserved: batches appear in the same order the digests were given', () => {
  const digests = [digest('1', 40), digest('2', 40), digest('3', 40), digest('4', 40)]
  const batches = packBatches(digests, 100)
  expect(batches.flatMap((b) => b.map((d) => d.sessionId))).toEqual(['1', '2', '3', '4'])
})
