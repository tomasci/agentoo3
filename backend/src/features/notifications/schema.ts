// The topbar bell's own wire shapes. There is no notifications table: an
// item in the feed is either an unchecked session result (see uncheckedSql in
// features/sessions/service.ts) or a pending library_suggestions row — both
// already exist for other reasons, and this feature only merges, sorts and
// caps them. The one thing that is actually new is a single read watermark,
// stored in system_settings under NOTIFICATIONS_READ_THROUGH_KEY (see
// service.ts and backend/README.md's own "Notifications" section for why a
// watermark rather than per-item read tracking).
//
// `z` comes from `@hono/zod-openapi`, the same reason whats-new/schema.ts's
// own header gives for its import: routes.ts patches `.openapi()` onto z's
// prototype as a side effect of importing OpenAPIHono first, and this module
// has no control over whether that has already happened by the time it runs.
import { z } from '@hono/zod-openapi'
import {
  librarySuggestionActionSchema,
  librarySuggestionKindSchema,
} from '@/features/learning/schema'
import { sessionStatusSchema } from '@/features/sessions/schema'

export const NOTIFICATIONS_READ_THROUGH_KEY = 'notifications_read_through'

/** Both source lists are fetched with this + 1 and the merged result is
 * capped to this many — see collectFeed in service.ts. */
export const NOTIFICATIONS_LIMIT = 50

/**
 * Written by POST /notifications/read, read back by every GET — see
 * service.ts's readStoredReadThrough, which mirrors whats-new/service.ts's
 * own readSetting: a missing or malformed row is treated as absent (nothing
 * read yet), never as an error.
 */
export const storedReadThroughSchema = z.object({
  readThrough: z.iso.datetime().openapi({
    description:
      'UTC, Date.toISOString() of the watermark — compared against each item’s own `at` in ' +
      'JS at millisecond precision, never in SQL (see service.ts for why).',
  }),
})
export type StoredReadThrough = z.infer<typeof storedReadThroughSchema>

const common = {
  id: z.string().uuid().openapi({ description: 'The underlying session or suggestion id' }),
  at: z.iso.datetime().openapi({
    description:
      "A session item's settledAt, or a suggestion item's createdAt — what the feed sorts on.",
  }),
  unread: z.boolean().openapi({
    description: 'at is strictly newer than the stored read-through watermark',
  }),
}

export const sessionNotificationItemSchema = z
  .object({
    source: z.literal('session').openapi({ description: 'An unchecked session result' }),
    ...common,
    projectId: z.string().uuid(),
    projectName: z.string(),
    title: z.string().nullable(),
    status: sessionStatusSchema.openapi({
      description:
        "The full session status, on purpose — a settled session can go back to 'idle' while " +
        'still unchecked.',
    }),
  })
  .openapi('SessionNotificationItem')
export type SessionNotificationItemDto = z.infer<typeof sessionNotificationItemSchema>

export const suggestionNotificationItemSchema = z
  .object({
    source: z
      .literal('suggestion')
      .openapi({ description: 'A learning suggestion awaiting review' }),
    ...common,
    kind: librarySuggestionKindSchema,
    action: librarySuggestionActionSchema,
    name: z.string().openapi({ description: 'The agent or skill name this suggestion targets' }),
    title: z.string(),
  })
  .openapi('SuggestionNotificationItem')
export type SuggestionNotificationItemDto = z.infer<typeof suggestionNotificationItemSchema>

// Discriminated on `source`, not `kind` — a suggestion item already has its
// own `kind` (agent/skill), so reusing that name as the union discriminator
// would collide with it.
export const notificationItemSchema = z
  .discriminatedUnion('source', [sessionNotificationItemSchema, suggestionNotificationItemSchema])
  .openapi('NotificationItem')
export type NotificationItemDto = z.infer<typeof notificationItemSchema>

export const notificationFeedSchema = z
  .object({
    items: z.array(notificationItemSchema).openapi({
      description:
        'Newest first (ties: a session item before a suggestion item, then id ascending), ' +
        'capped at NOTIFICATIONS_LIMIT.',
    }),
    hasUnread: z.boolean().openapi({
      description:
        'True when any item in `items` is unread. Exact for the whole feed, not just this page: ' +
        'anything past the cap is strictly older than items[0], so it can never be unread while ' +
        'every returned item is read.',
    }),
    truncated: z.boolean().openapi({
      description: 'True when more unchecked results or pending suggestions exist than the cap',
    }),
  })
  .openapi('NotificationFeed')
export type NotificationFeedDto = z.infer<typeof notificationFeedSchema>

export const markNotificationsReadSchema = z
  .object({
    // { offset: true }: the OpenAPI doc advertises `format: date-time`, i.e.
    // RFC 3339, which permits a numeric offset (`+02:00`) alongside `Z` — the
    // bare z.iso.datetime() default rejects every offset, which would reject
    // a value this route's own documented contract promises to accept.
    upTo: z.iso.datetime({ offset: true }).openapi({
      description:
        'The newest item the client has seen, typically the `at` of items[0] from its last GET. ' +
        'Clamped server-side to the feed’s actual newest item, so a stale or future value can ' +
        'never pre-mark an item that has not arrived yet.',
    }),
  })
  .openapi('MarkNotificationsRead')
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>
