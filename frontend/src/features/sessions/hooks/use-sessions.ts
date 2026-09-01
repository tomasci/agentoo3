import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsId'
import {
  getApiProjectsIdSessionsQueryKey,
  getApiProjectsIdSessionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import { patchApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiSessionsId'
import { postApiProjectsIdSessionsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessions'
import type { GetApiProjectsIdSessionsStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdSessions'

// The 200 response is an array, so a session is its element type.
export type Session = GetApiProjectsIdSessionsStatus200[number]

export function useSessions(projectId: string) {
  return useQuery(getApiProjectsIdSessionsQueryOptions({ path: { id: projectId } }))
}

function useInvalidate(projectId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiProjectsIdSessionsQueryKey({ path: { id: projectId } }),
    })
}

export function useCreateSession(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation({
    ...postApiProjectsIdSessionsMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateSession(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation({ ...patchApiSessionsIdMutationOptions(), onSuccess: () => invalidate() })
}

export function useDeleteSession(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation({ ...deleteApiSessionsIdMutationOptions(), onSuccess: () => invalidate() })
}
