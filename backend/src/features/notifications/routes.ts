import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { markNotificationsReadSchema, notificationFeedSchema } from './schema'
import { getNotificationFeed, markNotificationsRead } from './service'

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const notificationsRouter = new OpenAPIHono()

notificationsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/notifications',
    tags: ['notifications'],
    summary: "The topbar bell's feed: unchecked session results and pending learning suggestions",
    description:
      'Always 200. Newest first across both sources — see NotificationFeed’s own field ' +
      'descriptions for the tie-break, the 50-item cap, and what `truncated` means. `unread` is ' +
      'computed against the stored read-through watermark; opening the panel is expected to ' +
      'follow up with POST /notifications/read.',
    responses: {
      200: json(notificationFeedSchema, 'Current feed'),
    },
  }),
  async (c) => c.json(await getNotificationFeed(), 200),
)

notificationsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/notifications/read',
    tags: ['notifications'],
    summary: 'Advance the read-through watermark',
    description:
      'Send the `at` of the newest item the client displayed, not whatever GET /notifications ' +
      'reports right now — the server clamps it to the feed’s actual newest item, so a future ' +
      'or stale value can never move the watermark past what genuinely exists, and an older value ' +
      'never moves it backwards. Idempotent, and system-wide: there is no per-user state in this ' +
      'app. This never sets a session’s seenAt or changes a suggestion’s status — seeing the ' +
      'notification is not the same as checking the result.',
    request: {
      body: {
        // required: true, like whats-new/routes.ts's identical POST body —
        // without it a request with no body never reaches
        // markNotificationsReadSchema's own validation at all.
        content: { 'application/json': { schema: markNotificationsReadSchema } },
        description: 'The newest item already seen',
        required: true,
      },
    },
    responses: {
      200: json(notificationFeedSchema, 'Feed after the write, recomputed'),
      400: json(errorSchema, 'Missing body, or upTo is not an RFC 3339 datetime'),
    },
  }),
  async (c) => c.json(await markNotificationsRead(c.req.valid('json')), 200),
)
