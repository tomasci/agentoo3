// Independent checks of the learning schedule helpers
// (features/learning/schedule.ts) against an Intl-based oracle rather than
// against cron-parser's own answers: every expected instant below is derived
// from "what does the wall clock in that zone read at this UTC instant",
// never from the library under test.
//
// Requirement: a daily run, default 04:00 UTC; in any other zone the run
// fires exactly once per local day at the configured wall-clock time, across
// DST in both directions.

import { describe, expect, test } from 'bun:test'
import './setup-env'
import {
  cronPatternFor,
  DEFAULT_LEARNING_SCHEDULE,
  type LearningSchedule,
  latestOccurrenceAtOrBefore,
  learningScheduleSchema,
  nextRunAt,
} from '@/features/learning/schedule'

const HOUR = 3_600_000

/** Local wall clock at `at` in `tz`, as 'YYYY-MM-DD HH:MM:SS' — the oracle. */
function wall(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '??'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** UTC offset of `tz` at `at`, in minutes, computed from the oracle. */
function offsetMinutes(at: Date, tz: string): number {
  const w = wall(at, tz)
  const asUtc = Date.parse(`${w.replace(' ', 'T')}Z`)
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
}

/** Every nextRunAt occurrence in calendar year 2026, chained from Jan 1. */
function chain2026(schedule: LearningSchedule): Date[] {
  const out: Date[] = []
  let t = new Date('2025-12-31T12:00:00.000Z')
  for (let i = 0; i < 400; i++) {
    const n = nextRunAt(schedule, t)
    if (!n) break
    if (n.getTime() <= t.getTime()) throw new Error(`nextRunAt went backwards at ${t.toISOString()}`)
    if (n.getUTCFullYear() > 2026) break
    if (n.getUTCFullYear() === 2026) out.push(n)
    t = n
  }
  return out
}

const sched = (time: string, timezone: string): LearningSchedule => ({ enabled: true, time, timezone })

// --- the default -------------------------------------------------------------

describe('default schedule', () => {
  test('is enabled, 04:00, UTC', () => {
    expect(DEFAULT_LEARNING_SCHEDULE).toEqual({ enabled: true, time: '04:00', timezone: 'UTC' })
  })

  test('Europe/Moscow is UTC+3 on every day of 2026 (no DST) per the Intl oracle', () => {
    const offsets = new Set<number>()
    for (let d = 0; d < 365; d++) {
      offsets.add(offsetMinutes(new Date(Date.UTC(2026, 0, 1, 12) + d * 24 * HOUR), 'Europe/Moscow'))
    }
    expect([...offsets]).toEqual([180])
  })

  test('every default occurrence in 2026 is exactly 04:00:00Z, one per day, 365 in total', () => {
    const all = chain2026(DEFAULT_LEARNING_SCHEDULE)
    expect(all.length).toBe(365)
    expect(all.every((d) => d.toISOString().endsWith('T04:00:00.000Z'))).toBe(true)
    expect(all.every((d) => wall(d, 'UTC').endsWith(' 04:00:00'))).toBe(true)
  })

  test('nextRunAt is strictly after now: at 03:59:59.999Z it is the same day, at 04:00Z the next', () => {
    expect(nextRunAt(DEFAULT_LEARNING_SCHEDULE, new Date('2026-10-01T03:59:59.999Z'))?.toISOString()).toBe(
      '2026-10-01T04:00:00.000Z',
    )
    expect(nextRunAt(DEFAULT_LEARNING_SCHEDULE, new Date('2026-10-01T04:00:00.000Z'))?.toISOString()).toBe(
      '2026-10-02T04:00:00.000Z',
    )
  })
})

// --- cron pattern ------------------------------------------------------------

test('cronPatternFor maps HH:MM to "M H * * *" without leading zeros, at the extremes', () => {
  expect(cronPatternFor({ time: '00:00' })).toBe('0 0 * * *')
  expect(cronPatternFor({ time: '23:59' })).toBe('59 23 * * *')
  expect(cronPatternFor({ time: '04:05' })).toBe('5 4 * * *')
  expect(cronPatternFor({ time: '09:07' })).toBe('7 9 * * *')
})

test('schema rejects every malformed time the API must 400 on', () => {
  for (const time of ['24:00', '4:00', '04:60', '04:0', '004:00', '04:00:00', ' 04:00', '04:00 ', '4am', '-1:00']) {
    expect({ time, ok: learningScheduleSchema.safeParse({ enabled: true, time, timezone: 'UTC' }).success }).toEqual({
      time,
      ok: false,
    })
  }
})

test('schema rejects missing fields and wrong types', () => {
  for (const body of [
    { time: '04:00', timezone: 'UTC' },
    { enabled: true, timezone: 'UTC' },
    { enabled: true, time: '04:00' },
    { enabled: 'true', time: '04:00', timezone: 'UTC' },
    { enabled: true, time: 400, timezone: 'UTC' },
    { enabled: true, time: '04:00', timezone: '' },
    { enabled: true, time: '04:00', timezone: 'Not/AZone' },
  ]) {
    expect(learningScheduleSchema.safeParse(body).success).toBe(false)
  }
})

// --- DST zones: exactly one fire per local day at the configured time --------
//
// Europe/Kyiv 2026: spring forward Mar 29 03:00 -> 04:00; fall back Oct 25
// 04:00 -> 03:00. Asia/Jerusalem 2026: spring forward Mar 27 02:00 -> 03:00;
// fall back Oct 25 02:00 -> 01:00. Offsets are confirmed from the oracle.

test('the oracle agrees on the 2026 transitions this suite relies on', () => {
  expect(offsetMinutes(new Date('2026-03-28T12:00:00Z'), 'Europe/Kyiv')).toBe(120)
  expect(offsetMinutes(new Date('2026-03-29T12:00:00Z'), 'Europe/Kyiv')).toBe(180)
  expect(offsetMinutes(new Date('2026-10-24T12:00:00Z'), 'Europe/Kyiv')).toBe(180)
  expect(offsetMinutes(new Date('2026-10-25T12:00:00Z'), 'Europe/Kyiv')).toBe(120)
  expect(offsetMinutes(new Date('2026-03-26T12:00:00Z'), 'Asia/Jerusalem')).toBe(120)
  expect(offsetMinutes(new Date('2026-03-27T12:00:00Z'), 'Asia/Jerusalem')).toBe(180)
  expect(offsetMinutes(new Date('2026-10-24T12:00:00Z'), 'Asia/Jerusalem')).toBe(180)
  expect(offsetMinutes(new Date('2026-10-25T12:00:00Z'), 'Asia/Jerusalem')).toBe(120)
})

const ORDINARY: [string, string][] = [
  ['Europe/Kyiv', '04:00'],
  ['Europe/Kyiv', '00:30'],
  ['Europe/Kyiv', '23:45'],
  ['Asia/Jerusalem', '04:00'],
  ['Asia/Jerusalem', '00:00'],
  ['Asia/Jerusalem', '23:59'],
]

for (const [tz, time] of ORDINARY) {
  test(`${tz} ${time}: 365 fires in 2026, each reading exactly ${time}:00 local, one per local date`, () => {
    const all = chain2026(sched(time, tz))
    const off = all.filter((d) => !wall(d, tz).endsWith(` ${time}:00`))
    expect(off.map((d) => d.toISOString())).toEqual([])
    expect(new Set(all.map((d) => wall(d, tz).slice(0, 10))).size).toBe(all.length)
    expect(all.length).toBe(365)
  })

  test(`${tz} ${time}: latestOccurrenceAtOrBefore round-trips every 2026 fire (at, +1ms, -1ms)`, () => {
    const s = sched(time, tz)
    const all = chain2026(s)
    const mismatches: string[] = []
    for (let i = 1; i < all.length; i++) {
      const cur = all[i] as Date
      const prev = all[i - 1] as Date
      if (latestOccurrenceAtOrBefore(s, cur)?.getTime() !== cur.getTime()) mismatches.push(`at ${cur.toISOString()}`)
      if (latestOccurrenceAtOrBefore(s, new Date(cur.getTime() + 1))?.getTime() !== cur.getTime())
        mismatches.push(`+1ms ${cur.toISOString()}`)
      if (latestOccurrenceAtOrBefore(s, new Date(cur.getTime() - 1))?.getTime() !== prev.getTime())
        mismatches.push(`-1ms ${cur.toISOString()}`)
    }
    expect(mismatches).toEqual([])
  })
}

test('Kyiv 04:00 across spring-forward: Mar 28 02:00Z then Mar 29 01:00Z (a 23h gap)', () => {
  const s = sched('04:00', 'Europe/Kyiv')
  const a = nextRunAt(s, new Date('2026-03-27T12:00:00Z'))
  const b = a && nextRunAt(s, a)
  expect(a?.toISOString()).toBe('2026-03-28T02:00:00.000Z')
  expect(b?.toISOString()).toBe('2026-03-29T01:00:00.000Z')
})

test('Kyiv 04:00 across fall-back: Oct 25 02:00Z (04:00 EET happens once), then Oct 26 02:00Z', () => {
  const s = sched('04:00', 'Europe/Kyiv')
  const a = nextRunAt(s, new Date('2026-10-24T12:00:00Z'))
  expect(a?.toISOString()).toBe('2026-10-25T02:00:00.000Z')
  expect(a && nextRunAt(s, a)?.toISOString()).toBe('2026-10-26T02:00:00.000Z')
})

// A wall time inside a fall-back hour happens twice; the run must fire once.
for (const [tz, time, day] of [
  ['Europe/Kyiv', '03:30', '2026-10-25'],
  ['Asia/Jerusalem', '01:30', '2026-10-25'],
] as const) {
  test(`${tz} ${time} (ambiguous on ${day}): fires once that local day, not twice`, () => {
    const all = chain2026(sched(time, tz))
    const thatDay = all.filter((d) => wall(d, tz).startsWith(day))
    expect(thatDay.length).toBe(1)
    expect(all.length).toBe(365)
  })

  // latestOccurrenceAtOrBefore is the worker's last-resort windowEnd source
  // (learning-schedule.worker.ts handleLearningScheduleTrigger). It must name
  // the instant the schedule actually fired — the one nextRunAt (and BullMQ,
  // which uses the same cron-parser) produces — not the second, unfired
  // reading of the same wall time.
  test(`${tz} ${time} (ambiguous on ${day}): latestOccurrenceAtOrBefore later that day names the instant that actually fired`, () => {
    const s = sched(time, tz)
    const fired = chain2026(s).find((d) => wall(d, tz).startsWith(day)) as Date
    const laterThatDay = new Date(fired.getTime() + 4 * HOUR)
    expect(latestOccurrenceAtOrBefore(s, laterThatDay)?.toISOString()).toBe(fired.toISOString())
  })
}

// A wall time inside a spring-forward gap does not exist that day; the run
// must still happen exactly once that local day (cron-parser shifts it past
// the gap — schedule.ts documents this), and never be skipped.
for (const [tz, time, day, shifted] of [
  ['Europe/Kyiv', '03:30', '2026-03-29', '04:30:00'],
  ['Asia/Jerusalem', '02:30', '2026-03-27', '03:30:00'],
] as const) {
  test(`${tz} ${time} (nonexistent on ${day}): fires once that day, shifted to ${shifted}`, () => {
    const all = chain2026(sched(time, tz))
    const thatDay = all.filter((d) => wall(d, tz).startsWith(day))
    expect(thatDay.map((d) => wall(d, tz))).toEqual([`${day} ${shifted}`])
    expect(all.length).toBe(365)
  })
}

test('disabled: nextRunAt and latestOccurrenceAtOrBefore are null in any zone', () => {
  for (const tz of ['Europe/Moscow', 'Europe/Kyiv', 'Asia/Jerusalem']) {
    const s = { enabled: false, time: '04:00', timezone: tz }
    expect(nextRunAt(s, new Date())).toBeNull()
    expect(latestOccurrenceAtOrBefore(s, new Date())).toBeNull()
  }
})
