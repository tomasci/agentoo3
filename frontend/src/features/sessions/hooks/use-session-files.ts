import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { postApiSessionsIdFiles } from '@/shared/api/generated/clients/postApiSessionsIdFiles'
import { deleteApiSessionsIdFilesFileidMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsIdFilesFileid'
import {
  getApiSessionsIdFilesQueryKey,
  getApiSessionsIdFilesQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsIdFiles'
import type { GetApiSessionsIdFilesStatus200 } from '@/shared/api/generated/types/GetApiSessionsIdFiles'

// The 200 response is `{ files, usage }` — a session file, and its usage
// against the session's own limits, are each the element/field type.
export type SessionFile = GetApiSessionsIdFilesStatus200['files'][number]
export type SessionFilesUsage = GetApiSessionsIdFilesStatus200['usage']

export function useSessionFiles(sessionId: string) {
  return useQuery(getApiSessionsIdFilesQueryOptions({ path: { id: sessionId } }))
}

function useInvalidateSessionFiles(sessionId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: getApiSessionsIdFilesQueryKey({ path: { id: sessionId } }),
    })
}

export function useDeleteSessionFile(sessionId: string) {
  const invalidate = useInvalidateSessionFiles(sessionId)
  return useMutation({
    ...deleteApiSessionsIdFilesFileidMutationOptions(),
    onSuccess: () => invalidate(),
  })
}

export type AttachmentUploadStatus = 'uploading' | 'done' | 'error'

export interface AttachmentUpload {
  /** Client-side only, until the server assigns a real file id on success. */
  id: string
  file: File
  /** 0-100. Stays 0 for a rejection the pre-check below caught before ever
   * opening a connection. */
  progress: number
  status: AttachmentUploadStatus
  /** Set when `status === 'error'`. `true` for the cheap client-side size
   * pre-check (see `attach` below); an `unknown` — an axios error, most of
   * the time — for anything the server itself rejected, read through
   * `apiErrorMessage` at render time rather than formatted here, the same
   * division of labour `session-page.tsx`'s own `send` mutation uses. */
  error?: unknown
  precheckFailed?: boolean
  serverFile?: SessionFile
}

let nextUploadId = 0

/**
 * Owns every in-flight and just-finished upload for one session's composer:
 * starts each upload the moment a file is attached, tracks its own progress
 * and lets it be cancelled mid-flight — none of which the generated mutation
 * hook can do (`usePostApiSessionsIdFiles` has no `onUploadProgress` or
 * `AbortSignal` of its own), so this calls the generated *client* function
 * directly instead and manages the per-file bookkeeping here rather than in
 * the composer component, matching every other feature hook's job of owning
 * policy the component should not have to reimplement.
 */
export function useAttachmentUploads(sessionId: string) {
  const [uploads, setUploads] = useState<AttachmentUpload[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  const invalidate = useInvalidateSessionFiles(sessionId)

  const patch = useCallback((id: string, next: Partial<AttachmentUpload>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...next } : u)))
  }, [])

  /**
   * `budget`, when given, is the session's own usage from the last successful
   * list fetch — real data, not a guessed limit. It only ever catches a file
   * that would *obviously* bust the session's byte quota; the per-file size
   * ceiling and the allowed-type allowlist are enforced authoritatively by
   * the server and never duplicated here (see the component-contract-adjacent
   * rule in the brief: no client-side copy of a server rule beyond a cheap
   * pre-check).
   */
  const attach = useCallback(
    (files: File[], budget?: SessionFilesUsage) => {
      for (const file of files) {
        const id = `upload-${nextUploadId++}`

        if (budget && budget.sizeBytes + file.size > budget.maxSessionBytes) {
          setUploads((prev) => [
            ...prev,
            { id, file, progress: 0, status: 'error', precheckFailed: true },
          ])
          continue
        }

        const controller = new AbortController()
        controllers.current.set(id, controller)
        setUploads((prev) => [...prev, { id, file, progress: 0, status: 'uploading' }])

        postApiSessionsIdFiles({
          path: { id: sessionId },
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
            patch(id, { status: 'done', progress: 100, serverFile: data })
            void invalidate()
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
    [sessionId, invalidate, patch],
  )

  const cancel = useCallback((id: string) => controllers.current.get(id)?.abort(), [])

  const dismiss = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id))
  }, [])

  /** Drops the tray's chips for these server file ids — called once their
   * upload has been paired with a message that sent successfully, so a resent
   * prompt never re-offers files that already belong to the one before it. */
  const clearSent = useCallback((fileIds: string[]) => {
    if (fileIds.length === 0) return
    setUploads((prev) => prev.filter((u) => !(u.serverFile && fileIds.includes(u.serverFile.id))))
  }, [])

  const pendingCount = uploads.filter((u) => u.status === 'uploading').length

  return { uploads, attach, cancel, dismiss, clearSent, pendingCount }
}
