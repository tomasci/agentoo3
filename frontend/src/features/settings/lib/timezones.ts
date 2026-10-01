export interface TimezoneOption {
  value: string
  label: string
}

/** `GMT+3` → `UTC+3` (and bare `GMT` → `UTC±0`) — the offset part shared by
 *  `offsetLabel` (the picker's own row label) and `zoneWithOffset` (a
 *  schedule line's inline mention of the same zone), kept as one function so
 *  the two can never drift apart on how they spell an offset. Computed from
 *  `now` rather than hardcoded: a zone's offset can change (DST, a
 *  government redefining it), so this always matches what the zone means
 *  today. */
function currentOffset(zone: string, now: Date): string {
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')
  const offset = part?.value.replace('GMT', 'UTC') ?? 'UTC'
  return offset === 'UTC' ? 'UTC±0' : offset
}

/** `Europe/Moscow (UTC+3)` — the offset is what lets a reader place the zone
 *  without knowing the IANA name by heart, same reason the brief singles out
 *  this exact example. */
function offsetLabel(zone: string, now: Date): string {
  return `${zone} (${currentOffset(zone, now)})`
}

/** `Europe/Moscow, UTC+3` — the same offset `offsetLabel` computes for the
 *  picker, comma-joined instead of bracketed so it reads inline in a
 *  sentence ("Daily at 04:00 (Europe/Moscow, UTC+3)") rather than as a
 *  dropdown row. */
export function zoneWithOffset(zone: string): string {
  return `${zone}, ${currentOffset(zone, new Date())}`
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
