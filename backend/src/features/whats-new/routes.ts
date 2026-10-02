import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { dismissWhatsNewSchema, whatsNewStateSchema } from './schema'
import { dismissWhatsNew, getWhatsNewState } from './service'

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const whatsNewRouter = new OpenAPIHono()

whatsNewRouter.openapi(
  createRoute({
    method: 'get',
    path: '/whats-new',
    tags: ['whats-new'],
    summary: "Whether the 'Update installed' screen should show, and for which install",
    description:
      'Always 200. `pending` is true exactly when the most recently recorded install has not ' +
      'been dismissed yet — see POST /whats-new/dismiss. A box whose installer has never run ' +
      '(e.g. the docker dev stack) reports every field null/false, not an error.',
    responses: {
      200: json(whatsNewStateSchema, 'Current state'),
    },
  }),
  async (c) => c.json(await getWhatsNewState(), 200),
)

whatsNewRouter.openapi(
  createRoute({
    method: 'post',
    path: '/whats-new/dismiss',
    tags: ['whats-new'],
    summary: 'Close the screen for one install',
    description:
      'Send the `installedAt` the client actually displayed, not whatever GET /whats-new ' +
      'reports right now — storing it as-is (rather than clamping it to the current install) ' +
      'is what keeps a dismiss that races a newer install from swallowing that newer one. The ' +
      'close state is system-wide: every browser sees the screen gone, not just the one that ' +
      'closed it.',
    request: {
      body: {
        // required: true, unlike the `json()` helper above — see
        // system/routes.ts's identical PATCH /system/settings body for why:
        // without it, a request with no body (or a non-JSON content-type)
        // never reaches dismissWhatsNewSchema's own validation at all, and
        // dismissWhatsNew would be called with installedAt === undefined
        // instead of this ever 400ing.
        content: { 'application/json': { schema: dismissWhatsNewSchema } },
        description: 'The installedAt the client displayed',
        required: true,
      },
    },
    responses: {
      200: json(whatsNewStateSchema, 'State after the dismissal, freshly re-read'),
      400: json(errorSchema, 'Missing body, or installedAt is not an ISO-8601 datetime'),
    },
  }),
  async (c) => c.json(await dismissWhatsNew(c.req.valid('json')), 200),
)
