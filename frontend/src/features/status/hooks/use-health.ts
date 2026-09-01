import { useQuery } from '@tanstack/react-query'
import { getHealth } from '../api/get-health'

export const healthQueryKey = ['status', 'health'] as const

export function useHealth() {
  return useQuery({
    queryKey: healthQueryKey,
    queryFn: ({ signal }) => getHealth(signal),
    // The backend is expected to be down for now, so do not hammer it.
    retry: false,
    staleTime: 30_000,
  })
}
