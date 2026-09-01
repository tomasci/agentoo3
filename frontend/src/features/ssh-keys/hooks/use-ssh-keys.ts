import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiSshKeysIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSshKeysId'
import {
  getApiSshKeysQueryKey,
  getApiSshKeysQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSshKeys'
import { postApiSshKeysMutationOptions } from '@/shared/api/generated/hooks/usePostApiSshKeys'
import { postApiSshKeysIdTestMutationOptions } from '@/shared/api/generated/hooks/usePostApiSshKeysIdTest'
import type { GetApiSshKeysStatus200 } from '@/shared/api/generated/types/GetApiSshKeys'

// The 200 response is an array, so a key is its element type.
export type SshKey = GetApiSshKeysStatus200[number]

export function useSshKeys() {
  return useQuery(getApiSshKeysQueryOptions())
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: getApiSshKeysQueryKey() })
}

export function useCreateSshKey() {
  const invalidate = useInvalidate()
  return useMutation({ ...postApiSshKeysMutationOptions(), onSuccess: () => invalidate() })
}

export function useTestSshKey() {
  const invalidate = useInvalidate()
  // The result is stored on the key, so refresh the list to show it.
  return useMutation({ ...postApiSshKeysIdTestMutationOptions(), onSuccess: () => invalidate() })
}

export function useDeleteSshKey() {
  const invalidate = useInvalidate()
  return useMutation({ ...deleteApiSshKeysIdMutationOptions(), onSuccess: () => invalidate() })
}
