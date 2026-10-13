import { differenceInCalendarDays, format, startOfDay } from 'date-fns'

/** How many single-day groups follow "Yesterday" before everything else falls
 *  into "Older" — "the next 7 days", so 2 through 8 days ago. */
export const DAY_GROUPS_AFTER_YESTERDAY = 7

/** The two fields a session's place in the list depends on — a structural
 *  type rather than `Session`, so the dashboard's `OverviewSession` fits too. */
interface Timestamped {
  createdAt: string
  lastMessageAt: string | null
}

/** A group's identity and heading input; `key` is stable across renders and
 *  distinct per group, `day` is local midnight of a day group's calendar day.
 *  The label is the component's job (it needs `t()` and the language). */
export type SessionGroupHeading =
  | { kind: 'today'; key: 'today' }
  | { kind: 'yesterday'; key: 'yesterday' }
  | { kind: 'day'; key: `day-${string}`; day: Date }
  | { kind: 'older'; key: 'older' }

export type SessionGroup<T extends Timestamped> = SessionGroupHeading & { sessions: T[] }

/** An unparsable timestamp reads as the epoch, so a malformed row sorts last
 *  and lands in "Older" instead of poisoning the comparator with `NaN`. */
function toMs(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

/** When the session last had activity: its newest message, or — before it has
 *  any — the moment it was created. */
export function activityTime(session: Timestamped): string {
  return session.lastMessageAt ?? session.createdAt
}

/**
 * Newest activity first, newest creation first among equals — the order the
 * API answers in too. Done here as well so the list's order is this code's own
 * guarantee, not something it inherits from whatever order the cache holds.
 */
export function sortSessions<T extends Timestamped>(sessions: readonly T[]): T[] {
  return [...sessions].sort(
    (a, b) =>
      toMs(activityTime(b)) - toMs(activityTime(a)) || toMs(b.createdAt) - toMs(a.createdAt),
  )
}

/**
 * Which group a session belongs in, by the reader's *local calendar day*
 * relative to `now` — not by 24-hour distance, so 23:59 last night is
 * "Yesterday" at 00:01 this morning. A timestamp ahead of `now` (clock skew
 * between the server and this machine) counts as today rather than a day that
 * hasn't happened yet.
 *
 * Over a list sorted by `sortSessions` the answer only ever moves
 * today → yesterday → older days → older, so equal keys are always adjacent.
 */
export function sessionGroupOf(session: Timestamped, now: Date = new Date()): SessionGroupHeading {
  const active = new Date(toMs(activityTime(session)))
  const daysAgo = differenceInCalendarDays(now, active)
  if (daysAgo <= 0) return { kind: 'today', key: 'today' }
  if (daysAgo === 1) return { kind: 'yesterday', key: 'yesterday' }
  if (daysAgo <= 1 + DAY_GROUPS_AFTER_YESTERDAY) {
    const day = startOfDay(active)
    return { kind: 'day', key: `day-${format(day, 'yyyy-MM-dd')}`, day }
  }
  return { kind: 'older', key: 'older' }
}

/** The sessions sorted and split into groups, in display order. A group with
 *  no sessions is never returned. `now` is injectable so callers (and tests)
 *  need no fake clock. */
export function groupSessions<T extends Timestamped>(
  sessions: readonly T[],
  now: Date = new Date(),
): SessionGroup<T>[] {
  const groups: SessionGroup<T>[] = []
  for (const session of sortSessions(sessions)) {
    const heading = sessionGroupOf(session, now)
    const last = groups[groups.length - 1]
    if (last?.key === heading.key) last.sessions.push(session)
    else groups.push({ ...heading, sessions: [session] })
  }
  return groups
}
