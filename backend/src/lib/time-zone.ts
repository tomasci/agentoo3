// A single home for "is this a real IANA zone name" — shared by every feature
// that lets an operator type one in (the learning job's schedule,
// features/learning/schedule.ts; a project automation's cron schedule,
// features/automations/schema.ts), so the two cannot drift onto two slightly
// different notions of "valid timezone".

/**
 * Throws for a zone ICU does not recognise — the standard way to validate an
 * IANA zone name without a second dependency just for a lookup table.
 */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}
