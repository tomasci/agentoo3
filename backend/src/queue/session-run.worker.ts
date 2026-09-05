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
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { sanitizeForDb } from '@/db/sanitize'
import { messages, projects, sessions } from '@/db/schema'
import { env, hasClaudeCredential } from '@/env'
import { optionsFor } from '@/features/sessions/runner-options'
import { type TranscriptMessage, titleFor } from '@/features/sessions/titles'
import { publishSessionEvent, subscribeControl } from '@/lib/events'
import { logger } from '@/lib/logger'
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

  await publishSessionEvent({ kind: 'message', sessionId, seq, message: row })
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

/** How many continuations one stall may be nudged through before it stops. */
const MAX_AUTO_CONTINUATIONS = 3

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
async function enqueueContinuation(sessionId: string, text: string): Promise<void> {
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
 */
export async function recover(sessionId: string, who: string, recovery: Recovery): Promise<void> {
  // What the session is told happened, if everything below this line fails. It
  // becomes the notice once we know we are nudging rather than stopping.
  let why = recovery.giveUp
  try {
    const sent = await autoContinuationsSincePrompt(sessionId)
    if (sent < MAX_AUTO_CONTINUATIONS) {
      why = recovery.notice(sent + 1, MAX_AUTO_CONTINUATIONS)
      await appendMessage(sessionId, { type: 'notice', message: why }, who)
      await enqueueContinuation(sessionId, recovery.instruction)
      await setStatus(sessionId, 'queued', null)
      await enqueueSessionRun({ sessionId })
      return
    }
    // Said in the transcript as well as on the session row: a failure that
    // shows only as a red line on the sessions list is invisible from inside
    // the session, which is where whoever is reading it actually is.
    await appendMessage(sessionId, { type: 'error', message: recovery.giveUp }, who)
    await setStatus(sessionId, 'failed', recovery.giveUp)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${sessionId} could not be resumed: ${detail}`)
    try {
      await setStatus(sessionId, 'failed', `${why} Recovering from that failed too: ${detail}`)
    } catch (fatal) {
      // Nothing left to write with. Said as loudly as this process can say it,
      // because the row is now stale: the session reads as `running` and no
      // worker holds it.
      const why2 = fatal instanceof Error ? fatal.message : String(fatal)
      logger.error(
        `Session ${sessionId} is stranded: it still reads as 'running' and could not be marked failed (${why2}). Reset it by hand once the database is back.`,
      )
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

/** Exported for the tests; the worker below is the only real caller. */
export async function runTurn(job: SessionRunJob): Promise<void> {
  const { sessionId } = job

  // Claim the turn. A conditional update is the mutex: whichever worker moves
  // the row out of 'queued' owns it, and a duplicate delivery finds nothing.
  const [claimed] = await db
    .update(sessions)
    .set({ status: 'running', lastError: null, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'queued')))
    .returning()

  if (!claimed) {
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
  await db.update(messages).set({ pending: false }).where(eq(messages.id, userRow.id))
  const prompt = String((userRow.payload as { text?: unknown }).text ?? '')

  const abortController = new AbortController()
  let interrupted = false
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
  // Cumulative-so-far, to charge only what each result adds. See the result
  // branch below for why the naive sum was wrong by a factor of seven.
  let chargedUsd = 0
  let lastResult: TranscriptMessage | undefined

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
      }

      await appendMessage(sessionId, message, attribution(message, tasks, orchestratorName))

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
      await setStatus(
        sessionId,
        'failed',
        `Stopped: the session reached its $${claimed.maxBudgetUsd} budget. Raise it to continue.`,
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
      await recover(sessionId, orchestratorName, {
        notice: (attempt, of) =>
          `The turn ended while ${tasks} ${one ? 'was' : 'were'} still running in the background, so ${one ? 'it was' : 'they were'} stopped — this session cannot outlive its turn. Picking the work back up (${attempt} of ${of}).`,
        instruction: `Your previous turn ended while ${tasks} ${one ? 'was' : 'were'} still running in the background, so ${one ? 'it was' : 'they were'} stopped when the turn closed. No report is coming for ${one ? 'it' : 'them'}, and any claim that ${one ? 'it' : 'they'} finished is unsafe: check what actually landed on disk first, then carry on from there. Delegation blocks — send the work again and read the result inside the turn you are in, rather than ending a turn to wait for it.`,
        giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: every turn ended with delegated work still running in the background. Check the worktree for partial work.`,
      })
      return
    }

    await setStatus(sessionId, 'completed', null)
  } catch (error) {
    // An abort surfaces here as a thrown error, but it was asked for.
    if (interrupted) {
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
      await recover(sessionId, orchestratorName, {
        notice: (attempt, of) =>
          `The Claude Code process running this turn was killed by ${kill.signal}. ${kill.cause} Resuming where it left off (${attempt} of ${of}).`,
        instruction: `Your previous turn was cut short: the process running it was killed by ${kill.signal} partway through, so everything in flight stopped where it stood rather than finishing. ${kill.cause} Nothing is coming back for that work, and any note you left claiming it was done is unsafe — check what actually landed on disk before you trust it, then carry on. If a command you ran is what exhausted the machine, do not run it the same way again: split it up, run it over fewer files at a time, or cap its memory.`,
        giveUp: `Gave up after ${MAX_AUTO_CONTINUATIONS} continuations: the Claude Code process keeps being killed (${detail}). ${kill.cause}`,
      })
      return
    }

    // Recorded in the transcript as well as on the session: a failure that only
    // shows up as a red line on the sessions list is invisible from inside the
    // session, which is where someone reading the history actually is.
    await appendMessage(sessionId, { type: 'error', message: detail }, orchestratorName)
    // Anything still pending stays pending. Draining it now would replay the
    // same failure against every queued message in turn.
    await setStatus(sessionId, 'failed', detail)
  } finally {
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
