import { useQuery } from '@tanstack/react-query'
import { getApiWhatsNewQueryOptions } from '@/shared/api/generated/hooks/useGetApiWhatsNew'

/**
 * The operator's own "update installed" state: which version/when, and
 * whether that install still needs an acknowledgement. Unlike useHealth(),
 * nothing changes this mid-session except the operator's own dismiss
 * (use-dismiss-whats-new.ts writes straight into this query's cache) or the
 * installer running again on a page this tab doesn't need to notice without
 * a reload — so one request per page load is enough, not a poll.
 */
export function useWhatsNew() {
  return useQuery({ ...getApiWhatsNewQueryOptions(), refetchInterval: false })
}
