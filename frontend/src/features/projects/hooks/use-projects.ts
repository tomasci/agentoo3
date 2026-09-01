import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiProjectsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiProjectsId'
import {
  getApiProjectsQueryKey,
  getApiProjectsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjects'
import { postApiProjectsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjects'
import { postApiProjectsIdRetryMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdRetry'
import type { GetApiProjectsStatus200 } from '@/shared/api/generated/types/GetApiProjects'

// The 200 response is an array, so a project is its element type.
export type Project = GetApiProjectsStatus200[number]
export type ProjectStatus = Project['status']

/** A project in one of these is still being worked on by the backend. */
const IN_FLIGHT: ProjectStatus[] = ['pending', 'cloning']

export const isInFlight = (p: Project) => IN_FLIGHT.includes(p.status)

export function useProjects() {
  return useQuery({
    ...getApiProjectsQueryOptions(),
    // Cloning happens on a worker with no push channel, so poll while anything
    // is mid-setup and stop as soon as everything settles.
    refetchInterval: (query) => ((query.state.data ?? []).some(isInFlight) ? 1500 : false),
  })
}

function useInvalidateProjects() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: getApiProjectsQueryKey() })
}

export function useCreateProject() {
  const invalidate = useInvalidateProjects()
  return useMutation({
    ...postApiProjectsMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useRetryProject() {
  const invalidate = useInvalidateProjects()
  return useMutation({
    ...postApiProjectsIdRetryMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteProject() {
  const invalidate = useInvalidateProjects()
  return useMutation({
    ...deleteApiProjectsIdMutationOptions(),
    onSuccess: () => invalidate(),
  })
}
