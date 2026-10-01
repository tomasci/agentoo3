// The learning job itself: `runLearning`, the function
// queue/session-run.worker.ts dispatches a `'learning'`-named job to (see
// that file's own header for why it rides the session-run queue rather than
// a queue of its own). Everything from here down is the actual analysis —
// reading the library and the window's sessions, batching their digests, the
// per-batch review call, dedupe, and inserting survivors as
// `library_suggestions` rows. See backend/README.md's "Session learning"
// section for the shape of the whole feature; this file is the engine room.
//
// Never writes a library file. The only database write this makes besides
// learning_runs' own bookkeeping is `insertSuggestion` (features/learning/
// suggestions.ts) — status 'pending', exactly as a human-authored suggestion
// would be. Nothing here can change what a session sees until a human applies
// one.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { learningRuns, librarySuggestions, messages, projects, sessions } from '@/db/schema'
import { env, hasClaudeCredential } from '@/env'
import { logger } from '@/lib/logger'
import { agentPath, listAgents, listSkills, skillDir } from '@/library'
import { loadSessionLearningInstruction } from '@/library/learning-prompt'
import type { LearningRunJob } from '@/queue'
import { HEARTBEAT_INTERVAL_MS } from '@/queue/session-run.worker'
import { packBatches, type SessionDigest } from './batching'
import {
  type LibrarySnapshot,
  renderProposalMarkdown,
  type ValidatedCandidate,
  validateCandidate,
} from './candidates'
import { type DedupeTarget, isDeterministicDuplicate, judgeDuplicates } from './dedupe'
import { type DigestMessageRow, digestSession } from './digest'
import { runOneShotQuery } from './model-call'
import { REVIEW_ANSWER_JSON_SCHEMA, reviewAnswerSchema } from './review-schema'
import { insertSuggestion } from './suggestions'

type LearningRunRow = typeof learningRuns.$inferSelect
type ExistingSuggestionRow = typeof librarySuggestions.$inferSelect

/**
 * Claim the run: a conditional UPDATE is the mutex, the identical shape
 * session-run.worker.ts's own `claimTurn` documents — whichever delivery
 * moves the row out of 'queued' owns it, and a duplicate delivery (a BullMQ
 * redelivery, most likely) finds nothing left to claim.
 */
async function claimRun(runId: string): Promise<LearningRunRow | undefined> {
  const [row] = await db
    .update(learningRuns)
    .set({ status: 'running', startedAt: new Date(), heartbeatAt: null, updatedAt: new Date() })
    .where(and(eq(learningRuns.id, runId), eq(learningRuns.status, 'queued')))
    .returning()
  return row
}

interface Counters {
  sessionsAnalyzed: number
  suggestionsCreated: number
  duplicatesSkipped: number
}

