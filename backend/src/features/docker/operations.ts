// Operation records and their output log, in Redis only — this feature adds
// no table and no column (see the project brief), so there is nothing else
// for a docker operation's status or log to live in. A 1-hour TTL on every
// key here is deliberate: this is a live-progress record for "is the stack
// coming up", not a permanent audit trail, and it is refreshed on every write
// so a long-running `compose up --build` never expires out from under itself.
//
// Persist-then-publish throughout, exactly like lib/events.ts: a reconnecting
// SSE client replays the list it missed rather than this module trying to
// make pub/sub itself reliable.
//
// The per-operation record and its oplog stay project-wide (`op`, `oplog`,
// `project-ops` below): GET /projects/{id}/docker/operations answers every
// scope's history in one list, and each record now carries `sessionId` so a
// consumer can filter it client-side. Only the per-operation *lock* is scoped
// narrower than the project, because that is the one thing that actually has
// to serialize independently per session's worktree — see `dockerLockScope`.

import Redis from 'ioredis'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import type { DockerOperationDto, DockerOperationKind, DockerOperationStatus } from './schema'

const OPERATION_TTL_SECONDS = 3600
/** Matches the brief's `LTRIM … -2000 -1` — the oplog's own ring-buffer cap. */
const OPLOG_MAX_LINES = 2000

const lockKey = (scope: string) => `agentoo:docker:lock:${scope}`
const operationKey = (operationId: string) => `agentoo:docker:op:${operationId}`
const oplogKey = (operationId: string) => `agentoo:docker:oplog:${operationId}`
const projectOpsKey = (projectId: string) => `agentoo:docker:project-ops:${projectId}`
/** Same string as `operationKey` on purpose — pub/sub channels and ordinary
 * keys live in separate Redis namespaces, and the brief names both this way. */
export const operationChannel = (operationId: string) => `agentoo:docker:op:${operationId}`

/**
 * Same split as lib/events.ts's `pubSubConnection`/`subscriberConnection`,
 * and for the identical reason: BullMQ's `maxRetriesPerRequest: null` is
 * wrong for ordinary commands (a write against a dead Redis would hang the
 * caller forever instead of failing), but exactly right for a subscriber,
 * which holds no caller waiting on it and must not give up after one blip.
 */
const dataConnection = () =>
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    enableReadyCheck: false,
  })

const subscriberConnection = () =>
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })

let client: Redis | null = null
function redis(): Redis {
  if (!client) {
    client = dataConnection()
    client.on('error', (error) => logger.warn(`Redis (docker operations): ${error.message}`))
  }
  return client
}

// --- the operation record ----------------------------------------------------

export async function createOperation(input: {
  id: string
  projectId: string
  sessionId: string | null
  kind: DockerOperationKind
  services: string[]
}): Promise<DockerOperationDto> {
  const record: DockerOperationDto = {
    id: input.id,
    projectId: input.projectId,
    sessionId: input.sessionId,
    kind: input.kind,
    services: input.services,
    status: 'queued',
    exitCode: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  }
  await redis().set(operationKey(record.id), JSON.stringify(record), 'EX', OPERATION_TTL_SECONDS)
  await redis().rpush(projectOpsKey(input.projectId), record.id)
  await redis().expire(projectOpsKey(input.projectId), OPERATION_TTL_SECONDS)
  return record
}

export async function getOperation(operationId: string): Promise<DockerOperationDto | undefined> {
  const raw = await redis().get(operationKey(operationId))
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<DockerOperationDto>
    // dockerOperationSchema requires `sessionId` (nullable, not optional), but
    // a record `createOperation` wrote before this feature's worktree scope
    // existed never had the field at all. Defaulting it here, at the one
    // place a stored record is parsed back, is what keeps GET
    // .../docker/operations honouring its own documented shape for the up-to
    // -OPERATION_TTL_SECONDS a pre-migration record can still be read back —
    // every such record predates sessions having worktrees, so it was always
    // repo scope.
    return { ...parsed, sessionId: parsed.sessionId ?? null } as DockerOperationDto
  } catch {
    logger.warn(`Docker operation ${operationId} had a malformed record in Redis`)
    return undefined
  }
}

/**
 * Every operation this project has an id for, oldest first — the ids list
 * itself expires with the rest of this feature's state, so an operation that
 * aged out of both is simply gone from this list too, not reported as a gap.
 */
export async function listOperationsForProject(projectId: string): Promise<DockerOperationDto[]> {
  const ids = await redis().lrange(projectOpsKey(projectId), 0, -1)
  const records = await Promise.all(ids.map((id) => getOperation(id)))
  return records.filter((r): r is DockerOperationDto => r !== undefined)
}

type OperationPatch = Partial<
  Pick<DockerOperationDto, 'status' | 'exitCode' | 'error' | 'startedAt' | 'finishedAt'>
>

async function updateOperation(
  operationId: string,
  patch: OperationPatch,
): Promise<DockerOperationDto | undefined> {
  const current = await getOperation(operationId)
  if (!current) return undefined
  const next: DockerOperationDto = { ...current, ...patch }
  await redis().set(operationKey(operationId), JSON.stringify(next), 'KEEPTTL')
  await redis().publish(
    operationChannel(operationId),
    JSON.stringify({ kind: 'operation', operation: next }),
  )
  return next
}

export async function markOperationRunning(
  operationId: string,
): Promise<DockerOperationDto | undefined> {
  return updateOperation(operationId, { status: 'running', startedAt: new Date().toISOString() })
}

/**
 * Terminal transition. Publishes both the updated record (`operation`, same
 * as every other status change) and a dedicated `end` frame — the one SSE
 * consumers can use to stop listening without inspecting `status` themselves.
 */
