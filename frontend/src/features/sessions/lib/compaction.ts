/**
 * The accumulated cost, in USD, past which a session's history view offers to
 * compact it. Strictly greater than: a session sitting at exactly this amount
 * has not exceeded it. The one place the number lives — the banner's gate and
 * its tests both read it from here.
 */
export const COMPACT_SUGGEST_COST_USD = 1000

/**
 * Whether to show the "compact and start a new session" banner for a session
 * that has cost `totalCostUsd` so far. A cost that is not a finite number
 * (`NaN` from a malformed response, `Infinity`) is never a reason to nag: the
 * banner is a suggestion backed by a figure, and there is no figure to quote.
 */
export function shouldSuggestCompaction(totalCostUsd: number): boolean {
  return Number.isFinite(totalCostUsd) && totalCostUsd > COMPACT_SUGGEST_COST_USD
}
