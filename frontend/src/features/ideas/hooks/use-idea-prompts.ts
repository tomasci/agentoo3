import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiIdeasIdQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasId'
import { getApiIdeasIdCommentsQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdComments'
import {
  getApiIdeasIdPromptsQueryKey,
  getApiIdeasIdPromptsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasIdPrompts'
import { getApiIdeasIdRunsQueryOptions } from '@/shared/api/generated/hooks/useGetApiIdeasIdRuns'
import { postApiIdeasIdPromptsMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdPrompts'
import type { GetApiIdeasIdPromptsStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdPrompts'
import type { GetApiIdeasIdRunsStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdRuns'

// Both 200 responses are arrays, so a prompt and a run are each its own element type.
export type IdeaPrompt = GetApiIdeasIdPromptsStatus200[number]
export type IdeaRun = GetApiIdeasIdRunsStatus200[number]

const PENDING_PROMPT_POLL_MS = 1500

/** Polls while the most recent prompt is still `pending` — the same one-shot
 * generation call `isIdeaBusy` (lib/status.ts) already watches for at board
 * level, but read here from this idea's own history rather than the list DTO,
 * for a reader sitting on this one idea's page. Newest first, matching the
 * backend's own ordering (features/ideas/service.ts's `latestPromptFor`). */
export function useIdeaPrompts(ideaId: string) {
  return useQuery({
    ...getApiIdeasIdPromptsQueryOptions({ path: { id: ideaId } }),
    refetchInterval: (query) =>
      query.state.data?.[0]?.status === 'pending' ? PENDING_PROMPT_POLL_MS : false,
  })
}

/** Read-only here — a run is opened and closed by the handoff track this one
 * hands off to (features/ideas/service.ts's own doc comment). Polls on
 * `endedAt === null` rather than a specific status, so it does not have to
 * know which of `generating`/`dispatching`/`running` counts as "still open"
 * — none of them do once `endedAt` is set. */
export function useIdeaRuns(ideaId: string) {
  return useQuery({
    ...getApiIdeasIdRunsQueryOptions({ path: { id: ideaId } }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.endedAt === null) ? PENDING_PROMPT_POLL_MS : false,
  })
}

/**
 * Generate (or regenerate) a prompt. A `followup` also folds in every
 * unconsumed comment and stamps them `consumedAt` in the same transaction
 * (features/ideas/service.ts's `createIdeaPrompt`), so this invalidates the
 * comments list alongside the prompts list and the single-idea query
 * (`latestPrompt` is a card field — see `use-ideas.ts`) rather than assume
 * which kind was asked for.
 */
export function useGenerateIdeaPrompt(ideaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiIdeasIdPromptsMutationOptions(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdPromptsQueryKey({ path: { id: ideaId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdCommentsQueryKey({ path: { id: ideaId } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }),
        }),
      ]),
  })
}
