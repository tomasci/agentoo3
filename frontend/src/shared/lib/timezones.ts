export interface TimezoneOption {
  value: string
  label: string
}

/** `GMT+9` → `UTC+9` (and bare `GMT` → `UTC±0`) — the offset part shared by
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

/** `Asia/Tokyo (UTC+9)` — the offset is what lets a reader place the zone
 *  without knowing the IANA name by heart. `UTC` itself skips the
 *  parenthetical: its offset is always +0 by definition, so "UTC (UTC+0)"
 *  would just repeat the name back rather than tell the reader anything. */
function offsetLabel(zone: string, now: Date): string {
  return zone === 'UTC' ? zone : `${zone} (${currentOffset(zone, now)})`
}

/** `Asia/Tokyo, UTC+9` — the same offset `offsetLabel` computes for the
 *  picker, comma-joined instead of bracketed so it reads inline in a
 *  sentence ("Daily at 04:00 (Asia/Tokyo, UTC+9)") rather than as a dropdown
 *  row. `UTC` is the same bare name as above, for the same reason — "Daily
 *  at 04:00 (UTC)" reads naturally; "Daily at 04:00 (UTC, UTC+0)" does not. */
export function zoneWithOffset(zone: string): string {
  return zone === 'UTC' ? zone : `${zone}, ${currentOffset(zone, new Date())}`
}

let cached: TimezoneOption[] | null = null

/**
 * Every IANA zone `Intl` knows about, labelled with its current UTC offset
 * and sorted alphabetically, with `UTC` itself pinned first: it is the
 * default both callers start a fresh schedule from (`LearningScheduleCard`'s
 * `DEFAULT_VALUES`, `features/automations`' create dialog), so it needs to be
 * in the list and easy to find regardless of whether the engine's
 * `Intl.supportedValuesOf` happens to enumerate it — added by hand, deduped
 * against whatever the engine already returned, rather than left to chance.
 * `Intl.supportedValuesOf` is the modern, standard source for the rest (no
 * package to keep in sync with the IANA database ourselves) — on a browser
 * old enough to lack it, this falls back to a short, common list rather than
 * leaving the field with nothing to pick.
 *
 * Lives in `shared/` rather than a feature's own `lib/`, unlike most small
 * formatting helpers here (see `features/library/lib/format.ts`'s comment on
 * why those stay duplicated per feature): both `features/settings` (the
 * learning schedule) and `features/automations` (each automation's own
 * schedule) need the exact same zone list and offset arithmetic, and
 * `timezoneOptions`'s module-level cache would otherwise exist twice, doing
 * the same `Intl.supportedValuesOf` work independently per feature.
 */
export function timezoneOptions(): TimezoneOption[] {
  if (cached) return cached
  const now = new Date()
  let zones: string[]
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = ['Europe/London', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']
  }
  const rest = zones
    .filter((zone) => zone !== 'UTC')
    .map((zone) => ({ value: zone, label: offsetLabel(zone, now) }))
    .sort((a, b) => a.value.localeCompare(b.value))
  cached = [{ value: 'UTC', label: offsetLabel('UTC', now) }, ...rest]
  return cached
}
