// Redis records for one session's editor start attempts, and the per-session
// start lock — this feature's own namespace end to end (`agentoo:editor:*`),
// separate from docker/operations.ts's `agentoo:docker:*` on purpose: sharing
// that module would leak editor starts into GET /projects/{id}/docker/operations,
// share docker's own per-scope lock (an editor start and a docker `up` on the
// same session's worktree have nothing to do with each other), and churn keys
// this feature never wrote (docker's TTLs are tuned for a `compose up
// --build`, not a 90s container-plus-healthz wait).
//
// No pub/sub here, unlike docker/operations.ts: this feature is polled (see
// the design's own "Progress" note — GET .../editor is cheap enough to poll
// every couple of seconds while starting), so there is no SSE consumer to
// publish to.

import Redis from 'ioredis'
import { env } from '@/env'
import type { DockerOperationStatus } from '@/features/docker/schema'
import { logger } from '@/lib/logger'
import type { EditorOperationOutputLine } from './schema'

const OPERATION_TTL_SECONDS = 3600
/** The design's own cap: "the last 200 output lines". */
const OPLOG_MAX_LINES = 200
/** Matches editorOperationSchema's own documented per-line cap. */
const MAX_LINE_CHARS = 2000

const lockKey = (sessionId: string) => `agentoo:editor:lock:${sessionId}`
const operationKey = (operationId: string) => `agentoo:editor:op:${operationId}`
const oplogKey = (operationId: string) => `agentoo:editor:oplog:${operationId}`
const lastOpKey = (sessionId: string) => `agentoo:editor:last-op:${sessionId}`

// Same non-blocking connection docker/operations.ts uses for ordinary reads
// and writes — see that module's own comment for why this split (a data
// connection with maxRetriesPerRequest: 1, never the null BullMQ needs) is
// correct here and not for a queue connection.
const dataConnection = () =>
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    enableReadyCheck: false,
  })

let client: Redis | null = null
function redis(): Redis {
  if (!client) {
    client = dataConnection()
    client.on('error', (error) => logger.warn(`Redis (editor operations): ${error.message}`))
  }
  return client
}

/** The record persisted in Redis — deliberately without `output`, which lives
 * in its own list key (`oplogKey`) so a status poll that only wants the
 * record's fields never pays for deserializing up to 200 lines of text it is
 * about to discard. `getEditorOperationOutput` below reads that list back. */
export interface EditorOperationRecord {
  id: string
  status: DockerOperationStatus
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export async function createEditorOperation(
  sessionId: string,
  operationId: string,
): Promise<EditorOperationRecord> {
  const record: EditorOperationRecord = {
    id: operationId,
    status: 'queued',
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  }
  await redis().set(operationKey(operationId), JSON.stringify(record), 'EX', OPERATION_TTL_SECONDS)
  await redis().set(lastOpKey(sessionId), operationId, 'EX', OPERATION_TTL_SECONDS)
  return record
}

export async function getEditorOperation(
  operationId: string,
): Promise<EditorOperationRecord | undefined> {
  const raw = await redis().get(operationKey(operationId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as EditorOperationRecord
  } catch {
    logger.warn(`Editor operation ${operationId} had a malformed record in Redis`)
    return undefined
  }
}

/** The most recent start requested for this session, or undefined once it has
 * aged out of Redis (or none was ever requested). */
export async function lastEditorOperationId(sessionId: string): Promise<string | undefined> {
  const id = await redis().get(lastOpKey(sessionId))
  return id ?? undefined
}

type OperationPatch = Partial<
  Pick<EditorOperationRecord, 'status' | 'error' | 'startedAt' | 'finishedAt'>
>

async function updateEditorOperation(
  operationId: string,
  patch: OperationPatch,
): Promise<EditorOperationRecord | undefined> {
  const current = await getEditorOperation(operationId)
  if (!current) return undefined
  const next: EditorOperationRecord = { ...current, ...patch }
  await redis().set(operationKey(operationId), JSON.stringify(next), 'KEEPTTL')
  return next
}

export async function markEditorOperationRunning(
  operationId: string,
): Promise<EditorOperationRecord | undefined> {
  return updateEditorOperation(operationId, {
    status: 'running',
    startedAt: new Date().toISOString(),
  })
}

export async function finishEditorOperation(
  operationId: string,
  status: Extract<DockerOperationStatus, 'succeeded' | 'failed'>,
  error: string | null,
): Promise<EditorOperationRecord | undefined> {
  return updateEditorOperation(operationId, { status, error, finishedAt: new Date().toISOString() })
}

// --- the output log -----------------------------------------------------------

/** RPUSH -> LTRIM -> EXPIRE, in that order — persisted before it could ever be
 * read half-trimmed. No PUBLISH: see this module's own header for why this
 * feature is polled, not streamed. */
export async function appendEditorOperationOutput(
  operationId: string,
  line: { stream: 'stdout' | 'stderr'; text: string },
): Promise<void> {
  const at = new Date().toISOString()
  const text = line.text.length > MAX_LINE_CHARS ? line.text.slice(0, MAX_LINE_CHARS) : line.text
  await redis().rpush(oplogKey(operationId), JSON.stringify({ stream: line.stream, text, at }))
  await redis().ltrim(oplogKey(operationId), -OPLOG_MAX_LINES, -1)
  await redis().expire(oplogKey(operationId), OPERATION_TTL_SECONDS)
}

export async function getEditorOperationOutput(
  operationId: string,
): Promise<EditorOperationOutputLine[]> {
  const raw = await redis().lrange(oplogKey(operationId), 0, -1)
  const out: EditorOperationOutputLine[] = []
  for (const entry of raw) {
    try {
      out.push(JSON.parse(entry) as EditorOperationOutputLine)
    } catch {
      logger.warn(`Editor operation ${operationId} had a malformed oplog entry; skipping it`)
    }
  }
  return out
}

// --- the per-session start lock ------------------------------------------------
//
// Claim-don't-check, exactly like docker/operations.ts's own lock: the route
// only *peeks* at this key for a fast, friendly response when a start is
// already in flight; the worker's own SET NX is what actually serializes two
// starts on one session.

/** Best-effort read — not the mutex itself. Also what `deriveEditorState`
 * (service.ts) uses to decide `starting` vs. trusting the operation record. */
export async function editorLockHolder(sessionId: string): Promise<string | undefined> {
  const value = await redis().get(lockKey(sessionId))
  return value ?? undefined
}

export async function claimEditorLock(
  sessionId: string,
  operationId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis().set(lockKey(sessionId), operationId, 'PX', ttlMs, 'NX')
  return result === 'OK'
}

/** Compare-and-delete, not a bare DEL — same reasoning as
 * docker/operations.ts's `releaseOperationLock`: a lock this start once held
 * but that has since expired and been re-claimed by a later start must not be
 * torn down out from under that later claim. */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

export async function releaseEditorLock(sessionId: string, operationId: string): Promise<void> {
  await redis().eval(RELEASE_LOCK_SCRIPT, 1, lockKey(sessionId), operationId)
}
