// features/sessions/lib/session-groups.ts — the order the sessions list shows
// and the Today / Yesterday / per-day / Older buckets it is split into:
//
//   - sortSessions: `lastMessageAt ?? createdAt` descending, `createdAt`
//     descending among equals, never mutating its input;
//   - sessionGroupOf / groupSessions: bucketed by the reader's *local calendar
//     day* relative to an injected `now` — 0 days (or the future) is today, 1
//     is yesterday, 2..8 one group per day, 9+ older; empty buckets never
//     appear, groups come newest first and so do the sessions inside them.
//
// Every instant is built with the local-time Date constructor, so the
// expectations hold under whatever TZ the runner has. The last block switches
// `process.env.TZ` (which bun honours at runtime) to Europe/Berlin to show the
// day boundary is the local one, not UTC's, and to walk the 2026-10-25 DST
// change; it always restores the previous zone.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  DAY_GROUPS_AFTER_YESTERDAY,
  groupSessions,
  sessionGroupOf,
  sortSessions,
} from '../src/features/sessions/lib/session-groups'

interface S {
  id: string
  createdAt: string
  lastMessageAt: string | null
}

/** Local wall-clock time → ISO instant. Month is 1-based here. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(y, mo - 1, d, h, mi, s, ms)
const at = (...args: Parameters<typeof local>) => local(...args).toISOString()

const s = (id: string, createdAt: string, lastMessageAt: string | null = null): S => ({
  id,
  createdAt,
  lastMessageAt,
})

const LONG_AGO = at(2020, 1, 1, 12)

/** Group keys and the ids inside each, in display order. */
const shape = (groups: ReturnType<typeof groupSessions<S>>) =>
  groups.map((g) => [g.key, g.sessions.map((x) => x.id)])

// --- sortSessions ------------------------------------------------------------

