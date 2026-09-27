import { useQuery } from '@tanstack/react-query'
import { getApiHealthQueryOptions } from '@/shared/api/generated/hooks/useGetApiHealth'

export function useHealth() {
  return useQuery({
    ...getApiHealthQueryOptions(),
    // The header badge should notice the backend coming back without a
    // reload. Polls faster while the query is in error — the status bar's own
    // "Reconnecting…" line (app/status-bar.tsx) should clear within a few
    // seconds of the backend actually answering again, not sit on a stale
    // failure for up to 15s.
    refetchInterval: (query) => (query.state.status === 'error' ? 3_000 : 15_000),
    retry: false,
  })
}
