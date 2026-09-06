import type { Tone } from '@/shared/ui'
import type { AnomalyClass } from '../hooks/use-storage'

/**
 * `Record<AnomalyClass, ...>` rather than a `switch`/lookup by string: if the
 * backend's four fixed classes (attachments/schema.ts's
 * `storageAnomalyClassSchema`) ever grow a fifth, this fails the build until
 * it is given a tone, instead of a new class silently reading as untoned.
 * `dangling_row` and `checksum_mismatch` get `danger` — a database row
 * pointing at nothing, or content that no longer matches its own checksum,
 * is a correctness problem, not just housekeeping; the other two are
 * `warning`, ordinary leftover-disk-space findings.
 */
export const ANOMALY_TONE: Record<AnomalyClass, Tone> = {
  orphan_blob: 'warning',
  dangling_row: 'danger',
  orphan_session_dir: 'warning',
  checksum_mismatch: 'danger',
}
