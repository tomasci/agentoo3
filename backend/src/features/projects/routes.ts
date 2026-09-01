import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { AppError } from '@/lib/errors'
import { createProjectSchema, errorSchema, projectSchema, updateProjectSchema } from './schema'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  retryProject,
  updateProject,
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

export const projectsRouter = new OpenAPIHono()

projectsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects',
    tags: ['projects'],
    summary: 'List all projects',
    responses: { 200: json(z.array(projectSchema), 'Projects') },
  }),
  async (c) => c.json(await listProjects(), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects',
    tags: ['projects'],
    summary: 'Create a project from a git remote or an existing directory',
    description:
      'Returns immediately with status "pending"; cloning happens on a worker. ' +
      'Poll the project or watch for status "needs_manual", which carries the ' +
      'commands to run over SSH when a private repo needs authentication.',
    request: { body: json(createProjectSchema, 'Project to create') },
    responses: {
      201: json(projectSchema, 'Created'),
      400: json(errorSchema, 'Invalid input'),
    },
  }),
  async (c) => c.json(await createProject(c.req.valid('json')), 201),
)

projectsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: 'Get one project',
    request: { params: idParam },
    responses: { 200: json(projectSchema, 'Project'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getProject(c.req.valid('param').id), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: "Change a project's remote or SSH key",
    description:
      'For fixing what a failed clone revealed: the repo needed a key, the key ' +
      'was the wrong one, or the remote should have been https. Does not re-run ' +
      'setup; call retry afterwards.',
    request: { params: idParam, body: json(updateProjectSchema, 'Fields to change') },
    responses: {
      200: json(projectSchema, 'Updated'),
      400: json(errorSchema, 'Invalid input'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateProject(c.req.valid('param').id, c.req.valid('json')), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/retry',
    tags: ['projects'],
    summary: 'Re-run setup after resolving something manually',
    description:
      'Backs the "check again, I did the manual steps" button. Re-queues setup; ' +
      'if the repo is now present on disk it is adopted rather than re-cloned.',
    request: { params: idParam },
    responses: {
      200: json(projectSchema, 'Setup re-queued'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'Setup already running'),
    },
  }),
  async (c) => c.json(await retryProject(c.req.valid('param').id), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/projects/{id}',
    tags: ['projects'],
    summary: 'Delete a project',
    description:
      'With removeFiles=true the project directory is deleted, but only for ' +
      'cloned projects — an adopted external directory is never touched.',
    request: {
      params: idParam,
      query: z.object({
        removeFiles: z
          .enum(['true', 'false'])
          .default('false')
          .openapi({ param: { name: 'removeFiles', in: 'query' } }),
      }),
    },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteProject(c.req.valid('param').id, c.req.valid('query').removeFiles === 'true')
    return c.body(null, 204)
  },
)

// Surface AppError's status and recovery commands instead of a bare 500.
projectsRouter.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json(
      {
        error: error.message,
        ...(error.recoveryCommands && { recoveryCommands: error.recoveryCommands }),
      },
      error.status as 400,
    )
  }
  throw error
})
