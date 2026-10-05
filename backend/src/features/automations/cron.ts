// Pure cron helpers for project automations — no database, no clock of their
// own beyond an injectable `now` — so they are unit-testable in isolation and
// reusable from the three places that must never disagree about what a valid
// schedule is: createAutomation/updateAutomation's own validation,
// POST /automations/schedule-preview, and the sweep's own claim step
// (features/automations/scheduler.ts), which calls nextOccurrenceAfter to
// compute the row's next next_run_at.
//
// See backend/README.md's "Automations" section for why a 5-minute floor
// exists at all, and tests/automations-cron.test.ts for the pinned-down
// behaviour of each function below.

import { CronExpressionParser } from 'cron-parser'
import { isKnownTimeZone } from '@/lib/time-zone'

/**
 * Exactly 5 whitespace-separated fields: minute hour day-of-month month
 * day-of-week. cron-parser itself is more permissive than this (it silently
 * accepts a leading seconds field, and expands `@daily`/`@hourly`/... macros
 * internally), but every firing here creates a git worktree and spends model
 * budget — a schedule finer than the human typing it meant to ask for is
 * exactly the mistake this feature cannot afford to be lenient about.
 */
function hasExactlyFiveFields(cron: string): boolean {
  return cron.trim().split(/\s+/).filter(Boolean).length === 5
}

/** How many of a schedule's own future occurrences the spacing check below
 * walks. Generous enough to catch a schedule that is fine most of the time
 * but crowds two firings together once a year (a day-of-month combination
 * landing close to a weekday restriction, say); cheap enough that this never
 * has to think about a time budget — see cron-timing in
 * tests/automations-cron.test.ts for how fast this actually runs. */
const SPACING_CHECK_OCCURRENCES = 100

/** Every firing spends real budget (a worktree, a model turn), so a schedule
 * that could fire more often than this is refused outright — see
 * backend/README.md's "Automations" section. */
const MIN_SPACING_MS = 5 * 60 * 1000

export interface CronValidation {
  valid: boolean
  error: string | null
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether `cron` (read in `timezone`) is a schedule this feature accepts:
 * exactly 5 fields, actually parses, produces at least one future occurrence
 * (never, e.g., "the 30th of February" — cron-parser itself already refuses
 * an impossible day-of-month/month combination at parse time, which is what
 * the parse step below is wrapped against), and never fires twice less than
 * `MIN_SPACING_MS` apart across its next `SPACING_CHECK_OCCURRENCES`
 * occurrences.
 *
 * Never throws. Every failure mode becomes `{ valid: false, error }` rather
 * than an exception — the whole point is that `POST
 * /automations/schedule-preview` can answer a cron the user is still mid-way
 * through typing with a 200 and a reason, not a 400.
 */
export function validateCron(
  cron: string,
  timezone: string,
  now: Date = new Date(),
): CronValidation {
  if (!isKnownTimeZone(timezone)) {
    return { valid: false, error: `"${timezone}" is not a recognised IANA time zone` }
  }
  if (!hasExactlyFiveFields(cron)) {
    return {
      valid: false,
      error:
        'Cron must have exactly 5 fields (minute hour day-of-month month day-of-week) — a ' +
        'seconds field or an "@" shorthand is not supported',
    }
  }

  let interval: ReturnType<typeof CronExpressionParser.parse>
  try {
    interval = CronExpressionParser.parse(cron, { currentDate: now, tz: timezone })
  } catch (error) {
    return { valid: false, error: `Invalid cron expression: ${errMessage(error)}` }
  }

  let previous: Date | undefined
  for (let i = 0; i < SPACING_CHECK_OCCURRENCES; i++) {
    let occurrence: Date
    try {
      occurrence = interval.next().toDate()
    } catch {
      // cron-parser throws once it can prove no further occurrence exists.
      // Reached with i === 0 only for a combination the parse step above did
      // not already catch; past that, enough real occurrences are already in
      // hand that an exhausted search here is not "never fires" — it just
      // means this schedule's own occurrences do not run as far as
      // SPACING_CHECK_OCCURRENCES, which is not a reason to refuse it.
      if (i === 0) {
        return {
          valid: false,
          error: 'This schedule never produces a future occurrence',
        }
      }
      break
    }
    if (previous && occurrence.getTime() - previous.getTime() < MIN_SPACING_MS) {
      return {
        valid: false,
        error:
          'Consecutive occurrences of this schedule are less than 5 minutes apart — every ' +
          'firing creates a git worktree and spends model budget, so schedules finer than that ' +
          'are refused',
      }
    }
    previous = occurrence
  }

  return { valid: true, error: null }
}

/**
 * The next occurrence of `cron` (in `timezone`) strictly after `after`.
 *
 * Only ever called once `validateCron` has already accepted the pair — the
 * sweep (scheduler.ts) relies on that: a row whose cron can no longer parse
 * (hand-edited directly in the database) is handled by its own caller
 * catching the throw this surfaces, not by this function softening it into
 * null the way `validateCron` does.
 */
export function nextOccurrenceAfter(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate()
}

/**
 * The next `count` occurrences of `cron` (in `timezone`) strictly after
 * `after`, plus whether the schedule is valid at all — the one function
 * `POST /automations/schedule-preview` calls, so create/update's own
 * rejection and the preview's `valid`/`error` can never drift onto two
 * different notions of "valid cron" (see this module's own header).
 */
export function previewSchedule(
  cron: string,
  timezone: string,
  count: number,
  after: Date = new Date(),
): { valid: boolean; error: string | null; nextRuns: Date[] } {
  const validation = validateCron(cron, timezone, after)
  if (!validation.valid) return { ...validation, nextRuns: [] }

  // validateCron already proved this parses and fires at least once; wrapped
  // anyway rather than assumed, since "never throws" is this module's whole
  // contract to its callers.
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone })
    const nextRuns: Date[] = []
    for (let i = 0; i < count; i++) nextRuns.push(interval.next().toDate())
    return { valid: true, error: null, nextRuns }
  } catch (error) {
    return { valid: false, error: `Invalid cron expression: ${errMessage(error)}`, nextRuns: [] }
  }
}
