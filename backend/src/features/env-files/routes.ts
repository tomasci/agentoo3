import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { AppError, errorBody } from '@/lib/errors'
import { envFilePathSchema, envFileSchema, envFilesListSchema, putEnvFileSchema } from './schema'
import { deleteEnvFile, listEnvFiles, putEnvFile } from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const pathQuery = z.object({
  path: envFilePathSchema.openapi({
    param: { name: 'path', in: 'query' },
    description: 'Store-relative path of the file to delete, e.g. "server/.env"',
  }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const envFilesRouter = new OpenAPIHono()

// Same reason projectsRouter/dockerRouter both give their own: lets this
// router's own tests exercise it directly (mounted stand-alone, not under the
// full app) and still see AppError's real status and recovery commands
// instead of Hono's generic 500 for an uncaught throw.
envFilesRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

envFilesRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/env-files',
    operationId: 'listProjectEnvFiles',
    tags: ['env-files'],
    summary: "A project's stored env files",
    description:
      'Copied into every *new* session worktree, at the same relative paths, the moment the ' +
      'worktree is created — not synced into one already running. A project with no files yet ' +
      '(no env/ directory on disk) answers with an empty list, not an error. Sorted by path.',
    request: { params: idParam },
    responses: {
      200: json(envFilesListSchema, 'Stored env files, sorted by path'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json({ files: await listEnvFiles(c.req.valid('param').id) }, 200),
)

envFilesRouter.openapi(
  createRoute({
    method: 'put',
    path: '/projects/{id}/env-files',
    operationId: 'putProjectEnvFile',
    tags: ['env-files'],
    summary: 'Create or overwrite one stored env file',
    description:
      'Creates parent directories inside the store as needed — saving "server/.env" for the ' +
      'first time is what creates the "server/" structure. The basename must look like an env ' +
      'file ( ".env", ".env.<suffix>" or "<name>.env" ); content is capped at 64 KiB and may not ' +
      'contain a NUL byte. Refused once a project already has 100 stored files.',
    request: { params: idParam, body: json(putEnvFileSchema, 'Path and content to store') },
    responses: {
      200: json(envFileSchema, 'Saved'),
      400: json(errorSchema, 'Invalid path or content'),
      404: json(errorSchema, 'Not found'),
      409: json(errorSchema, 'This project already has the maximum number of stored env files'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await putEnvFile(id, c.req.valid('json')), 200)
  },
)

envFilesRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/projects/{id}/env-files',
    operationId: 'deleteProjectEnvFile',
    tags: ['env-files'],
    summary: 'Delete one stored env file',
    description:
      'Also removes now-empty parent directories inside the store (e.g. deleting the only file ' +
      'under "server/" removes "server/" too) — never the store root itself.',
    request: { params: idParam, query: pathQuery },
    responses: {
      204: { description: 'Deleted' },
      400: json(errorSchema, 'Invalid path'),
      404: json(errorSchema, 'Not found (project, or no file stored at that path)'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { path } = c.req.valid('query')
    await deleteEnvFile(id, path)
    return c.body(null, 204)
  },
)
