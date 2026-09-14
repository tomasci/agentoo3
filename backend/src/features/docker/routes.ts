import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import {
  AppError,
  errorBody,
  issuesFor,
  notFound,
  tooManyRequests,
  validationFailed,
} from '@/lib/errors'
import { logsArgs } from './args'
import type { DockerStream } from './cli'
import { realDockerCli } from './cli'
import { replayOperationOutput, subscribeOperationEvents } from './operations'
import {
  dockerDetectionListSchema,
  dockerOperationSchema,
  dockerStateSchema,
  downRequestSchema,
  serviceSelectionSchema,
  upRequestSchema,
} from './schema'
import {
  containerBelongsToScope,
  getDockerOperation,
  getProjectDockerState,
  listDockerDetections,
  listDockerOperations,
  requestDockerDown,
  requestDockerRestart,
  requestDockerStop,
  requestDockerUp,
} from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const operationIdParam = idParam.extend({
  operationId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'operationId', in: 'path' } }),
})

/**
 * Selects a *row*, never a path: `sessionId` picks which of a project's
 * scopes (its own repo/ checkout, or one session's independent worktree) a
 * request targets, but never supplies a directory or a flag itself — every
 * path this feature ever touches is still derived server-side from the
 * resolved scope (see scope.ts). That is what keeps this a query param and
 * not a body field: a body field could plausibly be read as "steer the
 * compose invocation", which docker-security.test.ts pins can never happen.
 */
const scopeQuery = z.object({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: 'sessionId', in: 'query' },
      description:
        "Scope to this session's own git worktree instead of the project's repo/ checkout. " +
        'Omitted means the repo/ checkout.',
    }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const dockerRouter = new OpenAPIHono()

// Same reason projectsRouter/sessionsRouter both give their own: lets this
// router's tests exercise it directly (mounted stand-alone, not under the
// full app) and still see AppError's real status and recovery commands
// instead of Hono's generic 500 for an uncaught throw.
dockerRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

dockerRouter.openapi(
  createRoute({
    method: 'get',
    path: '/docker/detection',
    tags: ['docker'],
    summary: 'Detect a compose file or Dockerfile for every project',
    description:
      'Filesystem only — no docker CLI call. Behind a 10s cache per project, so this is safe to ' +
      'poll for a nav badge. Answers `{ enabled: false, projects: [] }` when DOCKER_ENABLED=false.',
    responses: { 200: json(dockerDetectionListSchema, 'Detection for every project') },
  }),
  async (c) => c.json(await listDockerDetections(), 200),
)

dockerRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/docker',
    tags: ['docker'],
    summary: "A project's live docker state",
    description:
      'Reads the daemon directly — nothing here is stored. Always 200 for a known project, even ' +
      'with a broken compose file (see `configError`) or no docker CLI at all (see `daemon`): a ' +
      'broken or absent setup is a legitimate project state, not a server fault. `containers` is ' +
      'populated from `docker ps` independently of whether compose config parsed, so stop/down ' +
      'stay meaningful even when start/restart would not be.',
    request: { params: idParam, query: scopeQuery },
    responses: {
      200: json(dockerStateSchema, 'Current state'),
      400: json(errorSchema, 'The named session has no worktree of its own'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, "The session's worktree is no longer on disk"),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { sessionId } = c.req.valid('query')
    return c.json(await getProjectDockerState(id, sessionId), 200)
  },
)

const operationResponses = {
  202: json(dockerOperationSchema, 'Queued'),
  400: json(
    errorSchema,
    'Unknown service name, a Dockerfile-only field sent for a compose project, or the named ' +
      'session has no worktree of its own',
  ),
  403: json(errorSchema, 'Docker controls are disabled'),
  404: json(errorSchema, 'Not found (project, or the named session)'),
  409: json(
    errorSchema,
    "Another operation is already running for this scope, or the session's worktree is no " +
      'longer on disk',
  ),
  503: json(errorSchema, 'docker (or the daemon) is unavailable'),
}

dockerRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/docker/up',
    tags: ['docker'],
    summary: 'Start (or build and start) the stack, or one container',
    description:
      'Compose: `docker compose up -d`, optionally `--build`/`--force-recreate`/`--remove-orphans`, ' +
      'scoped to `services` (omitted or empty means the whole stack). Plain Dockerfile: builds if ' +
      'asked or if no image exists yet, then `docker run -d -p <hostPort|0>:<containerPort>`. ' +
      '`containerPort` is required when neither an EXPOSE nor a built image declares one. Returns ' +
      '202 immediately; the mutation itself runs on the worker — poll ' +
      'GET .../operations/{operationId} or open its SSE stream.',
    request: { params: idParam, query: scopeQuery, body: json(upRequestSchema, 'Up options') },
    responses: operationResponses,
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { sessionId } = c.req.valid('query')
    return c.json(await requestDockerUp(id, sessionId, c.req.valid('json')), 202)
  },
)

dockerRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/docker/stop',
    tags: ['docker'],
    summary: 'Stop the stack, or one or more services/the container, without removing anything',
    request: {
      params: idParam,
      query: scopeQuery,
      body: json(serviceSelectionSchema, 'Which services to stop'),
    },
    responses: operationResponses,
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { sessionId } = c.req.valid('query')
    return c.json(await requestDockerStop(id, sessionId, c.req.valid('json')), 202)
  },
)

dockerRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/docker/restart',
    tags: ['docker'],
    summary: 'Restart the stack, or one or more services/the container',
    request: {
      params: idParam,
      query: scopeQuery,
      body: json(serviceSelectionSchema, 'Which services to restart'),
    },
    responses: operationResponses,
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { sessionId } = c.req.valid('query')
    return c.json(await requestDockerRestart(id, sessionId, c.req.valid('json')), 202)
  },
)

dockerRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/docker/down',
    tags: ['docker'],
    summary: 'Cleanup: stop and remove the containers (and, if asked, volumes/images)',
    description:
      'Compose: `docker compose down`, which removes containers and the compose-created network ' +
      'only — `removeVolumes`/`removeImages` default to false and must be asked for explicitly. ' +
      'Plain Dockerfile: `docker stop` then `docker rm`; never removes the built image.',
    request: {
      params: idParam,
      query: scopeQuery,
      body: json(downRequestSchema, 'Cleanup options'),
    },
    responses: operationResponses,
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { sessionId } = c.req.valid('query')
    return c.json(await requestDockerDown(id, sessionId, c.req.valid('json')), 202)
  },
)

dockerRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/docker/operations',
    tags: ['docker'],
    summary: "A project's recent docker operations",
    description: 'Redis-backed, 1-hour TTL — this is a live-progress record, not a permanent log.',
    request: { params: idParam },
    responses: {
      200: json(z.array(dockerOperationSchema), 'Operations'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listDockerOperations(c.req.valid('param').id), 200),
)

dockerRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/docker/operations/{operationId}',
    tags: ['docker'],
    summary: 'One docker operation',
    request: { params: operationIdParam },
    responses: {
      200: json(dockerOperationSchema, 'Operation'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => {
    const { id, operationId } = c.req.valid('param')
    return c.json(await getDockerOperation(id, operationId), 200)
  },
)

// ============================================================================
// The two SSE routes below live outside the OpenAPI router, exactly like
// /sessions/:id/events (see sessions/routes.ts's own comment, which this
// mirrors): a generated client is typed for JSON bodies, and an event stream
// is neither JSON nor something a hook should wrap. `:id`/`:operationId`/
// `:containerId` and every query param are hand-validated with
// `validationFailed`/`issuesFor` so a malformed one 400s in the identical
// envelope every OpenAPI-validated route already uses, before any stream
// bytes go out.
// ============================================================================

const afterSchema = z.coerce.number().int().min(-1).optional()

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx would otherwise buffer the whole stream and deliver nothing.
    'X-Accel-Buffering': 'no',
  } as const
}

/**
 * Operation events: replays the oplog from `after`, sends the operation's
 * current record, then subscribes for live updates. Mirrors
 * /sessions/:id/events's own shape end to end, including the `retry: 3000\n:
 * connected\n\n` priming write (headers do not reach the client until the
 * first body byte) and the 20s heartbeat.
 */
