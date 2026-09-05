import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { GetApiSessionsIdMessagesStatus200 } from '@/shared/api/generated/types/GetApiSessionsIdMessages'
import type { SessionMessage } from '../hooks/use-sessions'

/**
 * The cached shape for a session's transcript, and the one key it lives
 * under — owned entirely by this module so nothing else has to know that a
 * session's messages are paginated at all.
 *
 * `MessagesPageParam` is `number | undefined` rather than a bare `number`:
 * `undefined` is a real cursor value (the initial "newest `limit`" page has
 * no `seq` to anchor on yet), not only the `getPreviousPageParam` "no more
 * pages" sentinel — that stop condition is decided from a page's own
 * `hasOlder` flag instead (see `useSessionMessages` in `use-sessions.ts`), so
 * the two meanings of `undefined` never have to be told apart.
 */
export type MessagesPage = GetApiSessionsIdMessagesStatus200
export type MessagesPageParam = number | undefined
export type MessagesData = InfiniteData<MessagesPage, MessagesPageParam>

/**
 * The one cache key every page of a session's transcript is written under.
 *
 * Deliberately NOT the generated `getApiSessionsIdMessagesQueryKey`: kubb
 * folds `query` into that key, so `{ limit: 100 }` and `{ before: 40, limit:
 * 100 }` would each own their own cache entry instead of landing in the one
 * `InfiniteData` every page of a session belongs to. The `'infinite'` suffix
 * is not decorative: without it this key is identical to the generated one
 * for the no-cursor case (`limit` alone), and a plain `useQuery` landing on
 * that key would read or write an `InfiniteData` as though it were a bare
 * `MessagesPage`.
 */
export function sessionMessagesKey(sessionId: string) {
  return [{ url: '/api/sessions/:id/messages', params: { id: sessionId } }, 'infinite'] as const
}

/**
 * Whether two deliveries of the message at the same `seq` are the same
 * message, cheaply.
 *
 * `payload` is written once when a message row is created and never patched —
 * the runner's only in-place UPDATE on the messages table (session-run.worker,
 * `.update(messages).set({ pending: false })`) touches `pending` on the just-
 * sent prompt row and nothing else. So a message's identity for a given `seq`
 * is fully described by these scalars; comparing them is a complete equality
 * check, not an approximation, and it never has to walk a `payload` that can
 * be megabytes of Bash output just to conclude "yes, still the same".
 */
function sameMessage(a: SessionMessage, b: SessionMessage): boolean {
  return (
    a.pending === b.pending &&
    a.title === b.title &&
    a.type === b.type &&
    a.parentToolUseId === b.parentToolUseId &&
    a.createdAt === b.createdAt
  )
}

/**
 * Merge a batch of arrivals into a flat, ascending list, keyed on `seq`.
 *
 * A pure function (no QueryClient, no notion of a page) so the no-op case is
 * unit-testable: a message replayed unchanged at a `seq` already present must
 * return the exact same array reference, not a new one. `Transcript` is
 * memoised on that identity, so a new array on every replayed message was
 * rebuilding the whole tree — `buildTranscript()` over every message in the
 * session — for no visible change, on every stream (re)connect. A genuine
 * change still produces a new array, exactly as before.
 *
 * Kept flat rather than taught to operate on `InfiniteData` directly: the
 * merge itself is genuinely about a list, and `appendStreamedMessage` below is
 * the one place that needs to know it always applies to the *last* page — the
 * live tail — so pagination stays a fact this function never has to carry.
 */
export function mergeSessionMessages(
  existing: SessionMessage[] | undefined,
  incoming: SessionMessage[],
): SessionMessage[] {
  let list = existing ?? []
  for (const message of incoming) {
    const at = list.findIndex((m) => m.seq === message.seq)
    if (at !== -1) {
      const current = list[at]
      if (current && sameMessage(current, message)) continue
      list = list.slice()
      list[at] = message
      continue
    }
    // Append, then sort only when it actually arrived out of order.
    const next = [...list, message]
    const previous = next[next.length - 2]
    list = previous && previous.seq > message.seq ? next.sort((a, b) => a.seq - b.seq) : next
  }
  return list
}

/**
 * Highest `seq` cached for a session, or `-1` if nothing is cached yet.
 *
 * The stream (use-session-stream.ts) seeds its own cursor from this: `-1`
 * makes it ask the backend for `after=-1`, replaying the whole transcript,
 * which is the right answer only when the cache is genuinely empty. Walks
 * every page rather than trusting the last one to hold the highest `seq`,
 * for the same reason the old flat-array version walked the whole array
 * rather than reading its last element: nothing here guarantees arrival
 * order equals `seq` order.
 */
export function newestCachedSeq(queryClient: QueryClient, sessionId: string): number {
  const pages = queryClient.getQueryData<MessagesData>(sessionMessagesKey(sessionId))?.pages ?? []
  let max = -1
  for (const page of pages) {
    for (const message of page.messages) max = Math.max(max, message.seq)
  }
  return max
}

