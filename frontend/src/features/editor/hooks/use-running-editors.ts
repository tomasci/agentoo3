import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiEditorsQueryKey,
  getApiEditorsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiEditors'
import { postApiProjectsIdSessionsSessionidEditorStopMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdSessionsSessionidEditorStop'

// How often the running-editors panel refreshes while it actually has
// something to show — fast enough that "In use"/"Idle" reads as current, not
// so fast it hammers `/api/editors` while a reader is just looking at it.
const POLL_MS = 10_000

/**
 * Every editor container currently holding the box-wide running cap — unlike
 * every other query in this feature, never scoped to this tab's own session
 * (editor-launcher.tsx's `useEditorStatus`), because its whole point is to
 * show what's running *elsewhere*.
 *
 * Callers mount this only once a start has actually failed
 * (editor-launcher.tsx), so there is no `enabled` flag here — the query
 * fetches the moment it is created and stops the moment its one caller
 * unmounts it, the same "mount is the on/off switch" idiom
 * features/docker/components/service-list.tsx's `ContainerPanel` uses for its
 * own log stream. Once fetched, it keeps polling only for as long as the data
 * says the panel would still be showing anything (`enabled && running >=
 * cap`) — a slot freeing up (or the feature going away) is also the moment
 * there is nothing left worth refreshing for.
 */
export function useRunningEditors() {
  return useQuery({
    ...getApiEditorsQueryOptions(),
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.enabled && data.running >= data.cap ? POLL_MS : false
    },
  })
}

/**
 * Stops any session's editor from the running-editors panel — deliberately
 * not `useEditorStop` (use-editor.ts): that hook writes its response straight
 * into *this tab's own* session status cache, which is never the row being
 * stopped here. The one thing worth doing with a successful stop is making
 * the list this panel is reading catch up, so the reader immediately sees
 * one fewer row (and, via the panel's own `refetchInterval`, the cap it was
 * measured against) — invalidating rather than reading the response directly
 * also picks up whatever `otherInstallsRunning`/`running` moved to, which
 * this response alone doesn't carry.
 */
export function useStopRunningEditor() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiProjectsIdSessionsSessionidEditorStopMutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getApiEditorsQueryKey() }),
  })
}
