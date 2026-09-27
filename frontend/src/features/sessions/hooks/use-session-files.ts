import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { atom, type PrimitiveAtom, useAtomValue, useStore } from 'jotai'
import { useCallback, useEffect } from 'react'
import { postApiSessionsIdFiles } from '@/shared/api/generated/clients/postApiSessionsIdFiles'
import { deleteApiSessionsIdFilesFileidMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiSessionsIdFilesFileid'
import {
  getApiSessionsIdFilesQueryKey,
  getApiSessionsIdFilesQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiSessionsIdFiles'
import type { GetApiSessionsIdFilesStatus200 } from '@/shared/api/generated/types/GetApiSessionsIdFiles'
import { readDraft, updateDraft } from '../lib/drafts'

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
  /**
   * The real `File`, present for an upload started in *this* browser tab —
   * in flight, just finished, or failed. Absent for a tile rehydrated from a
   * server file id recorded in the session's draft (lib/drafts.ts): a reload
   * has nothing left to hold a `File` object, since those never survive a
   * serialize round-trip, only the server file itself does. `name`/`size`/
   * `mimeType` are filled in either way — from the `File` on attach, from the
   * `SessionFile` on rehydrate — so a tile never has to branch on which one
   * it came from to render its title, its description or its media type.
   */
  file?: File
  name: string
  size: number
  mimeType: string
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
 * One tray per session, keyed by session id rather than owned by whichever
 * component happens to be mounted — a session's own page opens and closes as
 * the reader moves around the workspace (see the tab row, `app/tab-bar.tsx`),
 * and an upload that was still in flight, or a file already sitting done in
 * the tray, has to still be there — and to keep uploading in the background
 * — when they come back to it. One atom per session id, created lazily the
 * first time a session's tray is touched and kept alive for as long as this
 * tab stays open (nothing here ever removes an entry; an installation runs
 * long enough sessions to want that, but not so many distinct ones in one
 * browser tab's lifetime that a few empty arrays are worth the bookkeeping to
 * reclaim). A hand-rolled cache rather than jotai/utils' own `atomFamily`,
 * which is the obvious reach for exactly this — but is deprecated in the
 * version pinned here, in favour of a separate package this project has no
 * other reason to add.
 *
 * In-memory only, deliberately: this is what "survives navigating away and
 * back" means, not what "survives a reload" means — the latter is
 * lib/drafts.ts's `fileIds`, which every write below keeps in step with (see
 * `writeTray`).
 */
const sessionTrays = new Map<string, PrimitiveAtom<AttachmentUpload[]>>()

function sessionTrayAtom(sessionId: string): PrimitiveAtom<AttachmentUpload[]> {
  let trayAtom = sessionTrays.get(sessionId)
  if (!trayAtom) {
    trayAtom = atom<AttachmentUpload[]>([])
    sessionTrays.set(sessionId, trayAtom)
  }
  return trayAtom
}

/**
 * Every upload's `AbortController`, by upload id rather than by session:
 * `nextUploadId` is a single counter for the whole tab, so ids never collide
 * across sessions, and nothing here needs the session id at all to find the
 * right one to abort. Module-level for the same reason the tray above is an
 * atom rather than component state: cancelling has to reach an upload that
 * may have been started by a `session-page.tsx` instance that has since
 * unmounted.
 */
const controllers = new Map<string, AbortController>()

/**
 * Every session id whose *first* rehydration check — "is the in-memory tray
 * empty, and does the stored draft have ids worth seeding it from" — has
 * already run this page-load. Checked once, ever, per session id: the
 * question only has one right answer for a given page load (either there was
 * something to seed from, or there was not), and a session already in here
 * is never asked it again — see the rehydration effect inside
 * `useAttachmentUploads` below, the only reader.
 */
const settledSessions = new Set<string>()

/**
 * Session ids whose stored `fileIds`, read at the moment `settledSessions`
 * first admitted them, have not yet been fully resolved into tiles (kept) or
 * drops — because the files list this needs has not landed yet, or has
 * failed. In the order the draft stored them.
 *
 * While a session is in here, `writeTray` folds these ids into every write
 * it persists (`fileIdsToPersist`, below), *in addition to* whatever the
 * tray's own tiles say — a real write (an attach the reader makes in the gap
 * before the files list answers, most notably) must not make an id nobody
 * has confirmed dead yet disappear from storage, the exact trap drafts exist
 * to prevent. Cleared only once the rehydration effect has actually resolved
 * every one of them against a landed files list — never on a failed fetch,
 * which leaves a session's entry here exactly as pending as it was.
 */
const pendingSeeds = new Map<string, string[]>()

/** The server file ids a tray's own `done` tiles point at. */
function doneIdsOf(tray: AttachmentUpload[]): string[] {
  return tray
    .filter((u) => u.status === 'done' && u.serverFile)
    .map((u) => u.serverFile?.id)
    .filter((id): id is string => id !== undefined)
}

/** `seedIds` (in order) followed by any of `tray`'s own done ids not already
 *  among them — the persisted-`fileIds` in-progress rehydration `writeTray`
 *  merges into every write, above. */
function unionIds(seedIds: string[], tray: AttachmentUpload[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const id of seedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  for (const id of doneIdsOf(tray)) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged
}

/** What `writeTray` persists for one write: the tray's own done ids, unioned
 *  with this session's still-pending seed (if it has one) so a write made
 *  before rehydration resolves never drops an id nobody has confirmed dead
 *  yet — see `pendingSeeds`'s own comment. */
function fileIdsToPersist(sessionId: string, tray: AttachmentUpload[]): string[] {
  const seed = pendingSeeds.get(sessionId)
  return seed ? unionIds(seed, tray) : doneIdsOf(tray)
}

/**
 * The one place any write to a session's tray happens: sets the atom, then
 * folds the result's own done ids — unioned with any still-pending seed,
 * `fileIdsToPersist` above — back into the persisted draft (`updateDraft`,
 * lib/drafts.ts), so the draft never drifts from what the tray actually
 * holds, whether or not any `SessionPage` is even mounted to see it (an
 * upload's own `.then()`/`.catch()`, below, reach this exactly the same way
 * after the page that started it has unmounted). Deliberately does not touch
 * `pendingSeeds` itself either way: an ordinary write must never cancel a
 * pending rehydration — only the rehydration effect's own resolve step does.
 *
 * Progress-percentage ticks deliberately do not go through this — see
 * `attach`'s own `onUploadProgress`, the one write that calls `store.set`
 * directly instead: a percentage never changes which ids are `done`, so
 * routing it through here would mean one localStorage write per progress
 * event for a draft that never actually changed.
 */
function writeTray(
  store: ReturnType<typeof useStore>,
  trayAtom: PrimitiveAtom<AttachmentUpload[]>,
  sessionId: string,
  updater: (prev: AttachmentUpload[]) => AttachmentUpload[],
): void {
  let next: AttachmentUpload[] = []
  store.set(trayAtom, (prev) => {
    next = updater(prev)
    return next
  })
  updateDraft(sessionId, { fileIds: fileIdsToPersist(sessionId, next) })
}

/**
 * Owns every in-flight and just-finished upload for one session's composer:
 * starts each upload the moment a file is attached, tracks its own progress
 * and lets it be cancelled mid-flight — none of which the generated mutation
 * hook can do (`usePostApiSessionsIdFiles` has no `onUploadProgress` or
 * `AbortSignal` of its own), so this calls the generated *client* function
 * directly instead and manages the per-file bookkeeping here rather than in
 * the composer component, matching every other feature hook's job of owning
 * policy the component should not have to reimplement.
 *
 * The tray itself lives in `sessionTrayAtom`, above, not in this hook's own
 * state: every write goes through `writeTray` against the store this
 * component instance actually renders under (`useStore()`, not `jotai`'s
 * process-wide default store) so that a network callback landing after
 * `session-page.tsx` has unmounted — the reader closed the tab, or navigated
 * to another session, mid-upload — still reaches the tray (and the draft)
 * the next visit will read, rather than updating a `useState` nothing is
 * listening to any more. Capturing the *ambient* store rather than reaching
 * for the global one is also what lets a test mount this under its own
 * `<Provider>` and see a tray no other test's mount can see.
 *
 * Also rehydrates this session's tray from its persisted draft, once per
 * session per page-load — see the effect below.
 */
export function useAttachmentUploads(sessionId: string) {
  const store = useStore()
  const trayAtom = sessionTrayAtom(sessionId)
  const uploads = useAtomValue(trayAtom, { store })
  const invalidate = useInvalidateSessionFiles(sessionId)
  // Same query the session page's own composer usage line reads
  // (`useSessionFiles`, above) — react-query dedupes identical query keys
  // across separate `useQuery` calls, so this shares that one cache entry
  // and its one request rather than doubling either.
  const filesForRehydrate = useSessionFiles(sessionId)

  const write = useCallback(
    (updater: (prev: AttachmentUpload[]) => AttachmentUpload[]) =>
      writeTray(store, trayAtom, sessionId, updater),
    [store, trayAtom, sessionId],
  )

  const patchProgress = useCallback(
    (id: string, progress: number) => {
      store.set(trayAtom, (prev) => prev.map((u) => (u.id === id ? { ...u, progress } : u)))
    },
    [store, trayAtom],
  )

  /**
   * `budget`, when given, is the session's own usage from the last successful
   * list fetch — real data, not a guessed limit. It only ever catches a file
   * that would *obviously* bust the session's byte quota; the per-file size
   * ceiling and the allowed-type allowlist are enforced authoritatively by
   * the server and never duplicated here — no client-side copy of a server
   * rule beyond a cheap pre-check that only ever saves a doomed upload the
   * round trip it was going to fail anyway.
   */
  const attach = useCallback(
    (files: File[], budget?: SessionFilesUsage) => {
      for (const file of files) {
        const id = `upload-${nextUploadId++}`
        const base = { id, file, name: file.name, size: file.size, mimeType: file.type }

        if (budget && budget.sizeBytes + file.size > budget.maxSessionBytes) {
          write((prev) => [
            ...prev,
            { ...base, progress: 0, status: 'error', precheckFailed: true },
          ])
          continue
        }

        const controller = new AbortController()
        controllers.set(id, controller)
        write((prev) => [...prev, { ...base, progress: 0, status: 'uploading' }])

        postApiSessionsIdFiles({
          path: { id: sessionId },
          body: { file },
          signal: controller.signal,
          throwOnError: true,
          options: {
            onUploadProgress: (event) => {
              const total = event.total
              patchProgress(id, total ? Math.round((event.loaded / total) * 100) : 0)
            },
          },
        })
          .then(({ data }) => {
            write((prev) =>
              prev.map((u) =>
                u.id === id ? { ...u, status: 'done', progress: 100, serverFile: data } : u,
              ),
            )
            void invalidate()
          })
          .catch((error) => {
            // Aborted by `cancel` below, not a real failure — drop the chip
            // rather than show an error for something the user asked to stop.
            if (controller.signal.aborted) {
              write((prev) => prev.filter((u) => u.id !== id))
              return
            }
            write((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'error', error } : u)))
          })
          .finally(() => controllers.delete(id))
      }
    },
    [sessionId, invalidate, write, patchProgress],
  )

  const cancel = useCallback((id: string) => controllers.get(id)?.abort(), [])

  const dismiss = useCallback(
    (id: string) => write((prev) => prev.filter((u) => u.id !== id)),
    [write],
  )

  /** Drops the tray's chips for these server file ids — called once their
   * upload has been paired with a message that sent successfully, so a resent
   * prompt never re-offers files that already belong to the one before it. */
  const clearSent = useCallback(
    (fileIds: string[]) => {
      if (fileIds.length === 0) return
      write((prev) => prev.filter((u) => !(u.serverFile && fileIds.includes(u.serverFile.id))))
    },
    [write],
  )

  /**
   * Resolves this session's pending seed (`pendingSeeds`, above) against a
   * landed files list: one `done` tile per seed id that is still `status ===
   * 'ready'` and not already among the tray's own tiles, in the seed's own
   * order, placed *before* whatever is already there — an attach made while
   * the seed was still pending (see `writeTray`) keeps its own place at the
   * end rather than being reordered. A seed id that isn't ready any more
   * (deleted, or the backend's own GC marked its blob missing) is silently
   * dropped, exactly as the ids `clearSent`/`dismiss` drop are — there is no
   * chip to show for a file that is not there to send. Clears the pending
   * seed *before* writing, so the write this itself makes persists a plain
   * `doneIdsOf` — the union it no longer needs — rather than unioning the
   * seed into its own resolution.
   */
  const resolveSeed = useCallback(
    (seed: string[], files: SessionFile[]) => {
      pendingSeeds.delete(sessionId)
      const byId = new Map(files.map((f) => [f.id, f]))
      write((prev) => {
        const already = new Set(
          prev.map((u) => u.serverFile?.id).filter((id): id is string => id !== undefined),
        )
        const seen = new Set<string>()
        const tiles: AttachmentUpload[] = []
        for (const fileId of seed) {
          if (seen.has(fileId) || already.has(fileId)) continue
          seen.add(fileId)
          const f = byId.get(fileId)
          if (f?.status !== 'ready') continue
          tiles.push({
            id: `rehydrated-${fileId}`,
            name: f.originalFilename,
            size: f.sizeBytes,
            mimeType: f.mimeType,
            progress: 100,
            status: 'done',
            serverFile: f,
          })
        }
        return [...tiles, ...prev]
      })
    },
    [sessionId, write],
  )

  // Rehydration, in two steps that can be arbitrarily far apart in time:
  //
  // 1. The *first* time this session is seen this page-load (`settledSessions`,
  //    its own comment above) — checked once, ever, regardless of how many
  //    times this effect itself re-runs — if the in-memory tray is still
  //    empty and the stored draft has ids, they become this session's
  //    pending seed. From that moment, every write anyone makes to this
  //    session's tray (`writeTray`) persists the seed's own ids alongside its
  //    own, so an attach made before step 2 below ever runs — the regression
  //    this whole mechanism exists to close — cannot make them vanish from
  //    storage.
  // 2. Once the files list has actually landed (`filesForRehydrate.data`),
  //    resolve whatever this session's pending seed still is, whether that
  //    is what step 1 just set or something a slow list request left pending
  //    across several renders. A list that fails leaves the seed pending —
  //    deliberately: there is nothing here to resolve it *to*, so the ids it
  //    still names are the only honest answer.
  useEffect(() => {
    if (!settledSessions.has(sessionId)) {
      settledSessions.add(sessionId)
      if (uploads.length === 0) {
        const fileIds = readDraft(sessionId).fileIds
        if (fileIds.length > 0) pendingSeeds.set(sessionId, fileIds)
      }
    }
    const seed = pendingSeeds.get(sessionId)
    if (!seed || !filesForRehydrate.data) return
    resolveSeed(seed, filesForRehydrate.data.files)
  }, [sessionId, uploads.length, filesForRehydrate.data, resolveSeed])

  const pendingCount = uploads.filter((u) => u.status === 'uploading').length

  return { uploads, attach, cancel, dismiss, clearSent, pendingCount }
}
