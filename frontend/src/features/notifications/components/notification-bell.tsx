import { Bell } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '@/shared/components'
import { Button } from '@/shared/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/shared/ui/popover'
import { useMarkNotificationsRead, useNotifications } from '../hooks/use-notifications'
import { notificationKey } from '../lib/format'
import { NotificationList } from './notification-list'

/**
 * The bell in the global topbar (`app/tab-bar.tsx`): one newest-first feed of
 * unchecked session results and learning suggestions awaiting review, with a
 * red dot while anything in it is unread — never a count, the operator's own
 * decision for this control.
 *
 * Read state is server-side (`POST /notifications/read`), not tracked here —
 * opening the panel marks everything currently unread as read, the same way
 * `SessionPage` marks a session seen by posting on its own once the operator
 * can actually see the result. The one thing this component does track
 * locally is `highlighted`: which rows still *look* unread. Without it, a
 * row would flip to read-styled the instant the mark-read POST below
 * resolves — typically well before the operator has finished reading the
 * panel they just opened it to read. `highlighted` is a snapshot, not a
 * live flag: it only ever grows while the panel is open (a later poll
 * bringing a genuinely new unread item adds to it) and resets to empty the
 * moment the panel closes, so reopening it later shows nothing highlighted
 * and sends nothing — there is nothing new to mark.
 */
export function NotificationBell() {
  const { t, i18n } = useTranslation()
  const { data, isPending, isError } = useNotifications()
  const markRead = useMarkNotificationsRead()
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set<string>())
  // The `upTo` already sent for this open panel, so a poll that reports the
  // same newest item again doesn't re-send the same POST. Cleared on
  // failure so a later tick gets to retry, and on close (alongside
  // `highlighted` below) so the next open always re-marks whatever is
  // unread then, rather than staying silent forever once a given newest
  // item has been sent once.
  const sentUpToRef = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: markRead.mutate is a fresh function identity every render; only open/data should retrigger this
  useEffect(() => {
    if (!open || !data?.hasUnread) return
    const newest = data.items[0]
    if (!newest) return

    setHighlighted((prev) => {
      const next = new Set(prev)
      for (const item of data.items) {
        if (item.unread) next.add(notificationKey(item))
      }
      return next
    })

    if (sentUpToRef.current === newest.at) return
    sentUpToRef.current = newest.at
    markRead.mutate(
      { body: { upTo: newest.at } },
      {
        onError: () => {
          if (sentUpToRef.current === newest.at) sentUpToRef.current = null
        },
      },
    )
  }, [open, data])

  function closePanel() {
    setOpen(false)
    setHighlighted(new Set<string>())
    sentUpToRef.current = null
  }

  const hasUnread = Boolean(data?.hasUnread)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else closePanel()
      }}
    >
      <PopoverTrigger
        aria-label={hasUnread ? t('notifications.bellUnread') : t('notifications.bell')}
        render={<Button variant="ghost" size="icon" className="relative shrink-0" />}
      >
        <Bell aria-hidden="true" />
        {hasUnread && (
          <span className="pointer-events-none absolute top-1.5 right-1.5 flex">
            <StatusDot tone="danger" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{t('notifications.title')}</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-96 overflow-y-auto">
          <NotificationList
            data={data}
            isPending={isPending}
            isError={isError}
            highlighted={highlighted}
            locale={i18n.language}
            onNavigate={closePanel}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