/**
 * Whether a `loadOlder` (backward) page fetch is in flight for this
 * session's transcript — the one query-core state `appendStreamedMessage`
 * below has to avoid racing: it snapshots `state.data.pages` the instant it
 * starts and replaces the whole `InfiniteData` with that snapshot on
 * resolution (`infiniteQueryBehavior`'s `addToStart`), discarding any write
 * made while it was in flight.
 *
 * Read off `fetchMeta.fetchMore.direction` rather than the coarser
 * `queryClient.isFetching({ queryKey })`: `loadOlder` is, in practice, the
 * only fetch this query ever performs after its initial load (`staleTime:
 * Infinity` on `useSessionMessages` means nothing here is ever stale enough
 * for react-query's own background refetches to fire, and nothing in this
 * codebase invalidates this key), so the two checks agree today — but naming
 * the direction records *why* a write is unsafe rather than merely *when*
 * one happened to be observed. A plain "is this key fetching" would also
 * defer around some future fetch added to this query without anyone having
 * decided it needed to; this way, that decision still has to be made on
 * purpose. A named export, not a raw call site in `use-session-stream.ts`,
 * because the cache key and shape are this module's to know, not the
 * stream's.
 */
export function isFetchingOlderPage(queryClient: QueryClient, sessionId: string): boolean {
  const state = queryClient.getQueryState<MessagesData>(sessionMessagesKey(sessionId))
  return state?.fetchStatus === 'fetching' && state.fetchMeta?.fetchMore?.direction === 'backward'
}

/**
 * Merge streamed arrivals into the cached pages.
 *
 * Streamed messages are always newer than whatever pagination has loaded so
 * far — the stream's own cursor is seeded from `newestCachedSeq`, above — so
 * they always belong in the *last* page, the live tail that `selectMessages`
 * (use-sessions.ts) flattens in last. Every page this does not touch keeps
 * its own array reference: react-query's structural sharing and `select`'s
 * memoisation both key off which elements moved, and reallocating an
 * untouched older page would defeat both for nothing — the reader is not
 * rereading page 1 just because page 4 grew.
 *
 * Guards against the `loadOlder` race directly, rather than trusting every
 * caller to check `isFetchingOlderPage` first: a `loadOlder` fetch snapshots
 * `state.data.pages` the instant it starts and, on resolution, replaces the
 * whole `InfiniteData` with that snapshot plus the new page (query-core's
 * `addToStart`) — a `setQueryData` landing in between is not merged into
 * that result, it is discarded outright, no matter who made it or how soon
 * after. There is no write that survives that window, so this does not
 * attempt one: it waits for the fetch to settle and re-runs itself once it's
 * safe. `use-session-stream.ts` also checks the same flag before ever
 * calling in here, so in the normal (EventSource) path every arrival during
 * a slow fetch piles into its own buffer and lands as one write instead of
 * one deferred subscription per animation frame — but that is an efficiency
 * the stream buys for itself, not a precondition this relies on.
 */
export function appendStreamedMessage(
  queryClient: QueryClient,
  sessionId: string,
  messages: SessionMessage[],
): void {
  if (messages.length === 0) return
  if (isFetchingOlderPage(queryClient, sessionId)) {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (isFetchingOlderPage(queryClient, sessionId)) return
      unsubscribe()
      appendStreamedMessage(queryClient, sessionId, messages)
    })
    return
  }
  queryClient.setQueryData<MessagesData>(sessionMessagesKey(sessionId), (existing) => {
    if (!existing) {
      // `enabled` gates the stream on the messages query's own `isSuccess`, so
      // this should not happen in practice — seeded here anyway rather than
      // silently dropping the arrival if it ever does.
      return {
        pages: [{ messages: mergeSessionMessages(undefined, messages), hasOlder: false }],
        pageParams: [undefined],
      }
    }
    const lastIndex = existing.pages.length - 1
    const last = existing.pages[lastIndex]
    if (!last) {
      // Same call as the `!existing` branch above, and for the same reason:
      // an `InfiniteData` that has pages but none of them are "the last one"
      // only happens with `pages: []`, and dropping the arrival there is
      // exactly what that branch already refuses to do. Nothing in the app
      // produces a zero-page cache today — the initial fetch always returns
      // at least one page, empty or not — so this is unreachable in
      // practice; cheap enough to handle anyway rather than leave a silent
      // drop sitting next to a branch that explicitly rejects one.
      return {
        ...existing,
        pages: [{ messages: mergeSessionMessages(undefined, messages), hasOlder: false }],
        pageParams: [undefined],
      }
    }
    const mergedTail = mergeSessionMessages(last.messages, messages)
    if (mergedTail === last.messages) return existing // no-op: keep the whole InfiniteData reference too
    const pages = existing.pages.slice()
    pages[lastIndex] = { ...last, messages: mergedTail }
    return { ...existing, pages }
  })
}
