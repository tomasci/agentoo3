import { Link } from '@tanstack/react-router'
import { Library, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Loading, StatusDot } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/shared/ui/item'
import type { NotificationFeed, NotificationItem } from '../hooks/use-notifications'
import { formatNotificationTime, notificationKey } from '../lib/format'

interface NotificationListProps {
  data: NotificationFeed | undefined
  isPending: boolean
  isError: boolean
  /** Keys highlighted as unread — see `NotificationBell`'s own comment on
   *  why this is not simply each item's live `unread` flag. */
  highlighted: ReadonlySet<string>
  locale: string
  onNavigate: () => void
}

/** The panel's body: loading, error, empty, the feed itself, or the
 *  truncated footer — one component per the four states a feed can be in. */
export function NotificationList({
  data,
  isPending,
  isError,
  highlighted,
  locale,
  onNavigate,
}: NotificationListProps) {
  const { t } = useTranslation()

  if (isPending) return <Loading label={t('common.loading')} block />

  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('notifications.loadFailed')}</AlertDescription>
      </Alert>
    )
  }

  if (data.items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('notifications.empty.title')}</EmptyTitle>
          <EmptyDescription>{t('notifications.empty.description')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <>
      <ul className="flex flex-col gap-1">
        {data.items.map((item) => {
          const key = notificationKey(item)
          return (
            <li key={key}>
              <NotificationRow
                item={item}
                highlighted={highlighted.has(key)}
                locale={locale}
                onNavigate={onNavigate}
              />
            </li>
          )
        })}
      </ul>
      {/* No count, same as the dot: "more exist" is the whole fact, not how
          many — the two links hand off to the pages that actually list them
          rather than trying to grow this panel into one. */}
      {data.truncated && (
        <div className="mt-2 flex flex-col gap-1 border-t pt-2 text-xs text-muted-foreground">
          <p>{t('notifications.truncated')}</p>
          <p className="flex gap-3">
            <Link
              to="/sessions"
              onClick={onNavigate}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {t('notifications.allSessions')}
            </Link>
            <Link
              to="/library/suggested"
              onClick={onNavigate}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {t('notifications.allSuggestions')}
            </Link>
          </p>
        </div>
      )}
    </>
  )
}

function NotificationRow({
  item,
  highlighted,
  locale,
  onNavigate,
}: {
  item: NotificationItem
  highlighted: boolean
  locale: string
  onNavigate: () => void
}) {
  const { t } = useTranslation()
  const time = formatNotificationTime(item.at, locale)
  const variant = highlighted ? 'muted' : 'default'

  const title =
    item.source === 'session'
      ? (item.title ?? t('sessions.untitled', { id: item.id.slice(0, 8) }))
      : item.title

  const description =
    item.source === 'session'
      ? [item.projectName, t(`sessions.status.${item.status}`), time].join(' · ')
      : [
          `${t(`library.suggestions.action.${item.action}`)} ${t(`library.suggestions.kind.${item.kind}`)}`,
          item.name,
          time,
        ].join(' · ')

  return (
    <Item
      size="sm"
      variant={variant}
      render={
        item.source === 'session' ? (
          <Link
            to="/projects/$projectId/sessions/$sessionId"
            params={{ projectId: item.projectId, sessionId: item.id }}
            onClick={onNavigate}
          />
        ) : (
          <Link to="/library/suggestions/$id" params={{ id: item.id }} onClick={onNavigate} />
        )
      }
    >
      <ItemMedia variant="icon">
        {item.source === 'session' ? <MessagesSquare /> : <Library />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {highlighted && <StatusDot tone="danger" />}
          {title}
          {highlighted && <span className="sr-only">{t('notifications.unread')}</span>}
        </ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
    </Item>
  )
}
