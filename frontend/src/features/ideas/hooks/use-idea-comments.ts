import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiIdeaCommentsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiIdeaCommentsId'
import { getApiIdeasIdQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasId'
import {
  getApiIdeasIdCommentsQueryKey,
  getApiIdeasIdCommentsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasIdComments'
import { postApiIdeasIdCommentsMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdComments'
import type { GetApiIdeasIdCommentsStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdComments'

// The 200 response is an array, so a comment is its element type. `consumedAt`
// is set once a followup prompt has folded it in — see `useGenerateIdeaPrompt`
// in `use-idea-prompts.ts`, the mutation that stamps it.
export type IdeaComment = GetApiIdeasIdCommentsStatus200[number]

export function useIdeaComments(ideaId: string) {
  return useQuery(getApiIdeasIdCommentsQueryOptions({ path: { id: ideaId } }))
}

function useInvalidateIdeaComments(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiIdeasIdCommentsQueryKey({ path: { id: ideaId } }),
    })
}

/** `commentCount` on the card (`use-ideas.ts`'s `Idea`) changes with every add
 * or delete here, so both invalidate the single-idea query alongside this
 * idea's own comments list — see `use-ideas.ts`'s comment on why an idea, with
 * no push channel of its own, needs that told to it directly rather than
 * waiting for the board's next poll. */
function useInvalidateIdeaForCommentCount(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }) })
}

export function useCreateIdeaComment(ideaId: string) {
  const invalidateComments = useInvalidateIdeaComments(ideaId)
  const invalidateIdea = useInvalidateIdeaForCommentCount(ideaId)
  return useMutation({
    ...postApiIdeasIdCommentsMutationOptions(),
    onSuccess: () => Promise.all([invalidateComments(), invalidateIdea()]),
  })
}

export function useDeleteIdeaComment(ideaId: string) {
  const invalidateComments = useInvalidateIdeaComments(ideaId)
  const invalidateIdea = useInvalidateIdeaForCommentCount(ideaId)
  return useMutation({
    ...deleteApiIdeaCommentsIdMutationOptions(),
    onSuccess: () => Promise.all([invalidateComments(), invalidateIdea()]),
  })
}
