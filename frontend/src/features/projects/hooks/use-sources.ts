import { useQuery } from '@tanstack/react-query'
import { getApiSourcesQueryOptions } from '@/shared/api/generated/hooks/useGetApiSources'

/**
 * Folders available to adopt.
 *
 * Refetched on mount rather than cached hard: the operator will typically scp a
 * folder onto the server and come straight back to this form.
 */
export function useSources() {
  return useQuery({ ...getApiSourcesQueryOptions(), staleTime: 0 })
}
