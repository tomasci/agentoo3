import type { AnomalyOutcome } from '../hooks/use-storage'

/**
 * The tone each outcome reads as, honestly — not every non-`failed` outcome
 * is `success`: `revalidated` means the entry fixed itself and nothing was
 * deleted, which is good news but not the destructive action that was asked
 * for, so it gets the same informational `accent` as `unchanged` rather than
 * being folded into `success` and reported as if the delete happened.
 */
export const OUTCOME_TONE: Record<AnomalyOutcome, 'success' | 'accent' | 'danger'> = {
  deleted: 'success',
  revalidated: 'accent',
  unchanged: 'accent',
  failed: 'danger',
}

const EMPTY_TALLY: Record<AnomalyOutcome, number> = {
  deleted: 0,
  revalidated: 0,
  unchanged: 0,
  failed: 0,
}

/** How many of a bulk-delete's per-entry results landed in each outcome, so a
 * batch of 20 can be reported as one honest sentence instead of 20 toasts. */
export function tallyOutcomes(
  results: { outcome: AnomalyOutcome }[],
): Record<AnomalyOutcome, number> {
  const tally = { ...EMPTY_TALLY }
  for (const result of results) tally[result.outcome] += 1
  return tally
}
