// Mirrors features/sessions/lib/format.ts's own `formatDateTime` — each
// feature keeps a tiny copy rather than sharing one, the same duplication
// ideas/storage/docker/library already carry their own of.

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
 *  anything that isn't a real instant (null, '', unparsable) — an
 *  automation's `nextRunAt`/`lastRunAt`, and a run's `scheduledFor`/
 *  `startedAt`. */
export function formatDateTime(value: string | null): string {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : ''
}

/**
 * An ISO timestamp rendered *in a given IANA zone* rather than the reader's
 * own — the schedule builder's live preview needs this, and nothing else in
 * the app does: every other date shown here is an event that already
 * happened or will happen in absolute time, and the reader's own local time
 * is the useful answer for "when was/is that for me". A preview of upcoming
 * occurrences is different — it exists to let the reader confirm the cron
 * they just typed means what they think it means *in the zone they just
 * chose*, which only holds if the preview is shown in that same zone rather
 * than silently converted to wherever the browser happens to be.
 */
export function formatInZone(value: string, zone: string): string {
  const date = parse(value)
  if (!date) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: zone,
    }).format(date)
  } catch {
    // An invalid zone never reaches here in practice — the zone comes from
    // `timezoneOptions()`'s own list — but a stale/hand-edited value must not
    // crash the preview, only read as unformattable.
    return ''
  }
}
