// The one-shot Claude call that turns a `pending` idea_prompts row into
// `ready` or `failed`. This is the whole feature's only place that spends
// money, so every branch below either produces a stored answer or a stored
// reason, and none of them may throw past the queue worker that calls this —
// see queue/idea-prompt.worker.ts and queue/index.ts's `ideaPromptQueue` for
// why: a throw there is retried, and by the time this can fail the model call
// has already been billed.
//
// Never re-reads the canvas, the idea's blocks, or its comments. The row is
// created, its `sourceDigest` computed (the deterministic document from
// features/ideas/serialize.ts, despite the column's name — see its comment in
// db/schema.ts) and any unconsumed comments stamped `consumedAt`, all in one
// transaction, at enqueue time, by the HTTP layer. That is deliberate and
// load-bearing, not an oversight to "optimise" later: if this worker read the
// canvas fresh instead of trusting `sourceDigest`, a comment added between
// enqueue and this running would either be folded into the prompt without
// ever being marked consumed (so a later follow-up folds it in again), or
// marked consumed by the enqueue transaction without ever having reached a
// prompt at all (so it is silently dropped). Reading only the already-frozen
// `sourceDigest` is what keeps those two failure modes unreachable.
//
// Known gap: with `attempts: 1` and nothing that re-drives a stuck row, a
// worker process killed mid-generation leaves this row `pending` forever —
// nothing here notices, and nothing re-enqueues it. The remedy is a
// "regenerate" action on the HTTP surface, not a retry loop in this module:
// `POST /ideas/{id}/prompts` with the same `kind` (features/ideas/service.ts's
// createIdeaPrompt) inserts a fresh row that supersedes the stuck one, and —
// this is the part that used to be missing — re-points any still-open
// idea_runs row that was reading the stuck row's `promptId`, so the very next
// sweep (features/ideas/handoff.ts's progressOpenRuns) dispatches the new,
// generated prompt instead of continuing to wait on one that was never going
// to finish. Superseding the row alone was not enough: a run's `promptId` is
// otherwise only ever written once, at claim time, and never revisited.

import { tmpdir } from 'node:os'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { ideaPrompts } from '@/db/schema'
import { env, hasClaudeCredential } from '@/env'
import { logger } from '@/lib/logger'
import { ideaPromptAnswerSchema, loadIdeaPromptInstruction } from '@/library/idea-prompt'

/**
 * A JSON Schema mirror of `ideaPromptAnswerSchema`, handed to the SDK as
 * `outputFormat` so the model is steered toward the right shape from the
 * start. Steered, not guaranteed: the answer is still parsed and zod-validated
 * below exactly as if this were absent — a structured-output request is a
 * strong hint the SDK passes to the model, not a schema the SDK enforces on
 * what comes back, and treating it as enforcement is the kind of assumption
 * this project's boundary-validation rule exists to rule out.
 */
const IDEA_PROMPT_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    prompt: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'prompt', 'assumptions'],
  additionalProperties: false,
}

async function markFailed(promptId: string, reason: string): Promise<void> {
  // Model output and SDK error text are both untrusted strings by the time
  // they reach here — the same reasoning sanitizeForDb's own header states
  // for tool output.
  await db
    .update(ideaPrompts)
    .set({ status: 'failed', error: sanitizeForDb(reason), completedAt: new Date() })
    .where(eq(ideaPrompts.id, promptId))
}

/** Whichever of the two credential env vars is actually set — see the `env`
 * field below for why only this, `PATH` and `HOME` are passed through rather
 * than the usual `{ ...process.env }`. */
function credentialEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  if (env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  if (env.CLAUDE_CODE_OAUTH_TOKEN) out.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN
  return out
}

