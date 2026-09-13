import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiDockerDetectionQueryOptions } from '@/shared/api/generated/hooks/useGetApiDockerDetection'
import {
  getApiProjectsIdDockerQueryKey,
  getApiProjectsIdDockerQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdDocker'
import { postApiProjectsIdDockerDownMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdDockerDown'
import { postApiProjectsIdDockerRestartMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdDockerRestart'
import { postApiProjectsIdDockerStopMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdDockerStop'
import { postApiProjectsIdDockerUpMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdDockerUp'

/**
 * One project's full docker state: detection, daemon health, services,
 * containers, hosts — everything the page renders.
 *
 * Polled, never pushed: the four mutations below only ever return a queued
 * operation, and the work itself runs on a worker (see the SSE operation
 * stream, use-operation-stream.ts, for the one place actual progress is
 * pushed). Fast while an operation is in flight so a start/stop is reflected
 * within a couple of seconds, slow the rest of the time — the same
 * conditional-`refetchInterval` idiom as `useProjects`
 * (features/projects/hooks/use-projects.ts) and `useStorageSummary`
 * (features/storage/hooks/use-storage.ts).
 */
export function useDockerStatus(projectId: string) {
  return useQuery({
    ...getApiProjectsIdDockerQueryOptions({ path: { id: projectId } }),
    refetchInterval: (query) => (query.state.data?.activeOperationId ? 2000 : 10_000),
  })
}

/**
 * Detection for every project, one call — used to put a small indicator on
 * the projects list/overview (projects-table.tsx, project-overview.tsx)
 * without each row polling its own `/docker` status. `staleTime` is
 * generous and there is no `refetchInterval`: what compose/Dockerfile files
 * exist changes on the scale of a commit, not something worth polling for.
 */
export function useDockerDetection() {
  return useQuery({ ...getApiDockerDetectionQueryOptions(), staleTime: 30_000 })
}

export function useInvalidateDockerStatus(projectId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiProjectsIdDockerQueryKey({ path: { id: projectId } }),
    })
}

/**
 * The four operation-starting mutations. Each only invalidates the status
 * query on success — not on the operation's own completion, which nobody
 * here waits for synchronously. The fast poll interval above (while
 * `activeOperationId` is set) and the operation stream's own `end` frame
 * (use-operation-stream.ts, which invalidates again there) are what actually
 * catch the real "it's done".
 */
export function useDockerUp(projectId: string) {
  const invalidate = useInvalidateDockerStatus(projectId)
  return useMutation({
    ...postApiProjectsIdDockerUpMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useDockerStop(projectId: string) {
  const invalidate = useInvalidateDockerStatus(projectId)
  return useMutation({
    ...postApiProjectsIdDockerStopMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useDockerRestart(projectId: string) {
  const invalidate = useInvalidateDockerStatus(projectId)
  return useMutation({
    ...postApiProjectsIdDockerRestartMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useDockerDown(projectId: string) {
  const invalidate = useInvalidateDockerStatus(projectId)
  return useMutation({
    ...postApiProjectsIdDockerDownMutationOptions(),
    onSuccess: () => invalidate(),
  })
}
