// What a message's mode does to the prompt the agent is handed.
//
// The mode is per message, stored on the prompt row's payload and read back by
// the worker (session-run.worker.ts) — the session carries none, so Code and
// Q&A messages interleave freely in one conversation. The permission half of
// Q&A (read-only tool use) lives in runner-options.ts; this file is only the
// words and the decision of which mode a stored payload means.

import type { TurnMode } from './schema'

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