export async function finishOperation(
  operationId: string,
  status: Extract<DockerOperationStatus, 'succeeded' | 'failed'>,
  exitCode: number | null,
  error: string | null,
): Promise<DockerOperationDto | undefined> {
  const updated = await updateOperation(operationId, {
    status,
    exitCode,
    error,
    finishedAt: new Date().toISOString(),
  })
  if (updated) {
    await redis().publish(
      operationChannel(operationId),
      JSON.stringify({ kind: 'end', operationId, status, exitCode }),
    )
  }
  return updated
}

// --- the per-scope lock -------------------------------------------------------
//
// Claim-don't-check, the same discipline session-run.worker.ts's `claimTurn`
// uses for a different mutex: the POST route below only *peeks* at this key to
// give a fast, friendly 409 naming the operation already running, but the
// worker's own SET NX is what actually serializes two operations on one
// scope — a route-side check-then-enqueue would leave a window between the
// check and the job actually running where a second request could slip through.

/**
 * The Redis-key identity of one project's (or one session's) serialization
 * boundary: the bare project id at repo scope — BYTE-IDENTICAL to the key
 * this feature has always used, so a lock held across a deploy is still found
 * under it — and `<projectId>:s-<sessionId>` once a session's own worktree is
 * in play, a key nothing before this feature ever wrote (nothing migrates).
 *
 * The full session id, not the truncated form names.ts's `scopeKey` computes
 * for docker resource names: a Redis key has no length or charset limit, so
 * there is nothing here for that truncation to protect against, and the full
 * id is easier to recognise when reading keys by hand.
 */
export function dockerLockScope(projectId: string, sessionId: string | null): string {
  return sessionId === null ? projectId : `${projectId}:s-${sessionId}`
}

/** Best-effort read for the POST routes' 409 — not the mutex itself. */
export async function activeOperationForScope(scope: string): Promise<string | undefined> {
  const value = await redis().get(lockKey(scope))
  return value ?? undefined
}

export async function claimOperationLock(
  scope: string,
  operationId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis().set(lockKey(scope), operationId, 'PX', ttlMs, 'NX')
  return result === 'OK'
}

/**
 * Compare-and-delete, not a bare DEL: a lock this operation once held but
 * that has since expired and been re-claimed by a later operation must not be
 * torn down out from under that later claim. Lua makes the read-then-delete
 * atomic against a concurrent claim landing in between.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

export async function releaseOperationLock(scope: string, operationId: string): Promise<void> {
  await redis().eval(RELEASE_LOCK_SCRIPT, 1, lockKey(scope), operationId)
}

// --- the output log -----------------------------------------------------------

export interface OperationOutputEvent {
  seq: number
  stream: 'stdout' | 'stderr'
  text: string
  at: string
}

/** RPUSH -> LTRIM -> EXPIRE -> PUBLISH, in that order — persisted before it is
 * announced, exactly like appendMessage in session-run.worker.ts. */
export async function appendOperationOutput(
  operationId: string,
  line: { stream: 'stdout' | 'stderr'; text: string },
): Promise<void> {
  const at = new Date().toISOString()
  const length = await redis().rpush(
    oplogKey(operationId),
    JSON.stringify({ stream: line.stream, text: line.text, at }),
  )
  await redis().ltrim(oplogKey(operationId), -OPLOG_MAX_LINES, -1)
  await redis().expire(oplogKey(operationId), OPERATION_TTL_SECONDS)

  // The list index this entry landed at — the reconnect cursor a client's
  // `after` refers to. Valid as long as this operation's log has never
  // actually been trimmed (the overwhelmingly common case, since 2000 lines
  // is a lot of `compose up` output); once trimming has actually dropped
  // entries, an old `after` simply replays whatever remains, which is the
  // same bounded-history tradeoff the cap itself already accepts.
  const seq = length - 1
  await redis().publish(
    operationChannel(operationId),
    JSON.stringify({ kind: 'output', seq, stream: line.stream, text: line.text, at }),
  )
}

export async function replayOperationOutput(
  operationId: string,
  after: number,
): Promise<OperationOutputEvent[]> {
  const raw = await redis().lrange(oplogKey(operationId), after + 1, -1)
  return raw.map((entry, i) => {
    const seq = after + 1 + i
    try {
      const parsed = JSON.parse(entry) as { stream: 'stdout' | 'stderr'; text: string; at: string }
      return { seq, ...parsed }
    } catch {
      logger.warn(`Docker operation ${operationId} had a malformed oplog entry at ${seq}`)
      return { seq, stream: 'stdout' as const, text: '', at: new Date().toISOString() }
    }
  })
}

// --- live subscription --------------------------------------------------------

export type DockerOperationEvent =
  | { kind: 'operation'; operation: DockerOperationDto }
  | { kind: 'output'; seq: number; stream: 'stdout' | 'stderr'; text: string; at: string }
  | { kind: 'end'; operationId: string; status: DockerOperationStatus; exitCode: number | null }

export function subscribeOperationEvents(
  operationId: string,
  onEvent: (event: DockerOperationEvent) => void,
): () => void {
  const sub = subscriberConnection()
  sub.on('error', (error) =>
    logger.warn(`Redis subscriber (docker op ${operationId}): ${error.message}`),
  )
  void sub.subscribe(operationChannel(operationId))
  sub.on('message', (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as DockerOperationEvent)
    } catch {
      logger.warn(`Dropped a malformed docker operation event for ${operationId}`)
    }
  })
  return () => {
    void sub.quit().catch(() => sub.disconnect())
  }
}
