// Component-local, not shared/lib — see features/ideas/components/format.ts's
// own note that this app has no shared date-formatting helper to reuse, and
// deliberately avoids relative time because nothing there re-renders on a
// timer. That reasoning does not carry over here: the running-editors panel
// this feeds already re-renders on its own 10s poll (use-running-editors.ts),
// so a plain recompute on every render is enough to keep "last active" from
// visibly going stale, with no ticking timer of its own to manage.

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** "3 minutes ago" in the browser's own locale — coarsest unit that still
 *  reads as "just now" rather than "-14 seconds". `numeric: 'auto'` is what
 *  turns the 0-minute case into "now" instead of "0 minutes ago". */
export function formatLastActive(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso

  const diffMs = then - now
  const abs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (abs < MINUTE_MS) return rtf.format(Math.round(diffMs / 1000), 'second')
  if (abs < HOUR_MS) return rtf.format(Math.round(diffMs / MINUTE_MS), 'minute')
  if (abs < DAY_MS) return rtf.format(Math.round(diffMs / HOUR_MS), 'hour')
  return rtf.format(Math.round(diffMs / DAY_MS), 'day')
}
