import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import {
  getProjectDiskUsageQueryKey,
  getProjectDiskUsageQueryOptions,
} from '@/shared/api/generated/hooks/useGetProjectDiskUsage'
import {
  getProjectsDiskUsageQueryKey,
  getProjectsDiskUsageQueryOptions,
} from '@/shared/api/generated/hooks/useGetProjectsDiskUsage'
import { refreshProjectDiskUsageMutationOptions } from '@/shared/api/generated/hooks/useRefreshProjectDiskUsage'
import type { ProjectDiskUsage } from '@/shared/api/generated/types/ProjectDiskUsage'
import type { Project } from './use-projects'

export type { ProjectDiskUsage }

// The backend never waits for `du` (it can take tens of seconds): every call
// answers from a cache, and starts a background measurement when the numbers
// are missing or old. It reports `measuring: true` while that runs, still
// carrying the previous numbers — so the only thing a client has to do is ask
// again until the flag drops, and not at all the rest of the time.
const POLL_MS = 2000

export function useProjectsDiskUsage() {
  return useQuery({
    ...getProjectsDiskUsageQueryOptions(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((u) => u.measuring) ? POLL_MS : false,
  })
}

export function useProjectDiskUsage(projectId: string) {
  return useQuery({
    ...getProjectDiskUsageQueryOptions({ path: { id: projectId } }),
    refetchInterval: (query) => (query.state.data?.measuring ? POLL_MS : false),
  })
}

/** Starts a fresh measurement now, even if the cached one is still recent. */
export function useRefreshProjectDiskUsage(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...refreshProjectDiskUsageMutationOptions(),
    onSuccess: (data) => {
      // The response is the project's new state — `measuring: true` with the
      // previous numbers — and writing it is what starts the poll, since
      // `useProjectDiskUsage`'s `refetchInterval` reads that flag off the cache.
      queryClient.setQueryData(getProjectDiskUsageQueryKey({ path: { id: projectId } }), data)
      void queryClient.invalidateQueries({ queryKey: getProjectsDiskUsageQueryKey() })
    },
  })
}

/**
 * Asks for sizes again when a project appears, goes, or changes state.
 *
 * What the backend measured while a project was still being set up is no use
 * once it is ready ("Project folder not found", or a half-cloned figure), yet
 * nothing else would refetch it inside the query's `staleTime`. Keyed on the
 * `id:status` pairs rather than on the `projects` array, which is a new
 * reference on every poll of the project list; the first render only records
 * the baseline, because the queries fetch for themselves on mount.
 */
export function useRefetchDiskUsageOnStatusChange(
  projects: readonly Pick<Project, 'id' | 'status'>[],
) {
  const queryClient = useQueryClient()
  const signature = projects.map((p) => `${p.id}:${p.status}`).join(',')
  const seen = useRef(signature)
  useEffect(() => {
    if (seen.current === signature) return
    seen.current = signature
    void queryClient.invalidateQueries({ queryKey: getProjectsDiskUsageQueryKey() })
    for (const { id } of projects) {
      void queryClient.invalidateQueries({
        queryKey: getProjectDiskUsageQueryKey({ path: { id } }),
      })
    }
  }, [signature, projects, queryClient])
}
