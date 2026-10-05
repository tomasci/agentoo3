// The clock-watching half of project automations — see
// features/automations/service.ts for the CRUD half, and backend/README.md's
// "Automations" section for why this is a DB-driven sweep with a stored
// next_run_at rather than a per-automation BullMQ job scheduler (the shape
// features/learning/schedule.ts's own daily tick uses).
//
// One tick does three things, in order: claim every automation due to fire
// right now (and, if its stored cron no longer parses at all — only
// reachable by a row hand-edited directly in the database — disable it
// rather than crash or hot-loop on it forever); dispatch each claimed
// automation into a brand-new session, outside the claiming transaction
// (createSession/sendMessage reach their own queues and the filesystem,
// neither of which belongs inside a database transaction); and reconcile any
// run still `dispatching` long enough that the worker holding it has almost
// certainly died. Nothing here is retried on its own failure — the next tick
// simply tries again, the same discipline sweepIdeaHandoffs
// (features/ideas/handoff.ts) already follows for an equivalent sweep.

import { and, eq, lt, lte } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { automationRuns, automations } from '@/db/schema'
import { createSession, sendMessage } from '@/features/sessions/service'
import { logger } from '@/lib/logger'
import { nextOccurrenceAfter } from './cron'

type AutomationRow = typeof automations.$inferSelect

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `${name} · YYYY-MM-DD HH:mm`, the time rendered in the automation's own
 * timezone — not the server's, and not UTC: an operator reading a session
 * title should see the same wall-clock moment the schedule itself fired at.
 */
function sessionTitleFor(automation: AutomationRow, scheduledFor: Date): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: automation.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(scheduledFor).map((p) => [p.type, p.value]))
  // A hour12:false midnight can read back as "24" rather than "00" on some
  // ICU builds — normalised so the title never shows a clock that does not
  // exist.
  const hour = parts.hour === '24' ? '00' : parts.hour
  return `${automation.name} · ${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`
}

// --- claiming ----------------------------------------------------------------

interface Claim {
  automation: AutomationRow
  runId: string
  scheduledFor: Date
}

/**
 * One automation's claim: recompute next_run_at from `now` (never from the
 * due instant — that is what turns several missed occurrences into exactly
 * one run; see this module's own header), stamp last_run_at with the due
 * instant itself, and insert the automation_runs row — all in one
 * transaction, conditioned on the exact next_run_at this candidate was read
 * with a moment ago.
 *
 * No row back from the UPDATE means something else already claimed, edited,
 * paused or deleted it since the read — a clean skip, not a crash, same as
 * every other conditional-UPDATE claim in this codebase (e.g.
 * claimIdeaForHandoff, features/ideas/handoff.ts).
 *
 * The INSERT uses `onConflictDoNothing` rather than letting a duplicate
 * occurrence (two sweeps landing on the same due automation at once) raise a
 * unique violation: a violation would abort this transaction — Postgres
 * marks the whole transaction failed the instant any statement inside it
 * errors, so even catching that error in application code and returning
 * `null` cannot save it, and the COMMIT below would silently become a
 * ROLLBACK. That would undo the UPDATE just above it too, handing
 * `next_run_at` straight back to the value that is already due — which the
 * very next tick reads as due *again*, re-attempts the same claim, and hits
 * the same conflict forever. `onConflictDoNothing` turns a duplicate
 * occurrence into an ordinary no-op insert instead: `run` comes back
 * `undefined`, this function returns `null` exactly as it does for the lost
 * UPDATE race above, and — the whole point — the transaction still COMMITs,
 * so the schedule advance from the UPDATE always sticks regardless of which
 * sweep lost the INSERT race.
 */
