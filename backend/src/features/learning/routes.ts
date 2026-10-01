// The learning job's review surface: the schedule and run history
// (/library/learning), the suggestion queue a human decides over
// (/library/suggestions), and the version history an applied suggestion
// produces (/library/{agents,skills}/{name}/versions). Mounted on /library
// rather than its own prefix — this is a view over the library, the same
// reasoning features/library/routes.ts's own project-assignment endpoints
// already follow for living on /projects/{id}/library instead of /library.

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { createLearningRun, getLearningOverview } from './runs'
import {
  applySuggestionSchema,
  learningOverviewSchema,
  learningRunSchema,
  libraryItemVersionSchema,
  librarySuggestionSchema,
  librarySuggestionSummarySchema,
  listSuggestionsQuerySchema,
} from './schema'
import {
  applySuggestion,
  deleteRejectedSuggestion,
  getSuggestion,
  listSuggestions,
  rejectSuggestion,
} from './suggestions'
import { listVersions } from './versions'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const nameParam = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'name', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const learningRouter = new OpenAPIHono()

// --- schedule and run history -------------------------------------------------

learningRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/learning',
    tags: ['learning'],
    summary: 'The learning schedule and recent run history',
    description:
      'activeRun is non-null exactly while a run is queued or running; lastRun is the most ' +
      'recently finished one (completed or failed); recentRuns is up to the 10 most recent, ' +
      'newest first.',
    responses: {
      200: json(learningOverviewSchema, 'Schedule and run history'),
    },
  }),
  async (c) => c.json(await getLearningOverview(), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'post',
    path: '/library/learning/runs',
    tags: ['learning'],
    summary: 'Run the learning job now',
    description:
      'Starts a manual run with a 24h window ending now, as a job on the same queue a session ' +
      'turn runs on (so it waits behind running sessions rather than bypassing them). 409s if a ' +
      'run is already queued or running — at most one may be active at a time.',
    responses: {
      202: json(learningRunSchema, 'Started'),
      409: json(errorSchema, 'A run is already queued or running'),
    },
  }),
  async (c) => {
    const result = await createLearningRun({ trigger: 'manual', windowEnd: new Date() })
    if ('conflict' in result) {
      return c.json(
        { error: `A learning run is already ${result.conflict.status} (${result.conflict.id})` },
        409,
      )
    }
    return c.json(result.run, 202)
  },
)

// --- suggestions ---------------------------------------------------------

learningRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/suggestions',
    tags: ['learning'],
    summary: 'List suggestions by status',
    request: { query: listSuggestionsQuerySchema },
    responses: {
      200: json(z.array(librarySuggestionSummarySchema), 'Suggestions, newest first'),
    },
  }),
  async (c) => c.json(await listSuggestions(c.req.valid('query').status), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/suggestions/{id}',
    tags: ['learning'],
    summary: 'Get one suggestion, proposed markdown and current target state included',
    request: { params: idParam },
    responses: {
      200: json(librarySuggestionSchema, 'Suggestion'),
      404: json(errorSchema, 'Unknown suggestion'),
    },
  }),
  async (c) => c.json(await getSuggestion(c.req.valid('param').id), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'post',
    path: '/library/suggestions/{id}/apply',
    tags: ['learning'],
    summary: 'Apply a pending suggestion',
    description:
      "For 'modify', expectedCurrentHash must match the live target's current hash — a mismatch " +
      'means the item changed since this was reviewed, and is a 409 rather than silently ' +
      "overwriting it. For 'create', it is ignored.",
    request: { params: idParam, body: json(applySuggestionSchema, 'The hash last reviewed') },
    responses: {
      200: json(librarySuggestionSchema, 'Applied'),
      400: json(errorSchema, 'The proposed body no longer validates'),
      404: json(errorSchema, 'Unknown suggestion'),
      409: json(
        errorSchema,
        'Not pending, the modify target no longer exists, the create name is taken, or the hash is stale',
      ),
    },
  }),
  async (c) => c.json(await applySuggestion(c.req.valid('param').id, c.req.valid('json')), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'post',
    path: '/library/suggestions/{id}/reject',
    tags: ['learning'],
    summary: 'Reject a pending suggestion',
    description:
      'Kept, not deleted — a rejected suggestion stays visible under ?status=rejected so the job ' +
      'never proposes it again, until it is explicitly deleted below.',
    request: { params: idParam },
    responses: {
      200: json(librarySuggestionSchema, 'Rejected'),
      404: json(errorSchema, 'Unknown suggestion'),
      409: json(errorSchema, 'Not pending'),
    },
  }),
  async (c) => c.json(await rejectSuggestion(c.req.valid('param').id), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/library/suggestions/{id}',
    tags: ['learning'],
    summary: 'Permanently delete a rejected suggestion',
    description:
      'Only a rejected suggestion can be deleted — this is what frees the job to propose it again.',
    request: { params: idParam },
    responses: {
      204: { description: 'Deleted' },
      404: json(errorSchema, 'Unknown suggestion'),
      409: json(errorSchema, 'Not rejected'),
    },
  }),
  async (c) => {
    await deleteRejectedSuggestion(c.req.valid('param').id)
    return c.body(null, 204)
  },
)

// --- version history -------------------------------------------------------
//
// A sibling path on the same resource, mounted from this router rather than
// features/library/routes.ts: /library/agents/{name} and
// /library/skills/{name} already exist there, and `.../versions` is a
// distinct full path (one extra segment), so there is nothing to register
// here beyond "this belongs to the learning feature, not the library CRUD
// one" — see this file's own header for why the split is feature-owned
// rather than resource-owned.

learningRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/agents/{name}/versions',
    tags: ['learning'],
    summary: 'Version history for one agent',
    request: { params: nameParam },
    responses: {
      200: json(z.array(libraryItemVersionSchema), 'Versions, newest first'),
    },
  }),
  async (c) => c.json(await listVersions('agent', c.req.valid('param').name), 200),
)

learningRouter.openapi(
  createRoute({
    method: 'get',
    path: '/library/skills/{name}/versions',
    tags: ['learning'],
    summary: 'Version history for one skill',
    request: { params: nameParam },
    responses: {
      200: json(z.array(libraryItemVersionSchema), 'Versions, newest first'),
    },
  }),
  async (c) => c.json(await listVersions('skill', c.req.valid('param').name), 200),
)
