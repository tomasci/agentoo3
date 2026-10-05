// The CRUD half of project automations — the board of schedules themselves,
// and the read-only history of their runs. What this module deliberately
// does NOT do: watch the clock, claim a due automation, create the session it
// fires into, or close out a run — that is features/automations/scheduler.ts,
// the sweep this feature's worker side runs. This file only ever reads and
// writes the `automations` row itself (plus a batched read over
// `automation_runs` for the history endpoint and the `runCount` on every DTO).

import { count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { automationRuns, automations, projects } from '@/db/schema'
import type { SessionSummary } from '@/features/sessions/service'
import { sessionSummariesFor } from '@/features/sessions/service'
import { badRequest, notFound } from '@/lib/errors'
import { nextOccurrenceAfter, previewSchedule, validateCron } from './cron'
import type {
  AutomationDto,
  AutomationRunDto,
  CreateAutomationInput,
  SchedulePreviewDto,
  SchedulePreviewInput,
  UpdateAutomationInput,
} from './schema'

type AutomationRow = typeof automations.$inferSelect
type AutomationRunRow = typeof automationRuns.$inferSelect

async function requireProject(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!row) throw notFound('Project')
  return row
}

async function requireAutomationRow(id: string): Promise<AutomationRow> {
  const [row] = await db.select().from(automations).where(eq(automations.id, id)).limit(1)
  if (!row) throw notFound('Automation')
  return row
}

/** How many times each automation has ever fired — one batched count, the
 * same shape blockCountsFor/commentCountsFor (features/ideas/service.ts)
 * already use for an identical reason: a board (or a single card) must never
 * cost one extra query per row. */
async function runCountsFor(automationIds: string[]): Promise<Map<string, number>> {
  if (automationIds.length === 0) return new Map()
  const rows = await db
    .select({ automationId: automationRuns.automationId, n: count() })
    .from(automationRuns)
    .where(inArray(automationRuns.automationId, automationIds))
    .groupBy(automationRuns.automationId)
  return new Map(rows.map((r) => [r.automationId, Number(r.n)]))
}

function toDto(row: AutomationRow, runCount: number): AutomationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    paused: row.paused,
    orchestrator: row.orchestrator,
    baseBranch: row.baseBranch,
    maxBudgetUsd: row.maxBudgetUsd,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listAutomations(projectId: string): Promise<AutomationDto[]> {
  await requireProject(projectId)
  const rows = await db
    .select()
    .from(automations)
    .where(eq(automations.projectId, projectId))
    .orderBy(automations.createdAt)
  const runCounts = await runCountsFor(rows.map((r) => r.id))
  return rows.map((r) => toDto(r, runCounts.get(r.id) ?? 0))
}

export async function getAutomation(id: string): Promise<AutomationDto> {
  const row = await requireAutomationRow(id)
  const runCounts = await runCountsFor([row.id])
  return toDto(row, runCounts.get(row.id) ?? 0)
}

/**
 * Re-validate `cron`+`timezone` before trusting either one, regardless of
 * whether the call came through the HTTP schema (createAutomationSchema and
 * updateAutomationSchema already check this at the boundary) or some future
 * internal caller that reaches this module directly, bypassing zod entirely
 * — the identical defence createSession's own orchestrator guard documents
 * (features/sessions/service.ts). Throws `badRequest`, never lets an invalid
 * pair reach `nextOccurrenceAfter`, which assumes validity and would throw a
 * raw cron-parser error instead of this feature's own error envelope.
 */
function assertValidCron(cron: string, timezone: string): void {
  const result = validateCron(cron, timezone)
  if (!result.valid) throw badRequest(result.error ?? 'Invalid cron schedule')
}

/** `nextOccurrenceAfter`, but turning a cron that has gone bad since it was
 * last validated (the stored row was hand-edited outside this API — the
 * scheduler's own "no longer parses" case, backend/README.md's "Automations"
 * section) into this feature's own 400 rather than a raw cron-parser
 * exception reaching the client as a 500. */
