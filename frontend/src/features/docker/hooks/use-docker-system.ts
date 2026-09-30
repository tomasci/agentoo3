import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiDockerContainersQueryKey,
  getApiDockerContainersQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiDockerContainers'
import { getApiProjectsIdDockerQueryKey } from '@/shared/api/generated/hooks/useGetApiProjectsIdDocker'
import { postApiDockerContainersContaineridStopMutationOptions } from '@/shared/api/generated/hooks/usePostApiDockerContainersContaineridStop'
import type { GetApiDockerContainersStatus200 } from '@/shared/api/generated/types/GetApiDockerContainers'
import type { SystemContainerOwner } from '../lib/system'

/**
 * Every container on the docker host, across every project — the System
 * tab's Docker page (docker-system-page.tsx). Same polling idiom as
 * `useSessionsOverview` (features/sessions/hooks/use-sessions.ts): a fixed
 * 5s interval, paused while the tab is in the background, plus the page's
 * own Refresh button and `keepPreviousData` so a poll never blanks the table
 * while it refetches.
 */
export function useDockerSystemContainers() {
  return useQuery({
    ...getApiDockerContainersQueryOptions(),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  })
}

/**
 * Stops one container by its full id, from anywhere on the host regardless
 * of which project (if any) owns it.
 *
 * `container` in the response is null when the stop succeeded and the
 * daemon has since removed the container itself (a `docker run --rm`
 * container auto-removes the moment it stops) — there is no fresher state
 * left to report, so the row is dropped from the cached list instead of
 * written into it (a `null` must never land in `containers[]`), and the list
 * query is invalidated so the next fetch is the authoritative read of
 * whatever the daemon actually did with it.
 *
 * Otherwise this writes the endpoint's own fresh container straight into
 * the list query's cache — no second GET just to see the state it already
 * handed back — and, when the container carries an owner, invalidates that
 * project's own Docker status query so a project Docker page open in another
 * tab (docker-page.tsx's `useDockerStatus`) picks up the same stop. Invali-
 * dated by `projectId` alone, with no `query` half of the key: the container
 * could belong to the project's own repo/ checkout or to any one session's
 * worktree, and this list has no reason to know which — the project page's
 * query key nests `sessionId` as a second array element
 * (getApiProjectsIdDockerQueryKey), so a `projectId`-only filter matches
 * every scope's cache entry for that project at once. When the response
 * carries no owner (the null case), the owner is read off the cached row
 * before it's removed, since there's nothing left in the response to read it
 * from.
 */
export function useStopDockerSystemContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiDockerContainersContaineridStopMutationOptions(),
    onSuccess: (data, variables) => {
      const containerId = variables.path.containerId
      let removedOwner: SystemContainerOwner | null = null
      queryClient.setQueryData<GetApiDockerContainersStatus200>(
        getApiDockerContainersQueryKey(),
        (current) => {
          if (!current) return current
          const fresh = data.container
          if (fresh) {
            return {
              ...current,
              containers: current.containers.map((container) =>
                container.id === fresh.id ? fresh : container,
              ),
            }
          }
          removedOwner =
            current.containers.find((container) => container.id === containerId)?.owner ?? null
          return {
            ...current,
            containers: current.containers.filter((container) => container.id !== containerId),
          }
        },
      )
      const owner = data.container ? data.container.owner : removedOwner
      if (owner) {
        void queryClient.invalidateQueries({
          queryKey: getApiProjectsIdDockerQueryKey({ path: { id: owner.projectId } }),
        })
      }
      if (!data.container) {
        void queryClient.invalidateQueries({ queryKey: getApiDockerContainersQueryKey() })
      }
    },
  })
}
