import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiIdeaBlocksIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiIdeaBlocksId'
import { deleteApiIdeaGroupsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiIdeaGroupsId'
import { getApiIdeasIdQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasId'
import {
  getApiIdeasIdBlocksQueryKey,
  getApiIdeasIdBlocksQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import {
  getApiIdeasIdGroupsQueryKey,
  getApiIdeasIdGroupsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasIdGroups'
import { patchApiIdeaBlocksIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiIdeaBlocksId'
import { patchApiIdeaGroupsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiIdeaGroupsId'
import { postApiIdeasIdBlocksMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdBlocks'
import { postApiIdeasIdGroupsMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdGroups'
import type { GetApiIdeasIdBlocksStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdBlocks'
import type { GetApiIdeasIdGroupsStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdGroups'

// The idea's spatial canvas: typed blocks (the 200 response is an array, so a
// block is its element type — a discriminated union on `kind`) and the groups
// they can be dropped into. Neither polls: nothing here changes except
// through a direct edit on the same canvas the reader has open, unlike the
// board's own `latestPrompt`/`openRun` fields (see `use-ideas.ts`).
export type IdeaBlock = GetApiIdeasIdBlocksStatus200[number]
export type IdeaBlockKind = IdeaBlock['kind']
export type IdeaGroup = GetApiIdeasIdGroupsStatus200[number]

export function useIdeaBlocks(ideaId: string) {
  return useQuery(getApiIdeasIdBlocksQueryOptions({ path: { id: ideaId } }))
}

export function useIdeaGroups(ideaId: string) {
  return useQuery(getApiIdeasIdGroupsQueryOptions({ path: { id: ideaId } }))
}

function useInvalidateIdeaBlocks(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiIdeasIdBlocksQueryKey({ path: { id: ideaId } }),
    })
}

function useInvalidateIdeaGroups(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiIdeasIdGroupsQueryKey({ path: { id: ideaId } }),
    })
}

/** Only a block's own create/delete change the idea's `blockCount` (the card
 * field the board reads) — `useUpdateIdeaBlock` below moves or edits one in
 * place and leaves the count untouched, so it invalidates only the blocks
 * list, not the idea row too. */
function useInvalidateIdeaForBlockCount(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }) })
}

export function useCreateIdeaBlock(ideaId: string) {
  const invalidateBlocks = useInvalidateIdeaBlocks(ideaId)
  const invalidateIdea = useInvalidateIdeaForBlockCount(ideaId)
  return useMutation({
    ...postApiIdeasIdBlocksMutationOptions(),
    onSuccess: () => Promise.all([invalidateBlocks(), invalidateIdea()]),
  })
}

export function useUpdateIdeaBlock(ideaId: string) {
  const invalidate = useInvalidateIdeaBlocks(ideaId)
  return useMutation({ ...patchApiIdeaBlocksIdMutationOptions(), onSuccess: () => invalidate() })
}

export function useDeleteIdeaBlock(ideaId: string) {
  const invalidateBlocks = useInvalidateIdeaBlocks(ideaId)
  const invalidateIdea = useInvalidateIdeaForBlockCount(ideaId)
  return useMutation({
    ...deleteApiIdeaBlocksIdMutationOptions(),
    onSuccess: () => Promise.all([invalidateBlocks(), invalidateIdea()]),
  })
}

// Groups have no card-visible count of their own, so their mutations only
// ever touch this idea's own groups list.

export function useCreateIdeaGroup(ideaId: string) {
  const invalidate = useInvalidateIdeaGroups(ideaId)
  return useMutation({ ...postApiIdeasIdGroupsMutationOptions(), onSuccess: () => invalidate() })
}

export function useUpdateIdeaGroup(ideaId: string) {
  const invalidate = useInvalidateIdeaGroups(ideaId)
  return useMutation({ ...patchApiIdeaGroupsIdMutationOptions(), onSuccess: () => invalidate() })
}

export function useDeleteIdeaGroup(ideaId: string) {
  const invalidate = useInvalidateIdeaGroups(ideaId)
  return useMutation({ ...deleteApiIdeaGroupsIdMutationOptions(), onSuccess: () => invalidate() })
}