dockerRouter.get('/projects/:id/docker/operations/:operationId/events', async (c) => {
  const parsedParams = operationIdParam.safeParse({
    id: c.req.param('id'),
    operationId: c.req.param('operationId'),
  })
  const parsedQuery = z.object({ after: afterSchema }).safeParse({ after: c.req.query('after') })
  if (!parsedParams.success || !parsedQuery.success) {
    throw validationFailed([
      ...(parsedParams.success ? [] : issuesFor(parsedParams.error)),
      ...(parsedQuery.success ? [] : issuesFor(parsedQuery.error)),
    ])
  }
  const { id, operationId } = parsedParams.data
  const after = parsedQuery.data.after ?? -1

  // 404s before any stream headers go out, same reasoning as /sessions/:id/events.
  const operation = await getDockerOperation(id, operationId)
  const backlog = await replayOperationOutput(operationId, after)

  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let open = true
      const send = (event: string, data: unknown) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          open = false
        }
      }

      controller.enqueue(encoder.encode('retry: 3000\n: connected\n\n'))

      send('operation', operation)
      for (const line of backlog) send('output', line)
      if (operation.status === 'succeeded' || operation.status === 'failed') {
        send('end', {
          operationId: operation.id,
          status: operation.status,
          exitCode: operation.exitCode,
        })
      }

      unsubscribe = subscribeOperationEvents(operationId, (event) => {
        if (event.kind === 'operation') send('operation', event.operation)
        else if (event.kind === 'output') send('output', event)
        else
          send('end', {
            operationId: event.operationId,
            status: event.status,
            exitCode: event.exitCode,
          })
      })

      heartbeat = setInterval(() => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          open = false
        }
      }, 20_000)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, { headers: sseHeaders() })
})

// --- container logs ------------------------------------------------------

/** Hex only, so a containerId can never be read as a flag once it reaches argv. */
const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/
const containerLogsParams = idParam.extend({ containerId: z.string().regex(CONTAINER_ID_RE) })
const containerLogsQuery = z.object({
  tail: z.coerce.number().int().min(0).max(5000).optional(),
  since: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'since must be an RFC3339 timestamp')
    .optional(),
  // Same query param and the same reasoning as scopeQuery above — hand-parsed
  // rather than reused directly because this route lives outside the OpenAPI
  // router (see this file's own header) and validates every query key in one
  // schema, the same way the operation-events route above already does.
  sessionId: z.string().uuid().optional(),
})

/**
 * Per-API-process cap on concurrent `docker logs --follow` children. Without
 * it a client stuck in a reconnect loop spawns an unbounded number of them.
 * Exported so docker-logs-stream.test.ts can exercise the counter directly,
 * without opening 9 real HTTP connections.
 */
export const MAX_LOG_STREAMS = 8
let activeLogStreams = 0

export function acquireLogStreamSlot(): boolean {
  if (activeLogStreams >= MAX_LOG_STREAMS) return false
  activeLogStreams += 1
  return true
}

export function releaseLogStreamSlot(): void {
  activeLogStreams = Math.max(0, activeLogStreams - 1)
}

/** Test-only: bring the counter back to zero between test files. */
export function resetLogStreamSlotsForTests(): void {
  activeLogStreams = 0
}

const MAX_LOG_LINE_BYTES = 8_192
const MAX_LOG_LINES_PER_SECOND = 2_000

function truncateLine(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= MAX_LOG_LINE_BYTES) return text
  return new TextDecoder().decode(bytes.slice(0, MAX_LOG_LINE_BYTES))
}

/** `docker logs --timestamps` prefixes each line with an RFC3339 stamp and a
 * space; split it back out so the frame carries `at` and `text` separately. */
const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/s

function splitTimestamp(line: string): { at: string | null; text: string } {
  const match = line.match(TIMESTAMP_PREFIX)
  return match?.[1] !== undefined
    ? { at: match[1], text: match[2] ?? '' }
    : { at: null, text: line }
}

/**
 * Wires one already-open `DockerStream` into the SSE body for
 * GET .../containers/{containerId}/logs. Pure with respect to the daemon —
 * takes a `DockerStream`, never spawns one itself — which is what lets
 * docker-logs-stream.test.ts drive it with a fake and assert `close()` fires
 * on cancel without a real `docker logs` process anywhere nearby.
 *
 * No Redis, unlike the operation-events route above: Redis exists in this
 * feature because the *producer* of a docker-op's output is the worker and
 * can be nowhere else (see queue/docker-op.worker.ts). Here the producer is
 * the daemon itself, and any process holding the CLI can attach to it
 * directly — a worker hop would only add latency and a fan-out problem for
 * zero gain.
 */
