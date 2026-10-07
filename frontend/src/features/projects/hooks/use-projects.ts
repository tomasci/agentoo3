import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiProjectsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiProjectsId'
import { deleteProjectGitIdentityMutationOptions } from '@/shared/api/generated/hooks/useDeleteProjectGitIdentity'
import {
  getApiProjectsQueryKey,
  getApiProjectsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjects'
import {
  getProjectGitIdentityQueryKey,
  getProjectGitIdentityQueryOptions,
} from '@/shared/api/generated/hooks/useGetProjectGitIdentity'
import { patchApiProjectsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiProjectsId'
import { postApiProjectsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjects'
import { postApiProjectsIdRetryMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdRetry'
import { putProjectGitIdentityMutationOptions } from '@/shared/api/generated/hooks/usePutProjectGitIdentity'
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

export function useUpdateProject() {
  const invalidate = useInvalidateProjects()
  return useMutation({
    ...patchApiProjectsIdMutationOptions(),
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

// The project's git identity (name/email agents commit as) lives only in the
// project repo's own `.git/config`, so it is its own GET/PUT/DELETE trio
// rather than a field on the project row itself — fetched on demand by
// GitIdentityCard rather than bundled into `useProjects`' list query.

export function useGitIdentity(projectId: string) {
  return useQuery(getProjectGitIdentityQueryOptions({ path: { id: projectId } }))
}

/** The PUT/DELETE responses are the new state itself, so each mutation writes
 *  its own result straight into the query cache rather than invalidating and
 *  waiting on a refetch — the same shortcut `useAutomation`'s siblings in
 *  `use-automations.ts` take where a response already *is* the row. */
export function usePutGitIdentity(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...putProjectGitIdentityMutationOptions(),
    onSuccess: (data) => {
      queryClient.setQueryData(getProjectGitIdentityQueryKey({ path: { id: projectId } }), data)
    },
  })
}

export function useDeleteGitIdentity(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...deleteProjectGitIdentityMutationOptions(),
    onSuccess: (data) => {
      queryClient.setQueryData(getProjectGitIdentityQueryKey({ path: { id: projectId } }), data)
    },
  })
}
