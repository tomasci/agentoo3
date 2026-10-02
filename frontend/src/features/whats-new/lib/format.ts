// Mirrors features/library/lib/format.ts's own tiny `formatDateTime` copy —
// each feature keeps its own rather than sharing one (see that file's
// comment) — but this one follows the reader's chosen *interface* language
// rather than the browser's locale, and pins the time zone, both of which
// the others have no reason to do.

/** A release date ("2026-10-02", no time of day) as `language` would show
 *  it — `new Date('2026-10-02')` parses as UTC midnight per the ISO-8601
 *  date-only grammar, so the format call pins `timeZone: 'UTC'` too; without
 *  it, a reader west of Greenwich would see the previous day's date at
 *  certain hours, for a release date that was never an instant to begin
 *  with. */
export function formatReleaseDate(date: string, language: string): string {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return date
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed)
}
