// Runs one turn of a session: hands the user's message to the Agent SDK and
// records everything that comes back.
//
// A turn is the unit of work, not a session. The SDK's `resume` carries the
// conversation across turns, so the worker holds no state between them and a
// restart costs at most the turn that was in flight. That is also why a turn is
// never retried: by the time it can fail it has already edited files and spent
// tokens, and running it again would repeat both.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { Worker } from 'bullmq'
import { and, desc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import {
  messageFiles,
  messages,
  projects,
  sessionFiles,
  sessions,
  type turnOutcomeEnum,
} from '@/db/schema'
import { env, hasClaudeCredential } from '@/env'
import { announcementFor } from '@/features/attachments/manifest'
import { toManifestFile } from '@/features/attachments/service'
import { optionsFor } from '@/features/sessions/runner-options'
import { messageDto, toMessageDto } from '@/features/sessions/service'
import { type TranscriptMessage, titleFor } from '@/features/sessions/titles'
import { publishSessionEvent, subscribeControl } from '@/lib/events'
import { logger } from '@/lib/logger'
import { sessionUploadsDir } from '@/lib/paths'
// Imported as a namespace, not destructured: several tests hand-write a
// mock of this module listing only the exports that existed when they were
// written (session-recovery.test.ts, attachments-announcement.test.ts,
// session-message-shape.test.ts among them), and a static `import { x }
// from` a name that mock does not provide is a hard `SyntaxError` at load
// time under Bun's `mock.module`, not a soft `undefined` — verified
// directly. A namespace import degrades to `queueIndex.enqueueTurnEnded`
// reading `undefined` instead, which `endTurn` below already treats the
// same as the queue rejecting the call.
import * as queueIndex from './index'
import { enqueueSessionRun, QUEUE_SESSION_RUN, redisConnection, type SessionRunJob } from './index'

/**
 * Allocate the next position in the transcript.
 *
 * An atomic increment rather than `max(seq) + 1`: the API appends the user's
 * message while the worker may still be appending the previous turn's, and two
 * readers of the same max would collide on the unique index.
 */
async function nextSeq(sessionId: string): Promise<number> {
  const [row] = await db
    .update(sessions)
    .set({ nextSeq: sql`${sessions.nextSeq} + 1` })
    .where(eq(sessions.id, sessionId))
    .returning({ seq: sessions.nextSeq })
  if (!row) throw new Error(`Session ${sessionId} disappeared mid-turn`)
  // RETURNING gives the new value, so the one we were allocated is the previous.
  return row.seq - 1
}

/** Persist a message, then announce it. Order matters: the row is the record. */
export async function appendMessage(
  sessionId: string,
  message: TranscriptMessage,
  who: string,
): Promise<void> {
  const seq = await nextSeq(sessionId)
  const parentToolUseId =
    'parent_tool_use_id' in message ? ((message.parent_tool_use_id as string | null) ?? null) : null

  const [row] = await db
    .insert(messages)
    .values(
      // The SDK message is raw tool output: a NUL character anywhere inside it
      // makes Postgres reject the row, which would lose the message and, since
      // the publish below never runs, hide that loss from every client.
      sanitizeForDb({
        sessionId,
        seq,
        type: message.type,
        parentToolUseId,
        title: titleFor(message, who),
        payload: message as unknown as Record<string, unknown>,
      }),
    )
    .returning()
  if (!row) throw new Error(`Session ${sessionId} disappeared mid-turn`)

  // toMessageDto's default files=[] is right, not assumed: only a 'prompt' row
  // ever carries an attachment link, and appendMessage is never called with
  // one — see sendMessage/messageDto in service.ts for where that row's
  // `files` actually gets resolved and republished.
  await publishSessionEvent({ kind: 'message', sessionId, seq, message: toMessageDto(row) })
}

async function setStatus(sessionId: string, status: string, lastError?: string | null) {
  await db
    .update(sessions)
    .set({
      status: status as 'idle' | 'queued' | 'running' | 'interrupted' | 'completed' | 'failed',
      // Usually a process's stderr, verbatim.
      ...(lastError !== undefined && { lastError: sanitizeForDb(lastError) }),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
  await publishSessionEvent({ kind: 'status', sessionId, status, lastError })
}

/** The turn_outcome enum's own value type, so a typo cannot compile. */
type TurnOutcome = (typeof turnOutcomeEnum.enumValues)[number]

/**
 * How often the running-turn heartbeat below touches `sessions.heartbeatAt`.
 * Also the unit the reconciler's staleness threshold is built from
 * (turn-reconcile.worker.ts imports this and multiplies it by 3, rather than
 * redefining the tick there, so the two constants cannot drift apart). A
 * file-local constant, not `env.ts`: a parallel track owns that file right
 * now.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Record the one durable fact a turn produces: that the prompt which started
 * it has stopped, and how. Persist first, announce after — the row is the
 * record, the same rule `appendMessage` already follows above.
 *
 * `AND turn_ended_at IS NULL` is what makes this idempotent, and idempotency
 * here is load-bearing, not incidental: `runTurn`'s backstop in its `finally`
 * calls this unconditionally whenever no branch above already has, and the
 * reconciler (turn-reconcile.worker.ts) calls it again for a turn it decides
 * is stranded — both have to find nothing left to do on a prompt some branch
 * already closed, rather than overwriting a true verdict with a stale one.
 *
 * Returns whether *this* call is the one that actually rendered the verdict.
 * `runTurn` feeds that straight into its own `verdict` flag rather than
 * assuming it is always true at the call site, because the one case it is
 * *not* true — a verdict already recorded — is exactly the case the backstop
 * must not re-fire for.
 *
 * Guarded end to end, unlike most of this file's writes: this runs *after* a
 * branch has already decided the turn's fate (and usually the session's), so
 * a failure recording it must not re-enter that decision or throw back into
 * it. The same reasoning `recover`'s own comment gives for why a throw there
 * would be worse than the failure it exists to handle applies here too, one
 * layer further out.
 */
export async function endTurn(
  promptMessageId: string,
  outcome: TurnOutcome,
  detail?: string | null,
): Promise<boolean> {
  try {
    const [row] = await db
      .update(messages)
      .set({
        turnEndedAt: new Date(),
        turnOutcome: outcome,
        // Its own column, not sessions.lastError: the next turn's claim resets
        // that to null, the identical trap sessions.baseNote documents.
        turnDetail: detail == null ? null : sanitizeForDb(detail),
      })
      .where(and(eq(messages.id, promptMessageId), isNull(messages.turnEndedAt)))
      .returning({ sessionId: messages.sessionId })
    if (!row) return false

    // Strictly after the row above commits: a lost job here degrades to the
    // reconciler catching it later, which is a strictly better failure than a
    // client believing a turn ended before the row that says so exists.
    try {
      await queueIndex.enqueueTurnEnded({ sessionId: row.sessionId, promptMessageId, outcome })
    } catch (error) {
      logger.warn(`Could not announce the end of turn ${promptMessageId}: ${String(error)}`)
    }
    return true
  } catch (error) {
    logger.error(`Could not record the end of turn ${promptMessageId}: ${String(error)}`)
    return false
  }
}

/** How many continuations one stall may be nudged through before it stops. */
const MAX_AUTO_CONTINUATIONS = 3

/**
 * How long a turn waits before re-trying a claim blocked behind a sibling
 * non-isolated session in the same project (see the claim in `runTurn`).
 *
 * Polling rather than being woken is deliberate: nothing publishes an event
 * when the blocking session's turn ends — it might complete, fail, or be
 * interrupted, and all three already have their own status-setting paths that
 * would each need to know to nudge a waiter. A short re-enqueue is one cheap
 * Redis job per interval for however long the blocking turn runs, not a leak:
 * it stops the moment the claim succeeds or the session is deleted.
 */
const BLOCKED_CLAIM_RETRY_MS = 5_000

/**
 * What a result adds to the bill, given what this turn has already charged.
 *
 * `total_cost_usd` is cumulative for the whole SDK process, and one turn yields
 * many results: the SDK emits one per internal turn, including the turns a
 * background-task notification triggers by itself. Summing them re-charged the
 * same running total repeatedly — a real session emitted ten results all
 * reporting $28.86 and recorded $494.91 against a true spend of $72.78. Only
 * the increment is new money, and a result that reports less than what has
 * already been charged (the `num_turns: 0` notification results report zero)
 * must not claw any of it back.
 */
export function newSpend(cumulative: unknown, alreadyCharged: number): number {
  if (typeof cumulative !== 'number' || !Number.isFinite(cumulative)) return 0
  return Math.max(cumulative - alreadyCharged, 0)
}

/**
 * Delegated work this turn destroyed or abandoned, as a count of subagents.
 *
 * A per-turn process cannot host a fire-and-forget task: the CLI exits with the
 * query and SIGKILLs anything still backgrounded. `delegationHook` now forces
 * delegation into the foreground so this should not arise, but it is read back
 * from the result rather than assumed, because the old behaviour was to mark
 * such a turn `completed` — which is how a real session came to report "the
 * agent was killed mid-flight" while its operator was left guessing whether
 * anything was still running.
 *
 * Two distinct losses, and the first one is easy to miss: by the time the final
 * result arrives the shutdown kill has usually already been *counted*, so the
 * obvious `spawned - completed` arithmetic nets to zero on precisely the turn
 * that lost work (the real one reported `spawned: 9, completed: 8,
 * killed.system: 1`). A subagent the system or a dying parent killed is lost
 * work, not accounted-for work, so it is added rather than subtracted. What
 * remains unaccounted for on top of that is a task the process exited without
 * even recording.
 *
 * `subagent_stats` is not in the SDK's published types, so it is read entirely
 * defensively: a shape change must degrade to "nothing lost" rather than to a
 * false alarm. `killed.user` is excluded — an operator interrupt is not a loss
 * to report back to them.
 *
 * `started_in_background` is the gate. What `spawned` and `completed` count for
 * a *foreground* subagent is undocumented, so a turn that delegated normally
 * could otherwise look stranded, and this would nudge — then fail — a session
 * that was perfectly healthy. Gating on evidence that something really was
 * backgrounded ties the net to the exact condition the hook exists to prevent,
 * and leaves it inert while the hook holds.
 */
export function lostSubagents(message: TranscriptMessage | undefined): number {
  if (message?.type !== 'result') return 0
  const stats = (message as { subagent_stats?: unknown }).subagent_stats
  if (!stats || typeof stats !== 'object') return 0
  const num = (value: unknown) => (typeof value === 'number' ? value : 0)
  const { spawned, completed, failed, killed, started_in_background } = stats as Record<
    string,
    unknown
  >
  if (num(started_in_background) === 0) return 0

  const kills = (killed && typeof killed === 'object' ? killed : {}) as Record<string, unknown>
  const destroyed = num(kills.system) + num(kills.parent)
  const settled = num(completed) + num(failed) + num(kills.user) + destroyed
  const abandoned = Math.max(num(spawned) - settled, 0)
  return destroyed + abandoned
}

/**
 * Whether a `user` message reports a tool call the SDK cancelled on its own,
 * not one an operator declined.
 *
 * `tool_result_meta[].non_execution_kind` is not in the SDK's published
 * types — grepping the installed `.d.ts` files for either name returns
 * nothing — so this is read exactly as defensively as `lostSubagents` reads
 * `subagent_stats`: a shape change has to degrade to `false`, never to a
 * false alarm.
 *
 * This only reports what the message says; it does not know whether *this*
 * turn asked for the cancellation. That is what `interrupted` is for, set in
 * one place below by `abortController.abort()` — agentoo's only cancel
 * source. So a caller seeing this true while `interrupted` is still false
 * knows something other than agentoo cancelled that tool — and in this
 * configuration (`permissionMode: 'bypassPermissions'`, no `canUseTool`
 * registered anywhere in `src`) it cannot have been the operator either:
 * there was no prompt for one to have answered. A turn read exactly this
 * shape (`tool_result_meta: [{ non_execution_kind: "cancelled" }]`,
 * `permission_denials: []` on every result in the session) as a refusal and
 * told the model to stop and ask; nobody had refused anything, twice.
 *
 * Exported for the tests, like the other decisions in this file worth
 * pinning: nothing else imports it.
 */
export function cancelledWithoutInterrupt(message: TranscriptMessage | undefined): boolean {
  if (message?.type !== 'user') return false
  const meta = (message as { tool_result_meta?: unknown }).tool_result_meta
  if (!Array.isArray(meta)) return false
  return meta.some(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as { non_execution_kind?: unknown }).non_execution_kind === 'cancelled',
  )
}

/**
 * The truth behind the `completed` branch, once nothing above it in the
 * cascade has already claimed the turn (drained, over budget, cancelled tool,
 * lost background work).
 *
 * Before this, branch g wrote `setStatus('completed')` — the *session*
 * status, which this does not change — for three different endings, two of
 * which are lies: a turn that hit `error_max_turns` a third of the way
 * through, and a turn whose own result reports `is_error: true`, both read
 * identically to one that actually finished the work. A board that advances a
 * card on `completed` cannot tell those apart without this.
 *
 * Order matters, twice over. `error_max_turns` is checked first because it is
 * the most specific case of the same `error_*` family the third check below
 * also matches. The other `error_*` subtypes (`error_during_execution`,
 * `error_max_structured_output_retries`) have to be checked *before* the
 * `is_error === true` check, not after: the SDK's own `SDKResultError` type
 * declares `is_error` as a plain `boolean`, not narrowed to `true`, but every
 * error-subtype result actually observed (including `error_max_turns`,
 * verified against the real shape) carries `is_error: true` regardless of
 * which `error_*` subtype it is. Checking `is_error === true` first, as an
 * earlier version of this function did, therefore swallowed every `error_*`
 * result other than `error_max_turns` into the vaguer `stopped_api_error`,
 * making `stopped_execution_error` a value nothing could ever write — a real
 * defect an independent, real-Postgres pass caught
 * (turn-outcome-truth.test.ts). `is_error === true` only means something once
 * every `error_*` subtype has already been ruled out: it is what tells a
 * `success`-subtype result that ended on an API error apart from one that
 * did not, which is the one place the SDK's own docs on `SDKResultMessage`
 * actually use `is_error` to distinguish an ending.
 *
 * A missing `lastResult` entirely — the turn ended before a single `result`
 * message arrived — falls through every check here to `completed`, matching
 * what branch g already did before this existed (session-recovery.test.ts's
 * "a turn that ends before any result at all" pins that).
 *
 * Exported for the tests, like the other decisions in this file worth
 * pinning: nothing else imports it.
 */
export function completionOutcome(
  resultSubtype: string | undefined,
  lastResult: TranscriptMessage | undefined,
): TurnOutcome {
  const isError =
    lastResult?.type === 'result' ? (lastResult as { is_error?: unknown }).is_error : undefined
  if (resultSubtype === 'error_max_turns') return 'stopped_turn_limit'
  if (typeof resultSubtype === 'string' && resultSubtype.startsWith('error_')) {
    return 'stopped_execution_error'
  }
  if (isError === true) return 'stopped_api_error'
  return 'completed'
}

/**
 * One backgrounded shell command's state, pieced together from whatever this
 * turn saw about it. `background` is not fixed at start: the CLI can
 * auto-background a foreground Bash call that overruns its timeout, and that
 * transition shows up later as `task_updated`'s `patch.is_backgrounded`, with
 * nothing else marking it.
 */
interface BackgroundCommandTask {
  background: boolean
  status: 'running' | 'settled' | 'destroyed'
}

/** Turn-local memory `foldBackgroundCommand` builds and `lostBackgroundCommands` reads. */
export type BackgroundCommandLedger = Map<string, BackgroundCommandTask>

/**
 * Fold one SDK message into what this turn knows about backgrounded shell
 * commands, keyed by `task_id`.
 *
 * A fold, not a lookup, because `SDKTaskUpdatedMessage` carries only
 * `task_id` and `patch` — no `task_type`, no `tool_use_id` — so the only way
 * to know a later `killed` patch belongs to a shell command rather than a
 * subagent is to have remembered it from `task_started`. That is forced, not
 * one design among several: nothing in the settle or notification messages
 * says what kind of task settled.
 *
 * Every `local_bash` task is remembered here, foreground or backgrounded,
 * because a command that starts in the foreground can still end up
 * backgrounded later with no `task_started` ever having said so — only the
 * later `patch.is_backgrounded` does, which is why it is honoured here too.
 * `local_agent` is excluded at the door on purpose: `lostSubagents` already
 * owns delegated work, read off `subagent_stats` on the final result, and
 * remembering `local_agent` tasks here too would make one turn emit two
 * contradictory notices about the same loss. That exclusion also means a
 * stray `task_updated`/`task_notification` for a subagent's `task_id` finds
 * no entry here and is silently ignored — which is exactly what should
 * happen to it. `local_bash` is deliberately inclusive rather than narrow: it
 * is what the `Monitor` tool registers as too (verified against the exported
 * incident log), and a command Monitor is watching is exactly as abandoned by
 * a turn boundary as one Bash started directly.
 *
 * `ambient`/`skip_transcript` tasks are the CLI's own housekeeping — a
 * live-update watcher, a cache warm (`titles.ts` already keeps these off the
 * transcript for the same reason) — and a nudge because one of those was
 * still going at turn end would be the same class of false alarm that
 * `started_in_background` exists to prevent for subagents.
 */
export function foldBackgroundCommand(
  ledger: BackgroundCommandLedger,
  message: TranscriptMessage | undefined,
): void {
  if (message?.type !== 'system') return
  const sys = message as {
    subtype?: unknown
    task_id?: unknown
    task_type?: unknown
    is_backgrounded?: unknown
    ambient?: unknown
    skip_transcript?: unknown
    status?: unknown
    patch?: { status?: unknown; is_backgrounded?: unknown }
  }

  if (sys.subtype === 'task_started') {
    if (sys.ambient || sys.skip_transcript) return
    if (sys.task_type !== 'local_bash' || typeof sys.task_id !== 'string') return
    ledger.set(sys.task_id, { background: sys.is_backgrounded === true, status: 'running' })
    return
  }

  if (sys.subtype === 'task_updated') {
    if (typeof sys.task_id !== 'string') return
    const task = ledger.get(sys.task_id)
    if (!task) return
    if (sys.patch?.is_backgrounded === true) task.background = true
    const status = sys.patch?.status
    if (status === 'completed' || status === 'failed') task.status = 'settled'
    else if (status === 'killed') task.status = 'destroyed'
    // 'paused' is deliberately left alone: paused leaves it unsettled, not
    // settled — the command has not ended, it is merely not moving right now.
    return
  }

  if (sys.subtype === 'task_notification') {
    // No ambient/skip_transcript guard here on purpose, unlike task_started
    // above: an ambient task never gets an entry in the first place (it is
    // filtered at enrolment), so the lookup below already misses it and a
    // second filter here is a no-op for that case. The one case where it is
    // *not* a no-op is a real, already-enrolled local_bash task whose own
    // task_notification happens to carry ambient/skip_transcript — and
    // returning early there dropped a `completed` settle on the floor,
    // leaving a healthy entry looking unsettled and nudging a clean turn.
    // The filter belongs only at the door (task_started), not at every later
    // sighting of a task already let in.
    if (typeof sys.task_id !== 'string') return
    const task = ledger.get(sys.task_id)
    if (!task) return
    if (sys.status === 'completed' || sys.status === 'failed') task.status = 'settled'
    // 'stopped' is the SDK's word for cut off rather than finished — the
    // frontend (transcript.ts) already folds it into 'killed' for the same
    // reason.
    else if (sys.status === 'stopped') task.status = 'destroyed'
  }
}

/**
 * Background commands this turn destroyed or abandoned: destroyed on
 * `killed`/`stopped`, and anything merely still running — or `paused` — when
 * the loop ends counts too, because this turn is the last chance to hear
 * about it before the CLI process exits.
 *
 * Read after the `for await` loop, never off `lastResult`. That is the whole
 * point of this pair of functions: the kill for a backgrounded `git push`
 * arrived roughly five seconds *after* the result a `lastResult`-only read
 * would already have treated as "the turn finished cleanly."
 */
export function lostBackgroundCommands(ledger: BackgroundCommandLedger): number {
  let lost = 0
  for (const task of ledger.values()) {
    if (task.background && task.status !== 'settled') lost++
  }
  return lost
}

/**
 * The ways something *outside* a process ends it.
 *
 * Deliberately not every signal. A turn that died because the machine, systemd
 * or an operator stopped the process can be picked straight back up: the work
 * was interrupted, not wrong, and running it again is the right answer. A turn
 * that died on SIGSEGV or SIGABRT is the opposite — the CLI killed itself, on
 * this conversation, and resuming it buys three more identical crashes at full
 * model cost. Those keep the old behaviour and fail the turn.
 *
 * Keyed by number as well as named, because the exit code is often all there
 * is: a runtime that handles a signal and exits reports `128 + n`, and Claude
 * Code does exactly that, which is why the incident this exists for showed up
 * as the number 143 rather than as the word SIGTERM.
 */
const TERMINATION_SIGNALS: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
}

export interface ProcessKill {
  /** What ended it. */
  signal: string
  /** Why it most likely happened, in the terms an operator can act on. */
  cause: string
}

/**
 * The signal a failure message describes, if it describes one at all.
 *
 * The SDK composes two different wordings and the worker only ever sees the
 * finished string: `terminated by signal SIGX` when the child's exit event
 * carried a signal, and `exited with code N` when it did not — which is the
 * usual case here, because the CLI installs its own handler and translates the
 * signal into `128 + n` on the way out.
 *
 * Whichever wording appears *first* wins. The rest of the message can be up to
 * 2KB of the child's own stderr, and that is arbitrary text from whatever the
 * agent was running: it may quote either wording, and a genuine `exited with
 * code 1` must not be re-read as a kill because something further down the
 * output mentioned SIGKILL.
 */
function signalIn(detail: string): string | undefined {
  const named = detail.match(/Claude Code process terminated by signal (SIG[A-Z0-9]{1,8})/)
  const coded = detail.match(/Claude Code process exited with code (\d+)/)
  const namedAt = named?.index ?? Number.POSITIVE_INFINITY
  const codedAt = coded?.index ?? Number.POSITIVE_INFINITY

  if (named && namedAt < codedAt) {
    const signal = named[1] ?? ''
    return Object.values(TERMINATION_SIGNALS).includes(signal) ? signal : undefined
  }
  if (coded) return TERMINATION_SIGNALS[Number(coded[1]) - 128]
  return undefined
}

/**
 * Whether a turn died because something stopped the CLI process, rather than
 * because the model or the work failed.
 *
 * The distinction is the whole point: a stopped process is not a failed turn.
 * The conversation is intact on the SDK's side and `sdkSessionId` is already
 * persisted, so the session can simply be picked back up — whereas a genuine
 * error usually repeats, and re-running it would spend the money twice.
 *
 * Read out of the message text because that is all there is. The SDK raises a
 * plain `Error` whose message it composes itself, and by the time it reaches
 * the worker every structured field is gone.
 *
 * This is not hypothetical. A session on a 4GB box hit it four times in an
 * hour: `bun test` on the frontend suite exhausted the machine, the kernel
 * OOM-killed the test process, and systemd — whose `OOMPolicy` defaults to
 * `stop` — reacted by terminating the entire worker unit, the running `claude`
 * with it. What the operator saw was "Claude Code process exited with code
 * 143" and a dead session they had to type "Continue" into, four times.
 */
export function processKill(detail: string): ProcessKill | undefined {
  const signal = signalIn(detail)
  return signal ? { signal, cause: causeOf(signal) } : undefined
}

function causeOf(signal: string): string {
  switch (signal) {
    case 'SIGKILL':
      // Nothing in userspace SIGKILLs this process, so the kernel did, and on a
      // box like this the only thing that does is the OOM killer.
      return 'That is the kernel killing it outright, which here means the out-of-memory killer: something this session ran — a test suite or a build, usually — took the machine past its RAM.'
    case 'SIGTERM':
      // Two candidates, and from in here they are indistinguishable.
      return 'Something asked it to stop: either the worker service was restarted under it, or systemd stopped the whole unit because a process inside it was OOM-killed.'
    default:
      return 'Something outside this session ended it.'
  }
}

/**
 * Continuations already sent since the operator last spoke.
 *
 * The worker keeps no state between turns, so the bound is read back out of the
 * transcript. Without it a turn that keeps ending with work in flight re-queues
 * itself forever, at full model cost.
 */
async function autoContinuationsSincePrompt(sessionId: string): Promise<number> {
  const rows = await db
    .select({ payload: messages.payload })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.type, 'prompt')))
    .orderBy(desc(messages.seq))
    .limit(MAX_AUTO_CONTINUATIONS + 1)

  let sent = 0
  for (const row of rows) {
    if ((row.payload as { auto?: unknown } | null)?.auto !== true) break
    sent++
  }
  return sent
}