export async function runIdeaPrompt(promptId: string): Promise<void> {
  const [row] = await db.select().from(ideaPrompts).where(eq(ideaPrompts.id, promptId)).limit(1)
  if (!row) {
    // The idea (and this row with it, on cascade) can be deleted between
    // enqueue and delivery. Nothing to fail here — there is no row left to
    // write a failure onto.
    logger.warn(`Idea prompt ${promptId} no longer exists`)
    return
  }
  // A duplicate delivery — a BullMQ redelivery, or two enqueues of the same
  // row racing — must not regenerate and re-charge. `query()` below spends
  // real money the moment it runs, whether or not this turns out to be a
  // repeat, so this check has to be the first thing that happens.
  if (row.status !== 'pending') {
    logger.info(`Idea prompt ${promptId} is already ${row.status}; not regenerating`)
    return
  }

  if (!hasClaudeCredential) {
    // Same wording session-run.worker.ts's identical guard uses, so an
    // operator sees one consistent message regardless of which queue caught
    // the missing credential.
    await markFailed(
      promptId,
      'No Claude credential. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
    )
    return
  }

  const instruction = await loadIdeaPromptInstruction()

  const abortController = new AbortController()
  // The only timeout mechanism the SDK offers — see Options.abortController.
  // An abort surfaces as a thrown error while iterating below, not as some
  // distinct "timed out" message, so the catch block is what has to tell the
  // two apart (via `abortController.signal.aborted`, since nothing else in
  // this module ever calls `.abort()`).
  const timeout = setTimeout(() => abortController.abort(), env.IDEA_PROMPT_TIMEOUT_MS)

  try {
    const options: Options = {
      // Reads no files and must touch no worktree, so cwd only has to exist —
      // never `env.PROJECTS_DIR` or a project's own repo, which this call has
      // no business anywhere near.
      cwd: tmpdir(),
      abortController,
      // Never written to ~/.claude/projects/ and never resumed: this is one
      // question, one answer, not a conversation.
      persistSession: false,
      maxTurns: 1,
      maxBudgetUsd: env.IDEA_PROMPT_MAX_BUDGET_USD,
      // No project CLAUDE.md, no user settings — this call has no project
      // directory of its own to read one from, and no operator sitting at a
      // terminal whose settings should apply.
      settingSources: [],
      // No tools at all. That also makes permissionMode and hooks moot, so
      // neither is set: there is nothing for a permission mode to gate or a
      // hook to intercept.
      tools: [],
      systemPrompt: instruction,
      outputFormat: { type: 'json_schema', schema: IDEA_PROMPT_ANSWER_JSON_SCHEMA },
      // Options.env REPLACES the subprocess environment entirely rather than
      // merging with it (the SDK's own doc on this field says so) — unlike
      // runner-options.ts's `{ ...process.env, ... }`, which the comment
      // there already flags as handing every agent subprocess DATABASE_URL
      // and REDIS_URL for no reason a tool-less run has. This call spawns no
      // tool that could ever need those, so closing that hole here costs
      // nothing: only PATH, HOME, and whichever credential variable is
      // actually set.
      env: {
        ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
        ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
        ...credentialEnv(),
      },
    }

    let model: string | undefined
    let lastResult: Extract<SDKMessage, { type: 'result' }> | undefined

    for await (const message of query({ prompt: row.sourceDigest, options })) {
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        model = message.model
      }
      if (message.type === 'result') {
        lastResult = message
      }
    }

    if (!lastResult) {
      await markFailed(promptId, 'The model produced no result message before the query ended')
      return
    }
    if (lastResult.subtype !== 'success') {
      await markFailed(promptId, `Generation stopped early: ${lastResult.subtype}`)
      return
    }
    if (lastResult.is_error) {
      await markFailed(
        promptId,
        `Generation ended in an API error: ${lastResult.result || 'no detail given'}`,
      )
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(lastResult.result)
    } catch (error) {
      await markFailed(
        promptId,
        `Model answer was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    const answer = ideaPromptAnswerSchema.safeParse(parsed)
    if (!answer.success) {
      // Per the schema's own boundary-validation reasoning: a structured-
      // output request is a strong hint, not a guarantee, so a malformed
      // answer is an ordinary, expected failure mode here — not a bug to
      // throw over.
      await markFailed(
        promptId,
        `Model answer did not match the expected shape: ${answer.error.message}`,
      )
      return
    }

    await db
      .update(ideaPrompts)
      .set({
        status: 'ready',
        generatedTitle: sanitizeForDb(answer.data.title),
        generatedText: sanitizeForDb(answer.data.prompt),
        assumptions: sanitizeForDb(answer.data.assumptions),
        model: model ? sanitizeForDb(model) : null,
        costUsd: lastResult.total_cost_usd,
        completedAt: new Date(),
      })
      .where(eq(ideaPrompts.id, promptId))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const detail = abortController.signal.aborted
      ? `Generation exceeded its ${env.IDEA_PROMPT_TIMEOUT_MS}ms budget and was aborted: ${reason}`
      : `Generation failed: ${reason}`
    await markFailed(promptId, detail)
  } finally {
    clearTimeout(timeout)
  }
}
