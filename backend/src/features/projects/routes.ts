import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { AppError, errorBody } from '@/lib/errors'
import {
  createProjectSchema,
  errorSchema,
  gitIdentityInputSchema,
  gitIdentityStateSchema,
  projectSchema,
  updateProjectSchema,
} from './schema'
import {
  clearGitIdentity,
  createProject,
  deleteProject,
  getGitIdentity,
  getProject,
  listProjects,
  retryProject,
  setGitIdentity,
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
    summary: "Change a project's remote, SSH key or default branch",
    description:
      'For fixing what a failed clone revealed: the repo needed a key, the key ' +
      'was the wrong one, or the remote should have been https. Also sets the ' +
      'branch new session worktrees are cut from; that branch is only checked for ' +
      'existence when a session actually starts, not here. Does not re-run setup; ' +
      'call retry afterwards.',
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

projectsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/git-identity',
    operationId: 'getProjectGitIdentity',
    tags: ['projects'],
    summary: "A project's git commit identity",
    description:
      "Reads straight off the project repo's own `.git/config` — there is no database copy. " +
      '`available: false` (every other field null) when the project is not yet ready or its repo ' +
      "is missing on disk; this is never a 500. `local` is only what this repository's own " +
      'config holds, exactly what a hand edit of .git/config already shows; `effective` is what a ' +
      'commit made here right now would actually carry once global/system config is also in play.',
    request: { params: idParam },
    responses: {
      200: json(gitIdentityStateSchema, 'Current identity state'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await getGitIdentity(c.req.valid('param').id), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'put',
    path: '/projects/{id}/git-identity',
    operationId: 'putProjectGitIdentity',
    tags: ['projects'],
    summary: "Set a project's git commit identity",
    description:
      "Writes user.name/user.email into the project repo's own `.git/config` (`--local`, never " +
      'the global config), so every worktree, the editor and a human over ssh all pick it up. ' +
      'Collapses a hand-edited, multi-valued key back to one line.',
    request: { params: idParam, body: json(gitIdentityInputSchema, 'Name and email to set') },
    responses: {
      200: json(gitIdentityStateSchema, 'Saved'),
      400: json(errorSchema, 'Invalid input'),
      404: json(errorSchema, 'Not found'),
      409: json(
        errorSchema,
        'The project is not ready (or its repo is missing), or the config file is locked by ' +
          'another process — the message says which, and a lock is safe to retry.',
      ),
    },
  }),
  async (c) => c.json(await setGitIdentity(c.req.valid('param').id, c.req.valid('json')), 200),
)

projectsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/projects/{id}/git-identity',
    operationId: 'deleteProjectGitIdentity',
    tags: ['projects'],
    summary: "Clear a project's git commit identity",
    description:
      'Idempotent: clearing an identity that is already unset is still a 200. Once cleared, a ' +
      'commit in this project falls back to whatever the global config supplies, or fails with ' +
      '"Author identity unknown" if it supplies nothing either.',
    request: { params: idParam },
    responses: {
      200: json(gitIdentityStateSchema, 'Cleared'),
      404: json(errorSchema, 'Not found'),
      409: json(
        errorSchema,
        'The project is not ready (or its repo is missing), or the config file is locked by ' +
          'another process — the message says which, and a lock is safe to retry.',
      ),
    },
  }),
  async (c) => c.json(await clearGitIdentity(c.req.valid('param').id), 200),
)

// Surface AppError's status and recovery commands instead of a bare 500 —
// needed so this router's own tests (which exercise it directly, not through
// the full app) see the real status rather than Hono's generic 500 for an
// uncaught throw. errorBody is shared with app.ts's onError so the two never
// format an AppError differently depending on which one happens to catch it.
projectsRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})