/**
 * Queue a continuation of this session's own accord.
 *
 * `auto: true` is what makes the bound above countable, and marks the row as
 * ours so the UI can tell it apart from something the operator typed.
 */
async function enqueueContinuation(
  sessionId: string,
  text: string,
  parentPromptId?: string,
): Promise<void> {
  const [seqRow] = await db
    .update(sessions)
    .set({ nextSeq: sql`${sessions.nextSeq} + 1`, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning({ seq: sessions.nextSeq })
  if (!seqRow) throw new Error(`Session ${sessionId} disappeared before its continuation`)

  await db
    .insert(messages)
    .values({
      sessionId,
      seq: seqRow.seq - 1,
      type: 'prompt',
      pending: true,
      payload: sanitizeForDb({ text, auto: true }),
      // Links the continuation back to the prompt whose turn spawned it, so a
      // chain is reconstructible from the transcript alone with no live
      // observer. Omitted (not set to `null`) when the caller has none to
      // give, which today is only a test calling `recover` directly.
      ...(parentPromptId !== undefined && { continuesMessageId: parentPromptId }),
    })
    .returning()
}

/**
 * How a session gets itself moving again after a turn ended badly.
 *
 * Both callers say the same three things in different words, so they say them
 * through one shape: what the transcript shows while it is recovering, what the
 * model is told to do about it, and what the session reports if it never does.
 */
interface Recovery {
  /** The transcript line, told which attempt this is out of how many. */
  notice: (attempt: number, of: number) => string
  /** The continuation prompt: what actually happened, and what to do now. */
  instruction: string
  /** The session's `lastError` once the continuation budget is spent. */
  giveUp: string
}

/**
 * Nudge the session onwards, or stop and say why.
 *
 * The bound is what keeps this from being a loop that bills: a turn that ends
 * badly for the same reason every time would otherwise re-queue itself forever
 * at full model cost. It is read back out of the transcript rather than held in
 * memory, because the worker keeps no state between turns — and, for the kill
 * case, may not survive to the next one.
 *
 * Every database and queue call in here is guarded, all of them, because of
 * where this runs. The kill path fires precisely when the machine is in
 * trouble, so Postgres or Redis may be going down in the same moment — and now
 * that `OOMPolicy=continue` keeps the worker alive through an OOM kill, the
 * worker is *more* likely than before to reach this code with a sick database
 * under it. A throw escaping here would escape `runTurn`'s catch as well and
 * leave the session at `running` with nothing coming: not merely stuck, but
 * beyond the reach of the UI, which refuses to delete a running session and
 * only queues new messages behind one. That is worse than the failure this was
 * called to recover from, so the fallback is the honest thing — mark it failed,
 * and say that the recovery itself did not land.
 *
 * Exported for the tests, like the other decisions in this file worth pinning:
 * nothing else imports it.
 *
 * Returns what it decided rather than `void`: `runTurn`'s four call sites use
 * it to record the turn's own outcome via `endTurn` (`continued` maps to
 * `'continuing'`, `gave_up`/`recovery_failed` both map to `'stalled'` — the
 * caller could not tell those two apart from outside before this, which is
 * exactly the ambiguity this whole track exists to remove). Additive: every
 * existing caller in the tests ignores the return, so widening it from `void`
 * costs nothing already relying on the old shape. `parentPromptId` is new
 * too, and optional for the same reason — it links a continuation back to the
 * prompt whose turn spawned it (see `enqueueContinuation`), and a caller with
 * none to give (only a test invoking `recover` directly, today) simply omits
 * it rather than being forced to pass one.
 */
export interface RecoveryOutcome {
  outcome: 'continued' | 'gave_up' | 'recovery_failed'
  detail: string
}

export async function recover(
  sessionId: string,
  who: string,
  recovery: Recovery,
  parentPromptId?: string,
): Promise<RecoveryOutcome> {
  // What the session is told happened, if everything below this line fails. It
  // becomes the notice once we know we are nudging rather than stopping.
  let why = recovery.giveUp
  try {
    const sent = await autoContinuationsSincePrompt(sessionId)
    if (sent < MAX_AUTO_CONTINUATIONS) {
      why = recovery.notice(sent + 1, MAX_AUTO_CONTINUATIONS)
      await appendMessage(sessionId, { type: 'notice', message: why }, who)
      await enqueueContinuation(sessionId, recovery.instruction, parentPromptId)
      await setStatus(sessionId, 'queued', null)
      await enqueueSessionRun({ sessionId })
      return { outcome: 'continued', detail: why }
    }
    // Said in the transcript as well as on the session row: a failure that
    // shows only as a red line on the sessions list is invisible from inside
    // the session, which is where whoever is reading it actually is.
    await appendMessage(sessionId, { type: 'error', message: recovery.giveUp }, who)
    await setStatus(sessionId, 'failed', recovery.giveUp)
    return { outcome: 'gave_up', detail: recovery.giveUp }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${sessionId} could not be resumed: ${detail}`)
    const combined = `${why} Recovering from that failed too: ${detail}`
    try {
      await setStatus(sessionId, 'failed', combined)
      return { outcome: 'recovery_failed', detail: combined }
    } catch (fatal) {
      // Nothing left to write with. Said as loudly as this process can say it,
      // because the row is now stale: the session reads as `running` and no
      // worker holds it.
      const why2 = fatal instanceof Error ? fatal.message : String(fatal)
      logger.error(
        `Session ${sessionId} is stranded: it still reads as 'running' and could not be marked failed (${why2}). Reset it by hand once the database is back.`,
      )
      return {
        outcome: 'recovery_failed',
        detail: `${combined} The failure itself could not be written either: ${why2}.`,
      }
    }
  }
}

/** The label a message is attributed to, tracked as tasks start and finish. */
function attribution(
  message: TranscriptMessage,
  tasks: Map<string, string>,
  fallback: string,
): string {
  if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
    return tasks.get(message.parent_tool_use_id as string) ?? 'subagent'
  }
  return fallback
}

/**
 * Undo this turn's announcement stamp when the turn ends without the model
 * ever having produced anything for it.
 *
 * The stamp is written *before* `query()` runs, in the transaction above —
 * that is what lets the *next* turn tell new files apart from already-seen
 * ones with a plain `announced_seq IS NULL`, rather than a timestamp diff
 * that breaks across an interrupted turn or the auto-recovery continuation
 * path. The cost of stamping early is that "stamped" and "the model actually
 * saw it" can come apart: an interrupt, a killed CLI process recovered from,
 * or any other error can all end a turn before `query()` yielded a single
 * message. There is no structured way to tell from here whether it yielded
 * zero messages or several before dying, so this does not try to guess —
 * every one of those three paths just re-opens whatever this turn stamped.
 * Biased deliberately toward re-announcing: a duplicate notice on the next
 * turn costs a few tokens, while a file that is never mentioned again because
 * its one announcement was spent on a turn the model never saw costs the
 * feature (see attachments-announcement.test.ts's "a file announced on a
 * turn that died" for the incident this exists for).
 */
async function unstampAnnouncement(
  sessionId: string,
  seq: number,
  messageId: string,
): Promise<void> {
  await db
    .update(sessionFiles)
    .set({ announcedSeq: null })
    .where(and(eq(sessionFiles.sessionId, sessionId), eq(sessionFiles.announcedSeq, seq)))
  await db.delete(messageFiles).where(eq(messageFiles.messageId, messageId))
}

/**
 * Say so when an interrupt leaves a message waiting behind it.
 *
 * Both interrupt exits in `runTurn` return before the drain check further
 * down that would otherwise notice a message queued mid-turn, so without this
 * the session goes quiet at `interrupted` with a prompt sitting behind it
 * that nobody was told about. It is not lost: `sendMessage` moves an
 * `interrupted` session back to `queued` on the next send
 * (features/sessions/service.ts) and re-enqueues, and `runTurn` picks up the
 * *oldest* pending row — so the stranded prompt runs before whatever the
 * operator types next. Deliberately not auto-drained: see
 * session-recovery.test.ts's pending-during-an-interrupt case for why an
 * interrupted turn draining itself is the wrong fix.
 *
 * Both the read and the write are guarded, because the second call site is
 * inside `runTurn`'s `catch` block — see `recover`'s comment above for why
 * that is exactly where the database is least likely to be healthy. Neither
 * may throw out of an already-interrupted turn.
 */
async function noticeStrandedPrompt(sessionId: string, who: string): Promise<void> {
  try {
    const [stillPending] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.pending, true)))
      .limit(1)
    if (!stillPending) return
    await appendMessage(
      sessionId,
      {
        type: 'notice',
        message:
          'A message arrived while this turn was running and is still waiting. It was not dropped: sending another message picks it up first, before whatever you type next.',
      },
      who,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(
      `Session ${sessionId}: could not check for a message stranded by the interrupt: ${detail}`,
    )
  }
}

type SessionRow = typeof sessions.$inferSelect

/** The SQLSTATE Postgres reports for `FOR UPDATE NOWAIT` hitting a row someone else already has locked. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * The driver's own error carries the SQLSTATE; drizzle wraps it in a
 * `DrizzleQueryError` whose `cause` is that original error, so both have to
 * be checked — the code is never on the outer error itself.
 */
function isLockConflict(error: unknown): boolean {
  const code = (candidate: unknown) =>
    candidate && typeof candidate === 'object' && 'code' in candidate
      ? (candidate as { code?: unknown }).code
      : undefined
  return (
    code(error) === LOCK_NOT_AVAILABLE ||
    code((error as { cause?: unknown })?.cause) === LOCK_NOT_AVAILABLE
  )
}

/**
 * Claim the turn. A conditional update is the mutex: whichever worker moves
 * the row out of 'queued' owns it, and a duplicate delivery finds nothing.
 * Returns the claimed row, or `undefined` if the claim was refused — by
 * another worker, or by the lock below.
 *
 * A project need not be a git repo — an adopted plain folder is a supported
 * case (project-setup.worker.ts's `isRepo` check) — and such a project's
 * sessions get no per-session worktree at all, so they fall back to running
 * straight in the shared repo checkout (`workingDir: row.worktreePath ??
 * repoPath` in features/sessions/service.ts). At WORKER_CONCURRENCY 1 that
 * could never bite; above it, two non-isolated turns in the same project
 * would edit that one working tree and git index at the same time and
 * silently stomp each other's work. So a non-isolated session (no worktree)
 * additionally requires that no *other* non-isolated session in the same
 * project is already `running` — isolated sessions, each with their own
 * worktree, are unaffected and stay fully parallel, including several in the
 * same project: the lock below is only ever reached on the non-isolated path,
 * inside the `OR`'s second arm, which a row with a worktree never evaluates.
 * Do not read the predicate as redundant with the `status = 'queued'` check:
 * that guards a single row against a duplicate delivery, the predicate guards
 * a shared directory against two different rows.
 *
 * A plain `NOT EXISTS` reading `sibling.status = 'running'` is not enough by
 * itself: it is one autocommit read under READ COMMITTED, so a sibling claim
 * whose UPDATE has already run but not yet committed is invisible to it —
 * both claims read "nothing running" and both succeed in the one working
 * tree the predicate exists to protect. Measured against the real code path,
 * that hit 1-5 times in 20 pairs with no help at all. So the `lockScope` arm
 * runs first and takes `SELECT ... FOR UPDATE NOWAIT` over every non-isolated
 * row in the project — deliberately not filtered by status, because a row
 * that is still `queued` in this statement's own snapshot is exactly the row
 * a concurrent, not-yet-committed claim is about to change, and a filtered
 * scan would never consider it a candidate worth locking in the first place.
 * `NOWAIT` rather than a plain wait, because a claim that is genuinely mid
 * flight (its row lock held, not yet committed) would otherwise block this
 * one for as long as that transaction stays open — and the claim ahead of it
 * can legitimately take a while under real load. A lock conflict is caught
 * below and treated exactly like `sibling`'s `NOT EXISTS` finding one already
 * running: refuse the claim and let the caller's blocked-vs-lost re-read
 * decide what happens next, rather than actually waiting for the lock.
 *
 * Both subqueries correlate against `sessions` itself — the row this UPDATE
 * is about to touch — rather than taking the project id as a separate
 * parameter, because the project row has not been loaded yet at this point in
 * the turn and this avoids a round trip just to fetch it. That also keeps the
 * whole claim to the one statement it always was: no explicit transaction, no
 * separate read before it:  the lock and the update it guards have to be one
 * atomic statement anyway for the lock to mean anything, and Postgres already
 * treats a single statement as its own transaction.
 */
async function claimTurn(sessionId: string): Promise<SessionRow | undefined> {
  const lockScope = alias(sessions, 'lock_scope')
  const sibling = alias(sessions, 'sibling_session')
  // `FOR UPDATE NOWAIT` has no query-builder method that the fake `db` in
  // session-recovery.test.ts implements — that fake exists to test everything
  // *around* the claim without a real Postgres underneath it, and cannot
  // execute a real lock — so this one condition is a raw `sql` fragment
  // rather than `db.select(...).for(...)`, built from the same typed column
  // references as `sibling` below so a column rename still breaks this at
  // compile time. Only the alias name itself ("lock_scope") is bare text, and
  // it only has to agree with itself between the two places it appears here.
  // Not `exists (... for update nowait)`: EXISTS only has to prove one row
  // matches, so the planner may lock a single row and stop there — and two
  // concurrent claims have no guarantee of stopping at the *same* row rather
  // than each locking a different sibling and never conflicting with each
  // other at all. That version measured a real double-claim roughly 1 time in
  // 20 pairs. `count(*)` instead forces the inner query to visit and lock
  // every matching row before this condition can even be evaluated, so two
  // overlapping claims are always contending on the same set of rows rather
  // than possibly disjoint ones.
  const lockCondition = sql`(select count(*) from (
    select 1 from ${sessions} as lock_scope
    where ${and(eq(lockScope.projectId, sessions.projectId), isNull(lockScope.worktreePath))}
    for update nowait
  ) as locked_scope) >= 0`
  try {
    const [row] = await db
      .update(sessions)
      .set({
        status: 'running',
        lastError: null,
        // Reset, not merely left alone: a fresh claim's heartbeat has to start
        // from this claim's own `updatedAt` below, not from whatever a
        // *previous* turn of this same session last wrote here — otherwise a
        // brand-new turn could read as already stale to the reconciler before
        // its own first tick ever lands.
        heartbeatAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.status, 'queued'),
          or(
            isNotNull(sessions.worktreePath),
            and(
              lockCondition,
              notExists(
                db
                  .select({ id: sibling.id })
                  .from(sibling)
                  .where(
                    and(
                      eq(sibling.projectId, sessions.projectId),
                      ne(sibling.id, sessions.id),
                      isNull(sibling.worktreePath),
                      eq(sibling.status, 'running'),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .returning()
    return row
  } catch (error) {
    if (isLockConflict(error)) return undefined
    throw error
  }
}

/** Exported for the tests; the worker below is the only real caller. */
export async function runTurn(job: SessionRunJob): Promise<void> {
  const { sessionId } = job

  const claimed = await claimTurn(sessionId)

  if (!claimed) {
    // A failed claim used to mean one thing only: another worker already has
    // this turn, and logging it was the end of the story. It can now also mean
    // this turn is blocked behind a sibling non-isolated session, and that case
    // must not fall into the same branch — returning here without re-queuing
    // would strand the session at `queued` with a message waiting behind it
    // and nothing left to ever run it, which is the bug this predicate exists
    // to fix, in a new shape. Re-reading the row is what tells the two apart:
    // gone, or moved off `queued`, means the claim was genuinely lost and
    // someone else has it; still `queued` means nobody has it, it is only
    // waiting.
    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)

    if (row?.status === 'queued') {
      logger.info(
        `Session ${sessionId} is queued but blocked behind another running turn in its project; retrying in ${BLOCKED_CLAIM_RETRY_MS}ms`,
      )
      try {
        await enqueueSessionRun({ sessionId }, { delayMs: BLOCKED_CLAIM_RETRY_MS })
      } catch (error) {
        // The retry just above is the only thing that will ever run this
        // session again — nothing else is watching for the sibling to finish.
        // Losing it silently would leave the session `queued` forever with its
        // message still pending: the same bug this predicate exists to fix,
        // wearing a third costume. Surfaced the way `recover` surfaces an
        // equivalent queue failure, not swallowed into a log line.
        const detail = error instanceof Error ? error.message : String(error)
        logger.error(`Session ${sessionId} could not be re-queued after being blocked: ${detail}`)
        try {
          await setStatus(
            sessionId,
            'failed',
            `Blocked behind another turn in its project, and the retry could not be queued: ${detail}`,
          )
        } catch (fatal) {
          const why = fatal instanceof Error ? fatal.message : String(fatal)
          logger.error(
            `Session ${sessionId} is stranded: it still reads as 'queued' with a message pending and could not be marked failed (${why}). Reset it by hand once the database is back.`,
          )
        }
      }
      return
    }

    logger.warn(`Session ${sessionId} was not queued; another worker has the turn`)
    return
  }
  await publishSessionEvent({ kind: 'status', sessionId, status: 'running' })

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, claimed.projectId))
    .limit(1)
  if (!project) {
    await setStatus(sessionId, 'failed', 'The project no longer exists')
    return
  }

  if (!hasClaudeCredential) {
    await setStatus(
      sessionId,
      'failed',
      'No Claude credential. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
    )
    return
  }

  // The oldest unanswered prompt, whichever job woke us. Taking it from the
  // table rather than the job payload is what lets several messages sent during
  // a long turn drain in order afterwards.
  const [userRow] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.pending, true)))
    .orderBy(messages.seq)
    .limit(1)

  if (!userRow) {
    logger.info(`Session ${sessionId} has nothing pending`)
    await setStatus(sessionId, 'idle')
    return
  }
  // Flipping `pending` and stamping which files this turn announces happen in
  // one round-trip on purpose: `announcedSeq` is read back by the *next*
  // turn (`WHERE announced_seq IS NULL`) to decide what is new, and diffing a
  // timestamp instead would break on exactly the paths this worker is built
  // to survive — an interrupted turn, the auto-recovery continuation above,
  // and several messages queued during a long turn draining in order
  // afterwards.
  let announcement = ''
  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({
        pending: false,
        // A claim is a fresh turn starting on this prompt, so any verdict
        // already sitting here is stale by definition — whether it came from
        // the reconciler (a prompt it marked 'abandoned' that this very send
        // just revived) or from anywhere else. Unconditional, unlike
        // endTurn's own guarded update: a claim does not ask whether a turn
        // already ended here, it declares that a new one is starting.
        // Without this reset, endTurn's `WHERE turn_ended_at IS NULL` guard
        // would still find this row "already ended" from the stale verdict
        // and silently refuse to record what this turn actually does,
        // leaving the stale outcome to stick.
        turnStartedAt: new Date(),
        turnEndedAt: null,
        turnOutcome: null,
        turnDetail: null,
      })
      .where(eq(messages.id, userRow.id))

    const toAnnounce = await tx
      .select()
      .from(sessionFiles)
      .where(
        and(
          eq(sessionFiles.sessionId, sessionId),
          isNull(sessionFiles.deletedAt),
          isNull(sessionFiles.announcedSeq),
          eq(sessionFiles.status, 'ready'),
        ),
      )
      .orderBy(sessionFiles.createdAt, sessionFiles.id)
    if (toAnnounce.length === 0) return

    await tx
      .update(sessionFiles)
      .set({ announcedSeq: userRow.seq })
      .where(
        inArray(
          sessionFiles.id,
          toAnnounce.map((f) => f.id),
        ),
      )
    // "Attached at turn N" made explicit — the message that carried the
    // announcement is the turn that first told the agent about these files.
    // originalFilename is denormalised here (not just fileId) so a message
    // can still say which file this was after a hard delete clears fileId —
    // see message_files in db/schema.ts.
    await tx.insert(messageFiles).values(
      toAnnounce.map((f) => ({
        messageId: userRow.id,
        fileId: f.id,
        originalFilename: f.originalFilename,
      })),
    )

    announcement = announcementFor(sessionUploadsDir(sessionId), toAnnounce.map(toManifestFile))
  })

  // The prompt the browser is holding was published at send time, before any
  // `message_files` row existed, so its `files` is stuck at `[]` until
  // something tells it otherwise — this is that something. Published in the
  // same shape `listMessages` returns (see `messageDto`), so a client that
  // merges this event on `seq` and a client that instead refetches land on
  // the same state. Gated on `announcement`, exactly the signal above already
  // uses for "this turn linked files" (announcementFor returns '' only when
  // toAnnounce was empty): a turn with nothing new to say must not add SSE
  // traffic for a `files` the browser already has right. Deliberately not
  // done from inside the transaction above or on the un-stamp paths below —
  // an interrupted or failed turn already removes what it just linked, and
  // republishing there would just be undone again.
  if (announcement) {
    const dto = await messageDto(userRow.id)
    if (dto)
      await publishSessionEvent({ kind: 'message', sessionId, seq: userRow.seq, message: dto })
  }

  const userText = String((userRow.payload as { text?: unknown }).text ?? '')
  const prompt = announcement ? `${announcement}\n${userText}` : userText

  const abortController = new AbortController()
  let interrupted = false
  // Set from endTurn's own return, not assumed true at the call site: the one
  // case it is *not* true — a verdict already recorded — is exactly the case
  // the backstop below must not re-fire for. This cannot see a killed worker
  // process; that failure domain belongs to the heartbeat below and the
  // reconciler that reads it (turn-reconcile.worker.ts). This one only catches
  // a future branch that runs to a `return` without ever calling `endTurn`.
  let verdict = false
  // Proves the *worker process* is alive and holding the turn, nothing more —
  // not that the agent itself is making progress. Timer-driven on purpose,
  // not folded into the `for await` loop below: a turn blocked in a long
  // foreground Bash call runs no loop body either, and this platform actively
  // tells agents to run long things in the foreground rather than
  // backgrounding them, so a loop-driven heartbeat would be exactly as blind
  // as transcript silence for precisely the turns this exists to catch.
  const heartbeat = setInterval(() => {
    db.update(sessions)
      .set({ heartbeatAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .catch((error) => {
        // A missed tick is not a missed turn: the next one tries again in
        // HEARTBEAT_INTERVAL_MS, and the reconciler only acts after three are
        // missed in a row.
        logger.warn(`Session ${sessionId}: heartbeat write failed: ${String(error)}`)
      })
  }, HEARTBEAT_INTERVAL_MS)
  const unsubscribe = subscribeControl(sessionId, (event) => {
    if (event.kind === 'interrupt') {
      interrupted = true
      logger.info(`Interrupting session ${sessionId}`)
      abortController.abort()
    }
  })

  // Which agent produced a given message, for the row headings. task_started
  // announces a subagent's type; every message it then emits carries that
  // task's tool_use_id as parent_tool_use_id.
  const tasks = new Map<string, string>()
  const orchestratorName = claimed.orchestrator ?? 'orchestrator'
  // Turn-local, like `tasks` above and for the same reason: the worker holds
  // no state between turns, and this is rebuilt from the stream every time.
  // Named unambiguously on purpose — a local farther down this function is
  // already called `tasks` for an unrelated string, and shadowing that with
  // this Map would be the same mistake twice.
  const backgroundCommands: BackgroundCommandLedger = new Map()
  // Cumulative-so-far, to charge only what each result adds. See the result
  // branch below for why the naive sum was wrong by a factor of seven.
  let chargedUsd = 0
  let lastResult: TranscriptMessage | undefined
  // Latched inside the loop below, read after it. See cancelledWithoutInterrupt
  // for what this does and does not mean.
  let cancelledOutsideInterrupt = false

  try {
    const options = await optionsFor(claimed, project.slug, abortController, project.sshKeyId)
    logger.info(`Session ${sessionId} running in ${options.cwd}`)

    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && 'subtype' in message) {
        if (message.subtype === 'init' && message.session_id !== claimed.sdkSessionId) {
          // Persist immediately: without it a crash mid-turn loses the thread
          // and the next turn starts a fresh conversation.
          await db
            .update(sessions)
            .set({ sdkSessionId: message.session_id, updatedAt: new Date() })
            .where(eq(sessions.id, sessionId))
        }
        if (message.subtype === 'task_started') {
          const started = message as typeof message & {
            tool_use_id?: string
            subagent_type?: string
          }
          if (started.tool_use_id) {
            tasks.set(started.tool_use_id, started.subagent_type ?? 'subagent')
          }
        }
        // Folded for every system message with a subtype, not only
        // task_started: task_updated and task_notification are how a
        // background command later reports settling, being killed, or (the
        // CLI's own auto-backgrounding) only now turning out to be
        // backgrounded at all.
        foldBackgroundCommand(backgroundCommands, message)
      }

      await appendMessage(sessionId, message, attribution(message, tasks, orchestratorName))

      // The kill for a cancelled tool call can arrive well after this loop
      // has moved on — the incident this covers saw one land seconds after
      // the turn's own result — so this only latches the fact; interrupted
      // is read together with it after the loop, not here.
      if (cancelledWithoutInterrupt(message)) cancelledOutsideInterrupt = true

      if (message.type === 'result') {
        lastResult = message
        const cumulative = (message as typeof message & { total_cost_usd?: number }).total_cost_usd
        const delta = newSpend(cumulative, chargedUsd)
        if (delta > 0) {
          chargedUsd += delta
          await db
            .update(sessions)
            .set({ totalCostUsd: sql`${sessions.totalCostUsd} + ${delta}` })
            .where(eq(sessions.id, sessionId))
        }
      }
    }

    if (interrupted) {
      if (announcement) await unstampAnnouncement(sessionId, userRow.seq, userRow.id)
      await noticeStrandedPrompt(sessionId, orchestratorName)
      verdict = await endTurn(userRow.id, 'interrupted', null)
      await setStatus(sessionId, 'interrupted', null)
      return
    }

    // Anything sent while this turn ran goes straight into the next one.
    const [more] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.pending, true)))
      .limit(1)

    if (more) {
      verdict = await endTurn(userRow.id, 'drained', null)
      await setStatus(sessionId, 'queued', null)
      await enqueueSessionRun({ sessionId })
      return
    }

    // The SDK stops a query over budget with its own result subtype. Left
    // alone it reads as `success`, so a session that ran out of money looks
    // exactly like one that finished the job.
    const resultSubtype =
      lastResult?.type === 'result' ? (lastResult as { subtype?: string }).subtype : undefined
    if (resultSubtype === 'error_max_budget_usd') {
      const detail = `Stopped: the session reached its $${claimed.maxBudgetUsd} budget. Raise it to continue.`
      verdict = await endTurn(userRow.id, 'stopped_over_budget', detail)
      await setStatus(sessionId, 'failed', detail)
      return
    }

    // The SDK cancelled a tool call on its own, and the model reading that as
    // a user refusal is how a session went passive and started asking a human
    // to pick from a menu — twice — over a `git push` nobody had said no to.
    // Placed here on purpose: after the drain check, so a real message the
    // operator sent mid-turn always outranks this auto-nudge rather than
    // racing it; and skipped whenever the result itself says the turn stopped
    // for a reason (`error_*`, including the budget subtype just handled
    // above), because a `maxTurns` or budget stop legitimately cancels
    // whatever tool calls were still outstanding and nudging there would just
    // fight a limit that is working correctly.
    if (cancelledOutsideInterrupt && !resultSubtype?.startsWith('error_')) {
      const recovery = await recover(
        sessionId,
        orchestratorName,
        {
          notice: (attempt, of) =>
            `A tool call in this turn came back cancelled by the harness, not refused by the operator — nobody declined it. Re-running it (${attempt} of ${of}).`,
          instruction: `A tool call in your previous turn was reported as cancelled. That was not the operator saying no: nobody was asked, and this session runs with permissions bypassed, so there was no confirmation to refuse in the first place. The harness cancelled it on its own — most likely because the turn ended while it was still running. There is no menu to offer and no decision to wait for: re-run whatever that call was doing and carry on.`,
          giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: a tool call keeps coming back cancelled by the harness, not refused by the operator.`,
        },
        userRow.id,
      )
      verdict = await endTurn(
        userRow.id,
        recovery.outcome === 'continued' ? 'continuing' : 'stalled',
        recovery.detail,
      )
      return
    }

    // A background *command*, not a delegated task: the operator asked for
    // something — a `git push` behind a multi-minute pre-push hook, backgrounded
    // with `run_in_background: true` — and it never got to finish, because this
    // session cannot outlive its turn either. The count comes from the ledger
    // the loop above just built, not from `lastResult`: the kill for exactly
    // this kind of command arrived roughly five seconds after the result that
    // otherwise reads as "the turn finished cleanly."
    //
    // Guarded by the same `!resultSubtype?.startsWith('error_')` as the
    // cancellation branch above, for the same reason: a `maxTurns` or budget
    // stop (or any other `error_*` the SDK reports) legitimately kills
    // whatever commands were still backgrounded when it stopped, so this is
    // not a second, independent loss to nudge over. This is not a behaviour
    // regression either — before this ledger existed, a turn like that already
    // fell through to `completed` — so the guard restores the status quo
    // rather than hiding a newly-discovered one. Do not remove it to "catch"
    // that case: it is the budget/turn limit doing its job.
    const lostCommands = lostBackgroundCommands(backgroundCommands)
    if (lostCommands > 0 && !resultSubtype?.startsWith('error_')) {
      const oneCommand = lostCommands === 1
      const commands = oneCommand ? 'a command' : `${lostCommands} commands`
      const recovery = await recover(
        sessionId,
        orchestratorName,
        {
          notice: (attempt, of) =>
            `The turn ended while ${commands} you left running in the background ${oneCommand ? 'was' : 'were'} still going, so ${oneCommand ? 'it was' : 'they were'} stopped — this session cannot outlive its turn. Picking the work back up (${attempt} of ${of}).`,
          instruction: `Your previous turn ended while ${commands} you left running in the background ${oneCommand ? 'was' : 'were'} still going, so ${oneCommand ? 'it was' : 'they were'} stopped when the turn closed. No report is coming for ${oneCommand ? 'it' : 'them'}, and any claim that ${oneCommand ? 'it' : 'they'} finished is unsafe — check what actually happened (did it land, did it finish) before you trust it, then carry on. Backgrounding a command does not outlive your turn: run it in the foreground if you need to see it through, or check back on it again before the turn ends.`,
          giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: every turn ended with a command still running in the background. Check whether it actually finished.`,
        },
        userRow.id,
      )
      verdict = await endTurn(
        userRow.id,
        recovery.outcome === 'continued' ? 'continuing' : 'stalled',
        recovery.detail,
      )
      return
    }

    // A turn that ends having lost delegated work has not finished, whatever
    // its result says. Saying so in the transcript and picking the thread back
    // up is the whole difference between this and the session that sat dead for
    // fifteen minutes until its operator thought to ask whether it had crashed.
    const lost = lostSubagents(lastResult)
    if (lost > 0) {
      const one = lost === 1
      const tasks = `${lost} delegated task${one ? '' : 's'}`
      const recovery = await recover(
        sessionId,
        orchestratorName,
        {
          notice: (attempt, of) =>
            `The turn ended while ${tasks} ${one ? 'was' : 'were'} still running in the background, so ${one ? 'it was' : 'they were'} stopped — this session cannot outlive its turn. Picking the work back up (${attempt} of ${of}).`,
          instruction: `Your previous turn ended while ${tasks} ${one ? 'was' : 'were'} still running in the background, so ${one ? 'it was' : 'they were'} stopped when the turn closed. No report is coming for ${one ? 'it' : 'them'}, and any claim that ${one ? 'it' : 'they'} finished is unsafe: check what actually landed on disk first, then carry on from there. Delegation blocks — send the work again and read the result inside the turn you are in, rather than ending a turn to wait for it.`,
          giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: every turn ended with delegated work still running in the background. Check the worktree for partial work.`,
        },
        userRow.id,
      )
      verdict = await endTurn(
        userRow.id,
        recovery.outcome === 'continued' ? 'continuing' : 'stalled',
        recovery.detail,
      )
      return
    }

    // The outcome is a pure function of two values already in memory —
    // resultSubtype and lastResult — not a re-derivation of the cascade
    // above. See completionOutcome's own comment for why `error_max_turns`
    // and a genuine `is_error: true` are not the same fact as this session
    // actually finishing the work, and why writing `completed` for both was
    // exactly the lie a downstream board would advance a card on.
    verdict = await endTurn(userRow.id, completionOutcome(resultSubtype, lastResult), null)
    await setStatus(sessionId, 'completed', null)
  } catch (error) {
    // An abort surfaces here as a thrown error, but it was asked for.
    if (interrupted) {
      if (announcement) await unstampAnnouncement(sessionId, userRow.seq, userRow.id)
      await noticeStrandedPrompt(sessionId, orchestratorName)
      verdict = await endTurn(userRow.id, 'interrupted', null)
      await setStatus(sessionId, 'interrupted', null)
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${sessionId} failed: ${detail}`)

    // A killed process is not a failed turn, and must not be reported as one.
    // The work stopped where it stood for a reason that had nothing to do with
    // the model, and `resume` still has the conversation, so the session picks
    // itself back up instead of waiting for someone to notice and type
    // "Continue" — which is exactly what its operator had to do, four times in
    // one hour, before this existed.
    const kill = processKill(detail)
    if (kill) {
      if (announcement) await unstampAnnouncement(sessionId, userRow.seq, userRow.id)
      const recovery = await recover(
        sessionId,
        orchestratorName,
        {
          notice: (attempt, of) =>
            `The Claude Code process running this turn was killed by ${kill.signal}. ${kill.cause} Resuming where it left off (${attempt} of ${of}).`,
          instruction: `Your previous turn was cut short: the process running it was killed by ${kill.signal} partway through, so everything in flight stopped where it stood rather than finishing. ${kill.cause} Nothing is coming back for that work, and any note you left claiming it was done is unsafe — check what actually landed on disk before you trust it, then carry on. If a command you ran is what exhausted the machine, do not run it the same way again: split it up, run it over fewer files at a time, or cap its memory.`,
          giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: the Claude Code process keeps being killed (${detail}). ${kill.cause}`,
        },
        userRow.id,
      )
      verdict = await endTurn(
        userRow.id,
        recovery.outcome === 'continued' ? 'continuing' : 'stalled',
        recovery.detail,
      )
      return
    }

    // Recorded in the transcript as well as on the session: a failure that only
    // shows up as a red line on the sessions list is invisible from inside the
    // session, which is where someone reading the history actually is.
    if (announcement) await unstampAnnouncement(sessionId, userRow.seq, userRow.id)
    await appendMessage(sessionId, { type: 'error', message: detail }, orchestratorName)
    verdict = await endTurn(userRow.id, 'failed', detail)
    // Anything still pending stays pending. Draining it now would replay the
    // same failure against every queued message in turn.
    await setStatus(sessionId, 'failed', detail)
  } finally {
    clearInterval(heartbeat)
    // The other failure domain, distinct from the reconciler's: not a killed
    // process, but a branch of the cascade above that ran to a `return` (or
    // fell through to here) without ever calling `endTurn` at all — the
    // "eleventh branch someone adds next year" this exists for. Guarded twice
    // over: `endTurn`'s own WHERE makes a second call a no-op whenever a
    // branch above already rendered the verdict, and `endTurn` itself never
    // throws — so this is safe to call unconditionally rather than trusted to
    // run only when it should.
    if (!verdict) {
      await endTurn(userRow.id, 'unknown', 'No branch in this turn recorded an outcome.')
    }
    unsubscribe()
  }
}

export function startSessionRunWorker() {
  const worker = new Worker<SessionRunJob>(QUEUE_SESSION_RUN, (job) => runTurn(job.data), {
    connection: redisConnection(),
    concurrency: env.WORKER_CONCURRENCY,
  })
  worker.on('failed', (job, error) => {
    logger.error(`Session turn ${job?.data.sessionId} failed: ${error.message}`)
  })
  return worker
}
