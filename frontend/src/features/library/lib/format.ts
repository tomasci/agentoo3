// Mirrors features/sessions/lib/format.ts's own pair — each feature keeps a
// tiny copy rather than sharing one, the same duplication ideas/storage/docker
// already carry their own of.

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function parse(value: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** An ISO timestamp as the reader's own locale date and time, or '' for
 *  anything that isn't a real instant (null, '', unparsable). The one date
 *  formatter the whole feature uses — every date shown here (a run's window,
 *  when it finished, a suggestion's createdAt, a version's own timestamp,
 *  the schedule's next run) goes through this, so none of them can drift
 *  into a different shape (a bug this once was: the next-run line used
 *  `Date#toLocaleString` directly and read nothing like the rest). */
export function formatDateTime(value: string | null): string {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : ''
}

/** `Asia/Tokyo, UTC+9` — mirrors `shared/lib/timezones.ts`'s
 *  own `zoneWithOffset` (same computation, comma-joined rather than
 *  bracketed so it reads inline in a sentence), duplicated rather than
 *  imported for the same reason this file keeps its own `formatDateTime`
 *  instead of reaching into another feature. Computed from `now` rather than
 *  hardcoded: a zone's offset can change (DST, a government redefining it).
 *  `UTC` (the schedule's own default) is returned bare: its offset is always
 *  +0 by definition, so "UTC, UTC+0" would just repeat the name back rather
 *  than add anything. */
export function formatTimezone(zone: string): string {
  if (zone === 'UTC') return zone
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')
  const offset = part?.value.replace('GMT', 'UTC') ?? 'UTC'
  return `${zone}, ${offset === 'UTC' ? 'UTC±0' : offset}`
}
