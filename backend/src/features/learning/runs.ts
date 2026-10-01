// Starting and listing learning runs — see db/schema.ts's own comment on
// learning_runs for why at most one may be queued or running at a time, and
// backend/README.md for what a run actually does (round 2).
//
// Kept free of HTTP concerns on purpose: routes.ts is the only caller today,
// but round 2's own scheduler (the learning-schedule queue/worker) calls
// createLearningRun directly too, and neither should have to go through Hono
// to start a run.

import { desc, eq, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { learningRuns } from '@/db/schema'
import { isUniqueViolation } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { enqueueLearningRun } from '@/queue'
import { getLearningSchedule, nextRunAt } from './schedule'

type LearningRunRow = typeof learningRuns.$inferSelect

/** Row -> wire shape: every timestamp as ISO, nothing else to transform. */
function toLearningRunDto(row: LearningRunRow) {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    sessionsAnalyzed: row.sessionsAnalyzed,
    suggestionsCreated: row.suggestionsCreated,
    duplicatesSkipped: row.duplicatesSkipped,
    costUsd: row.costUsd,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}
export type LearningRunDto = ReturnType<typeof toLearningRunDto>

const DAY_MS = 24 * 60 * 60 * 1000

const ACTIVE = () => or(eq(learningRuns.status, 'queued'), eq(learningRuns.status, 'running'))
const FINISHED = () => or(eq(learningRuns.status, 'completed'), eq(learningRuns.status, 'failed'))

export type CreateLearningRunResult = { run: LearningRunDto } | { conflict: LearningRunDto }

/**
 * Starts a new run: windowStart is windowEnd minus 24h. The insert is the
 * actual mutex — learning_runs_single_active_key (db/schema.ts) is what
 * decides whether this succeeds, not a check-then-insert read here, so two
 * concurrent callers can never both believe they started the one active run.
 *
 * A unique-violation here is not a failure to report upward: it means a run
 * is already active, which is exactly what the caller needs to know, so this
 * resolves to `{ conflict }` rather than throwing.
 */
export async function createLearningRun(args: {
  trigger: 'scheduled' | 'manual'
  windowEnd: Date
}): Promise<CreateLearningRunResult> {
  const windowStart = new Date(args.windowEnd.getTime() - DAY_MS)

  let row: LearningRunRow
  try {
    const [inserted] = await db
      .insert(learningRuns)
      .values({ trigger: args.trigger, windowStart, windowEnd: args.windowEnd })
      .returning()
    if (!inserted) throw new Error('Insert returned no row')
    row = inserted
  } catch (error) {
    if (isUniqueViolation(error, 'learning_runs_single_active_key')) {
      const [active] = await db.select().from(learningRuns).where(ACTIVE()).limit(1)
      // The conflicting row finished between the failed insert and this read
      // — vanishingly unlikely, but report it as "nothing active" rather than
      // fabricate a row, and let the caller's own retry succeed normally.
      if (!active) throw new Error('A learning run conflicted, but no active run could be found')
      return { conflict: toLearningRunDto(active) }
    }
    throw error
  }

  try {
    await enqueueLearningRun({ learningRunId: row.id })
    return { run: toLearningRunDto(row) }
  } catch (error) {
    // The row must not block every future run forever just because this one
    // instant of enqueueing failed (Redis unreachable, most likely) — mark it
    // failed so the unique index stops treating it as active.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Learning run ${row.id}: could not enqueue — ${message}`)
    const [failed] = await db
      .update(learningRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(learningRuns.id, row.id))
      .returning()
    return {
      run: toLearningRunDto(
        failed ?? { ...row, status: 'failed', error: message, finishedAt: new Date() },
      ),
    }
  }
}

export interface LearningOverview {
  schedule: {
    value: Awaited<ReturnType<typeof getLearningSchedule>>['value']
    nextRunAt: string | null
  }
  activeRun: LearningRunDto | null
  lastRun: LearningRunDto | null
  recentRuns: LearningRunDto[]
}

/** Everything the Library UI's learning page needs in one call: the current
 * schedule, whichever run is active (if any), the most recent finished run,
 * and up to the 10 most recent runs overall, newest first. */
export async function getLearningOverview(): Promise<LearningOverview> {
  const schedule = await getLearningSchedule()
  const [active, last, recent] = await Promise.all([
    db.select().from(learningRuns).where(ACTIVE()).orderBy(desc(learningRuns.createdAt)).limit(1),
    db
      .select()
      .from(learningRuns)
      .where(FINISHED())
      .orderBy(desc(learningRuns.finishedAt))
      .limit(1),
    db.select().from(learningRuns).orderBy(desc(learningRuns.createdAt)).limit(10),
  ])

  return {
    schedule: {
      value: schedule.value,
      nextRunAt: nextRunAt(schedule.value, new Date())?.toISOString() ?? null,
    },
    activeRun: active[0] ? toLearningRunDto(active[0]) : null,
    lastRun: last[0] ? toLearningRunDto(last[0]) : null,
    recentRuns: recent.map(toLearningRunDto),
  }
}
