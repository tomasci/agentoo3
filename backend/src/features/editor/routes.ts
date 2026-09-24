import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { AppError, errorBody } from '@/lib/errors'
import { editorStatusSchema, runningEditorsSchema } from './schema'
import {
  getEditorStatus,
  listRunningEditors,
  requestEditorStart,
  requestEditorStop,
} from './service'

const params = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
  sessionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'sessionId', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const editorRouter = new OpenAPIHono()

// Same reason dockerRouter/projectsRouter/sessionsRouter each give their own:
// lets this router's own tests exercise it directly (mounted stand-alone) and
// still see AppError's real status instead of Hono's generic 500.
editorRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

editorRouter.openapi(
  createRoute({
    method: 'get',
    path: '/editors',
    tags: ['editor'],
    summary: 'Every editor container currently holding the running cap',
    description:
      'Always 200 — a disabled feature (`enabled: false`) and an unreachable docker daemon both ' +
      'answer with every count at zero, the same "not a server fault" discipline GET .../editor ' +
      "follows. `editors` lists only THIS install's own running containers whose session still " +
      'resolves, sorted idle first, then unresponsive, then in-use; `otherInstallsRunning` is the ' +
      "box-wide `running` total minus this install's own, never broken out by name. Meant for the " +
      'moment a start is refused at the cap, so a user can see who is holding it.',
    responses: {
      200: json(
        runningEditorsSchema,
        'The running-cap slots, and who (of this install) holds them',
      ),
    },
  }),
  async (c) => c.json(await listRunningEditors(), 200),
)

const statusResponses = {
  200: json(editorStatusSchema, "The session's editor status"),
  400: json(errorSchema, 'This session shares the project checkout; it has no worktree of its own'),
  404: json(errorSchema, 'Not found (project, or the named session)'),
  409: json(errorSchema, "The session's worktree is no longer on disk"),
}

editorRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/sessions/{sessionId}/editor',
    tags: ['editor'],
    summary: "A session's code-server status",
    description:
      'Answers 200 even when the feature is disabled (`enabled: false`) — a disabled feature is a ' +
      'legitimate state to report, not a server fault. `proxyPath` is the iframe src; load it only ' +
      'once `state` is `running` or `unresponsive`.',
    request: { params },
    responses: statusResponses,
  }),
  async (c) => {
    const { id, sessionId } = c.req.valid('param')
    return c.json(await getEditorStatus(id, sessionId), 200)
  },
)

const mutationResponses = {
  ...statusResponses,
  403: json(errorSchema, 'The editor is disabled (DOCKER_ENABLED or EDITOR_ENABLED is false)'),
  503: json(errorSchema, 'docker (or the daemon) is unavailable'),
}

editorRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/sessions/{sessionId}/editor/start',
    tags: ['editor'],
    summary: 'Start (or report the status of) this session code-server container',
    description:
      'Always 202 with the current status: already running and healthy, a start already in ' +
      'flight, or a freshly queued one. The mutation itself runs on the editor-op worker; poll ' +
      'GET .../editor for progress. 409 also covers EDITOR_MAX_RUNNING being reached.',
    request: { params },
    responses: {
      202: json(editorStatusSchema, 'Queued, already starting, or already running'),
      400: mutationResponses[400],
      403: mutationResponses[403],
      404: mutationResponses[404],
      409: json(
        errorSchema,
        "The session's worktree is no longer on disk, or EDITOR_MAX_RUNNING is reached",
      ),
      503: mutationResponses[503],
    },
  }),
  async (c) => {
    const { id, sessionId } = c.req.valid('param')
    return c.json(await requestEditorStart(id, sessionId), 202)
  },
)

editorRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/sessions/{sessionId}/editor/stop',
    tags: ['editor'],
    summary: 'Stop (docker rm -f) this session code-server container',
    description: 'Idempotent: stopping an already-stopped (or never-started) editor is still 200.',
    request: { params },
    responses: {
      200: json(editorStatusSchema, 'Stopped'),
      400: mutationResponses[400],
      403: mutationResponses[403],
      404: mutationResponses[404],
      409: json(errorSchema, "The session's worktree is gone, or a start is already in progress"),
      503: mutationResponses[503],
    },
  }),
  async (c) => {
    const { id, sessionId } = c.req.valid('param')
    return c.json(await requestEditorStop(id, sessionId), 200)
  },
)
