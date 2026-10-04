import type { InfiniteData } from '@tanstack/react-query'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { getApiSessionsIdMessages } from '@/shared/api/generated/clients/getApiSessionsIdMessages'
import { deleteApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsId'
import { getApiNotificationsQueryKey } from '@/shared/api/generated/hooks/useGetApiNotifications'
import {
  getApiProjectsIdSessionsQueryKey,
  getApiProjectsIdSessionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import {
  getApiSessionsIdQueryKey,
  getApiSessionsIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsId'
import {
  getApiSessionsOverviewQueryKey,
  getApiSessionsOverviewQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsOverview'
import { patchApiSessionsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiSessionsId'
import { postApiProjectsIdSessionsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessions'
import { postApiSessionsIdInterruptMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdInterrupt'
import { postApiSessionsIdMessagesMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdMessages'
import { postApiSessionsIdSeenMutationOptions } from '@/shared/api/generated/hooks/usePostApiSessionsIdSeen'
import type { GetApiProjectsIdSessionsStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdSessions'
import type {
  GetApiSessionsIdMessagesQuery,
  GetApiSessionsIdMessagesStatus200,
} from '@/shared/api/generated/types/GetApiSessionsIdMessages'
import type { GetApiSessionsOverviewWindowKey } from '@/shared/api/generated/types/GetApiSessionsOverview'
import { getApiSessionsIdMessagesStatus200Schema } from '@/shared/api/generated/zod/getApiSessionsIdMessagesSchema'
import { sessionMessagesKey } from '../lib/message-cache'

// The 200 response is an array, so a session is its element type.
export type Session = GetApiProjectsIdSessionsStatus200[number]

// A session plus the name of the project it belongs to — what the dashboard's
// three lists actually return (`OverviewSession` on the wire), re-exported
// under this feature's own hook rather than importing the generated type
// directly wherever a session's project name is needed.
export type { OverviewSession } from '@/shared/api/generated/types/OverviewSession'

/** `1d` | `3d` | `7d` — how far back the dashboard's Recent list looks. */
export type OverviewWindow = GetApiSessionsOverviewWindowKey

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
  const queryClient = useQueryClient()
  const invalidate = useInvalidate(projectId)
  return useMutation({
    ...postApiProjectsIdSessionsMutationOptions(),
    onSuccess: (data) => {
      // The dialog navigates straight to this session on success (see
      // new-session-dialog.tsx), so its detail query is seeded with the DTO
      // the create response already carries — otherwise the session page's
      // first render is a loading state for data this response already has.
      queryClient.setQueryData(getApiSessionsIdQueryKey({ path: { id: data.id } }), data)
      invalidate()
    },
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
        // The wire shape a client trusts without checking, checked: commit
        // 76113a8 changed this endpoint's 200 body from a bare array to this
        // envelope, and a tab still running the JS from before that landed
        // read `.messages` off an array and crashed three layers deeper, in a
        // cache updater, as `n.findIndex is not a function` — a shape change
        // failing anywhere but here. `payload` inside each message is
        // `z.unknown()`, so this does not walk a transcript's worth of Bash
        // output to do it.
        validator: { response: getApiSessionsIdMessagesStatus200Schema },
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
    // The *initial* page load failing, distinct from `isLoadOlderError`
    // below: a rejected first page (the validator above throwing on a
    // malformed envelope, or any other queryFn rejection) used to leave
    // `messages` at `NO_MESSAGES` with nothing to tell "no messages yet" apart
    // from "failed to load any" — an empty transcript, silently. `error` rides
    // along so a caller can show what actually went wrong rather than a bare
    // "it failed".
    //
    // Not just `query.isError`: query-core's `Query` reducer sets the whole
    // query's `status` to `'error'` on ANY failed fetch, including a later
    // `fetchPreviousPage` — `isFetchPreviousPageError` below is exactly that
    // same flag, narrowed by direction, not a separate one — and that reducer
    // never clears `data`. So after an initial page has already loaded,
    // `query.data` stays defined even while a failed `loadOlder` makes
    // `query.isError` true too. Gating on `query.data === undefined` as well
    // is what keeps this to "the first page never loaded", leaving a later
    // `loadOlder` failure to `isLoadOlderError` and the transcript on screen.
    isError: query.isError && query.data === undefined,
    error: query.error,
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

/**
 * The System tab's Sessions dashboard (`SessionsDashboardPage`): running,
 * unchecked and recent, across every project. Polled the same way `useSystem`
 * (features/system/hooks/use-system.ts) polls host load — a dashboard left
 * open needs to notice a session finishing on its own, not just whatever was
 * true at page load — but a background tab stops polling for the same reason
 * that hook does: a stale reading that then jumps on refocus reads worse than
 * one extra request a few seconds late.
 *
 * `placeholderData: keepPreviousData` is what the window toggle actually
 * relies on: switching between 1d/3d/7d keeps whatever the previous window
 * last rendered on screen while the new one loads, rather than every section
 * flashing back to `isPending` for a request that usually comes back looking
 * almost the same.
 */
export function useSessionsOverview(window: OverviewWindow) {
  return useQuery({
    ...getApiSessionsOverviewQueryOptions({ query: { window } }),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  })
}

/**
 * Marks a session's latest result as checked (`POST /sessions/{id}/seen`).
 *
 * Bookkeeping, not something the operator asked for: `SessionPage` is the one
 * caller, and it fires this itself the moment a loaded session reads
 * `unchecked: true` while the page is actually visible (see its own comment)
 * — nothing here surfaces success *or* failure to the reader. No `onError` of
 * its own for that reason: the shared client already logs every failed
 * request once, centrally (shared/api/client.ts's interceptor), and a session
 * that fails to be marked seen just stays in the dashboard's Unchecked list a
 * little longer, which is a fact the dashboard's own next poll shows on its
 * own rather than something worth a toast.
 */
export function useMarkSessionSeen() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiSessionsIdSeenMutationOptions(),
    onSuccess: async (data) => {
      // Cancels whatever GET for this same session is still in flight,
      // *before* writing the fresher DTO below — not in `onMutate`, which
      // runs too early to catch it: a stream `status` event's own refetch
      // (use-session-stream.ts) is independent of this mutation and is
      // usually not even dispatched yet at the moment `onMutate` runs, only
      // later while the POST is still pending. Safe to cancel rather than
      // merely overwrite-and-hope: this response is a full DTO read *after*
      // the seen write landed on the server, so it is at least as fresh as
      // any GET already in flight for the same session when it arrives —
      // cancelling one here can only ever discard a snapshot this response
      // already supersedes, never a genuinely newer one.
      const sessionKey = getApiSessionsIdQueryKey({ path: { id: data.id } })
      await queryClient.cancelQueries({ queryKey: sessionKey })
      // The updated DTO, straight into the cache the session page itself
      // reads — no refetch needed to see `unchecked` flip back to false.
      queryClient.setQueryData(sessionKey, data)
      void queryClient.invalidateQueries({ queryKey: getApiSessionsOverviewQueryKey() })
      void queryClient.invalidateQueries({
        queryKey: getApiProjectsIdSessionsQueryKey({ path: { id: data.projectId } }),
      })
      // This session just left the bell's own feed too (it only lists
      // *unchecked* results) — invalidated rather than patched locally,
      // since the feed also mixes in suggestions this response knows
      // nothing about.
      void queryClient.invalidateQueries({ queryKey: getApiNotificationsQueryKey() })
    },
  })
}
