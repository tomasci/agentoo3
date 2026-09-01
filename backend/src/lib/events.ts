// Redis pub/sub bridge between the worker and the API.
//
// The worker runs sessions; the API serves the SSE stream. They are separate
// processes, so the transcript has to cross a process boundary to reach a
// browser. Redis is already a dependency for BullMQ, so it carries this too.
//
// Delivery is best-effort by design. Every event is persisted before it is
// published, and each carries its `seq`, so a client that misses one (a dropped
// connection, a slow subscriber, an API restart) recovers by replaying from the
// database rather than by us trying to make pub/sub reliable.

import Redis from 'ioredis'
import { env } from '@/env'
import { logger } from './logger'

/** Transcript events for one session: appended messages and status changes. */
export const sessionChannel = (sessionId: string) => `agentoo:session:${sessionId}`

/** Control messages *to* a running session, for interrupts. */
export const controlChannel = (sessionId: string) => `agentoo:control:${sessionId}`

export type SessionEvent =
  | { kind: 'message'; sessionId: string; seq: number; message: unknown }
  | { kind: 'status'; sessionId: string; status: string; lastError?: string | null }

export type ControlEvent = { kind: 'interrupt' }

/**
 * Connections for pub/sub, deliberately not BullMQ's.
 *
 * BullMQ needs `maxRetriesPerRequest: null` because it blocks on a connection
 * waiting for jobs, and a bounded retry would tear that down. Those exact
 * settings are wrong here: with an unbounded retry and the offline queue on, a
 * publish to a Redis that is down never rejects — it waits, forever, inside the
 * turn that called it. Verified against a stopped server: the call hangs rather
 * than throwing. A dropped live update is not worth stalling a session for, so
 * these fail fast instead and the transcript recovers by replaying from the
 * database.
 */
const pubSubConnection = () =>
  new Redis(env.REDIS_URL, {
    // Bounded, so a publish against a dead Redis rejects instead of waiting.
    maxRetriesPerRequest: 1,
    // Left on so the first publish after boot is buffered through the
    // handshake rather than rejected for arriving a few milliseconds early;
    // maxRetriesPerRequest is what flushes it with an error if Redis is really
    // gone. Both were verified against a server that is up, and one that is not.
    enableOfflineQueue: true,
    enableReadyCheck: false,
  })

/**
 * The subscriber side keeps retrying: it holds no caller waiting on it, and a
 * reader that gives up on the first blip would go silent for good.
 */
const subscriberConnection = () =>
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })

let publisher: Redis | null = null

/** One shared publisher. Publishing does not block the connection. */
function pub(): Redis {
  if (!publisher) {
    publisher = pubSubConnection()
    // Without a listener ioredis escalates connection errors to an unhandled
    // 'error' event, which would take the process down over a blip.
    publisher.on('error', (error) => logger.warn(`Redis publisher: ${error.message}`))
  }
  return publisher
}

export async function publishSessionEvent(event: SessionEvent): Promise<void> {
  try {
    await pub().publish(sessionChannel(event.sessionId), JSON.stringify(event))
  } catch (error) {
    // A failed publish costs a client its live update, not its data — the row
    // is already committed. Never let it break the run.
    logger.warn(`Could not publish ${event.kind} for session ${event.sessionId}: ${String(error)}`)
  }
}

/**
 * Unlike a transcript event, a dropped interrupt is not recoverable by replay:
 * nothing re-sends it, so the caller is told when it did not land.
 */
export async function publishControl(sessionId: string, event: ControlEvent): Promise<void> {
  await pub().publish(controlChannel(sessionId), JSON.stringify(event))
}

/**
 * Subscribe to one session's events.
 *
 * A subscribed ioredis connection cannot issue ordinary commands, so each
 * subscriber gets its own. SSE readers are few (one per open browser tab) and
 * short-lived, which is the case this trades for simplicity.
 */
export function subscribeSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): () => void {
  const sub = subscriberConnection()
  sub.on('error', (error) => logger.warn(`Redis subscriber: ${error.message}`))
  void sub.subscribe(sessionChannel(sessionId))
  sub.on('message', (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as SessionEvent)
    } catch {
      logger.warn(`Dropped a malformed session event for ${sessionId}`)
    }
  })
  return () => {
    void sub.quit().catch(() => sub.disconnect())
  }
}

export function subscribeControl(
  sessionId: string,
  onEvent: (event: ControlEvent) => void,
): () => void {
  const sub = subscriberConnection()
  sub.on('error', (error) => logger.warn(`Redis subscriber: ${error.message}`))
  void sub.subscribe(controlChannel(sessionId))
  sub.on('message', (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as ControlEvent)
    } catch {
      logger.warn(`Dropped a malformed control event for ${sessionId}`)
    }
  })
  return () => {
    void sub.quit().catch(() => sub.disconnect())
  }
}
