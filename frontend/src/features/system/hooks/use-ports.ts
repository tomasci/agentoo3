import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getApiSystemPortsQueryOptions } from '@/shared/api/generated/hooks/useGetApiSystemPorts'
import type {
  GetApiSystemPortsScopeKey,
  GetApiSystemPortsStatus200,
} from '@/shared/api/generated/types/GetApiSystemPorts'

export type PortScope = GetApiSystemPortsScopeKey
export type PortEntry = GetApiSystemPortsStatus200['ports'][number]

/**
 * The host's current port -> process table (a structured `ss -tulpn`),
 * scoped to `listening` or `all` sockets — see the query key, which folds
 * `scope` in (`getApiSystemPortsQueryOptions`'s own key includes the query),
 * so switching scope is a distinct cache entry rather than a filter over one.
 *
 * No `refetchInterval`: this is a Refresh-button page, not a polled one —
 * a reader asks for a new read when they want one. `retry: false`: a 503
 * means neither `ss` nor /proc could be read at all, and retrying only
 * delays that message rather than fixing it. `staleTime: 0`: a port table is
 * a snapshot of "right now", so coming back to this page after time away
 * should re-fetch rather than show a stale one as current.
 *
 * `refetchOnWindowFocus: false` and `refetchOnReconnect: false`: this page's
 * own contract is manual refresh only, so it must not depend on the app-wide
 * `refetchOnWindowFocus: false` in providers.tsx — with `staleTime: 0`,
 * TanStack's own defaults would otherwise refetch on both of those, which
 * would make Refresh's own spinner lie about when a request is in flight.
 * `refetchOnMount` stays at its default: a fresh visit to the page should
 * still fetch.
 *
 * `placeholderData: keepPreviousData`: switching scope is a distinct query
 * key (above), so without this `data` goes back to `undefined` the instant
 * the toggle is clicked — the whole table, and the toggle itself, would
 * disappear behind a spinner and then pop back once the new scope resolves.
 * Keeping the outgoing scope's rows on screen (the page dims them via
 * `isPlaceholderData` while the new ones load) reads as one steady table
 * instead of that flicker — same trade `useSessionsOverview`'s own comment
 * (features/sessions/hooks/use-sessions.ts) makes for its window toggle.
 */
export function usePorts(scope: PortScope) {
  return useQuery({
    ...getApiSystemPortsQueryOptions({ query: { scope } }),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  })
}
