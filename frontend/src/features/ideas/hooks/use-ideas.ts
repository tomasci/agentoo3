import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiIdeasIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiIdeasId'
import {
  getApiIdeasIdQueryKey,
  getApiIdeasIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasId'
import {
  getApiProjectsIdIdeasQueryKey,
  getApiProjectsIdIdeasQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdIdeas'
import { patchApiIdeasIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiIdeasId'
import { postApiIdeasIdMoveMutationOptions } from '@/shared/api/generated/hooks/usePostApiIdeasIdMove'
import { postApiProjectsIdIdeasMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdIdeas'
import type { GetApiProjectsIdIdeasStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdIdeas'
import { isIdeaBusy } from '../lib/status'

// The 200 response is an array, so an idea (a board card) is its element
// type — see `GetApiIdeasIdStatus200` (the single-get endpoint) for the same
// shape one row at a time; both come from the backend's one `ideaSchema`, so
// nothing here has to cast between them.
export type Idea = GetApiProjectsIdIdeasStatus200[number]
export type IdeaStatus = Idea['status']

/** How often the board polls while something is busy — see `isIdeaBusy`
 * (lib/status.ts) for what "busy" means. Same cadence `useProjects` polls
 * cloning at, for the same reason: it is a worker doing the work, not
 * something the reader is about to wait seconds for either way. */
const BUSY_POLL_MS = 1500

/**
 * The board's own read: every idea for a project, already grouped by column
 * and ordered within it (the backend orders by `status, boardPosition`).
 *
 * Polls while any card is busy and stops the moment none are — prompt
 * generation and a handed-off session both run with no push channel of their
 * own into this list (see `isIdeaBusy`'s own comment), so this is the only way
 * the board ever learns a card moved on without the reader refreshing by hand.
 */
export function useIdeas(projectId: string) {
  return useQuery({
    ...getApiProjectsIdIdeasQueryOptions({ path: { id: projectId } }),
    refetchInterval: (query) => ((query.state.data ?? []).some(isIdeaBusy) ? BUSY_POLL_MS : false),
  })
}

/** One idea's own row — the detail a canvas page reads its header from.
 * Polls on the same "busy" predicate as `useIdeas`, since a reader sitting on
 * one idea's page needs exactly the same "did this move on" answer the board
 * does, for the same reason (no per-idea push channel). */
export function useIdea(ideaId: string) {
  return useQuery({
    ...getApiIdeasIdQueryOptions({ path: { id: ideaId } }),
    refetchInterval: (query) =>
      query.state.data && isIdeaBusy(query.state.data) ? BUSY_POLL_MS : false,
  })
}

function useInvalidateIdeas(projectId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiProjectsIdIdeasQueryKey({ path: { id: projectId } }),
    })
}

export function useCreateIdea(projectId: string) {
  const invalidate = useInvalidateIdeas(projectId)
  return useMutation({
    ...postApiProjectsIdIdeasMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

/**
 * Unlike a session — kept fresh by its own SSE `status` event
 * (`features/sessions/hooks/use-session-stream.ts`) — an idea has no per-row
 * push channel, so `useUpdateIdea`/`useDeleteIdea`/`useMoveIdea` below also
 * invalidate the single-idea query directly rather than leaving that to the
 * next poll: the mutation already knows the id, so there is nothing to gain
 * by waiting.
 */
function useInvalidateIdea() {
  const queryClient = useQueryClient()
  return (ideaId: string) =>
    queryClient.invalidateQueries({ queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }) })
}

export function useUpdateIdea(projectId: string) {
  const invalidateList = useInvalidateIdeas(projectId)
  const invalidateIdea = useInvalidateIdea()
  return useMutation({
    ...patchApiIdeasIdMutationOptions(),
    onSuccess: (idea) => Promise.all([invalidateList(), invalidateIdea(idea.id)]),
  })
}

export function useDeleteIdea(projectId: string) {
  const invalidateList = useInvalidateIdeas(projectId)
  const invalidateIdea = useInvalidateIdea()
  return useMutation({
    ...deleteApiIdeasIdMutationOptions(),
    onSuccess: (_data, variables) =>
      Promise.all([invalidateList(), invalidateIdea(variables.path.id)]),
  })
}

export function useMoveIdea(projectId: string) {
  const invalidateList = useInvalidateIdeas(projectId)
  const invalidateIdea = useInvalidateIdea()
  return useMutation({
    ...postApiIdeasIdMoveMutationOptions(),
    onSuccess: (idea) => Promise.all([invalidateList(), invalidateIdea(idea.id)]),
  })
}
