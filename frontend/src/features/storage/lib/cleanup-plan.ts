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
 * A named, exported function rather than inline `useMemo` in the page: the
 * arithmetic is the part worth being exactly right, and it is worth being
 * able to assert on directly, without also standing up a DOM and fighting the
 * fact that `t()` never interpolates its params in this test environment (see
 * storage-page.test.tsx's own note on that).
 */
export function cleanupPlanFor(anomalies: StorageAnomaly[]): CleanupPlan {
  return {
    blobs: anomalies.filter((a) => a.class === 'orphan_blob').length,
    rows: anomalies.filter((a) => a.class === 'dangling_row').length,
    dirs: anomalies.filter((a) => a.class === 'orphan_session_dir').length,
    mismatches: anomalies.filter((a) => a.class === 'checksum_mismatch').length,
    bytes: anomalies.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
    total: anomalies.length,
  }
}
