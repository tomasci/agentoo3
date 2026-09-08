import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiIdeasIdBlocksQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import { postApiIdeasIdBlocksReorderMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdBlocksReorder'

/**
 * `POST /ideas/{id}/blocks/reorder` — the correcting half of `seq` (see
 * `idea_blocks.seq`, backend `db/schema.ts`): a drag only ever moves a
 * block's x/y, never its reading order, so this is the *only* thing in this
 * track allowed to change `seq`, and it is only ever called from an explicit
 * user action (the list's move-up/down, or the canvas's "reorder from
 * layout") — never from a drag handler.
 *
 * Kept here rather than in `hooks/use-idea-canvas.ts`: that file is T11's,
 * off limits to this track (see the report), and this mutation is new in
 * this one.
 */
export function useReorderIdeaBlocks(ideaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiIdeasIdBlocksReorderMutationOptions(),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: getApiIdeasIdBlocksQueryKey({ path: { id: ideaId } }),
      }),
  })
}
