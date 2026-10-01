// The learning job's run schedule — a single admin-configurable key in
// system_settings (see features/system/settings.ts for the table this
// shares), storing when the daily session-learning review runs (see
// backend/README.md for what that job does).
//
// Same absent-means-default model as max_concurrent_sessions: no row means
// "run on the built-in default", and a saved row that fails to parse against
// this schema is treated as unset rather than thrown — the identical
// behaviour settings.ts's own readMaxConcurrentSessionsOverride documents,
// because a hand-edited or stale row should degrade the feature, never 500
// the whole settings page.
//
// `z` comes from `@hono/zod-openapi`, not bare 'zod', for the same reason
// settings.ts gives for its own import: this schema is embedded in
// /system/settings's response, so it has to carry `.openapi()`, but whether
// *this* module happens to be reached through a route first, or through
// queue/learning-schedule.worker.ts's reconcile loop first (no OpenAPIHono
// anywhere in that chain), is not something this file controls.

import { z } from '@hono/zod-openapi'
import { CronExpressionParser } from 'cron-parser'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { systemSettings } from '@/db/schema'
import { logger } from '@/lib/logger'

export const LEARNING_SCHEDULE_KEY = 'learning_schedule'

/** Throws for a zone ICU does not recognise — the standard way to validate an
 * IANA zone name without a second dependency just for a lookup table. */
function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const learningScheduleSchema = z
  .object({
    enabled: z.boolean(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM, 24-hour')
      .openapi({ description: '24h HH:MM, read in `timezone` below', example: '04:00' }),
    timezone: z
      .string()
      .refine(isKnownTimeZone, 'Unknown IANA time zone')
      .openapi({ description: 'IANA zone name', example: 'Europe/Moscow' }),
  })
  .openapi('LearningSchedule')
export type LearningSchedule = z.infer<typeof learningScheduleSchema>

/**
 * Europe/Moscow, not a bare "+03:00" offset. The reference point given for
 * this default was "Moscow/Israel/Ukraine, effectively UTC+3" — three real
 * places, each with its own DST rule at other times of year — and the one
 * among them that is a fixed UTC+3 year-round, with no DST transition ever to
 * land a 04:00 run on the wrong side of, is Moscow: Russia abolished daylight
 * saving in 2014. Naming it as a zone rather than a raw offset also keeps a
 * future change of mind about which of the three to follow a one-word config
 * change rather than a code change.
 */
export const DEFAULT_LEARNING_SCHEDULE: LearningSchedule = {
  enabled: true,
  time: '04:00',
  timezone: 'Europe/Moscow',
}

/**
 * The stored override, or undefined if no row exists or it fails to validate
 * — mirrors features/system/settings.ts's own
 * readMaxConcurrentSessionsOverride, including treating a malformed stored
 * value as "nothing usable" rather than a reason to fail the request.
 */
async function readLearningScheduleOverride(): Promise<LearningSchedule | undefined> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, LEARNING_SCHEDULE_KEY))
    .limit(1)
  if (!row) return undefined

  const parsed = learningScheduleSchema.safeParse(row.value)
  if (!parsed.success) {
    logger.warn(
      `Stored ${LEARNING_SCHEDULE_KEY} (${JSON.stringify(row.value)}) does not match the ` +
        'expected shape — treating it as unset',
    )
    return undefined
  }
  return parsed.data
}

/** The effective schedule right now: a saved override if one exists, else the
 * built-in default. Reads the database fresh on every call, like
 * getMaxConcurrentSessions — queue/learning-schedule.worker.ts polls this the
 * same way queue/session-concurrency.ts polls that one. */
export async function getLearningSchedule(): Promise<{
  value: LearningSchedule
  source: 'override' | 'default'
}> {
  const override = await readLearningScheduleOverride()
  return {
    value: override ?? DEFAULT_LEARNING_SCHEDULE,
    source: override === undefined ? 'default' : 'override',
  }
}

