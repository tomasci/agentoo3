import { useQuery } from '@tanstack/react-query'
import { getApiSystemQueryOptions } from '@/shared/api/generated/hooks/useGetApiSystem'

/**
 * Host load for the status bar.
 *
 * Polled rather than streamed: it is three numbers on a five-second cadence, and
 * a second SSE connection alongside the transcript would cost more than it saves.
 * The backend measures CPU as the delta between polls, so a steady interval is
 * also what makes that number meaningful.
 */
export function useSystem() {
  return useQuery({
    ...getApiSystemQueryOptions(),
    refetchInterval: 5000,
    // Keep polling in a background tab: coming back to a stale reading that then
    // jumps is worse than one extra request a few seconds apart.
    refetchIntervalInBackground: false,
    staleTime: 4000,
    retry: false,
  })
}
