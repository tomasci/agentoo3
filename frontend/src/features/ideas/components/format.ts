// Component-local formatting, not `../lib/`: that directory is the data
// layer's own (hooks/lib/model, per this track's brief) and this is
// presentation only — a comment's or a run's timestamp, printed for a
// reader rather than fed back into a request.

/** The browser's own locale/timezone, matching every other timestamp already
 * shown in this app (there is no shared date-formatting helper to reuse — see
 * the report). No relative "3 minutes ago": that goes stale the moment the
 * reader stops looking at it, and nothing here re-renders on a timer. */
export function formatIdeaDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
