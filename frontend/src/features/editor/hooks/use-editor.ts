import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiProjectsIdSessionsSessionidEditorQueryKey,
  getApiProjectsIdSessionsSessionidEditorQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdSessionsSessionidEditor'
import { postApiProjectsIdSessionsSessionidEditorStartMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessionsSessionidEditorStart'
import { postApiProjectsIdSessionsSessionidEditorStopMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessionsSessionidEditorStop'
import type { GetApiProjectsIdSessionsSessionidEditorStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdSessionsSessionidEditor'

/** The one status shape all three endpoints (GET, start, stop) answer with —
 *  kubb names each response type after its own route, but they are
 *  structurally the same `EditorStatus` the design doc describes. Aliased
 *  here off the GET response, arbitrarily, since it is the query this status
 *  actually lives under. */
export type EditorStatus = GetApiProjectsIdSessionsSessionidEditorStatus200
export type EditorOperation = NonNullable<EditorStatus['operation']>

/**
 * One session's editor: enabled/daemon/state, the iframe's own `proxyPath`,
 * and the latest start operation with its output.
 *
 * Polled, like `useDockerStatus` (features/docker/hooks/use-docker.ts) —
 * there is no push channel for this (the design doc is explicit: "Progress:
 * polled (no SSE)"). Fast while a start is in flight so the page notices a
 * container coming up within a couple of seconds, slower once it is settled,
 * and slower still once it is confirmed stopped — there is nothing left to
 * watch for at that point beyond a reader pressing Start again.
 */
export function useEditorStatus(projectId: string, sessionId: string) {
  return useQuery({
    ...getApiProjectsIdSessionsSessionidEditorQueryOptions({
      path: { id: projectId, sessionId },
    }),
    refetchInterval: (query) => {
      const state = query.state.data?.state
      if (state === 'starting') return 2000
      if (state === 'running') return 30_000
      return 15_000
    },
  })
}

/**
 * Both mutations write their own response straight into the status query's
 * cache, rather than only invalidating it (contrast `useDockerUp` and
 * friends, which invalidate and let the next poll catch up): a `start` or
 * `stop` call already IS a fresh `EditorStatus` — the same one a GET would
 * return a moment later — so writing it in directly is what lets the iframe
 * mount (or the start log appear) the instant the mutation resolves instead
 * of waiting out `useEditorStatus`'s own interval.
 */
function useWriteEditorStatus(projectId: string, sessionId: string) {
  const queryClient = useQueryClient()
  const queryKey = getApiProjectsIdSessionsSessionidEditorQueryKey({
    path: { id: projectId, sessionId },
  })
  return (status: EditorStatus) => queryClient.setQueryData(queryKey, status)
}

export function useEditorStart(projectId: string, sessionId: string) {
  const write = useWriteEditorStatus(projectId, sessionId)
  return useMutation({
    ...postApiProjectsIdSessionsSessionidEditorStartMutationOptions(),
    onSuccess: (status) => write(status),
  })
}

export function useEditorStop(projectId: string, sessionId: string) {
  const write = useWriteEditorStatus(projectId, sessionId)
  return useMutation({
    ...postApiProjectsIdSessionsSessionidEditorStopMutationOptions(),
    onSuccess: (status) => write(status),
  })
}
