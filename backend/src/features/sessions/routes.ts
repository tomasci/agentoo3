import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { createSessionSchema, sessionSchema, updateSessionSchema } from './schema'
import { createSession, deleteSession, getSession, listSessions, updateSession } from './service'

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