async function claimOne(candidate: AutomationRow, now: Date): Promise<Claim | null> {
  const due = candidate.nextRunAt
  if (!due) return null // paused or edited away since the read; nothing to claim

  let nextRunAt: Date
  try {
    nextRunAt = nextOccurrenceAfter(candidate.cron, candidate.timezone, now)
  } catch (error) {
    // Only reachable via a row hand-edited directly in the database — the
    // API's own validation (features/automations/schema.ts) never lets an
    // unparsable cron reach this table. Disabled rather than retried
    // forever: a cron that cannot be parsed will not start parsing on the
    // next tick either.
    logger.error(
      `Automation ${candidate.id} has a cron that no longer parses; disabling it until edited: ` +
        errMessage(error),
    )
    await db
      .update(automations)
      .set({ nextRunAt: null, updatedAt: new Date() })
      .where(and(eq(automations.id, candidate.id), eq(automations.nextRunAt, due)))
    return null
  }

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(automations)
      .set({ nextRunAt, lastRunAt: due })
      .where(
        and(
          eq(automations.id, candidate.id),
          eq(automations.paused, false),
          eq(automations.nextRunAt, due),
        ),
      )
      .returning()
    if (!claimed) return null

    const [run] = await tx
      .insert(automationRuns)
      .values({
        automationId: claimed.id,
        scheduledFor: due,
        // Snapshot from the row the claim itself just returned — not the
        // candidate read a moment ago — so a prompt edited between this
        // tick's initial read and the claim still fires with what the
        // operator most recently saved.
        prompt: claimed.prompt,
        status: 'dispatching',
      })
      // See this function's own comment above: a conflict here must not
      // abort the transaction, or the UPDATE above would roll back with it.
      .onConflictDoNothing({
        target: [automationRuns.automationId, automationRuns.scheduledFor],
      })
      .returning({ id: automationRuns.id })
    // No row back means the conflict fired (not a failed insert — that would
    // have thrown) — another sweep already holds this exact occurrence.
    // Returning null here still lets the transaction commit, so the UPDATE's
    // own advance of next_run_at is kept either way.
    if (!run) return null
    return { automation: claimed, runId: run.id, scheduledFor: due }
  })
}

async function claimDueAutomations(now: Date): Promise<Claim[]> {
  const candidates = await db
    .select()
    .from(automations)
    .where(and(eq(automations.paused, false), lte(automations.nextRunAt, now)))

  const claimed: Claim[] = []
  for (const candidate of candidates) {
    const claim = await claimOne(candidate, now)
    if (claim) claimed.push(claim)
  }
  return claimed
}

// --- dispatching ---------------------------------------------------------

/**
 * Create a brand-new session and send this run's prompt into it — never a
 * reuse of an earlier run's session, even one still open or running (see
 * this feature's own brief for why: an automation-created session is meant
 * to be reviewed and closed out on its own, not silently appended to).
 *
 * Every step can fail — createSession 400s on a baseBranch that resolves to
 * nothing, or 409s on a project that is not ready — and none of it may leave
 * the run stuck `dispatching` silently: any failure records a human sentence
 * on the run's own `error` and marks it `failed`, mirroring dispatchRun's
 * identical discipline in features/ideas/handoff.ts. The session id is
 * persisted the moment it exists, before `sendMessage` even runs, so a crash
 * between the two still leaves the run pointing at the real session it
 * created rather than an orphan with no record of it at all.
 *
 * Returns whether the run ended `dispatched` — only for the sweep's own
 * summary counters, never branched on by its caller.
 */