export function buildContainerLogsStream(
  dockerStream: DockerStream,
  meta: { containerId: string; tail: number; since?: string },
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  let closedByClient = false
  let done = false
  const finish = () => {
    if (done) return
    done = true
    onDone?.()
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let open = true
      const send = (event: string, data: unknown) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          open = false
        }
      }

      send('open', { containerId: meta.containerId, tail: meta.tail, since: meta.since ?? null })

      // Without this, a quiet container (nothing logged for a while) sits on
      // a connection nginx's 300s proxy_read_timeout will eventually drop —
      // silently, on both ends, which is the opposite of "live-updating
      // logs". Same interval /sessions/:id/events and the operation-events
      // route above already use.
      heartbeat = setInterval(() => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          open = false
        }
      }, 20_000)

      let windowStart = Date.now()
      let emittedThisWindow = 0
      let droppedThisWindow = 0

      try {
        for await (const line of dockerStream.lines) {
          const now = Date.now()
          if (now - windowStart >= 1000) {
            if (droppedThisWindow > 0) send('dropped', { lines: droppedThisWindow })
            windowStart = now
            emittedThisWindow = 0
            droppedThisWindow = 0
          }
          if (emittedThisWindow >= MAX_LOG_LINES_PER_SECOND) {
            droppedThisWindow += 1
            continue
          }
          emittedThisWindow += 1
          const { at, text } = splitTimestamp(truncateLine(line.line))
          send('log', { stream: line.stream, at, text })
        }
        if (droppedThisWindow > 0) send('dropped', { lines: droppedThisWindow })

        const exitCode = await dockerStream.exited
        if (closedByClient) send('end', { reason: 'closed', message: null })
        else if (exitCode === 0) send('end', { reason: 'eof', message: null })
        else send('end', { reason: 'exited', message: `docker logs exited with code ${exitCode}` })
      } catch (error) {
        send('end', {
          reason: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        stopHeartbeat()
        // The client has to see EOF, not an open socket nothing will ever
        // write to again — without this, every request hung forever the
        // moment the child exited (verified: on a host with no `docker`
        // binary at all, that is every single request). Guarded because a
        // client-side cancel may have already torn the controller down by
        // the time this runs, and closing twice throws.
        if (open) {
          try {
            controller.close()
          } catch {
            // Already closed or cancelled out from under us.
          }
        }
        open = false
        finish()
      }
    },
    cancel() {
      closedByClient = true
      stopHeartbeat()
      dockerStream.close()
      finish()
    },
  })
}

dockerRouter.get('/projects/:id/docker/containers/:containerId/logs', async (c) => {
  const parsedParams = containerLogsParams.safeParse({
    id: c.req.param('id'),
    containerId: c.req.param('containerId'),
  })
  const parsedQuery = containerLogsQuery.safeParse({
    tail: c.req.query('tail'),
    since: c.req.query('since'),
    sessionId: c.req.query('sessionId'),
  })
  if (!parsedParams.success || !parsedQuery.success) {
    throw validationFailed([
      ...(parsedParams.success ? [] : issuesFor(parsedParams.error)),
      ...(parsedQuery.success ? [] : issuesFor(parsedQuery.error)),
    ])
  }
  const { id, containerId } = parsedParams.data
  const tail = parsedQuery.data.tail ?? 500
  const since = parsedQuery.data.since
  const sessionId = parsedQuery.data.sessionId

  // 404s the same way an unknown project (or an unknown/cross-project
  // session) would, and ALSO 404s a container that exists but isn't ours —
  // never distinguished in the response, so this cannot be used to probe
  // what else is running.
  const owned = await containerBelongsToScope(id, sessionId, containerId)
  if (!owned) throw notFound('Container')

  if (!acquireLogStreamSlot())
    throw tooManyRequests('Too many concurrent log streams; try again shortly')

  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseLogStreamSlot()
  }

  const dockerStream = realDockerCli.stream(logsArgs(containerId, { tail, since }), {})
  const body = buildContainerLogsStream(dockerStream, { containerId, tail, since }, release)

  return new Response(body, { headers: sseHeaders() })
})