async function finishRun(
  runId: string,
  status: 'completed' | 'failed',
  counters: Counters,
  error: string | null,
): Promise<void> {
  await db
    .update(learningRuns)
    .set({
      status,
      sessionsAnalyzed: counters.sessionsAnalyzed,
      suggestionsCreated: counters.suggestionsCreated,
      duplicatesSkipped: counters.duplicatesSkipped,
      error: error == null ? null : sanitizeForDb(error),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(learningRuns.id, runId))
}

/**
 * Adds `delta` to the run's running cost total immediately, not batched until
 * the end — so a run killed mid-way (the worker process dying, the same
 * failure domain session-run.worker.ts's own heartbeat exists for) still
 * leaves an honest partial spend on the row instead of losing it.
 */
async function addCost(runId: string, delta: number): Promise<void> {
  if (!(delta > 0)) return
  const [row] = await db
    .select({ costUsd: learningRuns.costUsd })
    .from(learningRuns)
    .where(eq(learningRuns.id, runId))
    .limit(1)
  await db
    .update(learningRuns)
    .set({ costUsd: (row?.costUsd ?? 0) + delta, updatedAt: new Date() })
    .where(eq(learningRuns.id, runId))
}

/** Every agent's and every skill's full current markdown, read straight off
 * disk — never re-rendered — plus, for a skill, the names (not the content)
 * of any files bundled beside SKILL.md. Returned both as a lookup the
 * candidate validator can compare a proposal against, and as the exact text
 * handed to the model, so "the prompt contains every item's markdown" and
 * "the validator's view of the library" can never silently disagree. */
async function loadLibrarySnapshot(): Promise<{
  snapshot: LibrarySnapshot
  renderedForPrompt: string
}> {
  const [agents, skills] = await Promise.all([listAgents(), listSkills()])
  const agentEntries = await Promise.all(
    agents.map(async (a) => [a.name, await readFile(agentPath(a.name), 'utf8')] as const),
  )
  const skillEntries = await Promise.all(
    skills.map(
      async (s) =>
        [s.name, await readFile(join(skillDir(s.name), 'SKILL.md'), 'utf8'), s.extraFiles] as const,
    ),
  )

  const snapshot: LibrarySnapshot = {
    agents: new Map(agentEntries),
    skills: new Map(skillEntries.map(([name, markdown]) => [name, markdown])),
  }

  const agentSections = agentEntries
    .map(([name, markdown]) => `#### Agent: ${name}\n\`\`\`markdown\n${markdown}\n\`\`\``)
    .join('\n\n')
  const skillSections = skillEntries
    .map(([name, markdown, extraFiles]) => {
      const extra = extraFiles.length ? extraFiles.join(', ') : '(none)'
      return `#### Skill: ${name}\nExtra files alongside SKILL.md: ${extra}\n\`\`\`markdown\n${markdown}\n\`\`\``
    })
    .join('\n\n')

  const renderedForPrompt =
    `## Current library\n\n### Agents\n\n${agentSections || '(none)'}\n\n` +
    `### Skills\n\n${skillSections || '(none)'}`

  return { snapshot, renderedForPrompt }
}

function toDedupeTarget(row: ExistingSuggestionRow): DedupeTarget {
  return {
    id: row.id,
    kind: row.kind,
    action: row.action,
    name: row.name,
    title: row.title,
    rationale: row.rationale,
    // Reparsed, not read straight off the row — see renderProposalMarkdown's
    // own comment (candidates.ts) for why a raw jsonb `proposed` cannot be
    // trusted to still be in the order it was written in, and what that costs
    // the deterministic dedupe layer (isDeterministicDuplicate) if it isn't.
    proposedMarkdown: renderProposalMarkdown(
      row.kind,
      row.name,
      row.proposed as Record<string, unknown>,
    ),
  }
}

function renderPendingRejectedList(rows: ExistingSuggestionRow[]): string {
  if (rows.length === 0) return '(none)'
  return rows
    .map(
      (r) =>
        `- [${r.status}] kind=${r.kind} action=${r.action} name=${r.name}\n` +
        `  title: ${r.title}\n  rationale: ${r.rationale}`,
    )
    .join('\n')
}

function buildReviewPrompt(
  libraryText: string,
  pendingRejectedText: string,
  batch: SessionDigest[],
): string {
  const digestsText = batch.map((d) => `### Session ${d.sessionId}\n\n${d.text}`).join('\n\n')
  return (
    `${libraryText}\n\n` +
    `## Pending and rejected suggestions already on file\n\n${pendingRejectedText}\n\n` +
    `## Sessions to review in this batch\n\n${digestsText}`
  )
}

/** Every session created in [windowStart, windowEnd), oldest first, joined to
 * its project name — exactly the window a run is defined to cover. */
async function loadWindowSessions(windowStart: Date, windowEnd: Date) {
  return db
    .select({
      id: sessions.id,
      projectName: projects.name,
      title: sessions.title,
      orchestrator: sessions.orchestrator,
      status: sessions.status,
      createdAt: sessions.createdAt,
      totalCostUsd: sessions.totalCostUsd,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(gte(sessions.createdAt, windowStart), lt(sessions.createdAt, windowEnd)))
    .orderBy(sessions.createdAt)
}

/** Every message for every session in `sessionIds`, grouped back into one
 * array per session — a single query regardless of how many sessions the
 * window held, rather than one round trip each. */
async function loadMessagesBySession(
  sessionIds: string[],
): Promise<Map<string, DigestMessageRow[]>> {
  const byId = new Map<string, DigestMessageRow[]>()
  if (sessionIds.length === 0) return byId
  const rows = await db
    .select({
      sessionId: messages.sessionId,
      type: messages.type,
      parentToolUseId: messages.parentToolUseId,
      payload: messages.payload,
      seq: messages.seq,
    })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
    .orderBy(messages.sessionId, messages.seq)
  for (const row of rows) {
    const list = byId.get(row.sessionId) ?? []
    list.push({ type: row.type, parentToolUseId: row.parentToolUseId, payload: row.payload })
    byId.set(row.sessionId, list)
  }
  return byId
}

/** Whether a run's summed cost has already reached its own ceiling — checked
 * before every new call this engine is about to start, never mid-call. */
function budgetExceeded(costSoFar: number): boolean {
  return costSoFar >= env.LEARNING_RUN_BUDGET_USD
}

/**
 * Runs the learning job for `job.learningRunId`. Every path through this
 * function ends in a terminal row: `completed` or `failed`, with
 * `finishedAt`, the three counters, `costUsd`, and (on failure, or when
 * something non-fatal still needs flagging) a human-readable `error`. Never
 * throws past its caller (queue/session-run.worker.ts's dispatcher) for an
 * ordinary failure — the one thing this cannot protect against is the
 * process dying outright, which is exactly what the heartbeat below and
 * features/learning/stale.ts's own recovery exist for.
 */
export async function runLearning(job: LearningRunJob): Promise<void> {
  const claimed = await claimRun(job.learningRunId)
  if (!claimed) {
    logger.info(
      `Learning run ${job.learningRunId} was not queued; another worker has it, or it was already handled`,
    )
    return
  }

  logger.info(
    `Learning run ${claimed.id} claimed (trigger=${claimed.trigger}, window=${claimed.windowStart.toISOString()}..${claimed.windowEnd.toISOString()})`,
  )

  const counters: Counters = { sessionsAnalyzed: 0, suggestionsCreated: 0, duplicatesSkipped: 0 }
  const notes: string[] = []
  let costSoFar = 0
  let settled = false
  // Whether any batch actually produced a parsed review answer — tracked
  // separately from `notes`/`counters` because a run can reach `completed`
  // with zero suggestions for two very different reasons: the model looked
  // and genuinely found nothing worth proposing (every batch answered), or
  // every batch's review call failed or came back unparseable, so nothing
  // was ever actually reviewed. Only the first of those is a real success;
  // the second must not read as one just because it also ends with zero
  // suggestions.
  let anyBatchReviewed = false

  const heartbeat = setInterval(() => {
    db.update(learningRuns)
      .set({ heartbeatAt: new Date() })
      .where(eq(learningRuns.id, claimed.id))
      .catch((error) => {
        logger.warn(`Learning run ${claimed.id}: heartbeat write failed: ${String(error)}`)
      })
  }, HEARTBEAT_INTERVAL_MS)
  // Never keeps the process alive by itself.
  heartbeat.unref()

  const chargeAndRecord = async (delta: number): Promise<void> => {
    if (delta > 0) {
      costSoFar += delta
      await addCost(claimed.id, delta).catch((error) => {
        logger.warn(`Learning run ${claimed.id}: could not record cost: ${String(error)}`)
      })
    }
  }

  const logFinish = (status: 'completed' | 'failed'): void => {
    logger.info(
      `Learning run ${claimed.id} finished: status=${status}, sessionsAnalyzed=${counters.sessionsAnalyzed}, ` +
        `suggestionsCreated=${counters.suggestionsCreated}, duplicatesSkipped=${counters.duplicatesSkipped}, ` +
        `costUsd=${costSoFar.toFixed(4)}`,
    )
  }

  try {
    if (!hasClaudeCredential) {
      await finishRun(
        claimed.id,
        'failed',
        counters,
        'No Claude credential. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
      )
      settled = true
      logFinish('failed')
      return
    }

    const windowSessions = await loadWindowSessions(claimed.windowStart, claimed.windowEnd)
    const messagesBySession = await loadMessagesBySession(windowSessions.map((s) => s.id))

    const digests: SessionDigest[] = []
    for (const session of windowSessions) {
      const rows = messagesBySession.get(session.id) ?? []
      const text = digestSession(
        {
          projectName: session.projectName,
          title: session.title,
          orchestrator: session.orchestrator,
          status: session.status,
          createdAt: session.createdAt,
          totalCostUsd: session.totalCostUsd,
        },
        rows,
      )
      if (text !== null) digests.push({ sessionId: session.id, text })
    }

    logger.info(
      `Learning run ${claimed.id}: ${windowSessions.length} session(s) in window, ${digests.length} digest(s)`,
    )

    if (digests.length === 0) {
      await finishRun(claimed.id, 'completed', counters, null)
      settled = true
      logFinish('completed')
      return
    }

    const [{ snapshot, renderedForPrompt }, instruction, existingRows] = await Promise.all([
      loadLibrarySnapshot(),
      loadSessionLearningInstruction(),
      db.select().from(librarySuggestions).where(eq(librarySuggestions.status, 'pending')),
    ])

    // A second, separate read for 'rejected' rather than one OR'd query: kept
    // as two simple selects rather than reaching for drizzle's `or` helper
    // for what is, at the data volumes this table holds, an entirely trivial
    // extra round trip.
    const rejectedRows = await db
      .select()
      .from(librarySuggestions)
      .where(eq(librarySuggestions.status, 'rejected'))
    const pendingAndRejected = [...existingRows, ...rejectedRows]
    const pendingRejectedText = renderPendingRejectedList(pendingAndRejected)

    // Grows as this run accepts candidates, so a later batch's dedupe (both
    // layers) sees what an earlier batch in this same run already inserted.
    const acceptedThisRun: DedupeTarget[] = pendingAndRejected.map(toDedupeTarget)

    const batches = packBatches(digests, env.LEARNING_BATCH_CHARS)
    logger.info(`Learning run ${claimed.id}: ${batches.length} batch(es) to review`)

    for (const batch of batches) {
      if (budgetExceeded(costSoFar)) {
        const remainingSessions = batches
          .slice(batches.indexOf(batch))
          .reduce((n, b) => n + b.length, 0)
        const note = `Run budget ($${env.LEARNING_RUN_BUDGET_USD}) reached; ${remainingSessions} session(s) across ${batches.length - batches.indexOf(batch)} batch(es) were not sent to the model`
        notes.push(note)
        logger.info(`Learning run ${claimed.id}: ${note}`)
        break
      }

      const batchSessionIds = new Set(batch.map((d) => d.sessionId))
      counters.sessionsAnalyzed += batch.length
      // This batch's own share of the two counters above, logged once the
      // batch is fully processed — the running totals in `counters` mix in
      // every earlier batch, which is not what "this batch's outcome" means.
      let batchDuplicatesSkipped = 0
      let batchSuggestionsCreated = 0

      const reviewResult = await runOneShotQuery({
        systemPrompt: instruction,
        prompt: buildReviewPrompt(renderedForPrompt, pendingRejectedText, batch),
        outputJsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
      })
      await chargeAndRecord(reviewResult.costUsd)

      if (!reviewResult.ok) {
        const note = `Batch of ${batch.length} session(s): review call failed: ${reviewResult.reason}`
        notes.push(note)
        logger.warn(`Learning run ${claimed.id}: ${note}`)
        continue
      }

      const parsedAnswer = reviewAnswerSchema.safeParse(reviewResult.data)
      if (!parsedAnswer.success) {
        const note = `Batch of ${batch.length} session(s): review answer did not match the expected shape: ${parsedAnswer.error.message}`
        notes.push(note)
        logger.warn(`Learning run ${claimed.id}: ${note}`)
        continue
      }
      anyBatchReviewed = true

      const validated: ValidatedCandidate[] = []
      for (const raw of parsedAnswer.data.suggestions) {
        const result = validateCandidate(raw, snapshot, batchSessionIds)
        if (!result.ok) {
          logger.warn(`Learning run ${claimed.id}: dropped a candidate — ${result.reason}`)
          continue
        }
        validated.push(result.candidate)
      }

      // Deterministic layer first: free, and shrinks what the judge call
      // (below) has to consider. Checked against both `acceptedThisRun` (what
      // earlier batches, and earlier runs, already have on file) and
      // `thisBatchTargets` (what this same batch has already let through) —
      // acceptedThisRun only gains an entry once insertSuggestion has
      // actually run, which is too late for two candidates proposed in the
      // very same review answer to catch each other.
      const survivorsAfterDeterministic: ValidatedCandidate[] = []
      const thisBatchTargets: DedupeTarget[] = []
      for (const candidate of validated) {
        const duplicate =
          isDeterministicDuplicate(candidate, acceptedThisRun) ??
          isDeterministicDuplicate(candidate, thisBatchTargets)
        if (duplicate) {
          counters.duplicatesSkipped++
          batchDuplicatesSkipped++
          continue
        }
        survivorsAfterDeterministic.push(candidate)
        // Synthetic id matches the index `judgeDuplicates` (dedupe.ts) will
        // show this same candidate under, so a `candidate:<index>` the judge
        // names for a later candidate in this batch resolves to this entry.
        thisBatchTargets.push({
          id: `candidate:${survivorsAfterDeterministic.length - 1}`,
          kind: candidate.kind,
          action: candidate.action,
          name: candidate.name,
          title: candidate.title,
          rationale: candidate.rationale,
          proposedMarkdown: candidate.proposedMarkdown,
        })
      }

      if (survivorsAfterDeterministic.length === 0) {
        logger.info(
          `Learning run ${claimed.id}: batch of ${batch.length} session(s) done — ${validated.length} candidate(s), ${batchDuplicatesSkipped} duplicate(s) skipped, 0 inserted`,
        )
        continue
      }

      if (budgetExceeded(costSoFar)) {
        const note = `Batch of ${batch.length} session(s): run budget reached before the dedupe judge could run; ${survivorsAfterDeterministic.length} candidate(s) from this batch were not inserted`
        notes.push(note)
        logger.info(`Learning run ${claimed.id}: ${note}`)
        continue
      }

      const judgeResult = await judgeDuplicates(survivorsAfterDeterministic, acceptedThisRun)
      await chargeAndRecord(judgeResult.costUsd)

      if (!judgeResult.ok) {
        // Fail closed: an unverified duplicate on file is worse than a missed
        // suggestion, so nothing from this batch is inserted when the judge
        // call itself could not be trusted.
        const note = `Batch of ${batch.length} session(s): dedupe judge call failed, so ${survivorsAfterDeterministic.length} candidate(s) were not inserted: ${judgeResult.reason}`
        notes.push(note)
        logger.warn(`Learning run ${claimed.id}: ${note}`)
        continue
      }

      for (let i = 0; i < survivorsAfterDeterministic.length; i++) {
        const candidate = survivorsAfterDeterministic[i]
        if (!candidate) continue
        if (judgeResult.duplicateOf[i] !== null) {
          counters.duplicatesSkipped++
          batchDuplicatesSkipped++
          continue
        }
        try {
          const row = await insertSuggestion({
            runId: claimed.id,
            kind: candidate.kind,
            action: candidate.action,
            name: candidate.name,
            title: candidate.title,
            rationale: candidate.rationale,
            sourceSessionIds: candidate.sourceSessionIds,
            proposed: candidate.proposed,
            baseMarkdown:
              candidate.action === 'modify'
                ? (snapshot[candidate.kind === 'agent' ? 'agents' : 'skills'].get(candidate.name) ??
                  null)
                : null,
          })
          counters.suggestionsCreated++
          batchSuggestionsCreated++
          acceptedThisRun.push({
            id: row.id,
            kind: candidate.kind,
            action: candidate.action,
            name: candidate.name,
            title: candidate.title,
            rationale: candidate.rationale,
            proposedMarkdown: candidate.proposedMarkdown,
          })
        } catch (error) {
          // insertSuggestion re-validates `proposed` against the exact same
          // schemas validateCandidate already checked above — this should
          // never actually fire, but a model-proposed body is untrusted input
          // twice over, so this is logged and dropped rather than crashing
          // the whole run over one candidate.
          logger.warn(
            `Learning run ${claimed.id}: insertSuggestion rejected a validated candidate (${candidate.kind} ${candidate.name}): ${String(error)}`,
          )
        }
      }

      logger.info(
        `Learning run ${claimed.id}: batch of ${batch.length} session(s) done — ${validated.length} candidate(s), ${batchDuplicatesSkipped} duplicate(s) skipped, ${batchSuggestionsCreated} inserted`,
      )
    }

    // A run that reaches here with batches but not one of them successfully
    // reviewed must not read as `completed`: zero suggestions from a run that
    // never got a usable answer out of the model is a failure, not a quiet
    // success, and this is the one place that distinction is still visible
    // (every batch's own note is already folded into `notes` below). This
    // also covers the run budget being exhausted before the first batch was
    // ever reviewed, since that path never sets `anyBatchReviewed` either.
    const status = anyBatchReviewed ? 'completed' : 'failed'
    await finishRun(claimed.id, status, counters, notes.length ? notes.join(' | ') : null)
    settled = true
    logFinish(status)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`Learning run ${claimed.id} failed: ${detail}`)
    try {
      await finishRun(claimed.id, 'failed', counters, detail)
      settled = true
      logFinish('failed')
    } catch (fatal) {
      logger.error(
        `Learning run ${claimed.id} is stranded: it still reads as 'running' and could not be marked failed (${String(fatal)}). features/learning/stale.ts's own recovery will pick it up once its heartbeat goes stale.`,
      )
    }
  } finally {
    clearInterval(heartbeat)
    if (!settled) {
      // The backstop: a branch above that returned without ever calling
      // finishRun — the identical "eleventh branch someone adds next year"
      // reasoning session-run.worker.ts's own finally gives for `endTurn`.
      await finishRun(
        claimed.id,
        'failed',
        counters,
        'No branch in this run recorded an outcome.',
      ).catch((fatal) => {
        logger.error(
          `Learning run ${claimed.id}: the unconditional backstop itself failed: ${String(fatal)}`,
        )
      })
    }
  }
}