/**
 * Applies a sparse patch for this one key: a schedule object upserts the row
 * (bumping updatedAt even when it matches the current default — the same
 * "still counts as an override" rule updateSystemSettings documents for its
 * own key); `null` deletes the row, reverting to the default; `undefined`
 * (the key left out of the PATCH body) leaves it untouched. Mirrors
 * updateSystemSettings's own handling of maxConcurrentSessions for the
 * identical reason — see that function's comment.
 */
export async function setLearningSchedule(
  value: LearningSchedule | null | undefined,
): Promise<void> {
  if (value === null) {
    await db.delete(systemSettings).where(eq(systemSettings.key, LEARNING_SCHEDULE_KEY))
  } else if (value !== undefined) {
    await db
      .insert(systemSettings)
      .values({ key: LEARNING_SCHEDULE_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      })
  }
}

// --- pure cron helpers, unit-tested in tests/learning-schedule.test.ts -----

/**
 * 'MM HH * * *' — minute and hour fields pinned, day/month/weekday left to
 * run every tick, because this schedule is "once a day at a time", nothing
 * coarser than that.
 */
export function cronPatternFor(schedule: Pick<LearningSchedule, 'time'>): string {
  const [hour, minute] = schedule.time.split(':').map(Number)
  return `${minute} ${hour} * * *`
}

/**
 * The next instant strictly after `now` at which the wall clock in
 * `schedule.timezone` reads `schedule.time` — null when disabled.
 *
 * cron-parser's own `.next()` already treats `currentDate` as exclusive: an
 * exact match steps to the *following* occurrence rather than returning `now`
 * again (verified against the installed version's actual behaviour, not
 * assumed from its docs), so this needs no extra fencepost handling.
 *
 * On a spring-forward day, `schedule.time` can name a wall-clock moment that
 * never occurs in `schedule.timezone` at all (e.g. 02:30 when that zone's
 * clocks jump from 01:59:59 straight to 03:00:00) — cron-parser resolves that
 * by shifting forward across the gap by its exact size, landing on the first
 * valid local instant after the nonexistent one (02:30 -> 03:30 for a
 * one-hour gap), rather than skipping the day entirely or firing before the
 * jump. This function inherits that behaviour rather than overriding it, and
 * tests/learning-schedule.test.ts pins it down explicitly.
 */
export function nextRunAt(schedule: LearningSchedule, now: Date): Date | null {
  if (!schedule.enabled) return null
  const interval = CronExpressionParser.parse(cronPatternFor(schedule), {
    currentDate: now,
    tz: schedule.timezone,
  })
  return interval.next().toDate()
}

/**
 * The most recent instant at or before `at` matching the schedule — null when
 * disabled. queue/learning-schedule.worker.ts uses this to compute a
 * *scheduled* run's reviewed window when the trigger fires late (the worker
 * was down, or a prior run overran):
 * the window should end at the tick that was actually due, not at whatever
 * moment the worker happened to notice it.
 *
 * `.prev()` is exclusive of its own `currentDate`, so the search runs from one
 * millisecond after `at` rather than from `at` itself — a schedule probed at
 * exactly its own fire time must still return that instant, not the
 * occurrence before it.
 *
 * On a spring-forward day, this does *not* mirror `nextRunAt`'s own gap
 * handling: `.next()` lands on the gap-shifted instant (02:30 -> 03:30)
 * because its forward minute-by-minute search naturally steps past the gap,
 * but `.prev()`'s backward day-by-day search never constructs that shifted
 * instant at all — verified against the installed version's actual
 * behaviour, not assumed — so a schedule whose time falls inside that day's
 * gap is, from this function's point of view, treated as if it had not
 * fired that day, and the previous day's occurrence is returned instead.
 * tests/learning-schedule.test.ts pins this asymmetry down explicitly. In
 * practice this only matters for a schedule time chosen to land inside some
 * zone's one-hour DST gap, which an operator picking a time like 04:00 is
 * never going to do by accident.
 */
export function latestOccurrenceAtOrBefore(schedule: LearningSchedule, at: Date): Date | null {
  if (!schedule.enabled) return null
  const interval = CronExpressionParser.parse(cronPatternFor(schedule), {
    currentDate: new Date(at.getTime() + 1),
    tz: schedule.timezone,
  })
  return interval.prev().toDate()
}
