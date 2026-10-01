import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { deleteApiLibrarySuggestionsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiLibrarySuggestionsId'
import { getApiLibraryAgentsQueryKey } from '@/shared/api/generated/hooks/useGetApiLibraryAgents'
import {
  getApiLibraryAgentsNameVersionsQueryKey,
  getApiLibraryAgentsNameVersionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibraryAgentsNameVersions'
import {
  getApiLibraryLearningQueryKey,
  getApiLibraryLearningQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibraryLearning'
import { getApiLibrarySkillsQueryKey } from '@/shared/api/generated/hooks/useGetApiLibrarySkills'
import {
  getApiLibrarySkillsNameVersionsQueryKey,
  getApiLibrarySkillsNameVersionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibrarySkillsNameVersions'
import {
  getApiLibrarySuggestionsQueryKey,
  getApiLibrarySuggestionsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibrarySuggestions'
import {
  getApiLibrarySuggestionsIdQueryKey,
  getApiLibrarySuggestionsIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibrarySuggestionsId'
import { postApiLibraryLearningRunsMutationOptions } from '@/shared/api/generated/hooks/usePostApiLibraryLearningRuns'
import { postApiLibrarySuggestionsIdApplyMutationOptions } from '@/shared/api/generated/hooks/usePostApiLibrarySuggestionsIdApply'
import { postApiLibrarySuggestionsIdRejectMutationOptions } from '@/shared/api/generated/hooks/usePostApiLibrarySuggestionsIdReject'
import type { GetApiLibrarySuggestionsStatusKey } from '@/shared/api/generated/types/GetApiLibrarySuggestions'
import type { LibrarySuggestion } from '@/shared/api/generated/types/LibrarySuggestion'

export type { LearningOverview } from '@/shared/api/generated/types/LearningOverview'
export type { LearningRun } from '@/shared/api/generated/types/LearningRun'
export type { LibraryItemVersion } from '@/shared/api/generated/types/LibraryItemVersion'
export type { LibrarySuggestion } from '@/shared/api/generated/types/LibrarySuggestion'
export type {
  LibrarySuggestionSummary,
  LibrarySuggestionSummaryActionEnumKey as SuggestionAction,
  LibrarySuggestionSummaryKindEnumKey as SuggestionKind,
} from '@/shared/api/generated/types/LibrarySuggestionSummary'
export type SuggestionStatus = GetApiLibrarySuggestionsStatusKey

const ACTIVE_RUN_POLL_MS = 5_000
// Nothing pushes a scheduled run's own start, so this is how a reader who
// left the Suggested view open across 04:00 learns one began without
// reloading — slow, since it is only a "did anything start" check, not the
// 5s poll that actually follows a run's own progress once one is.
const IDLE_POLL_MS = 30_000

/**
 * The learning panel's own read: the schedule, any run in flight, and the
 * last finished one. Polls fast while a run is active and slowly otherwise
 * (see the constants above), and invalidates every suggestion list the
 * moment a run that *was* active stops being the active one — that is the
 * one signal a newly-created suggestion exists at all, since nothing else
 * pushes it.
 */
export function useLearningOverview() {
  const queryClient = useQueryClient()
  const previousActiveRunId = useRef<string | null>(null)

  const query = useQuery({
    ...getApiLibraryLearningQueryOptions(),
    refetchInterval: (q) => (q.state.data?.activeRun ? ACTIVE_RUN_POLL_MS : IDLE_POLL_MS),
  })

  const activeRunId = query.data?.activeRun?.id ?? null
  useEffect(() => {
    if (previousActiveRunId.current && !activeRunId) {
      void queryClient.invalidateQueries({ queryKey: getApiLibrarySuggestionsQueryKey() })
    }
    previousActiveRunId.current = activeRunId
  }, [activeRunId, queryClient])

  return query
}

export function useRunLearningNow() {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiLibraryLearningRunsMutationOptions(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: getApiLibraryLearningQueryKey() }),
  })
}

export function useSuggestions(status: SuggestionStatus) {
  return useQuery(getApiLibrarySuggestionsQueryOptions({ query: { status } }))
}

export function useSuggestion(id: string) {
  return useQuery({
    ...getApiLibrarySuggestionsIdQueryOptions({ path: { id } }),
    enabled: Boolean(id),
  })
}

/** Every list a change in one suggestion's status can affect — the three
 *  status tabs share one endpoint keyed by `status`, so invalidating the
 *  unparemeterized key clears all of them at once (partial match). */
function invalidateSuggestionLists(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: getApiLibrarySuggestionsQueryKey() })
}

export function useApplySuggestion(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiLibrarySuggestionsIdApplyMutationOptions(),
    onSuccess: (data: LibrarySuggestion) => {
      invalidateSuggestionLists(queryClient)
      void queryClient.invalidateQueries({
        queryKey: getApiLibrarySuggestionsIdQueryKey({ path: { id } }),
      })
      // The applied item's own list and version history, so the editor the
      // reader lands on next shows the new version straight away rather than
      // a stale cache entry from before the apply.
      if (data.kind === 'agent') {
        void queryClient.invalidateQueries({ queryKey: getApiLibraryAgentsQueryKey() })
        void queryClient.invalidateQueries({
          queryKey: getApiLibraryAgentsNameVersionsQueryKey({ path: { name: data.name } }),
        })
      } else {
        void queryClient.invalidateQueries({ queryKey: getApiLibrarySkillsQueryKey() })
        void queryClient.invalidateQueries({
          queryKey: getApiLibrarySkillsNameVersionsQueryKey({ path: { name: data.name } }),
        })
      }
    },
  })
}

// `id` is optional: the Suggested list rejects whichever row's id is current
// at mutate() time (there is no one "current" suggestion to key an extra
// invalidation off of), while the review page already knows its own id and
// passes it so its own cached detail is invalidated too.
export function useRejectSuggestion(id?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postApiLibrarySuggestionsIdRejectMutationOptions(),
    onSuccess: () => {
      invalidateSuggestionLists(queryClient)
      if (id) {
        void queryClient.invalidateQueries({
          queryKey: getApiLibrarySuggestionsIdQueryKey({ path: { id } }),
        })
      }
    },
  })
}

export function useDeleteSuggestion() {
  const queryClient = useQueryClient()
  return useMutation({
    ...deleteApiLibrarySuggestionsIdMutationOptions(),
    onSuccess: () => invalidateSuggestionLists(queryClient),
  })
}

export function useAgentVersions(name: string) {
  return useQuery({
    ...getApiLibraryAgentsNameVersionsQueryOptions({ path: { name } }),
    enabled: Boolean(name),
  })
}

export function useSkillVersions(name: string) {
  return useQuery({
    ...getApiLibrarySkillsNameVersionsQueryOptions({ path: { name } }),
    enabled: Boolean(name),
  })
}
