/** The full local date and time, or `null` for anything that isn't a real
 * instant — mirrors `sessions/lib/format.ts`'s `formatFullTime`, kept as its
 * own copy rather than a cross-feature import for one line of Intl. */
export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}
