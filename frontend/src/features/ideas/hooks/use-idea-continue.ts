import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiIdeasIdQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasId'
import { getApiIdeasIdCommentsQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdComments'
import { getApiIdeasIdPromptsQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdPrompts'
import { getApiProjectsIdIdeasQueryKey } from '@/shared/api/generated/hooks/useGetApiProjectsIdIdeas'
import { postApiIdeasIdContinueMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdContinue'

/**
 * `POST /ideas/{id}/continue` — the verification-column affordance: folds in
 * what the last run did and any unconsumed feedback comments into a follow-up
 * prompt, and hands it into the same session the idea already has. Not
 * exported from `use-idea-prompts.ts` alongside its sibling
 * `useGenerateIdeaPrompt`: this hits a different endpoint (`/continue`, not
 * `/prompts`) that the generated client already carries
 * (`usePostApiIdeasIdContinue.ts`) but that no hook here had yet wrapped —
 * added rather than left for a component to call the generated mutation
 * options directly, so this feature's mutations all go through the same
 * layer as every other one in this directory.
 *
 * Takes `projectId` alongside `ideaId`, unlike this file's siblings in
 * `use-idea-prompts.ts`: the detail page is the only caller, so both are
 * available at the call site, and the board's list needs invalidating too
 * (see below).
 *
 * Invalidates the same shape of query set `useGenerateIdeaPrompt` does: this
 * idea's own row (`latestPrompt`/`openRun`), its prompts (a new one was just
 * created) and its comments (unconsumed ones are folded in and stamped
 * `consumedAt` in the same transaction, per the endpoint's own description) —
 * plus the board's list, which `useGenerateIdeaPrompt` has no `projectId` to
 * reach.
 */
export function useContinueIdea(ideaId: string, projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiIdeasIdContinueMutationOptions(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: getApiProjectsIdIdeasQueryKey({ path: { id: projectId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdPromptsQueryKey({ path: { id: ideaId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdCommentsQueryKey({ path: { id: ideaId } }),
        }),
      ]),
  })
}
