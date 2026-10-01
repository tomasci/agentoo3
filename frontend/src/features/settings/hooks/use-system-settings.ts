import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiSystemSettingsQueryKey,
  getApiSystemSettingsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSystemSettings'
import { patchApiSystemSettingsMutationOptions } from '@/shared/api/generated/hooks/usePatchApiSystemSettings'

export function useSystemSettings() {
  return useQuery(getApiSystemSettingsQueryOptions())
}

// Invalidates rather than writing the mutation's own response straight into
// the cache: the same choice use-prompts.ts makes for its save/reset pair,
// one more round trip in exchange for never trusting an optimistic echo of
// what this call alone thinks is now true (see settings.ts's own doc comment
// on why a write re-reads rather than returning what it wrote).
export function useUpdateSystemSettings() {
  const queryClient = useQueryClient()
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getApiSystemSettingsQueryKey() })
  return useMutation({ ...patchApiSystemSettingsMutationOptions(), onSuccess: invalidate })
}
