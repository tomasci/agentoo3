import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsId'
import {
  getApiProjectsIdSessionsQueryKey,
  getApiProjectsIdSessionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import {
  getApiSessionsIdQueryKey,
  getApiSessionsIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsId'
import { getApiSessionsIdMessagesQueryOptions } from '@/shared/api/generated/hooks/useGetApiSessionsIdMessages'
import { patchApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiSessionsId'
import { postApiProjectsIdSessionsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessions'
import { postApiSessionsIdInterruptMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdInterrupt'
import { postApiSessionsIdMessagesMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdMessages'
import type { GetApiProjectsIdSessionsStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdSessions'
import type { GetApiSessionsIdMessagesStatus200 } from '@/shared/api/generated/types/GetApiSessionsIdMessages'

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

export type SessionMessage = GetApiSessionsIdMessagesStatus200[number]

export function useSession(sessionId: string) {
  return useQuery(getApiSessionsIdQueryOptions({ path: { id: sessionId } }))
}

export function useSessionMessages(sessionId: string) {
  return useQuery({
    ...getApiSessionsIdMessagesQueryOptions({ path: { id: sessionId } }),
    // The stream keeps this fresh; refetching on every window focus would
    // replace a live transcript with an identical one and flash the UI.
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useSendMessage(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiSessionsIdMessagesMutationOptions(),
    // Nothing is inserted by hand: the message comes back over the stream like
    // every other one, so there is one path that appends to the transcript.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: getApiSessionsIdQueryKey({ path: { id: sessionId } }),
      }),
  })
}

export function useInterruptSession(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiSessionsIdInterruptMutationOptions(),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: getApiSessionsIdQueryKey({ path: { id: sessionId } }),
      }),
  })
}
