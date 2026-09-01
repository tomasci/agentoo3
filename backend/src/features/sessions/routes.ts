import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { subscribeSession } from '@/lib/events'
import {
  createSessionSchema,
  sendMessageSchema,
  sessionMessageSchema,
  sessionSchema,
  updateSessionSchema,
} from './schema'
import {
  createSession,
  deleteSession,
  getSession,
  interruptSession,
  listMessages,
  listSessions,
  sendMessage,
  updateSession,
} from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const sessionsRouter = new OpenAPIHono()

sessionsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/sessions',
    tags: ['sessions'],
    summary: "List a project's sessions",
    request: { params: idParam },
    responses: {
      200: json(z.array(sessionSchema), 'Sessions'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await listSessions(c.req.valid('param').id), 200),
)

sessionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/sessions',
    tags: ['sessions'],
    summary: 'Start a session on its own git worktree',
    description:
      'Each session gets a worktree on branch agentoo/s-<id>, so two sessions can ' +
      'run against the same project without fighting over the working tree. A ' +
      'project that is not a git repository, or has no commits yet, cannot have ' +
      'worktrees — those sessions share the checkout and report isolated=false.',
    request: { params: idParam, body: json(createSessionSchema, 'Session to create') },
    responses: {
      201: json(sessionSchema, 'Created'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Project is not ready'),
    },
  }),
  async (c) => c.json(await createSession(c.req.valid('param').id, c.req.valid('json')), 201),
)

sessionsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Get one session',
    request: { params: idParam },
    responses: { 200: json(sessionSchema, 'Session'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getSession(c.req.valid('param').id), 200),
)

sessionsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Rename a session or change its orchestrator and budget',
    request: { params: idParam, body: json(updateSessionSchema, 'Fields to change') },
    responses: {
      200: json(sessionSchema, 'Updated'),
      400: json(errorSchema, 'Invalid input'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateSession(c.req.valid('param').id, c.req.valid('json')), 200),
)

sessionsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/sessions/{id}',
    tags: ['sessions'],
    summary: 'Delete a session and remove its worktree',
    description:
      'The branch is kept: it holds whatever the session did, and deleting a ' +
      'session should not silently discard work.',
    request: { params: idParam },
    responses: {
      204: { description: 'Deleted' },
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Session is running'),
    },
  }),
  async (c) => {
    await deleteSession(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

sessionsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/sessions/{id}/messages',
    tags: ['sessions'],
    summary: 'Read a session transcript',
    description:
      'Ordered by seq. Pass `after` to fetch only what followed a message you ' +
      'already have, which is how a reconnecting stream catches up.',
    request: {
      params: idParam,
      query: z.object({
        after: z.coerce
          .number()
          .int()
          .min(-1)
          .optional()
          .openapi({ param: { name: 'after', in: 'query' } }),
      }),
    },
    responses: {
      200: json(z.array(sessionMessageSchema), 'Messages'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => {
    const { after } = c.req.valid('query')
    return c.json(await listMessages(c.req.valid('param').id, after ?? -1), 200)
  },
)

sessionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/messages',
    tags: ['sessions'],
    summary: 'Send a message to a session',
    description:
      'Always accepted. If a turn is already running the message waits behind ' +
      'it and is picked up as soon as that turn finishes.',
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: sendMessageSchema } }, required: true },
    },
    responses: {
      201: json(sessionMessageSchema, 'Accepted'),
      400: json(errorSchema, 'No orchestrator'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Project is not ready'),
    },
  }),
  async (c) => {
    const { text } = c.req.valid('json')
    return c.json(await sendMessage(c.req.valid('param').id, text), 201)
  },
)

sessionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/interrupt',
    tags: ['sessions'],
    summary: 'Stop the running turn',
    request: { params: idParam },
    responses: {
      200: json(sessionSchema, 'Interrupt requested'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Session is not running'),
    },
  }),
  async (c) => c.json(await interruptSession(c.req.valid('param').id), 200),
)

/**
 * Live transcript.
 *
 * Registered outside the OpenAPI router: the generated client is typed for JSON
 * bodies, and an event stream is neither JSON nor something the frontend should
 * reach through a generated hook. The browser opens it with EventSource.
 *
 * Reconnection is the client's job and costs nothing: it passes the last seq it
 * saw as `after`, and the replay below closes the gap before live events start.
 */
sessionsRouter.get('/sessions/:id/events', async (c) => {
  const id = c.req.param('id')
  const after = Number(c.req.query('after') ?? -1)

  // Fails with 404 before any stream headers go out, so a bad id is an ordinary
  // error rather than an immediately-closed stream.
  const backlog = await listMessages(id, Number.isFinite(after) ? after : -1)

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
          // The client went away between our check and the write.
          open = false
        }
      }

      // Flush something immediately. Headers do not reach the client until the
      // first byte of the body, so a session with nothing to replay would
      // otherwise leave EventSource waiting for the first heartbeat before it
      // even fires onopen — and an idle-timeout may close it first. `retry`
      // also sets how long the browser waits before reconnecting.
      controller.enqueue(encoder.encode('retry: 3000\n: connected\n\n'))

      for (const message of backlog) send('message', { kind: 'message', message })

      unsubscribe = subscribeSession(id, (event) => send(event.kind, event))

      // Well inside the installer's proxy_read_timeout (300s, and
      // proxy_buffering is off), so an idle session is never dropped for being
      // quiet.
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

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx would otherwise buffer the whole stream and deliver nothing.
      'X-Accel-Buffering': 'no',
    },
  })
})
