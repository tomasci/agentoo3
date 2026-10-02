// Pure, unit-tested helpers over the learning schedule (features/learning/
// schedule.ts) — the cron pattern it builds, and the two instant-finding
// functions round 2's scheduler and window computation rely on. No database:
// these never read or write system_settings.
//
// The DST expectations below are pinned to the actual behaviour of the
// installed cron-parser version (5.10.0), verified independently against
// Intl's own offset readings for each zone/date rather than simply echoed
// back from the library under test — see each test's own comment for the
// arithmetic. If a future cron-parser upgrade changes how it resolves a
// nonexistent or ambiguous local time, this is what will catch it.

import { expect, test } from 'bun:test'
import './setup-env'
import {
  cronPatternFor,
  DEFAULT_LEARNING_SCHEDULE,
  type LearningSchedule,
  latestOccurrenceAtOrBefore,
  learningScheduleSchema,
  nextRunAt,
} from '@/features/learning/schedule'

const moscow = (time: string): LearningSchedule => ({
  enabled: true,
  time,
  timezone: 'Europe/Moscow',
})

const jerusalem = (time: string): LearningSchedule => ({
  enabled: true,
  time,
  timezone: 'Asia/Jerusalem',
})

// --- cronPatternFor ----------------------------------------------------------

test('cronPatternFor: minute and hour fields only, day/month/weekday wild', () => {
  expect(cronPatternFor({ time: '04:00' })).toBe('0 4 * * *')
  expect(cronPatternFor({ time: '23:59' })).toBe('59 23 * * *')
  expect(cronPatternFor({ time: '00:00' })).toBe('0 0 * * *')
  expect(cronPatternFor({ time: '09:05' })).toBe('5 9 * * *')
})

// --- the default ---------------------------------------------------------

test('the default schedule is enabled, 04:00 UTC', () => {
  expect(DEFAULT_LEARNING_SCHEDULE).toEqual({
    enabled: true,
    time: '04:00',
    timezone: 'UTC',
  })
})

// --- disabled --------------------------------------------------------------

test('nextRunAt and latestOccurrenceAtOrBefore are both null when disabled', () => {
  const disabled: LearningSchedule = { enabled: false, time: '04:00', timezone: 'Europe/Moscow' }
  expect(nextRunAt(disabled, new Date())).toBeNull()
  expect(latestOccurrenceAtOrBefore(disabled, new Date())).toBeNull()
})

// --- Europe/Moscow: fixed UTC+3, no DST ever -------------------------------
//
// Local 04:00 Europe/Moscow is always UTC 01:00 — no date in this zone can
// change that, which is exactly what makes it a convenient fixed-offset
// fixture for exercising the non-DST path below (the default itself is now
// plain UTC — see DEFAULT_LEARNING_SCHEDULE).

test('nextRunAt in a fixed-offset zone: strictly after now, same day', () => {
  const schedule = moscow('04:00')
  // Local 03:30 (UTC 00:30) — before today's 04:00 local (UTC 01:00).
  const now = new Date('2026-03-15T00:30:00.000Z')
  expect(nextRunAt(schedule, now)?.toISOString()).toBe('2026-03-15T01:00:00.000Z')
})

test('nextRunAt at exactly the fire instant steps to the following day, not the same one', () => {
  const schedule = moscow('04:00')
  const exact = new Date('2026-03-15T01:00:00.000Z')
  expect(nextRunAt(schedule, exact)?.toISOString()).toBe('2026-03-16T01:00:00.000Z')
})

test('latestOccurrenceAtOrBefore at exactly the fire instant returns that instant (inclusive)', () => {
  const schedule = moscow('04:00')
  const exact = new Date('2026-03-15T01:00:00.000Z')
  expect(latestOccurrenceAtOrBefore(schedule, exact)?.toISOString()).toBe(
    '2026-03-15T01:00:00.000Z',
  )
})

test('latestOccurrenceAtOrBefore one millisecond after the fire instant still returns it', () => {
  const schedule = moscow('04:00')
  const justAfter = new Date('2026-03-15T01:00:00.001Z')
  expect(latestOccurrenceAtOrBefore(schedule, justAfter)?.toISOString()).toBe(
    '2026-03-15T01:00:00.000Z',
  )
})

test('latestOccurrenceAtOrBefore one millisecond before the fire instant returns the previous day', () => {
  const schedule = moscow('04:00')
  const justBefore = new Date('2026-03-15T00:59:59.999Z')
  expect(latestOccurrenceAtOrBefore(schedule, justBefore)?.toISOString()).toBe(
    '2026-03-14T01:00:00.000Z',
  )
})

// --- Asia/Jerusalem: a zone that does observe DST ---------------------------
//
// 2026's spring-forward is the night of Mar 26/27: local clocks jump from
// 01:59:59 straight to 03:00:00 (GMT+2 -> GMT+3), so no wall clock in
// [02:00, 03:00) exists that night at all.

