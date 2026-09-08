import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiSystemPromptsNameMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSystemPromptsName'
import {
  getApiSystemPromptsNameQueryKey,
  getApiSystemPromptsNameQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSystemPromptsName'
import { putApiSystemPromptsNameMutationOptions } from '@/shared/api/generated/hooks/usePutApiSystemPromptsName'
import type { GetApiSystemPromptsNameStatus200 } from '@/shared/api/generated/types/GetApiSystemPromptsName'

export type Prompt = GetApiSystemPromptsNameStatus200

export function usePrompt(name: string) {
  return useQuery({
    ...getApiSystemPromptsNameQueryOptions({ path: { name } }),
    enabled: Boolean(name),
  })
}

function useInvalidatePrompt(name: string) {
  const queryClient = useQueryClient()
  return () =>
    void queryClient.invalidateQueries({
      queryKey: getApiSystemPromptsNameQueryKey({ path: { name } }),
    })
}

export function useUpdatePrompt(name: string) {
  const invalidate = useInvalidatePrompt(name)
  return useMutation({ ...putApiSystemPromptsNameMutationOptions(), onSuccess: invalidate })
}

// Reverts to the built-in default rather than deleting anything the operator
// can address again — see the backend route's own doc comment (deletes the
// saved file, so GET immediately falls back to the fallback constant).
export function useResetPrompt(name: string) {
  const invalidate = useInvalidatePrompt(name)
  return useMutation({ ...deleteApiSystemPromptsNameMutationOptions(), onSuccess: invalidate })
}
