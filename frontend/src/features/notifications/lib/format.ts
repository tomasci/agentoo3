import type { NotificationItem } from '../hooks/use-notifications'

/**
 * A stable React key for one feed entry. `id` alone isn't enough — a
 * session and a suggestion come from two different tables and can share a
 * uuid by coincidence — so the key carries `source` too.
 */
export function notificationKey(item: NotificationItem): string {
  return `${item.source}:${item.id}`
}

/**
 * An ISO timestamp as `locale` would show it — mirrors
 * `features/whats-new/lib/format.ts`'s `formatReleaseDate`, which takes the
 * same (value, locale) shape rather than a module-level formatter: the bell
 * follows the reader's own interface language, the same way that screen
 * does, not the browser's locale the way `features/sessions`/
 * `features/library`'s own `formatDateTime` do.
 */
export function formatNotificationTime(at: string, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
