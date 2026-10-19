// What a message's mode does to the prompt the agent is handed.
//
// The mode is per message, stored on the prompt row's payload and read back by
// the worker (session-run.worker.ts) — the session carries none, so Code and
// Q&A messages interleave freely in one conversation. The permission half of
// Q&A (read-only tool use) lives in runner-options.ts; this file is only the
// words and the decision of which mode a stored payload means.
//
// The same goes for the one other thing a prompt can be wrapped in: the summary
// a compacted session starts from (withCompactedContext, below).

import { type CompactContextPayload, compactContextPayloadSchema, type TurnMode } from './schema'

/**
 * Prepended to a Q&A turn's prompt, never to the stored message: the
 * transcript renders `payload.text`, so the operator keeps seeing only what
 * they typed.
 *
 * Asking is not what keeps the turn read-only — `optionsFor` denies the writes
 * in Q&A mode regardless — but without it the agent spends the turn trying
 * edits that are refused and then reports the refusals, instead of answering.
 */
export const QA_MODE_INSTRUCTION =
  "[Q&A mode] The user's message below is a question or a note, not a task. Answer it conversationally, using everything already in this conversation. Do not edit, create, or delete files, do not run commands that change state (no commits, installs, migrations, builds that write files, or service/container changes), do not delegate work that would make changes, and do not make any other modifications. You may read files and inspect the project to answer accurately. This applies to this message only."

/**
 * Which mode a stored prompt payload asks for. Anything but an explicit
 * `mode: 'qa'` is Code: every prompt row written before this existed has no
 * `mode` at all, and a payload is JSON read back from the database, so a
 * malformed one must degrade to the permissive default the app has always run
 * with rather than throw in the middle of claiming a turn.
 */
export function turnModeOf(payload: unknown): TurnMode {
  return typeof payload === 'object' &&
    payload !== null &&
    (payload as { mode?: unknown }).mode === 'qa'
    ? 'qa'
    : 'code'
}

/**
 * The text the SDK is given for one turn: the attachments announcement (if
 * this turn is the one that first announces files), then — Q&A only — the
 * instruction, then what the operator typed.
 *
 * Code is exactly what the worker built inline before modes existed, so that
 * path stays byte-identical. In Q&A the instruction sits after the
 * announcement, not before it, so the announcement still reads as the harness's
 * note about the files and the instruction reads as framing for the message it
 * directly precedes.
 */
export function composeTurnPrompt({
  announcement,
  text,
  mode,
}: {
  announcement: string
  text: string
  mode: TurnMode
}): string {
  if (mode === 'qa') {
    return `${announcement ? `${announcement}\n` : ''}${QA_MODE_INSTRUCTION}\n\n${text}`
  }
  return announcement ? `${announcement}\n${text}` : text
}

/**
 * `messages.type` of the row a compacted session starts from. Ours, like
 * 'prompt': the SDK never emits it. Always seq 0 and never pending, so the turn
 * worker, which only claims pending prompts, can never mistake it for one.
 */
export const COMPACT_CONTEXT_TYPE = 'compact_context'

/** What the framing below needs from a `compact_context` payload. */
export type CompactedContext = Pick<
  CompactContextPayload,
  'summary' | 'sourceSessionId' | 'sourceTitle' | 'sourceBranch'
>

/**
 * A stored `compact_context` payload as the context it means, or null when it
 * is not one. The payload is JSON read back from the database, so a malformed
 * row degrades to "no seed" instead of throwing mid-claim — the same stance as
 * turnModeOf.
 */
export function compactContextOf(payload: unknown): CompactedContext | null {
  const parsed = compactContextPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const { summary, sourceSessionId, sourceTitle, sourceBranch } = parsed.data
  return { summary, sourceSessionId, sourceTitle, sourceBranch }
}

/**
 * The prompt for a compacted session's first turn: the summary of the
 * conversation it continues, framed as background, then the operator's message.
 *
 * Never stored — the prompt row keeps only what the operator typed, so the
 * transcript shows that and nothing else. The worker applies this only while
 * the session has no SDK session yet: once the first turn's `init` persists one,
 * `resume` carries this text with the rest of the conversation, and repeating it
 * would pay for the summary again on every turn. A first turn that died before
 * `init` leaves no SDK session, so the next one re-seeds, which is correct.
 *
 * The framing says what the block is, because a model handed a wall of prior
 * work as the opening of a user message will otherwise take it for the request.
 * The branch sentence is there because the new worktree starts from the source
 * branch's last commit, not from the source's working tree: edits the source
 * had not committed are not here, and an agent that assumes they are will
 * report work it cannot find.
 */
export function withCompactedContext(prompt: string, context: CompactedContext | null): string {
  if (!context) return prompt
  const title = context.sourceTitle ?? 'Untitled session'
  return [
    '[Compacted context from previous session]',
    `This conversation continues work from an earlier session ("${title}", id ${context.sourceSessionId}) whose history was compacted into the summary below. It is background context, not a new request.`,
    ...(context.sourceBranch
      ? [
          `This session's worktree was cut from the last commit of branch "${context.sourceBranch}"; uncommitted changes from the previous session are not present.`,
        ]
      : []),
    `<summary>\n${context.summary}\n</summary>`,
    '[End of compacted context]',
    '',
    prompt,
  ].join('\n')
}
