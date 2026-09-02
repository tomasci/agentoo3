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
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
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
    .values({
      sessionId,
      seq,
      type: message.type,
      parentToolUseId,
      title: titleFor(message, who),
      payload: message as unknown as Record<string, unknown>,
    })
    .returning()

  await publishSessionEvent({ kind: 'message', sessionId, seq, message: row })
}

async function setStatus(sessionId: string, status: string, lastError?: string | null) {
  await db
    .update(sessions)
    .set({
      status: status as 'idle' | 'queued' | 'running' | 'interrupted' | 'completed' | 'failed',
      ...(lastError !== undefined && { lastError }),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
  await publishSessionEvent({ kind: 'status', sessionId, status, lastError })
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

async function runTurn(job: SessionRunJob): Promise<void> {
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
        const result = message as typeof message & { total_cost_usd?: number }
        if (typeof result.total_cost_usd === 'number') {
          await db
            .update(sessions)
            .set({ totalCostUsd: sql`${sessions.totalCostUsd} + ${result.total_cost_usd}` })
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
    } else {
      await setStatus(sessionId, 'completed', null)
    }
  } catch (error) {
    // An abort surfaces here as a thrown error, but it was asked for.
    if (interrupted) {
      await setStatus(sessionId, 'interrupted', null)
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${sessionId} failed: ${detail}`)
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
