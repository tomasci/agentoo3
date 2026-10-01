export interface TimezoneOption {
  value: string
  label: string
}

/** `Europe/Moscow (UTC+3)` — the offset is what lets a reader place the zone
 *  without knowing the IANA name by heart, same reason the brief singles out
 *  this exact example. Computed from `now` rather than hardcoded: a zone's
 *  offset can change (DST, a government redefining it), so this always
 *  matches what the zone means today. */
function offsetLabel(zone: string, now: Date): string {
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')
  // "GMT+3" / "GMT" (for UTC itself) — never absent for a valid IANA zone.
  const offset = part?.value.replace('GMT', 'UTC') ?? 'UTC'
  return `${zone} (${offset === 'UTC' ? 'UTC±0' : offset})`
}

let cached: TimezoneOption[] | null = null

/**
 * Every IANA zone `Intl` knows about, labelled with its current UTC offset
 * and sorted alphabetically. `Intl.supportedValuesOf` is the modern,
 * standard source for this list (no package to keep in sync with the IANA
 * database ourselves) — on a browser old enough to lack it, this falls back
 * to a short, common list rather than leaving the field with nothing to pick.
 */
export function timezoneOptions(): TimezoneOption[] {
  if (cached) return cached
  const now = new Date()
  let zones: string[]
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = ['UTC', 'Europe/Moscow', 'Europe/London', 'America/New_York', 'Asia/Tokyo']
  }
  cached = zones
    .map((zone) => ({ value: zone, label: offsetLabel(zone, now) }))
    .sort((a, b) => a.value.localeCompare(b.value))
  return cached
}
