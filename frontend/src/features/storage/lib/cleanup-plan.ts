import type { StorageAnomaly } from '../hooks/use-storage'

export interface CleanupPlan {
  blobs: number
  rows: number
  dirs: number
  mismatches: number
  bytes: number
  total: number
}

/**
 * What `POST /storage/cleanup` would actually do to the anomalies the last
 * check found: delete every open one, `checksum_mismatch` included — cleanup
 * deletes the corrupt blob and its row for that class too now (see gc.ts's
 * `runCleanup`, which calls `remediateAnomaly` for every open anomaly
 * regardless of class). This has to agree with what the confirmation dialog
 * asks the operator to confirm, or the count and byte total they see would be
 * smaller than what actually happens — which is exactly the bug this once
 * was: an earlier version filtered `checksum_mismatch` out of both, back when
 * cleanup genuinely only reported that class rather than remediating it.
 *
 * The idea-assets storage root's three classes (`orphan_idea_dir`,
 * `idea_dangling_row`, `idea_checksum_mismatch`) fold into the same three
 * buckets as their session-rooted twins rather than getting buckets of their
 * own: they are the same kind of problem — an orphan directory, a dangling
 * row, a checksum mismatch — just under a different root, and an operator
 * confirming a cleanup needs to know how many rows/dirs/mismatches are about
 * to go, not which root each lived under. `bytes` and `total` already summed
 * every open anomaly regardless of class (that blanket sum is what the
 * `checksum_mismatch` fix above relies on), so adding a storage root needed
 * no change there — only here, to the four named buckets, which is exactly
 * the spot a class this doesn't fold into would silently under-count.
 *
 * A named, exported function rather than inline `useMemo` in the page: the
 * arithmetic is the part worth being exactly right, and it is worth being
 * able to assert on directly, without also standing up a DOM and fighting the
 * fact that `t()` never interpolates its params in this test environment (see
 * storage-page.test.tsx's own note on that).
 */
export function cleanupPlanFor(anomalies: StorageAnomaly[]): CleanupPlan {
  return {
    blobs: anomalies.filter((a) => a.class === 'orphan_blob').length,
    rows: anomalies.filter((a) => a.class === 'dangling_row' || a.class === 'idea_dangling_row')
      .length,
    dirs: anomalies.filter((a) => a.class === 'orphan_session_dir' || a.class === 'orphan_idea_dir')
      .length,
    mismatches: anomalies.filter(
      (a) => a.class === 'checksum_mismatch' || a.class === 'idea_checksum_mismatch',
    ).length,
    bytes: anomalies.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
    total: anomalies.length,
  }
}