test('nextRunAt across a DST forward jump, for a time unaffected by the gap', () => {
  // 04:00 local is outside [02:00, 03:00), so this only has to get the
  // offset right on each side of the transition.
  const schedule = jerusalem('04:00')
  const now = new Date('2026-03-26T12:00:00.000Z') // local 14:00, GMT+2, well before the jump
  // Mar 27 04:00 local is already GMT+3 -> UTC 01:00.
  expect(nextRunAt(schedule, now)?.toISOString()).toBe('2026-03-27T01:00:00.000Z')
})

test('nextRunAt for a wall-clock time that does not exist on the spring-forward day', () => {
  // 02:30 local never happens on Mar 27 2026 in this zone. The documented,
  // tested behaviour (see schedule.ts's own comment on nextRunAt): resolve to
  // the first valid local instant after the gap, shifted forward by the
  // gap's exact size (one hour here) — so 02:30 becomes 03:30, not skipped
  // to the next day and not fired before the jump.
  const schedule = jerusalem('02:30')
  const now = new Date('2026-03-26T12:00:00.000Z')
  const next = nextRunAt(schedule, now)
  expect(next?.toISOString()).toBe('2026-03-27T00:30:00.000Z')

  // Confirm that instant really does read as 03:30 local, GMT+3 — the
  // gap-shifted instant, not some other accidental match.
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZoneName: 'short',
  }).format(next as Date)
  expect(local).toBe('03:30 GMT+3')
})

test('latestOccurrenceAtOrBefore does not mirror nextRunAt on a spring-forward gap day', () => {
  // Unlike nextRunAt (above), latestOccurrenceAtOrBefore's backward search
  // never discovers the gap-shifted 03:30 instant on Mar 27 — this is the
  // documented asymmetry in schedule.ts's own comment on this function, not
  // a bug in this wrapper: cron-parser's `.prev()` itself never constructs
  // it, regardless of where probed from later that same day. Probed from Mar
  // 27 itself (before Mar 28's own, perfectly ordinary 02:30 arrives), the
  // most recent occurrence it can find is Mar 26's.
  const schedule = jerusalem('02:30')
  for (const atIso of [
    '2026-03-27T01:00:00.000Z', // exactly the gap-shifted instant (03:30 local)
    '2026-03-27T20:00:00.000Z', // later the same day, still before Mar 28 02:30 local
  ]) {
    expect(latestOccurrenceAtOrBefore(schedule, new Date(atIso))?.toISOString()).toBe(
      '2026-03-26T00:30:00.000Z',
    )
  }

  // Once Mar 28 arrives, its own 02:30 is an ordinary local time again (no
  // gap that day), and the backward search finds it normally.
  expect(
    latestOccurrenceAtOrBefore(schedule, new Date('2026-03-28T00:00:00.000Z'))?.toISOString(),
  ).toBe('2026-03-27T23:30:00.000Z')
})

test('nextRunAt across the autumn fall-back (ambiguous hour), for a time outside it', () => {
  // 2026's fall-back is the night of Oct 24/25: 01:59:59 GMT+3 repeats as
  // 01:00:00 GMT+2 (the [01:00, 02:00) hour occurs twice). 04:00 is outside
  // that window, so this only has to get the new offset right.
  const schedule = jerusalem('04:00')
  const now = new Date('2026-10-24T12:00:00.000Z') // local 15:00, GMT+3
  // Oct 25 04:00 local is already GMT+2 -> UTC 02:00.
  expect(nextRunAt(schedule, now)?.toISOString()).toBe('2026-10-25T02:00:00.000Z')
})

test('nextRunAt for a wall-clock time inside the ambiguous fall-back hour picks the first occurrence', () => {
  const schedule = jerusalem('01:30')
  const now = new Date('2026-10-24T12:00:00.000Z')
  const next = nextRunAt(schedule, now)
  // The earlier of the two 01:30s that night — GMT+3, before the clocks move
  // back — not the later, GMT+2 one.
  expect(next?.toISOString()).toBe('2026-10-24T22:30:00.000Z')
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZoneName: 'short',
  }).format(next as Date)
  expect(local).toBe('01:30 GMT+3')
})

// --- schema validation -------------------------------------------------------

test('learningScheduleSchema accepts a well-formed schedule', () => {
  const parsed = learningScheduleSchema.safeParse({
    enabled: true,
    time: '04:00',
    timezone: 'Europe/Moscow',
  })
  expect(parsed.success).toBe(true)
})

test('learningScheduleSchema rejects a malformed time', () => {
  for (const time of ['24:00', '9:00', '12:60', '12:5', 'noon', '']) {
    const parsed = learningScheduleSchema.safeParse({
      enabled: true,
      time,
      timezone: 'Europe/Moscow',
    })
    expect(parsed.success).toBe(false)
  }
})

test('learningScheduleSchema rejects an unknown IANA zone', () => {
  const parsed = learningScheduleSchema.safeParse({
    enabled: true,
    time: '04:00',
    timezone: 'Mars/Olympus_Mons',
  })
  expect(parsed.success).toBe(false)
})

test('learningScheduleSchema accepts other real IANA zones', () => {
  for (const timezone of ['Asia/Jerusalem', 'Europe/Kyiv', 'UTC', 'America/New_York']) {
    const parsed = learningScheduleSchema.safeParse({ enabled: true, time: '04:00', timezone })
    expect(parsed.success).toBe(true)
  }
})
