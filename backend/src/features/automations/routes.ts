// Project automations' HTTP surface — see backend/README.md's "Automations"
// section for the feature as a whole, and features/automations/scheduler.ts
// for the worker-side sweep that actually fires these on schedule. This file
// is only the route/schema/service wiring, the same split every other
// feature here already follows (compare features/ideas/routes.ts).

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { AppError, errorBody } from '@/lib/errors'
import {
  automationRunSchema,
  automationSchema,
  createAutomationSchema,
  listAutomationRunsQuerySchema,
  schedulePreviewRequestSchema,
  schedulePreviewSchema,
  updateAutomationSchema,
} from './schema'
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  schedulePreview,
  updateAutomation,
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

export const automationsRouter = new OpenAPIHono()

// Same reasoning as projectsRouter.onError (features/projects/routes.ts):
// needed so this router's own tests (which exercise it directly, not
// through the full app) see the real status rather than Hono's generic 500
// for an uncaught throw. errorBody is shared with app.ts's onError so the
// two never format an AppError differently depending on which one catches
// it.
automationsRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

// --- automations: CRUD --------------------------------------------------------

automationsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/automations',
    tags: ['automations'],
    summary: "List a project's automations",
    request: { params: idParam },
    responses: {
      200: json(z.array(automationSchema), 'Automations, oldest first'),
      404: json(errorSchema, 'Project not found'),
    },
  }),
  async (c) => c.json(await listAutomations(c.req.valid('param').id), 200),
)

automationsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/automations',
    tags: ['automations'],
    summary: 'Create an automation',
    description:
      'next_run_at is set to the first occurrence strictly after now, or left null if created ' +
      'paused.',
    request: { params: idParam, body: json(createAutomationSchema, 'Automation to create') },
    responses: {
      201: json(automationSchema, 'Created'),
      400: json(errorSchema, 'Invalid input, including an unschedulable cron'),
      404: json(errorSchema, 'Project not found'),
    },
  }),
  async (c) => c.json(await createAutomation(c.req.valid('param').id, c.req.valid('json')), 201),
)

automationsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/automations/{id}',
    tags: ['automations'],
    summary: 'Get one automation',
    request: { params: idParam },
    responses: { 200: json(automationSchema, 'Automation'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => c.json(await getAutomation(c.req.valid('param').id), 200),
)

automationsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/automations/{id}',
    tags: ['automations'],
    summary: 'Update an automation',
    description:
      'Every field is independently optional. Editing name/prompt/orchestrator/baseBranch/' +
      'maxBudgetUsd takes effect on the next run, with no change to the schedule; editing cron, ' +
      'timezone, or resuming a paused automation recomputes next_run_at from now (never ' +
      'back-filling occurrences missed while paused); pausing clears next_run_at to null.',
    request: { params: idParam, body: json(updateAutomationSchema, 'Fields to change') },
    responses: {
      200: json(automationSchema, 'Updated'),
      400: json(errorSchema, 'Invalid input, including an unschedulable cron'),
      404: json(errorSchema, 'Not found'),
    },
  }),
  async (c) => c.json(await updateAutomation(c.req.valid('param').id, c.req.valid('json')), 200),
)

automationsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/automations/{id}',
    tags: ['automations'],
    summary: 'Delete an automation',
    description:
      'Stops all future runs. Past automation_runs rows are deleted with it, but the sessions ' +
      "they created are not — they are the user's own work.",
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteAutomation(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

// --- runs: read-only here — created and closed by the scheduler -------------

automationsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/automations/{id}/runs',
    tags: ['automations'],
    summary: "List an automation's runs, newest first",
    request: { params: idParam, query: listAutomationRunsQuerySchema },
    responses: {
      200: json(z.array(automationRunSchema), 'Runs, newest scheduled occurrence first'),
      404: json(errorSchema, 'Automation not found'),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    return c.json(await listAutomationRuns(id, limit), 200)
  },
)

// --- schedule preview ---------------------------------------------------------

automationsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/automations/schedule-preview',
    tags: ['automations'],
    summary: 'Preview the next occurrences of a cron schedule',
    description:
      'Never a 400 for a bad cron — the UI calls this live while the operator is still typing, ' +
      'so an unschedulable expression is an ordinary 200 with valid: false and a reason. 400 is ' +
      'reserved for a malformed request body.',
    request: { body: json(schedulePreviewRequestSchema, 'Cron, timezone and how many to preview') },
    responses: {
      200: json(schedulePreviewSchema, 'Validity and the next occurrences (ISO), if valid'),
      400: json(errorSchema, 'Malformed request body'),
    },
  }),
  (c) => c.json(schedulePreview(c.req.valid('json')), 200),
)
