import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiNotificationsQueryKey,
  getApiNotificationsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiNotifications'
import { postApiNotificationsReadMutationOptions } from '@/shared/api/generated/hooks/usePostApiNotificationsRead'
import type { GetApiNotificationsStatus200 } from '@/shared/api/generated/types/GetApiNotifications'

export type NotificationFeed = GetApiNotificationsStatus200
export type NotificationItem = NotificationFeed['items'][number]

/**
 * The bell's own feed: unchecked session results and learning suggestions
 * awaiting review, newest first. Polled the same way `useSystem`/`useDocker`
 * poll their own status — a panel nobody has opened yet still needs to learn
 * a result settled on its own — but not while the tab is backgrounded, the
 * same restraint those hooks apply for the same reason: a stale dot that
 * then jumps on refocus reads worse than one extra request a few seconds
 * late.
 */
export function useNotifications() {
  return useQuery({
    ...getApiNotificationsQueryOptions(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
}

/**
 * POST /notifications/read, writing its answer straight into GET
 * /notifications' own cache rather than invalidating and refetching — the
 * same idiom `useDismissWhatsNew` (features/whats-new/hooks/
 * use-dismiss-whats-new.ts) uses for the same reason: the response already
 * *is* "the feed after the write", so a second round trip would only
 * restate it. No `onError` of its own: a failed mark-read just leaves the
 * dot lit a little longer, which the next poll (or the next open) corrects
 * on its own, not something worth a toast.
 *
 * `onSuccess` first cancels whatever GET for this same feed is still in
 * flight, the same idiom `useMarkSessionSeen` (features/sessions/hooks/
 * use-sessions.ts) uses and for the same reason: the 15s poll
 * (`useNotifications`) can have one outstanding at the moment this response
 * lands, and that poll's own snapshot was read *before* the write, so it can
 * resolve afterwards still claiming `hasUnread: true` and overwrite the
 * fresher cache this `setQueryData` is about to write — bringing the dot
 * back until the next poll corrects it up to 15s later. Cancelling first is
 * safe rather than merely overwrite-and-hope: this response is the feed
 * *after* the read write landed on the server, so it is at least as fresh as
 * any GET already in flight when it arrives.
 */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiNotificationsReadMutationOptions(),
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey: getApiNotificationsQueryKey() })
      queryClient.setQueryData(getApiNotificationsQueryKey(), data)
    },
  })
}
