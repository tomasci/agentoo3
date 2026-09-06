// The "honest outcome" logic behind every destructive storage action: a
// `delete` (per-row or bulk) re-verifies before acting, so `revalidated`
// (fixed itself, nothing was deleted) and `failed` are just as real an
// answer as `deleted` — see openapi.json's own description of `outcome` on
// `/storage/anomalies/{id}/delete`. This is what the report says depends on.

import { expect, test } from 'bun:test'
import { OUTCOME_TONE, tallyOutcomes } from '../src/features/storage/lib/outcomes'

test('deleted alone reads as success', () => {
  expect(OUTCOME_TONE.deleted).toBe('success')
})

// The whole point of re-verifying before deleting: an entry that fixed
// itself must never be reported the same way as one that was actually
// removed, so it is not `success` — but it is not a failure either.
test('revalidated and unchanged read as informational, never success and never danger', () => {
  expect(OUTCOME_TONE.revalidated).toBe('accent')
  expect(OUTCOME_TONE.unchanged).toBe('accent')
})

test('failed is the one outcome that must never be visually indistinguishable from success', () => {
  expect(OUTCOME_TONE.failed).toBe('danger')
})

test('tallyOutcomes counts an empty batch as all zero', () => {
  expect(tallyOutcomes([])).toEqual({ deleted: 0, revalidated: 0, unchanged: 0, failed: 0 })
})

test('tallyOutcomes counts a mixed batch honestly, failures included', () => {
  const results = [
    { outcome: 'deleted' as const },
    { outcome: 'deleted' as const },
    { outcome: 'revalidated' as const },
    { outcome: 'failed' as const },
  ]
  expect(tallyOutcomes(results)).toEqual({ deleted: 2, revalidated: 1, unchanged: 0, failed: 1 })
})

// The explicit acceptance criterion: a failure among many successes must
// still show up in the tally, not be dropped or rounded away.
test('a single failure among many successes is not swallowed', () => {
  const results = [
    ...Array.from({ length: 19 }, () => ({ outcome: 'deleted' as const })),
    { outcome: 'failed' as const },
  ]
  const tally = tallyOutcomes(results)
  expect(tally.deleted).toBe(19)
  expect(tally.failed).toBe(1)
})
