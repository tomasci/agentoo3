import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { badRequest } from '@/lib/errors'
import { subscribeSession } from '@/lib/events'
import {
  createSessionSchema,
  messagePageSchema,
  sendMessageSchema,
  sessionMessageSchema,
  sessionSchema,
  updateSessionSchema,
} from './schema'
import {
  createSession,
  deleteSession,
  exportSession,
  getSession,
  interruptSession,
  listMessagePage,
  listMessages,
  listSessions,
  sendMessage,
  sessionExportFileName,
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
      'worktrees — those sessions share the checkout and report isolated=false. ' +
      'The worktree is cut from baseBranch, or the project default branch, or ' +
      "the checkout's current branch, in that order; whichever one is used is " +
      'fetched from the remote first. If that branch does not exist locally or ' +
      'on the remote at all, the request 400s before a session is created — a ' +
      'network hiccup while updating it is not fatal and just gets noted on the ' +
      'session (baseNote), but a branch that resolves to nothing is.',
    request: { params: idParam, body: json(createSessionSchema, 'Session to create') },
    responses: {
      201: json(sessionSchema, 'Created'),
      400: json(errorSchema, 'baseBranch does not exist locally or on the remote'),
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
    summary: 'Read a session transcript, a page at a time',
    description:
      'Always ascending by seq, in every mode, so a client never has to re-sort ' +
      'what it gets back regardless of which cursor it used. Three modes, chosen ' +
      'by which of `after`/`before`/`limit` are present:\n\n' +
      '`after` (or neither cursor and no `limit`): forward and unbounded — ' +
      'everything with seq > after. This is unchanged from before pagination ' +
      'existed, and is how a reconnecting client catches up on what it already ' +
      'has a prefix of. `limit` does not apply to it; omitting both cursors and ' +
      '`limit` returns the whole transcript, exactly as this endpoint always ' +
      'has.\n\n' +
      '`before`: a backward page anchored on a seq you already have — the ' +
      '`limit` messages immediately older than it (seq < before), for a ' +
      'scrollback UI paging up through history it has partly loaded.\n\n' +
      '`limit` alone, with neither cursor: the newest `limit` messages. This is ' +
      'the initial-load case — opening a session has no seq to anchor on yet, ' +
      'only how many messages it wants, so it cannot use `before`, and ' +
      'unbounded `after` would defeat the point of paginating at all.\n\n' +
      '`before` defaults `limit` to 100, and so does `limit` alone — both are ' +
      'the bounded modes. `after` and `before` point in opposite directions on ' +
      'one cursor, so sending both is a 400 rather than a guess at which one ' +
      'wins. `hasOlder` says whether messages older than this page still exist ' +
      '— computed honestly for both bounded modes by asking for one extra row ' +
      'past `limit` rather than a separate, and separately racy, COUNT(*) — and ' +
      'always false for the unbounded `after` response, since nothing was held ' +
      'back there for it to report on.',
    request: {
      params: idParam,
      query: z.object({
        after: z.coerce
          .number()
          .int()
          .min(-1)
          .optional()
          .openapi({
            param: { name: 'after', in: 'query' },
            description:
              'Exclusive; forward, ascending and unbounded. Cannot be combined with before.',
          }),
        before: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .openapi({
            param: { name: 'before', in: 'query' },
            description:
              'Exclusive; backward page of up to `limit` messages, still returned ascending. ' +
              'Cannot be combined with after.',
          }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .openapi({
            param: { name: 'limit', in: 'query' },
            description:
              'Page size for a bounded backward page. With before, defaults to 100. Alone, with ' +
              'neither cursor, it means the newest `limit` messages — the initial-load case, when ' +
              'there is no seq yet to pass as before. Ignored when after is set.',
          }),
      }),
    },
    responses: {
      200: json(messagePageSchema, 'A page of messages, always ascending by seq'),
      400: json(errorSchema, 'after and before were both set'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => {
    const { after, before, limit } = c.req.valid('query')
    return c.json(await listMessagePage(c.req.valid('param').id, { after, before, limit }), 200)
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
 * Download the full transcript as a JSON file.
 *
 * Registered outside the OpenAPI router, like /events: this is a download, not
 * a data fetch — the browser navigates to it and the server names the file. A
 * generated react-query hook would be dead code that pulls a multi-megabyte
 * transcript into a cache nobody invalidates, and the generated axios client
 * neither preserves nor exposes Content-Disposition, so the spec would
 * describe the payload while hiding the part that makes it a file.
 *
 * No query parameters: export means the whole transcript. The id is validated
 * here (the openapi router normally does that) so a malformed id 400s before
 * any body bytes go out, same as an unknown id 404s via getSession.
 *
 * Excluding worktreePath does not make this file safe to hand out freely —
 * payloads are verbatim and contain absolute paths, bash commands and file
 * contents the agent read. Redacting that would be lossy and unverifiable,
 * and defeats the point of exporting a complete transcript.
 */
sessionsRouter.get('/sessions/:id/export', async (c) => {
  const parsed = z.string().uuid().safeParse(c.req.param('id'))
  if (!parsed.success) throw badRequest('Invalid session id')

  const doc = await exportSession(parsed.data)
  return c.body(JSON.stringify(doc, null, 2), 200, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Disposition': `attachment; filename="${sessionExportFileName(doc.session)}"`,
    'Cache-Control': 'no-store',
  })
})

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
