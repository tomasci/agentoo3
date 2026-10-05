import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiAutomationsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiAutomationsId'
import {
  getApiAutomationsIdQueryKey,
  getApiAutomationsIdQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiAutomationsId'
import { getApiAutomationsIdRunsQueryOptions } from '@/shared/api/generated/hooks/useGetApiAutomationsIdRuns'
import {
  getApiProjectsIdAutomationsQueryKey,
  getApiProjectsIdAutomationsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdAutomations'
import { patchApiAutomationsIdMutationOptions } from '@/shared/api/generated/hooks/usePatchApiAutomationsId'
import { postApiAutomationsSchedulePreviewMutationOptions } from '@/shared/api/generated/hooks/usePostApiAutomationsSchedulePreview'
import { postApiProjectsIdAutomationsMutationOptions } from '@/shared/api/generated/hooks/usePostApiProjectsIdAutomations'
import type { GetApiAutomationsIdRunsStatus200 } from '@/shared/api/generated/types/GetApiAutomationsIdRuns'
import type { GetApiProjectsIdAutomationsStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdAutomations'

// The 200 responses are arrays, so an automation/run is its element type —
// the same `Idea`/`IdeaRun` idiom `features/ideas/hooks/use-ideas.ts` uses
// for the identical reason (one backend schema, two endpoints returning it
// one row at a time or many).
export type Automation = GetApiProjectsIdAutomationsStatus200[number]
export type AutomationRun = GetApiAutomationsIdRunsStatus200[number]

/** How often the detail page's own automation + run-history queries refetch
 *  while the page is open — matching the backend sweep's own 15s interval
 *  (backend's `queue/automation-sweep.worker.ts`), since a firing any more
 *  often than that cannot exist yet to find. */
const SWEEP_POLL_MS = 15_000

/** The project's automations list — no polling of its own; the list changes
 *  on this reader's own create/edit/pause/delete, which already invalidate
 *  it below, and on a sweep firing elsewhere, which the detail page (not
 *  this list) is the place to watch happen. */
export function useAutomations(projectId: string) {
  return useQuery(getApiProjectsIdAutomationsQueryOptions({ path: { id: projectId } }))
}

/** One automation's own row — the detail page's header. Polls while open:
 *  `nextRunAt`/`lastRunAt` move the moment the sweep worker fires this
 *  automation, with no push channel of its own to announce it. */
export function useAutomation(automationId: string) {
  return useQuery({
    ...getApiAutomationsIdQueryOptions({ path: { id: automationId } }),
    refetchInterval: SWEEP_POLL_MS,
  })
}

/** The automation's run history, newest first (the API's own order) — polls
 *  for the same reason `useAutomation` does: a new firing has no push
 *  channel of its own. */
export function useAutomationRuns(automationId: string, limit = 100) {
  return useQuery({
    ...getApiAutomationsIdRunsQueryOptions({ path: { id: automationId }, query: { limit } }),
    refetchInterval: SWEEP_POLL_MS,
  })
}

function useInvalidateAutomations(projectId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiProjectsIdAutomationsQueryKey({ path: { id: projectId } }),
    })
}

/** Unlike a session's SSE `status` event, an automation has no per-row push
 *  channel, so `useUpdateAutomation`/`useDeleteAutomation` below also
 *  invalidate the single-automation query directly rather than leaving that
 *  to the next poll — the same reasoning `use-ideas.ts`'s identical
 *  `useInvalidateIdea` gives. */
function useInvalidateAutomation() {
  const queryClient = useQueryClient()
  return (automationId: string) =>
    queryClient.invalidateQueries({
      queryKey: getApiAutomationsIdQueryKey({ path: { id: automationId } }),
    })
}

export function useCreateAutomation(projectId: string) {
  const invalidate = useInvalidateAutomations(projectId)
  return useMutation({
    ...postApiProjectsIdAutomationsMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

/** Also backs pause/resume — both the list's own Switch and the detail
 *  page's Pause/Resume button are just a PATCH `{ paused }` through this
 *  same hook, per the API's own contract. */
export function useUpdateAutomation(projectId: string) {
  const invalidateList = useInvalidateAutomations(projectId)
  const invalidateOne = useInvalidateAutomation()
  return useMutation({
    ...patchApiAutomationsIdMutationOptions(),
    onSuccess: (automation) => Promise.all([invalidateList(), invalidateOne(automation.id)]),
  })
}

export function useDeleteAutomation(projectId: string) {
  const invalidateList = useInvalidateAutomations(projectId)
  const invalidateOne = useInvalidateAutomation()
  return useMutation({
    ...deleteApiAutomationsIdMutationOptions(),
    onSuccess: (_data, variables) =>
      Promise.all([invalidateList(), invalidateOne(variables.path.id)]),
  })
}

/** The schedule builder's live preview — a POST, not a GET, because the
 *  cron/timezone pair being previewed is not yet (or no longer) saved
 *  anywhere the server could key a query on; see the schedule builder's own
 *  comment for why this is a debounced `mutate` rather than a `useQuery`. */
export function usePreviewSchedule() {
  return useMutation(postApiAutomationsSchedulePreviewMutationOptions())
}
