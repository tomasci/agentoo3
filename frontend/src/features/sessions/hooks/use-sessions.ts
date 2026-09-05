import type { InfiniteData } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiSessionsIdMessages } from '@/shared/api/generated/clients/getApiSessionsIdMessages'
import { deleteApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsId'
import {
  getApiProjectsIdSessionsQueryKey,
  getApiProjectsIdSessionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import {
  getApiSessionsIdQueryKey,
  getApiSessionsIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsId'
import { patchApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiSessionsId'
import { postApiProjectsIdSessionsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessions'
import { postApiSessionsIdInterruptMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdInterrupt'
import { postApiSessionsIdMessagesMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdMessages'
import type { GetApiProjectsIdSessionsStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdSessions'
import type {
  GetApiSessionsIdMessagesQuery,
  GetApiSessionsIdMessagesStatus200,
} from '@/shared/api/generated/types/GetApiSessionsIdMessages'
import { sessionMessagesKey } from '../lib/message-cache'

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

// The envelope's `messages` array, so a session message is its element type —
// not the envelope itself, which also carries `hasOlder` for the page it came
// from.
export type SessionMessage = GetApiSessionsIdMessagesStatus200['messages'][number]

/** Backward page size, and the size of the initial "newest N" load — both
 * bounded modes the backend supports (see the endpoint's own doc comment). */
export const PAGE_SIZE = 100

export function useSession(sessionId: string) {
  return useQuery(getApiSessionsIdQueryOptions({ path: { id: sessionId } }))
}

/**
 * The flattened view every consumer actually wants, cached by react-query's
 * own `select` memoisation: it re-runs only when the underlying `InfiniteData`
 * reference changes, and hands back the *same* `select` result otherwise.
 *
 * Module-level, not an inline arrow and not a `useMemo` in the hook body below:
 * either of those is a new function identity on every render, which is a new
 * `select` on every render as far as react-query is concerned, so the
 * memoisation above never gets a chance to hit. `Transcript` is `memo()`d on
 * `messages`' own identity (see transcript.tsx) — the whole point of this
 * function existing on its own is keeping that array reference stable across
 * a render that changed nothing about the transcript.
 */
function selectMessages(data: InfiniteData<GetApiSessionsIdMessagesStatus200, number | undefined>) {
  return {
    messages: data.pages.flatMap((page) => page.messages),
    hasOlder: data.pages[0]?.hasOlder ?? false,
  }
}

const NO_MESSAGES: SessionMessage[] = []

export function useSessionMessages(sessionId: string) {
  const query = useInfiniteQuery({
    queryKey: sessionMessagesKey(sessionId),
    queryFn: async ({ pageParam, signal }) => {
      // `undefined` is the initial load: no seq exists yet to anchor a
      // `before` page on, so `limit` alone asks for the newest page instead.
      const query: GetApiSessionsIdMessagesQuery =
        pageParam === undefined ? { limit: PAGE_SIZE } : { before: pageParam, limit: PAGE_SIZE }
      const { data } = await getApiSessionsIdMessages({
        path: { id: sessionId },
        query,
        signal,
        throwOnError: true,
      })
      return data
    },
    initialPageParam: undefined as number | undefined,
    // Older pages are *previous*, never *next*: forward is the stream's job
    // (use-session-stream.ts), so `pages` stays chronological with
    // `pages[last]` always the live tail the stream appends to, and loading
    // more history never has to renumber or reverse anything already on
    // screen.
    getPreviousPageParam: (firstPage) =>
      firstPage.hasOlder ? firstPage.messages[0]?.seq : undefined,
    getNextPageParam: () => undefined,
    // No `maxPages`: dropping a page the reader has already scrolled past
    // would silently delete loaded history rather than merely re-fetch it.
    select: selectMessages,
    // The stream keeps this fresh; refetching on every window focus would
    // replace a live transcript with an identical one and flash the UI.
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

  return {
    messages: query.data?.messages ?? NO_MESSAGES,
    // The *first* loaded page's own claim (see `selectMessages` above) — raw
    // backend data, not a stop condition. `session-page.tsx` gates on
    // `hasPreviousPage` below instead, which is react-query's own derived
    // answer to "would fetching again do anything", and does not go stale
    // the way this can (see that field's own comment).
    hasOlder: query.data?.hasOlder ?? false,
    // Derived by react-query from `getPreviousPageParam` itself, so it is
    // false exactly when another `fetchPreviousPage` would be a no-op —
    // unlike `hasOlder` above, which is only ever the *first* page's own flag
    // and stays `true` forever if a page ever comes back empty while still
    // claiming there is more (see session-page.tsx's `requestOlder`).
    hasPreviousPage: query.hasPreviousPage,
    isPending: query.isPending,
    isSuccess: query.isSuccess,
    isLoadingOlder: query.isFetchingPreviousPage,
    isLoadOlderError: query.isFetchPreviousPageError,
    loadOlder: () => query.fetchPreviousPage(),
  }
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
