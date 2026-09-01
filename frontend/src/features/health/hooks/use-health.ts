import { useQuery } from '@tanstack/react-query'
import { getApiHealthQueryOptions } from '@/shared/api/generated/hooks/useGetApiHealth'

export function useHealth() {
  return useQuery({
    ...getApiHealthQueryOptions(),
    // The header badge should notice the backend coming back without a reload.
    refetchInterval: 15_000,
    retry: false,
  })
}
