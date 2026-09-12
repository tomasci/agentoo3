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
import type { Options, SDKMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk'
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

async function markFailed(
  promptId: string,
  reason: string,
  captured: { costUsd?: number; model?: string } = {},
): Promise<void> {
  await db
    .update(ideaPrompts)
    .set({
      status: 'failed',
      // Model output and SDK error text are both untrusted strings by the
      // time they reach here — the same reasoning sanitizeForDb's own header
      // states for tool output.
      error: sanitizeForDb(reason),
      // Populated whenever a `result` message was actually captured before
      // this failure — see every call site that passes `captured`. An
      // error_max_budget_usd failure is, by definition, the most expensive
      // kind of run; leaving these null unconditionally (the previous
      // behaviour) meant cost accounting over idea_prompts undercounted
      // exactly the runs that spent the most. A failure with no result ever
      // captured has nothing to report and stores null here, which is
      // honest — there is no cost or model to attribute it to.
      costUsd: captured.costUsd ?? null,
      model: captured.model ? sanitizeForDb(captured.model) : null,
      completedAt: new Date(),
    })
    .where(eq(ideaPrompts.id, promptId))
}

/**
 * Turns a non-success `result` message into a reason an operator can act on,
 * naming the knob that governs it where one exists. The SDK's own `errors`
 * array is the closest thing to a detail message it gives us; `subtype` is
 * the only thing that tells us which of our own limits (if any) is at fault.
 *
 * Every subtype below (bar `error_during_execution`) corresponds to one of
 * this module's own ceilings, which is why each gets its env var named
 * explicitly — "reached its turn limit" is guessable, "set
 * IDEA_PROMPT_MAX_TURNS higher" saves an operator the trip to this file.
 */
function describeResultError(result: SDKResultError): string {
  // `errors` is typed as always present, but this is SDK output crossing a
  // process boundary at runtime, not a value this module constructed — the
  // same reasoning that governs every other untrusted value in this file
  // (see markFailed's own comment) applies here too, so this reads it
  // defensively rather than trusting the type declaration.
  const detail =
    (Array.isArray(result.errors) ? result.errors.join('; ') : '') ||
    result.stop_reason ||
    'no detail given'
  if (result.subtype === 'error_max_turns') {
    return `Generation reached its turn limit before producing an answer (${result.subtype}; raise IDEA_PROMPT_MAX_TURNS, currently ${env.IDEA_PROMPT_MAX_TURNS}): ${detail}`
  }
  if (result.subtype === 'error_max_budget_usd') {
    return `Generation reached its budget ceiling before producing an answer (${result.subtype}; raise IDEA_PROMPT_MAX_BUDGET_USD, currently ${env.IDEA_PROMPT_MAX_BUDGET_USD}): ${detail}`
  }
  if (result.subtype === 'error_max_structured_output_retries') {
    return `Generation repeatedly failed to produce output matching the expected shape and gave up (${result.subtype}): ${detail}`
  }
  // 'error_during_execution', and anything the SDK adds later — its own doc
  // on SDKMessage calls this union open ("the set grows over time") — still
  // gets a legible message, just without a knob of ours to name.
  return `Generation ended in an internal error (${result.subtype}): ${detail}`
}

/**
 * Everything that happens once a `result` message has been captured, whether
 * `query()`'s generator finished normally or the SDK threw while advancing
 * past it — see the comment on `lastResult`'s declaration in `runIdeaPrompt`
 * for why the SDK can do the latter with a perfectly good, already-billed
 * answer already in hand. Handling both exits through this one function is
 * what makes that answer reach the row either way, instead of a valid
 * generation being discarded just because the CLI process then exited
 * non-zero. Every branch below finalises the row — as `ready` or as
 * `failed`, with whatever cost and model this result carried — before
 * returning, so a caller need not do anything further once this resolves;
 * the boolean says which of the two it was.
 */
async function finalizeCapturedResult(
  promptId: string,
  model: string | undefined,
  lastResult: Extract<SDKMessage, { type: 'result' }>,
): Promise<boolean> {
  const captured = { costUsd: lastResult.total_cost_usd, model }

  if (lastResult.subtype !== 'success') {
    // Kept, rather than deleted, even though the SDK throwing on the very
    // next pull (see `lastResult`'s own comment) is the normal way this is
    // reached in practice: it is what a future SDK version that lets the
    // stream end cleanly after an error subtype would hit instead.
    await markFailed(promptId, describeResultError(lastResult), captured)
    return false
  }
  if (lastResult.is_error) {
    // subtype stays 'success' here even though the turn failed — see
    // SDKResultSuccess's own doc: is_error true means an API error ended the
    // turn, with the error text left in `result`.
    await markFailed(
      promptId,
      `Generation ended in an API error: ${lastResult.result || 'no detail given'}`,
      captured,
    )
    return false
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(lastResult.result)
  } catch (error) {
    await markFailed(
      promptId,
      `Model answer was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      captured,
    )
    return false
  }

  const answer = ideaPromptAnswerSchema.safeParse(parsed)
  if (!answer.success) {
    // Per the schema's own boundary-validation reasoning: a structured-
    // output request is a strong hint, not a guarantee, so a malformed
    // answer is an ordinary, expected failure mode here — not a bug to throw
    // over.
    await markFailed(
      promptId,
      `Model answer did not match the expected shape: ${answer.error.message}`,
      captured,
    )
    return false
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
  return true
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

  // Declared here rather than inside the `try` below so the `catch` block can
  // still read whatever `result` message this run did receive. That is not
  // redundant with the post-loop checks a few lines down: reading sdk.mjs's
  // Query.readMessages shows a "result" message is enqueued to this generator
  // unconditionally, but the CLI process then exits — always, even on success
  // (see SDKResultMessage's own doc) — and when the transport treats that
  // exit as an error, the SDK discards it in favour of throwing
  // `new Error("Claude Code returned an error result: " + <the result's own
  // errors, joined>)`, which is exactly the "maxTurns (1)" message this
  // module used to surface. That throw lands on the *next* iteration of the
  // `for await` below, i.e. after the result message was already delivered
  // and `lastResult` set — so without hoisting these two out of the `try`,
  // every one of the SDK's own error subtypes (and even a genuinely valid,
  // already-billed answer) was being flattened into the generic catch below
  // with no access to the result that explains — or redeems — it.
  let model: string | undefined
  let lastResult: Extract<SDKMessage, { type: 'result' }> | undefined

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
      // A single round-trip left no room for the model to retry a structured
      // answer the CLI itself rejected, or to continue a longer one — see
      // IDEA_PROMPT_MAX_TURNS's own comment in env.ts for why every run used
      // to fail outright with "Reached maximum number of turns (1)" before
      // producing anything. `tools: []` below means there is no agentic
      // tool-use fan-out for a turn ceiling to guard against here, so
      // maxBudgetUsd and the abort timeout are what actually bound a runaway
      // run; this only has to be generous enough not to starve the ordinary
      // case.
      maxTurns: env.IDEA_PROMPT_MAX_TURNS,
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
    await finalizeCapturedResult(promptId, model, lastResult)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (abortController.signal.aborted) {
      // Kept ahead of the "a result was captured" branch below: a run cut off
      // by the deadline is still cut off even if the model got as far as
      // emitting a `result` message first — see the test that drives exactly
      // this ordering ("an abort is told apart from an early stop even when a
      // result arrived first"). Any cost that result already reported is real
      // spend regardless, so it is still recorded.
      await markFailed(
        promptId,
        `Generation exceeded its ${env.IDEA_PROMPT_TIMEOUT_MS}ms budget and was aborted: ${reason}`,
        lastResult ? { costUsd: lastResult.total_cost_usd, model } : undefined,
      )
    } else if (lastResult) {
      // The usual way this catch is reached at all — see the comment above
      // `lastResult`'s declaration. A captured result finalises exactly as it
      // would have if the loop had ended cleanly: as a stored answer when it
      // is one, and only as a stored failure otherwise.
      await finalizeCapturedResult(promptId, model, lastResult)
    } else {
      await markFailed(promptId, `Generation failed: ${reason}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}
