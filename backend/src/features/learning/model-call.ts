// The one-shot, tool-less, structured-output SDK call both the review call
// and the dedupe judge call are built from — the posture copied closely from
// features/ideas/prompt-service.ts (that module's own header explains why
// each option is there): `tools: []`, `settingSources: []`, `cwd: tmpdir()`,
// `persistSession: false`, a restricted env, an abort timeout, `maxTurns`,
// `maxBudgetUsd`, `outputFormat: json_schema`. Factored out here because this
// round needs the identical shape twice (features/learning/engine.ts's own
// review call, features/learning/dedupe.ts's judge call) — one more copy of
// prompt-service.ts's own boilerplate would be the second way of doing this
// project explicitly warns against.
//
// Returns rather than throws for every failure this module can foresee —
// same reasoning prompt-service.ts gives for its own markFailed/
// finalizeCapturedResult split: a judge or review call that failed has
// already been billed by the time it can fail, so the caller needs the cost
// either way, not an exception that loses it.

import { tmpdir } from 'node:os'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { env } from '@/env'

export interface OneShotCallResult {
  ok: boolean
  /** Present only when `ok` is true: the parsed JSON the model returned. */
  data?: unknown
  /** Present only when `ok` is false: why, in a sentence an operator can read
   * straight into the run's `error` column. */
  reason?: string
  /** What this call added to the bill, win or lose — a failed call can still
   * have spent real money before it failed. */
  costUsd: number
}

/** Whichever of the two credential env vars is actually set — identical to
 * prompt-service.ts's own credentialEnv, duplicated rather than imported
 * because that module's copy is not exported and this one lives in a
 * different feature entirely. */
function credentialEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  if (env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  if (env.CLAUDE_CODE_OAUTH_TOKEN) out.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN
  return out
}

type ResultMessage = Extract<SDKMessage, { type: 'result' }>

/** A one-off result's own `errors`/`stop_reason`, read as defensively as
 * prompt-service.ts's describeResultError reads the identical shape — SDK
 * output crossing a process boundary at runtime, not a value this module
 * constructed. */
function describeNonSuccess(result: ResultMessage): string {
  const r = result as unknown as { errors?: unknown; stop_reason?: unknown; subtype: string }
  const detail =
    (Array.isArray(r.errors) ? r.errors.join('; ') : '') ||
    (typeof r.stop_reason === 'string' ? r.stop_reason : '') ||
    'no detail given'
  return `Generation ended in ${r.subtype}: ${detail}`
}

/**
 * A `subtype: 'success'` result the SDK still flagged `is_error: true` —
 * seen in practice for an invalid credential, where the SDK reports
 * `result: "Failed to authenticate. API Error: 401 Invalid bearer token"`
 * rather than a thrown exception or a non-'success' subtype. `result` is
 * already a human-readable sentence in this shape, so it is returned as-is
 * rather than wrapped in this module's own commentary — both the ordinary
 * return path and the catch block below (which used to skip this check
 * entirely and try to JSON.parse `result` as if it were the model's answer,
 * reporting a confusing "not valid JSON" failure instead of the real one)
 * go through this one function, so a credential problem reads identically
 * whichever path the SDK happens to route it through.
 */
function describeApiError(result: ResultMessage): string {
  return (result as unknown as { result?: string }).result || 'no detail given'
}

export async function runOneShotQuery(args: {
  systemPrompt: string
  prompt: string
  outputJsonSchema: Record<string, unknown>
}): Promise<OneShotCallResult> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), env.LEARNING_CALL_TIMEOUT_MS)

  // Declared outside the try so the catch block can still read whatever
  // result this run did capture before the SDK threw past it — the identical
  // reasoning, and the identical shape, prompt-service.ts's own `lastResult`
  // documents at length.
  let lastResult: ResultMessage | undefined

  try {
    const options: Options = {
      cwd: tmpdir(),
      abortController,
      persistSession: false,
      maxTurns: env.LEARNING_MAX_TURNS,
      maxBudgetUsd: env.LEARNING_CALL_BUDGET_USD,
      settingSources: [],
      tools: [],
      systemPrompt: args.systemPrompt,
      outputFormat: { type: 'json_schema', schema: args.outputJsonSchema },
      ...(env.LEARNING_MODEL !== undefined && { model: env.LEARNING_MODEL }),
      // Options.env REPLACES the subprocess environment entirely — see
      // prompt-service.ts's identical comment. This call spawns no tool that
      // could ever need anything beyond PATH/HOME/the credential.
      env: {
        ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
        ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
        ...credentialEnv(),
      },
    }

    for await (const message of query({ prompt: args.prompt, options })) {
      if (message.type === 'result') lastResult = message
    }

    if (!lastResult) {
      return {
        ok: false,
        reason: 'The model produced no result message before the query ended',
        costUsd: 0,
      }
    }
    const costUsd = (lastResult as unknown as { total_cost_usd?: number }).total_cost_usd ?? 0

    if (lastResult.subtype !== 'success') {
      return { ok: false, reason: describeNonSuccess(lastResult), costUsd }
    }
    if ((lastResult as unknown as { is_error?: boolean }).is_error) {
      return { ok: false, reason: describeApiError(lastResult), costUsd }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse((lastResult as unknown as { result: string }).result)
    } catch (error) {
      return {
        ok: false,
        reason: `Model answer was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        costUsd,
      }
    }
    return { ok: true, data: parsed, costUsd }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const costUsd =
      (lastResult as unknown as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0
    if (abortController.signal.aborted) {
      return {
        ok: false,
        reason: `Call exceeded its ${env.LEARNING_CALL_TIMEOUT_MS}ms timeout and was aborted: ${reason}`,
        costUsd,
      }
    }
    if (lastResult) {
      // The usual way this catch is reached at all — see prompt-service.ts's
      // own comment on why the SDK can throw on the very next pull after
      // already having delivered a perfectly good result message.
      if (lastResult.subtype !== 'success')
        return { ok: false, reason: describeNonSuccess(lastResult), costUsd }
      if ((lastResult as unknown as { is_error?: boolean }).is_error) {
        return { ok: false, reason: describeApiError(lastResult), costUsd }
      }
      try {
        const parsed = JSON.parse((lastResult as unknown as { result: string }).result)
        return { ok: true, data: parsed, costUsd }
      } catch (parseError) {
        return {
          ok: false,
          reason: `Model answer was not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          costUsd,
        }
      }
    }
    return { ok: false, reason: `Call failed: ${reason}`, costUsd }
  } finally {
    clearTimeout(timeout)
  }
}
