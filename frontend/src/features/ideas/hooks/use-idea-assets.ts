import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { postApiIdeasIdAssets } from '@/shared/api/generated/clients/postApiIdeasIdAssets'
import { deleteApiIdeaAssetsIdMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiIdeaAssetsId'
import { getApiIdeasIdQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasId'
import {
  getApiIdeasIdAssetsQueryKey,
  getApiIdeasIdAssetsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiIdeasIdAssets'
import type { GetApiIdeasIdAssetsStatus200 } from '@/shared/api/generated/types/GetApiIdeasIdAssets'

// The 200 response is `{ files, usage }` — an idea asset, and its usage
// against the idea's own limits, are each the element/field type.
export type IdeaAsset = GetApiIdeasIdAssetsStatus200['files'][number]
export type IdeaAssetsUsage = GetApiIdeasIdAssetsStatus200['usage']

export function useIdeaAssets(ideaId: string) {
  return useQuery(getApiIdeasIdAssetsQueryOptions({ path: { id: ideaId } }))
}

function useInvalidateIdeaAssets(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiIdeasIdAssetsQueryKey({ path: { id: ideaId } }),
    })
}

/** `assetCount` on the card (`use-ideas.ts`'s `Idea`) changes with every
 * delete or finished upload here, so both invalidate the single-idea query
 * alongside this idea's own assets list — see `use-ideas.ts`'s comment on why
 * an idea, with no push channel of its own, needs that told to it directly. */
function useInvalidateIdeaForAssetCount(ideaId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: getApiIdeasIdQueryKey({ path: { id: ideaId } }) })
}

export function useDeleteIdeaAsset(ideaId: string) {
  const invalidateAssets = useInvalidateIdeaAssets(ideaId)
  const invalidateIdea = useInvalidateIdeaForAssetCount(ideaId)
  return useMutation({
    ...deleteApiIdeaAssetsIdMutationOptions(),
    onSuccess: () => Promise.all([invalidateAssets(), invalidateIdea()]),
  })
}

// "uploaded", not "done" (use-session-files.ts's own `AttachmentUploadStatus`
// uses the latter): the board's own status vocabulary (`lib/status.ts`'s six
// literals, one of which is that same four-letter word) is meant to live in
// that one file alone, and this is a wholly different piece of state (one
// upload's own progress) that would otherwise collide with it by coincidence.
export type IdeaAssetUploadStatus = 'uploading' | 'uploaded' | 'error'

export interface IdeaAssetUpload {
  /** Client-side only, until the server assigns a real file id on success. */
  id: string
  file: File
  /** 0-100. Stays 0 for a rejection the pre-check below caught before ever
   * opening a connection. */
  progress: number
  status: IdeaAssetUploadStatus
  /** Set when `status === 'error'`. `true` for the cheap client-side size
   * pre-check (see `attach` below); an `unknown` — an axios error, most of
   * the time — for anything the server itself rejected, read through
   * `apiErrorMessage` at render time rather than formatted here, the same
   * division of labour `use-session-files.ts`'s identical hook uses. */
  error?: unknown
  precheckFailed?: boolean
  serverFile?: IdeaAsset
}

let nextUploadId = 0

/**
 * Owns every in-flight and just-finished upload for one idea's asset panel:
 * starts each upload the moment a file is attached, tracks its own progress
 * and lets it be cancelled mid-flight — none of which the generated mutation
 * hook can do (`usePostApiIdeasIdAssets` has no `onUploadProgress` or
 * `AbortSignal` of its own), so this calls the generated *client* function
 * directly instead, exactly mirroring `use-session-files.ts`'s
 * `useAttachmentUploads` (the pattern this is deliberately a sibling of,
 * named for its own feature rather than reused, since a page that shows both
 * a session's and an idea's attachments needs the two told apart).
 */
export function useIdeaAssetUploads(ideaId: string) {
  const [uploads, setUploads] = useState<IdeaAssetUpload[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  const invalidateAssets = useInvalidateIdeaAssets(ideaId)
  const invalidateIdea = useInvalidateIdeaForAssetCount(ideaId)

  const patch = useCallback((id: string, next: Partial<IdeaAssetUpload>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...next } : u)))
  }, [])

  /**
   * `budget`, when given, is the idea's own usage from the last successful
   * list fetch — real data, not a guessed limit. It only ever catches a file
   * that would *obviously* bust the idea's byte quota; the per-file size
   * ceiling and the allowed-type allowlist are enforced authoritatively by
   * the server and never duplicated here.
   */
  const attach = useCallback(
    (files: File[], budget?: IdeaAssetsUsage) => {
      for (const file of files) {
        const id = `upload-${nextUploadId++}`

        if (budget && budget.sizeBytes + file.size > budget.maxIdeaBytes) {
          setUploads((prev) => [
            ...prev,
            { id, file, progress: 0, status: 'error', precheckFailed: true },
          ])
          continue
        }

        const controller = new AbortController()
        controllers.current.set(id, controller)
        setUploads((prev) => [...prev, { id, file, progress: 0, status: 'uploading' }])

        postApiIdeasIdAssets({
          path: { id: ideaId },
          body: { file },
          signal: controller.signal,
          throwOnError: true,
          options: {
            onUploadProgress: (event) => {
              const total = event.total
              patch(id, { progress: total ? Math.round((event.loaded / total) * 100) : 0 })
            },
          },
        })
          .then(({ data }) => {
            patch(id, { status: 'uploaded', progress: 100, serverFile: data })
            void invalidateAssets()
            void invalidateIdea()
          })
          .catch((error) => {
            // Aborted by `cancel` below, not a real failure — drop the chip
            // rather than show an error for something the user asked to stop.
            if (controller.signal.aborted) {
              setUploads((prev) => prev.filter((u) => u.id !== id))
              return
            }
            patch(id, { status: 'error', error })
          })
          .finally(() => controllers.current.delete(id))
      }
    },
    [ideaId, invalidateAssets, invalidateIdea, patch],
  )

  const cancel = useCallback((id: string) => controllers.current.get(id)?.abort(), [])

  const dismiss = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id))
  }, [])

  /** Drops the tray's chips for these server file ids — the counterpart to
   * `use-session-files.ts`'s `clearSent`, for whatever calls the equivalent of
   * "done with this tray" here (an image block that consumed the upload, say). */
  const clearSent = useCallback((fileIds: string[]) => {
    if (fileIds.length === 0) return
    setUploads((prev) => prev.filter((u) => !(u.serverFile && fileIds.includes(u.serverFile.id))))
  }, [])

  const pendingCount = uploads.filter((u) => u.status === 'uploading').length

  return { uploads, attach, cancel, dismiss, clearSent, pendingCount }
}
