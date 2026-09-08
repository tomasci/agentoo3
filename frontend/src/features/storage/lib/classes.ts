import type { Tone } from '@/shared/ui'
import type { AnomalyClass } from '../hooks/use-storage'

/**
 * `Record<AnomalyClass, ...>` rather than a `switch`/lookup by string: if the
 * backend's fixed classes (attachments/schema.ts's
 * `storageAnomalyClassSchema`) ever grow another, this fails the build until
 * it is given a tone, instead of a new class silently reading as untoned.
 * `dangling_row` and `checksum_mismatch` get `danger` — a database row
 * pointing at nothing, or content that no longer matches its own checksum,
 * is a correctness problem, not just housekeeping; `orphan_blob` and
 * `orphan_session_dir` are `warning`, ordinary leftover-disk-space findings.
 * The `idea_*`/`orphan_idea_dir` classes are the same three kinds of problem
 * again, just rooted under the idea-assets storage root instead of a
 * session's, so each gets its session-rooted twin's tone.
 */
export const ANOMALY_TONE: Record<AnomalyClass, Tone> = {
  orphan_blob: 'warning',
  dangling_row: 'danger',
  orphan_session_dir: 'warning',
  checksum_mismatch: 'danger',
  orphan_idea_dir: 'warning',
  idea_dangling_row: 'danger',
  idea_checksum_mismatch: 'danger',
}
