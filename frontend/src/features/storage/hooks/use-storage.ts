import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  getApiStorageAnomaliesQueryKey,
  getApiStorageAnomaliesQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiStorageAnomalies'
import {
  getApiStorageSummaryQueryKey,
  getApiStorageSummaryQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiStorageSummary'
import { postApiStorageAnomaliesBulkMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageAnomaliesBulk'
import { postApiStorageAnomaliesBulkDeleteMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageAnomaliesBulkDelete'
import { postApiStorageAnomaliesIdDeleteMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageAnomaliesIdDelete'
import { postApiStorageAnomaliesIdRecheckMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageAnomaliesIdRecheck'
import { postApiStorageAnomaliesIdResolveMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageAnomaliesIdResolve'
import { postApiStorageCheckMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageCheck'
import { postApiStorageCleanupMutationOptions } from '@/shared/api/generated/hooks/usePostApiStorageCleanup'
import type {
  GetApiStorageAnomaliesQuery,
  GetApiStorageAnomaliesStatus200,
} from '@/shared/api/generated/types/GetApiStorageAnomalies'
import type { GetApiStorageSummaryStatus200 } from '@/shared/api/generated/types/GetApiStorageSummary'
import type { PostApiStorageAnomaliesIdDeleteStatus200 } from '@/shared/api/generated/types/PostApiStorageAnomaliesIdDelete'

// The 200 response is an array, so an anomaly is its element type, and its
// class is that element's own `class` field — never hand-typed against the
// four fixed strings, so a class the backend ever adds shows up here as a
// type error rather than a silent gap.
export type StorageAnomaly = GetApiStorageAnomaliesStatus200[number]
export type AnomalyClass = StorageAnomaly['class']

// The one shape `.../{id}/delete`, `.../{id}/recheck` and each entry of
// `.../bulk-delete`'s own `results` all answer with — re-verified before
// anything happens, so `outcome` is never just "the thing I asked for", see
// each field's own description in openapi.json.
export type AnomalyRemediation = PostApiStorageAnomaliesIdDeleteStatus200
export type AnomalyOutcome = AnomalyRemediation['outcome']

export type TopSession = GetApiStorageSummaryStatus200['topSessions'][number]

export const ANOMALY_CLASSES: readonly AnomalyClass[] = [
  'orphan_blob',
  'dangling_row',
  'orphan_session_dir',
  'checksum_mismatch',
]

/**
 * Polls `/storage/summary` while a check or cleanup this page triggered might
 * still be running.
 *
 * There is no job-status endpoint: `/storage/check` and `/storage/cleanup`
 * both only ever answer 202 `{ enqueued: true }`, the same as the schedule's
 * own run, and the worker's actual report (`GcReport` in the backend) is
 * logged, never returned by any route. "Finished" is inferred the same way a
 * human reading this page would — `lastCheckAt`/`lastCleanupAt` moving past
 * the moment the job was asked for — with a two-minute ceiling so a wedged
 * worker cannot poll forever.
 */
export function useStorageSummary() {
  const [watching, setWatching] = useState<{ kind: 'check' | 'cleanup'; askedAt: number } | null>(
    null,
  )

  const summary = useQuery({
    ...getApiStorageSummaryQueryOptions(),
    refetchInterval: watching ? 1500 : false,
  })

  useEffect(() => {
    if (!watching || !summary.data) return
    const finishedAt =
      watching.kind === 'check' ? summary.data.lastCheckAt : summary.data.lastCleanupAt
    const settled =
      Boolean(finishedAt) && new Date(finishedAt as string).getTime() >= watching.askedAt
    if (settled || Date.now() - watching.askedAt > 120_000) setWatching(null)
  }, [summary.data, watching])

  return {
    ...summary,
    /** True while a job triggered from this page might still be running. */
    watching: watching !== null,
    startWatching: (kind: 'check' | 'cleanup') => setWatching({ kind, askedAt: Date.now() }),
  }
}

function useInvalidateStorage() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: getApiStorageSummaryQueryKey() })
    void queryClient.invalidateQueries({ queryKey: getApiStorageAnomaliesQueryKey() })
  }
}

export function useRunStorageCheck() {
  const invalidate = useInvalidateStorage()
  return useMutation({ ...postApiStorageCheckMutationOptions(), onSuccess: () => invalidate() })
}

export function useRunStorageCleanup() {
  const invalidate = useInvalidateStorage()
  return useMutation({ ...postApiStorageCleanupMutationOptions(), onSuccess: () => invalidate() })
}

export function useStorageAnomalies(query: GetApiStorageAnomaliesQuery) {
  return useQuery(getApiStorageAnomaliesQueryOptions({ query }))
}

export function useResolveAnomaly() {
  const invalidate = useInvalidateStorage()
  return useMutation({
    ...postApiStorageAnomaliesIdResolveMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export function useBulkResolveAnomalies() {
  const invalidate = useInvalidateStorage()
  return useMutation({
    ...postApiStorageAnomaliesBulkMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

/** Per-row destructive remediation — deletes the orphan blob, dangling row,
 * orphan session directory, or (for a checksum_mismatch) the corrupt blob and
 * its row, whichever this one anomaly's own class calls for. Re-verified
 * immediately before anything happens: see `outcome` on the response. */
export function useDeleteAnomaly() {
  const invalidate = useInvalidateStorage()
  return useMutation({
    ...postApiStorageAnomaliesIdDeleteMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

/** Re-runs the check on one anomaly without deleting anything: a finding that
 * no longer holds is resolved (it fixed itself), one that still holds stays
 * open with `lastSeenAt` refreshed. */
export function useRecheckAnomaly() {
  const invalidate = useInvalidateStorage()
  return useMutation({
    ...postApiStorageAnomaliesIdRecheckMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

/** The destructive counterpart to `useBulkResolveAnomalies`, for an explicit,
 * selected id list rather than a class-wide sweep — that sweep is
 * `useRunStorageCleanup` above. */
export function useBulkDeleteAnomalies() {
  const invalidate = useInvalidateStorage()
  return useMutation({
    ...postApiStorageAnomaliesBulkDeleteMutationOptions(),
    onSuccess: () => invalidate(),
  })
}