function nextOccurrenceOrThrow(cron: string, timezone: string, after: Date): Date {
  try {
    return nextOccurrenceAfter(cron, timezone, after)
  } catch (error) {
    throw badRequest(
      `This automation's stored schedule is no longer valid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * Create an automation. `next_run_at` is the first occurrence strictly after
 * now — null if created paused, per the schedule-state rules in this
 * feature's own brief (and this table's own comment, db/schema.ts): "null
 * exactly while paused" is an invariant, not merely today's default.
 */
export async function createAutomation(
  projectId: string,
  input: CreateAutomationInput,
): Promise<AutomationDto> {
  await requireProject(projectId)
  assertValidCron(input.cron, input.timezone)

  const paused = input.paused ?? false
  const nextRunAt = paused ? null : nextOccurrenceOrThrow(input.cron, input.timezone, new Date())

  const [row] = await db
    .insert(automations)
    .values({
      projectId,
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone,
      paused,
      orchestrator: input.orchestrator,
      baseBranch: input.baseBranch ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      nextRunAt,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')
  return getAutomation(row.id)
}

/**
 * Patch an automation. Every field is independently optional, and most of
 * them — name, prompt, orchestrator, baseBranch, maxBudgetUsd — leave
 * `next_run_at` untouched: the sweep re-reads the row at fire time, so those
 * take effect on the next run without this function doing anything about
 * scheduling at all. `cron`/`timezone`/`paused` are the three fields this
 * schedule-state machine actually cares about:
 *
 * - `paused` ending up true: `next_run_at` becomes null, full stop, even if
 *   this same request also changed `cron`/`timezone` — a schedule that will
 *   not fire has nothing for a next-run instant to describe, and the stored
 *   (possibly just-edited) cron is validated below regardless, so resuming
 *   later never discovers a broken schedule.
 * - `cron` or `timezone` actually changing, or `paused` flipping true→false
 *   (a resume): `next_run_at` is recomputed from now — a resume never
 *   back-fills occurrences missed while paused, and an edited schedule is
 *   judged against the clock at the moment it was saved, not against
 *   whatever instant the old cron would have produced.
 * - Neither of the above: `next_run_at` is left out of the UPDATE's own SET
 *   entirely, not merely re-written with the value this function read a
 *   moment ago. A plain rename or prompt edit has no business touching the
 *   schedule at all, and `row.nextRunAt` can already be stale by the time
 *   this statement runs: the sweep (scheduler.ts's `claimOne`) advances that
 *   same column, in its own transaction, on exactly the short interval this
 *   PATCH races against. Writing `row.nextRunAt` back unconditionally would
 *   silently undo a claim that committed in that window — the automation's
 *   `next_run_at` would point at the occurrence that *just fired* again,
 *   which the next sweep tick would try to claim a second time, collide with
 *   the `automation_runs` row the first claim already inserted, and never
 *   advance past. Omitting the column from the SET is what makes "nothing
 *   here changed the schedule" true at the SQL level, not just in this
 *   function's own intent.
 */
export async function updateAutomation(
  id: string,
  input: UpdateAutomationInput,
): Promise<AutomationDto> {
  const row = await requireAutomationRow(id)

  const nextCron = input.cron ?? row.cron
  const nextTimezone = input.timezone ?? row.timezone
  const scheduleChanged = nextCron !== row.cron || nextTimezone !== row.timezone
  if (scheduleChanged) assertValidCron(nextCron, nextTimezone)

  const nextPaused = input.paused ?? row.paused
  const resumed = row.paused && !nextPaused

  // Absent entirely (rather than `row.nextRunAt`) in the "neither" case —
  // see this function's own comment above for why that distinction is the
  // whole point.
  let nextRunAtPatch: { nextRunAt: Date | null } | Record<string, never>
  if (nextPaused) {
    nextRunAtPatch = { nextRunAt: null }
  } else if (scheduleChanged || resumed) {
    nextRunAtPatch = { nextRunAt: nextOccurrenceOrThrow(nextCron, nextTimezone, new Date()) }
  } else {
    nextRunAtPatch = {}
  }

  await db
    .update(automations)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.prompt !== undefined && { prompt: input.prompt }),
      ...(input.cron !== undefined && { cron: input.cron }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
      ...(input.paused !== undefined && { paused: input.paused }),
      ...(input.orchestrator !== undefined && { orchestrator: input.orchestrator }),
      ...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
      ...(input.maxBudgetUsd !== undefined && { maxBudgetUsd: input.maxBudgetUsd }),
      ...nextRunAtPatch,
      updatedAt: new Date(),
    })
    .where(eq(automations.id, id))

  return getAutomation(id)
}

/** Delete the row; automation_runs cascades with it, but the sessions those
 * runs created do not — they are the user's own work (see this feature's own
 * brief, and idea_runs' identical reasoning in db/schema.ts). */
export async function deleteAutomation(id: string): Promise<void> {
  await requireAutomationRow(id)
  await db.delete(automations).where(eq(automations.id, id))
}

// --- runs: read-only here — created and closed by the scheduler ------------

const DEFAULT_RUN_LIMIT = 100
const MAX_RUN_LIMIT = 500

function toRunDto(row: AutomationRunRow, session: SessionSummary | undefined): AutomationRunDto {
  return {
    id: row.id,
    automationId: row.automationId,
    sessionId: row.sessionId,
    scheduledFor: row.scheduledFor.toISOString(),
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    error: row.error,
    prompt: row.prompt,
    session: session
      ? {
          id: session.id,
          title: session.title,
          status: session.status,
          totalCostUsd: session.totalCostUsd,
          unchecked: session.unchecked,
        }
      : null,
  }
}

export async function listAutomationRuns(
  automationId: string,
  limit?: number,
): Promise<AutomationRunDto[]> {
  await requireAutomationRow(automationId)
  const cappedLimit = Math.min(limit ?? DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT)

  const rows = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.scheduledFor))
    .limit(cappedLimit)

  const sessionIds = [
    ...new Set(rows.map((r) => r.sessionId).filter((id): id is string => id !== null)),
  ]
  const sessions = await sessionSummariesFor(sessionIds)
  return rows.map((r) => toRunDto(r, r.sessionId ? sessions.get(r.sessionId) : undefined))
}

// --- schedule preview ---------------------------------------------------------

const DEFAULT_PREVIEW_COUNT = 5

/**
 * Never throws, and never a 400 for a bad cron — see this feature's own
 * brief, and schedulePreviewRequestSchema's own `valid`/`error` fields (the
 * one place in this feature where an invalid schedule is an ordinary 200
 * answer, because the UI calls this live while the operator is still typing).
 */
export function schedulePreview(input: SchedulePreviewInput): SchedulePreviewDto {
  const result = previewSchedule(input.cron, input.timezone, input.count ?? DEFAULT_PREVIEW_COUNT)
  return {
    valid: result.valid,
    error: result.error,
    nextRuns: result.nextRuns.map((d) => d.toISOString()),
  }
}
