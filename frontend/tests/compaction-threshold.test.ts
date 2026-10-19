// The one number behind the "Compact session and start new one" banner, and
// the rule that reads it (lib/compaction.ts): strictly greater than the
// constant, finite only. A session sitting at exactly the threshold has not
// exceeded it, and a cost that is not a real number is no reason to nag.

import { expect, test } from 'bun:test'
import {
  COMPACT_SUGGEST_COST_USD,
  shouldSuggestCompaction,
} from '../src/features/sessions/lib/compaction'

test('the threshold is 1000 USD', () => {
  expect(COMPACT_SUGGEST_COST_USD).toBe(1000)
})

test('nothing at or below the threshold is suggested, including exactly 1000', () => {
  expect(shouldSuggestCompaction(0)).toBe(false)
  expect(shouldSuggestCompaction(0.0001)).toBe(false)
  expect(shouldSuggestCompaction(999.99)).toBe(false)
  expect(shouldSuggestCompaction(1000)).toBe(false)
  expect(shouldSuggestCompaction(COMPACT_SUGGEST_COST_USD)).toBe(false)
})

test('anything above the threshold is suggested', () => {
  expect(shouldSuggestCompaction(1000.01)).toBe(true)
  expect(shouldSuggestCompaction(1001)).toBe(true)
  expect(shouldSuggestCompaction(5000)).toBe(true)
  expect(shouldSuggestCompaction(COMPACT_SUGGEST_COST_USD + 0.01)).toBe(true)
})

test('a cost that is not finite is never suggested', () => {
  expect(shouldSuggestCompaction(Number.NaN)).toBe(false)
  expect(shouldSuggestCompaction(Number.POSITIVE_INFINITY)).toBe(false)
  expect(shouldSuggestCompaction(Number.NEGATIVE_INFINITY)).toBe(false)
})

test('a negative cost is not suggested', () => {
  expect(shouldSuggestCompaction(-5000)).toBe(false)
})
