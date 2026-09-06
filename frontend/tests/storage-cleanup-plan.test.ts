// The exact arithmetic behind the cleanup confirmation dialog, pulled out of
// storage-page.tsx precisely so it can be asserted on directly — `t()` never
// interpolates its params without a real i18next instance in this test
// environment (see tests/storage-page.test.tsx's own note), so a DOM-level
// test can prove *that* the dialog rendered its "something to clean up" body
// but not the exact numbers inside it. This is where the numbers themselves
// are pinned down.

import { expect, test } from 'bun:test'
import { cleanupPlanFor } from '../src/features/storage/lib/cleanup-plan'

const T = '2026-09-04T10:00:00.000Z'

const anomaly = (o: Record<string, unknown>) => ({
  id: 'a',
  sessionId: null,
  fileId: null,
  path: null,
  originalFilename: null,
  detail: null,
  firstSeenAt: T,
  lastSeenAt: T,
  resolvedAt: null,
  sizeBytes: null,
  ...o,
})

test('an empty list plans nothing', () => {
  expect(cleanupPlanFor([])).toEqual({
    blobs: 0,
    rows: 0,
    dirs: 0,
    mismatches: 0,
    bytes: 0,
    total: 0,
  })
})

test('counts each class separately, and totals every one of them together', () => {
  const plan = cleanupPlanFor([
    anomaly({ id: 'a1', class: 'orphan_blob', sizeBytes: 100 }),
    anomaly({ id: 'a2', class: 'orphan_blob', sizeBytes: 200 }),
    anomaly({ id: 'a3', class: 'dangling_row', sizeBytes: 50 }),
    anomaly({ id: 'a4', class: 'orphan_session_dir', sizeBytes: null }),
    anomaly({ id: 'a5', class: 'checksum_mismatch', sizeBytes: 999 }),
  ])
  expect(plan).toEqual({ blobs: 2, rows: 1, dirs: 1, mismatches: 1, bytes: 1349, total: 5 })
})

// The regression this track fixes: cleanup used to report `checksum_mismatch`
// only, never remediate it, and the confirmation excluded it from both the
// count and the bytes to match. `runCleanup` (gc.ts) now deletes the corrupt
// blob and its row for that class too, so this has to count and total it
// exactly like every other open anomaly, not fall back to zero.
test('checksum_mismatch counts toward the total and the byte sum, not just its own field', () => {
  const plan = cleanupPlanFor([anomaly({ id: 'a1', class: 'checksum_mismatch', sizeBytes: 999 })])
  expect(plan.mismatches).toBe(1)
  expect(plan.total).toBe(1)
  expect(plan.bytes).toBe(999)
})

test('a null sizeBytes contributes nothing to the byte total rather than becoming NaN', () => {
  const plan = cleanupPlanFor([
    anomaly({ id: 'a1', class: 'orphan_session_dir', sizeBytes: null }),
    anomaly({ id: 'a2', class: 'orphan_blob', sizeBytes: 100 }),
  ])
  expect(plan.bytes).toBe(100)
})