describe('sortSessions', () => {
  test('orders by lastMessageAt, falling back to createdAt, newest first', () => {
    const list = [
      s('created-recently-never-spoke', at(2026, 10, 12, 9)),
      s('created-long-ago-spoke-last', LONG_AGO, at(2026, 10, 13, 9)),
      s('spoke-yesterday', at(2026, 10, 1), at(2026, 10, 12, 8)),
      s('old', LONG_AGO),
    ]
    expect(sortSessions(list).map((x) => x.id)).toEqual([
      'created-long-ago-spoke-last',
      'created-recently-never-spoke',
      'spoke-yesterday',
      'old',
    ])
  })

  test('equal activity times tie-break on createdAt, newest first', () => {
    const t = at(2026, 10, 13, 9)
    const list = [
      s('created-oldest', at(2026, 10, 1), t),
      s('created-newest', at(2026, 10, 10), t),
      // No messages: its createdAt *is* the activity time, and it is the
      // newest creation of the three, so it leads.
      s('no-messages-created-at-t', t),
      s('created-middle', at(2026, 10, 5), t),
    ]
    expect(sortSessions(list).map((x) => x.id)).toEqual([
      'no-messages-created-at-t',
      'created-newest',
      'created-middle',
      'created-oldest',
    ])
  })

  test('does not mutate the array it is given', () => {
    const list = [s('a', LONG_AGO), s('b', at(2026, 10, 13))]
    const before = list.map((x) => x.id)
    const sorted = sortSessions(list)
    expect(list.map((x) => x.id)).toEqual(before)
    expect(sorted).not.toBe(list)
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

// --- sessionGroupOf: boundaries ----------------------------------------------

describe('sessionGroupOf', () => {
  test('there are 7 single-day groups after Yesterday', () => {
    expect(DAY_GROUPS_AFTER_YESTERDAY).toBe(7)
  })

  test('00:00:00.000 today is Today; 23:59:59.999 the day before is Yesterday', () => {
    const now = local(2026, 10, 13, 0, 1)
    expect(sessionGroupOf(s('x', at(2026, 10, 13, 0, 0, 0, 0)), now).kind).toBe('today')
    expect(sessionGroupOf(s('x', at(2026, 10, 12, 23, 59, 59, 999)), now).kind).toBe('yesterday')
  })

  test('calendar days, not 24-hour distance: one minute ago across midnight is Yesterday', () => {
    const now = local(2026, 10, 13, 0, 0, 30)
    expect(sessionGroupOf(s('x', at(2026, 10, 12, 23, 59, 30)), now).kind).toBe('yesterday')
    // ...and 23h59m ago on the same calendar day is still Today.
    const late = local(2026, 10, 13, 23, 59)
    expect(sessionGroupOf(s('x', at(2026, 10, 13, 0, 0)), late).kind).toBe('today')
  })

  test('the start of the day before yesterday is a day group, not Yesterday', () => {
    const now = local(2026, 10, 13, 12)
    const g = sessionGroupOf(s('x', at(2026, 10, 11, 23, 59)), now)
    expect(g.kind).toBe('day')
    expect(g.key).toBe('day-2026-10-11')
  })

  test('exactly 8 calendar days ago is still a day group; 9 is Older', () => {
    const now = local(2026, 10, 13, 10)
    const eight = sessionGroupOf(s('x', at(2026, 10, 5, 0, 0)), now)
    expect(eight.kind).toBe('day')
    expect(eight.key).toBe('day-2026-10-05')
    const eightLate = sessionGroupOf(s('x', at(2026, 10, 5, 23, 59, 59, 999)), now)
    expect(eightLate.key).toBe('day-2026-10-05')
    expect(sessionGroupOf(s('x', at(2026, 10, 4, 23, 59, 59, 999)), now).kind).toBe('older')
    expect(sessionGroupOf(s('x', at(2026, 10, 4, 0, 0)), now).kind).toBe('older')
  })

  test('a day group carries local midnight of its day', () => {
    const now = local(2026, 10, 13, 10)
    const g = sessionGroupOf(s('x', at(2026, 10, 9, 17, 45)), now)
    if (g.kind !== 'day') throw new Error(`expected a day group, got ${g.kind}`)
    expect(g.day.getTime()).toBe(local(2026, 10, 9).getTime())
  })

  test('a timestamp ahead of now is Today, however far ahead', () => {
    const now = local(2026, 10, 13, 10)
    expect(sessionGroupOf(s('x', at(2026, 10, 13, 10, 0, 1)), now).kind).toBe('today')
    expect(sessionGroupOf(s('x', at(2026, 10, 14, 9)), now).kind).toBe('today')
    expect(sessionGroupOf(s('x', at(2027, 1, 1)), now).kind).toBe('today')
  })

  test('no messages: grouped by createdAt', () => {
    const now = local(2026, 10, 13, 10)
    expect(sessionGroupOf(s('x', at(2026, 10, 12, 9), null), now).kind).toBe('yesterday')
    expect(sessionGroupOf(s('x', LONG_AGO, null), now).kind).toBe('older')
  })

  test('with messages: grouped by lastMessageAt, not by an old createdAt', () => {
    const now = local(2026, 10, 13, 10)
    expect(sessionGroupOf(s('x', LONG_AGO, at(2026, 10, 13, 9)), now).kind).toBe('today')
  })

  test('an unparsable timestamp lands in Older rather than throwing', () => {
    const now = local(2026, 10, 13, 10)
    expect(sessionGroupOf(s('x', 'not-a-date'), now).kind).toBe('older')
    expect(sessionGroupOf(s('x', ''), now).kind).toBe('older')
  })
})

// --- groupSessions: shape -----------------------------------------------------

describe('groupSessions', () => {
  const now = local(2026, 10, 13, 10)

  test('a mixed, shuffled list: group order newest first, in-group order newest first', () => {
    const list = [
      s('older-b', at(2025, 6, 1)),
      s('d3-early', at(2026, 10, 10, 8)),
      s('today-early', at(2026, 10, 13, 1)),
      s('yesterday', at(2026, 10, 1), at(2026, 10, 12, 18)),
      s('d8', at(2026, 10, 5, 12)),
      s('older-a', LONG_AGO, at(2026, 9, 1)),
      s('today-late', LONG_AGO, at(2026, 10, 13, 9, 30)),
      s('d3-late', at(2026, 10, 10, 20)),
      s('d2', at(2026, 10, 11, 12)),
    ]
    expect(shape(groupSessions(list, now))).toEqual([
      ['today', ['today-late', 'today-early']],
      ['yesterday', ['yesterday']],
      ['day-2026-10-11', ['d2']],
      ['day-2026-10-10', ['d3-late', 'd3-early']],
      ['day-2026-10-05', ['d8']],
      ['older', ['older-a', 'older-b']],
    ])
  })

  test('every one of the 2..8-days-ago days gets its own group, in order', () => {
    const list = Array.from({ length: 11 }, (_, i) => s(`ago-${i}`, at(2026, 10, 13 - i, 9)))
    expect(shape(groupSessions(list, now))).toEqual([
      ['today', ['ago-0']],
      ['yesterday', ['ago-1']],
      ['day-2026-10-11', ['ago-2']],
      ['day-2026-10-10', ['ago-3']],
      ['day-2026-10-09', ['ago-4']],
      ['day-2026-10-08', ['ago-5']],
      ['day-2026-10-07', ['ago-6']],
      ['day-2026-10-06', ['ago-7']],
      ['day-2026-10-05', ['ago-8']],
      ['older', ['ago-9', 'ago-10']],
    ])
  })

  test('days with no sessions produce no group at all', () => {
    const list = [s('today', at(2026, 10, 13, 9)), s('d4', at(2026, 10, 9, 9))]
    const groups = groupSessions(list, now)
    expect(groups.map((g) => g.key)).toEqual(['today', 'day-2026-10-09'])
    for (const g of groups) expect(g.sessions.length).toBeGreaterThan(0)
  })

  test('only Older sessions: one Older group; no sessions: no groups', () => {
    expect(shape(groupSessions([s('a', LONG_AGO), s('b', at(2019, 1, 1))], now))).toEqual([
      ['older', ['a', 'b']],
    ])
    expect(groupSessions([], now)).toEqual([])
  })

  test('the tie-break carries through into a group', () => {
    const t = at(2026, 10, 13, 9)
    const list = [s('made-first', at(2026, 10, 1), t), s('made-second', at(2026, 10, 2), t)]
    expect(shape(groupSessions(list, now))).toEqual([['today', ['made-second', 'made-first']]])
  })

  test('a future timestamp joins Today and sorts at its top', () => {
    const list = [s('now-ish', at(2026, 10, 13, 9)), s('skewed', at(2026, 10, 13, 11))]
    expect(shape(groupSessions(list, now))).toEqual([['today', ['skewed', 'now-ish']]])
  })
})

// --- a non-UTC zone, and across a DST change -----------------------------------

describe('under Europe/Berlin', () => {
  // Restored to the zone the run started in only if that is a real zone.
  // Another file may already have "restored" an unset TZ by assigning
  // `undefined`, which leaves the string "undefined" behind; handing that
  // back is a no-op for Date and Intl, which then stay on Berlin for every
  // later file. bun test's own default is UTC.
  const isZone = (tz: string | undefined): tz is string => {
    if (!tz) return false
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }
  const previous = process.env.TZ
  const restore = () => {
    process.env.TZ = isZone(previous) ? previous : 'Etc/UTC'
  }
  const inBerlin = <T>(fn: () => T): T => {
    process.env.TZ = 'Europe/Berlin'
    try {
      return fn()
    } finally {
      restore()
    }
  }
  afterEach(restore)

  test('restoring leaves the runner off Berlin', () => {
    inBerlin(() => undefined)
    expect(new Date(2026, 9, 1, 12).getTimezoneOffset()).not.toBe(-120)
  })

  test('the zone switch is actually in effect (CEST before 25 Oct, CET after)', () => {
    inBerlin(() => {
      expect(new Date('2026-10-24T12:00:00Z').getTimezoneOffset()).toBe(-120)
      expect(new Date('2026-10-26T12:00:00Z').getTimezoneOffset()).toBe(-60)
    })
  })

  test('the day boundary is Berlin midnight, not UTC midnight', () => {
    // 00:30 on 13 Oct in Berlin is still 12 Oct in UTC; 23:59 Berlin on the
    // 12th is the same UTC day as `now`, but the previous local day.
    const now = new Date('2026-10-12T22:30:00Z')
    const groups = inBerlin(() =>
      groupSessions(
        [
          s('berlin-today', '2026-10-12T22:00:00Z'), // 00:00 CEST 13 Oct
          s('berlin-yesterday', '2026-10-12T21:59:00Z'), // 23:59 CEST 12 Oct
        ],
        now,
      ),
    )
    expect(shape(groups)).toEqual([
      ['today', ['berlin-today']],
      ['yesterday', ['berlin-yesterday']],
    ])
  })

  test('the clocks going back: 24h20m elapsed on one calendar day is still Today', () => {
    inBerlin(() => {
      // 25 Oct 2026 is 25 hours long in Berlin.
      const now = local(2026, 10, 25, 23, 30)
      expect(now.getTime() - local(2026, 10, 25, 0, 10).getTime()).toBe((24 * 60 + 20) * 60 * 1000)
      expect(sessionGroupOf(s('x', at(2026, 10, 25, 0, 10)), now).kind).toBe('today')
    })
  })

  test('the clocks going back: yesterday / day / older keys on the far side of it', () => {
    inBerlin(() => {
      const now = local(2026, 10, 26, 0, 30)
      expect(sessionGroupOf(s('x', at(2026, 10, 25, 0, 0)), now).kind).toBe('yesterday')
      expect(sessionGroupOf(s('x', at(2026, 10, 24, 23, 59)), now).key).toBe('day-2026-10-24')
      // 8 vs 9 calendar days back, straddling the change.
      const later = local(2026, 11, 2, 0, 0, 30)
      expect(sessionGroupOf(s('x', at(2026, 10, 25, 0, 0)), later).key).toBe('day-2026-10-25')
      expect(sessionGroupOf(s('x', at(2026, 10, 24, 23, 59, 59)), later).kind).toBe('older')
    })
  })

  test('the clocks going forward (29 Mar 2026, a 23-hour day) keep the same boundaries', () => {
    inBerlin(() => {
      const now = local(2026, 3, 29, 23, 30)
      expect(sessionGroupOf(s('x', at(2026, 3, 29, 0, 0)), now).kind).toBe('today')
      expect(sessionGroupOf(s('x', at(2026, 3, 28, 23, 59)), now).kind).toBe('yesterday')
      const g = sessionGroupOf(s('x', at(2026, 3, 27, 12)), now)
      expect(g.key).toBe('day-2026-03-27')
      if (g.kind !== 'day') throw new Error('expected a day group')
      expect(g.day.getTime()).toBe(local(2026, 3, 27).getTime())
    })
  })
})