async function dispatchRun(
  automation: AutomationRow,
  runId: string,
  scheduledFor: Date,
): Promise<boolean> {
  let sessionId: string
  try {
    const session = await createSession(automation.projectId, {
      title: sessionTitleFor(automation, scheduledFor),
      orchestrator: automation.orchestrator,
      ...(automation.baseBranch ? { baseBranch: automation.baseBranch } : {}),
      ...(automation.maxBudgetUsd !== null ? { maxBudgetUsd: automation.maxBudgetUsd } : {}),
    })
    sessionId = session.id
  } catch (error) {
    const detail = `Could not create a session for this automation: ${errMessage(error)}`
    await db
      .update(automationRuns)
      .set({ status: 'failed', error: sanitizeForDb(detail) })
      .where(eq(automationRuns.id, runId))
    return false
  }

  // Persisted immediately, before sendMessage runs — see this function's own
  // comment above for why.
  await db.update(automationRuns).set({ sessionId }).where(eq(automationRuns.id, runId))

  try {
    const message = await sendMessage(sessionId, automation.prompt)
    await db
      .update(automationRuns)
      .set({ promptMessageId: message.id, status: 'dispatched' })
      .where(eq(automationRuns.id, runId))
    return true
  } catch (error) {
    const detail = `Could not send the prompt into the session: ${errMessage(error)}`
    await db
      .update(automationRuns)
      .set({ status: 'failed', error: sanitizeForDb(detail) })
      .where(eq(automationRuns.id, runId))
    return false
  }
}

// --- stale-run reconcile -----------------------------------------------------

/** A `dispatching` run older than this has almost certainly lost the worker
 * that was holding it — mid-createSession or mid-sendMessage, most likely a
 * process restart. Comfortably longer than either call ever legitimately
 * takes (seconds, not minutes), short enough that a genuinely stuck run does
 * not sit unexplained for long. */
const STALE_DISPATCH_AFTER_MS = 10 * 60 * 1000

/**
 * A run still `dispatching` more than `STALE_DISPATCH_AFTER_MS` after its own
 * `startedAt` is marked `failed` with a sentence saying so — never
 * re-dispatched, the same "never retry, it may have already spent money"
 * policy a session turn's own recovery follows (see backend/README.md's
 * "Running a turn").
 */
async function reconcileStaleRuns(now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_DISPATCH_AFTER_MS)
  const stale = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.status, 'dispatching'), lt(automationRuns.startedAt, staleBefore)))

  const detail =
    'Stranded: the worker process dispatching this run stopped before it finished — it most ' +
    'likely died mid-dispatch. Nothing was re-run.'
  let recovered = 0
  for (const row of stale) {
    const [updated] = await db
      .update(automationRuns)
      .set({ status: 'failed', error: detail })
      .where(and(eq(automationRuns.id, row.id), eq(automationRuns.status, 'dispatching')))
      .returning({ id: automationRuns.id })
    if (updated) recovered++
  }
  return recovered
}

// --- the tick ------------------------------------------------------------

/**
 * One sweep tick: claim every automation due to fire right now, dispatch
 * each of them into a brand-new session, and reconcile any run a dead worker
 * left `dispatching`. Called on queue/automation-sweep.worker.ts's own short
 * schedule, and once at worker boot for whatever piled up while nothing was
 * sweeping — mirrors sweepIdeaHandoffs' identical two triggers.
 *
 * If the worker was down across several of an automation's own occurrences,
 * exactly one run fires — for the due instant this tick actually read — and
 * next_run_at jumps straight to the first occurrence after `now`; see
 * claimOne's own comment for why that is not a burst of catch-up runs.
 */
export async function sweepAutomations(now: Date = new Date()): Promise<{
  claimed: number
  dispatched: number
  failed: number
  staleRecovered: number
}> {
  const claims = await claimDueAutomations(now)

  let dispatched = 0
  let failed = 0
  for (const claim of claims) {
    const ok = await dispatchRun(claim.automation, claim.runId, claim.scheduledFor)
    if (ok) dispatched++
    else failed++
  }

  const staleRecovered = await reconcileStaleRuns(now)

  if (claims.length > 0 || staleRecovered > 0) {
    logger.info(
      `Automation sweep: claimed ${claims.length}, dispatched ${dispatched}, failed ${failed}, ` +
        `${staleRecovered} stale run(s) recovered`,
    )
  }
  return { claimed: claims.length, dispatched, failed, staleRecovered }
}
