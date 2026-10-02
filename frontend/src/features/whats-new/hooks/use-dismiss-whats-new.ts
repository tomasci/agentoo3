import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiWhatsNewQueryKey } from '@/shared/api/generated/hooks/useGetApiWhatsNew'
import { postApiWhatsNewDismissMutationOptions } from '@/shared/api/generated/hooks/usePostApiWhatsNewDismiss'

/**
 * POST /whats-new/dismiss, writing its answer straight into GET /whats-new's
 * own cache rather than invalidating and refetching — unlike
 * use-system-settings.ts's save/reset (which deliberately re-reads, see that
 * file's comment, because something else could have changed the value in
 * between), the response here already *is* "state after the dismissal,
 * freshly re-read" (routes.ts's own description of the 200), so a second
 * round trip would only restate it.
 */
export function useDismissWhatsNew() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiWhatsNewDismissMutationOptions(),
    onSuccess: (data) => {
      queryClient.setQueryData(getApiWhatsNewQueryKey(), data)
    },
  })
}
