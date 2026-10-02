import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteProjectEnvFileMutationOptions } from '@/shared/api/generated/hooks/useDeleteProjectEnvFile'
import {
  listProjectEnvFilesQueryKey,
  listProjectEnvFilesQueryOptions,
} from '@/shared/api/generated/hooks/useListProjectEnvFiles'
import { putProjectEnvFileMutationOptions } from '@/shared/api/generated/hooks/usePutProjectEnvFile'
import type { ListProjectEnvFilesStatus200 } from '@/shared/api/generated/types/ListProjectEnvFiles'

// The 200 response is `{ files: [...] }`, so a file is the array's element type.
export type EnvFile = ListProjectEnvFilesStatus200['files'][number]

/**
 * One project's stored env files, sorted by path — the server does the
 * sorting (routes.ts's `listProjectEnvFiles`), so there is nothing to repeat
 * here. No polling: unlike docker status (use-docker.ts), nothing here
 * changes except through this page's own mutations, and those already
 * invalidate the query below on success.
 */
export function useListEnvFiles(projectId: string) {
  return useQuery(listProjectEnvFilesQueryOptions({ path: { id: projectId } }))
}

function useInvalidate(projectId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: listProjectEnvFilesQueryKey({ path: { id: projectId } }),
    })
}

/** Creates a file (and its parent folders, in the store) or overwrites one
 * already there — the same request for "add" (empty content) and "save". */
export function usePutEnvFile(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation({ ...putProjectEnvFileMutationOptions(), onSuccess: () => invalidate() })
}

export function useDeleteEnvFile(projectId: string) {
  const invalidate = useInvalidate(projectId)
  return useMutation({ ...deleteProjectEnvFileMutationOptions(), onSuccess: () => invalidate() })
}
