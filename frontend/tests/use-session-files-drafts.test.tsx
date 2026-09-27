// The attachment tray's half of the per-session draft
// (features/sessions/hooks/use-session-files.ts + lib/drafts.ts):
//
//   D5  the tray outlives the component: an upload that finishes while no
//       page is mounted still lands in the tray *and* in the stored draft's
//       `fileIds`;
//   D6  after a reload (empty in-memory tray) the tray is rebuilt from the
//       stored `fileIds`, filtered to files the session still has *ready*,
//       and the stored ids are corrected to match;
//   D7  switching one mounted instance from session A to session B — the
//       `SessionPage` reuse case — never writes an empty `fileIds` over B's
//       stored draft, and never touches A's;
//   D8  removing a tile or `clearSent` drops those ids from the stored draft.
//
// The two hooks are mounted together, the way session-page.tsx uses them
// (tests/session-page-drafts.test.tsx covers the real page). The upload and
// the files-list clients are mocked through ./mock-module so each test decides
// when an upload resolves and what, and when, the files list answers.
//
// Module state: `settledSessions` and the tray-atom cache in
// use-session-files.ts are module-level and live for the whole file, the way
// they live for a whole page load in the browser. A fresh Jotai store per
// test empties the *visible* tray, but only a session id this file has never
// used before behaves like "first visit after a reload" — so every test that
// depends on that uses its own ids (`fresh()`), and says so.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import { type StorageWrite, swapLocalStorage } from './storage-spy'
import { useSessionDraft } from '../src/features/sessions/hooks/use-session-draft'
import {
  type SessionFile,
  useAttachmentUploads,
} from '../src/features/sessions/hooks/use-session-files'
import { updateDraft } from '../src/features/sessions/lib/drafts'

// --- mocked clients ----------------------------------------------------------

interface UploadCall {
  sessionId: string
  file: File
  resolve: (data: SessionFile) => void
  reject: (err: unknown) => void
}
let uploadCalls: UploadCall[] = []

await mockModule('@/shared/api/generated/clients/postApiSessionsIdFiles', () => ({
  postApiSessionsIdFiles: (opts: {
    path: { id: string }
    body: { file: File }
    signal?: AbortSignal
  }) =>
    new Promise((resolve, reject) => {
      uploadCalls.push({
        sessionId: opts.path.id,
        file: opts.body.file,
        resolve: (data) => resolve({ data }),
        reject,
      })
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}))

/** Per session id: what the files list answers. Absent → an empty list. */
let filesBySession: Record<string, SessionFile[]> = {}
/** Per session id: the files request waits on this before answering. */
let filesGates: Record<string, Promise<void>> = {}
/** Session ids whose files request fails. */
let filesFail = new Set<string>()
let filesRequests: string[] = []

await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async (opts: { path: { id: string } }) => {
    const id = opts.path.id
    filesRequests.push(id)
    const gate = filesGates[id]
    if (gate) await gate
    if (filesFail.has(id)) throw new Error('files list failed')
    const files = filesBySession[id] ?? []
    return {
      data: {
        files,
        usage: { fileCount: files.length, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 1e9 },
      },
    }
  },
}))

// --- fixtures ----------------------------------------------------------------

const T = '2026-09-04T10:00:00.000Z'
const sessionFile = (id: string, sessionId: string, o: Partial<SessionFile> = {}): SessionFile => ({
  id,
  sessionId,
  originalFilename: `${id}.txt`,
  mimeType: 'text/plain',
  sizeBytes: 123,
  checksum: 'abc',
  status: 'ready',
  lineCount: 1,
  pageCount: null,
  createdAt: T,
  ...o,
})
const file = (name = 'a.txt') => new File(['hello'], name, { type: 'text/plain' })

let seq = 0
/** A session id this file has never used — see the header on module state. */
const fresh = (label: string) => `${label}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

const key = (id: string) => `agentoo:draft:${id}`
const stored = (id: string): unknown => {
  const raw = localStorage.getItem(key(id))
  return raw === null ? null : JSON.parse(raw)
}
const storedFileIds = (id: string) =>
  (stored(id) as { fileIds?: string[] } | null)?.fileIds ?? null

function gateFiles(sessionId: string): () => void {
  let release: () => void = () => {}
  filesGates[sessionId] = new Promise<void>((r) => {
    release = r
  })
  return release
}

// --- localStorage write log --------------------------------------------------

let writes: StorageWrite[] = []
let restoreStorage: () => void = () => {}
function recordWrites() {
  restoreStorage = swapLocalStorage({ onWrite: (w) => writes.push(w) })
}
function stopRecording() {
  restoreStorage()
}
/** Every write to `id`'s draft key, as the `fileIds` it left behind — `[]`
 *  for a removal, which is exactly what losing the draft looks like. */
const fileIdsWrittenFor = (id: string) =>
  writes
    .filter((w) => w.key === key(id))
    .map((w) =>
      w.op === 'remove' ? [] : ((JSON.parse(w.value ?? '{}') as { fileIds: string[] }).fileIds ?? []),
    )

// --- mounting ----------------------------------------------------------------

let client: QueryClient
let store: ReturnType<typeof createStore>
let container: HTMLDivElement | undefined
let root: Root | undefined
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let files: ReturnType<typeof useAttachmentUploads>
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let draft: ReturnType<typeof useSessionDraft>
/** Every render: the session id and the server ids of the tiles shown. */
let renders: { sessionId: string; tiles: string[] }[] = []

function Probe({ sessionId }: { sessionId: string }) {
  files = useAttachmentUploads(sessionId)
  draft = useSessionDraft(sessionId)
  renders.push({
    sessionId,
    tiles: files.uploads.map((u) => u.serverFile?.id ?? `(${u.status}:${u.name})`),
  })
  return null
}

async function render(sessionId: string) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <Probe sessionId={sessionId} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  container = undefined
}

async function flush(ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(() => {
  uploadCalls = []
  filesBySession = {}
  filesGates = {}
  filesFail = new Set()
  filesRequests = []
  writes = []
  renders = []
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  store = createStore()
})

afterEach(async () => {
  stopRecording()
  await unmount()
  client.clear()
})

// --- D5. the tray survives in-app navigation ----------------------------------

test('an upload that finishes after the page unmounted is in the tray, done, on the way back', async () => {
  const A = fresh('d5')
  await render(A)
  await act(async () => {
    files.attach([file('notes.txt')])
  })
  expect(uploadCalls).toHaveLength(1)
  expect(files.uploads.map((u) => u.status)).toEqual(['uploading'])
  expect(storedFileIds(A)).toBeNull()

  await unmount()
  uploadCalls[0]?.resolve(sessionFile('srv-1', A, { originalFilename: 'notes.txt' }))
  await flush()

  // Nothing is mounted, and still the draft learned the new id.
  expect(storedFileIds(A)).toEqual(['srv-1'])

  await render(A)
  await flush()
  expect(files.uploads).toHaveLength(1)
  expect(files.uploads[0]?.status).toBe('done')
  expect(files.uploads[0]?.progress).toBe(100)
  expect(files.uploads[0]?.serverFile?.id).toBe('srv-1')
  expect(files.uploads[0]?.name).toBe('notes.txt')
  expect(files.pendingCount).toBe(0)
})

test('an upload that fails after the page unmounted shows as an error tile on the way back, with no id stored', async () => {
  const A = fresh('d5')
  await render(A)
  await act(async () => {
    files.attach([file('x.txt')])
  })
  await unmount()
  uploadCalls[0]?.reject(new Error('413'))
  await flush()
  expect(localStorage.getItem(key(A))).toBeNull()

  await render(A)
  await flush()
  expect(files.uploads.map((u) => u.status)).toEqual(['error'])
})

test('a finish while away keeps the text typed before leaving', async () => {
  const A = fresh('d5')
  await render(A)
  await act(async () => {
    draft.setText('half a thought')
    files.attach([file()])
  })
  await unmount()
  uploadCalls[0]?.resolve(sessionFile('srv-2', A))
  await flush()
  expect(stored(A)).toEqual({ text: 'half a thought', fileIds: ['srv-2'] })
})

test("an upload for A finishing while B is mounted lands in A's tray and draft, not B's", async () => {
  const A = fresh('d5a')
  const B = fresh('d5b')
  await render(A)
  await act(async () => {
    files.attach([file()])
  })
  await render(B)
  await flush()
  uploadCalls[0]?.resolve(sessionFile('srv-a', A))
  await flush()
  expect(files.uploads).toEqual([])
  expect(storedFileIds(A)).toEqual(['srv-a'])
  expect(localStorage.getItem(key(B))).toBeNull()

  await render(A)
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['srv-a'])
})

// --- D6. rehydration after a reload -------------------------------------------

test('a stored draft rehydrates one done tile per id still ready, and the stored ids are corrected', async () => {
  // Fresh id: first visit of this page load, as after a reload.
  const S = fresh('d6')
  updateDraft(S, { text: 'about these', fileIds: ['f1', 'f2'] })
  filesBySession[S] = [
    sessionFile('f1', S, { originalFilename: 'photo.png', mimeType: 'image/png', sizeBytes: 4096 }),
  ]
  await render(S)
  await flush()

  expect(files.uploads).toHaveLength(1)
  const tile = files.uploads[0]
  expect(tile?.status).toBe('done')
  expect(tile?.progress).toBe(100)
  expect(tile?.serverFile?.id).toBe('f1')
  expect(tile?.name).toBe('photo.png')
  expect(tile?.size).toBe(4096)
  expect(tile?.mimeType).toBe('image/png')
  // No File survives a reload.
  expect(tile?.file).toBeUndefined()
  expect(files.pendingCount).toBe(0)
  // The dropped f2 is corrected in storage; the text is left alone.
  expect(stored(S)).toEqual({ text: 'about these', fileIds: ['f1'] })
})

test('a stored id whose file is not ready (pending, missing) is dropped, not shown', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['ok', 'pend', 'gone'] })
  filesBySession[S] = [
    sessionFile('ok', S),
    sessionFile('pend', S, { status: 'pending' } as Partial<SessionFile>),
    sessionFile('gone', S, { status: 'missing' } as Partial<SessionFile>),
  ]
  await render(S)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['ok'])
  expect(storedFileIds(S)).toEqual(['ok'])
})

test('rehydrated tiles keep the stored order, not the files list order', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['f3', 'f1', 'f2'] })
  filesBySession[S] = [sessionFile('f1', S), sessionFile('f2', S), sessionFile('f3', S)]
  await render(S)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['f3', 'f1', 'f2'])
  expect(storedFileIds(S)).toEqual(['f3', 'f1', 'f2'])
})

test('when none of the stored ids exist any more, the tray is empty and fileIds are cleared', async () => {
  const S = fresh('d6')
  updateDraft(S, { text: 'still here', fileIds: ['x1'] })
  filesBySession[S] = []
  await render(S)
  await flush()
  expect(files.uploads).toEqual([])
  expect(stored(S)).toEqual({ text: 'still here', fileIds: [] })
})

test('stored fileIds are left untouched until the files list actually lands', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['f1', 'f2'] })
  filesBySession[S] = [sessionFile('f1', S)]
  const release = gateFiles(S)
  recordWrites()
  await render(S)
  await flush()
  expect(files.uploads).toEqual([])
  expect(storedFileIds(S)).toEqual(['f1', 'f2'])
  expect(fileIdsWrittenFor(S)).toEqual([])

  await act(async () => {
    release()
  })
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['f1'])
  expect(fileIdsWrittenFor(S)).toEqual([['f1']])
})

test('a failed files list never wipes the stored fileIds', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['f1'] })
  filesFail.add(S)
  await render(S)
  await flush(5)
  expect(files.uploads).toEqual([])
  expect(storedFileIds(S)).toEqual(['f1'])
})

test('rehydration runs once: a later remount does not duplicate tiles', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['f1'] })
  filesBySession[S] = [sessionFile('f1', S)]
  await render(S)
  await flush()
  await unmount()
  await render(S)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['f1'])
})

test('an attach made before the files list lands keeps the stored ids it has not seen yet', async () => {
  // After a reload the stored `fileIds` are the *only* record that f1 is
  // sitting in this draft — and the backend will send it with the next
  // prompt whether or not the tray shows it (lib/drafts.ts's own header). A
  // paste in the first moment after reload, before the files list answers,
  // must not make f1 invisible.
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['f1'] })
  filesBySession[S] = [sessionFile('f1', S)]
  const release = gateFiles(S)
  await render(S)
  await flush()
  await act(async () => {
    files.attach([file('pasted.txt')])
  })
  await act(async () => {
    release()
  })
  await flush()
  uploadCalls[0]?.resolve(sessionFile('new', S, { originalFilename: 'pasted.txt' }))
  await flush()

  expect(files.uploads.map((u) => u.serverFile?.id).sort()).toEqual(['f1', 'new'])
  expect([...(storedFileIds(S) ?? [])].sort()).toEqual(['f1', 'new'])
})

// --- D7. the regression: switching one instance from A to B -------------------

async function switchCase(opts: { aFileIds: string[]; bCached: boolean }) {
  // Fresh ids: B must be a first visit this page load, as after a reload.
  const A = fresh('d7a')
  const B = fresh('d7b')
  if (opts.aFileIds.length > 0) {
    updateDraft(A, { text: 'alpha', fileIds: opts.aFileIds })
    filesBySession[A] = opts.aFileIds.map((id) => sessionFile(id, A))
  } else {
    updateDraft(A, { text: 'alpha' })
  }
  updateDraft(B, { text: 'beta', fileIds: ['b1'] })
  filesBySession[B] = [sessionFile('b1', B)]

  await render(A)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(opts.aFileIds)
  if (opts.bCached) await client.prefetchQuery({
    queryKey: [{ url: '/api/sessions/:id/files', params: { id: B } }],
    queryFn: async () => ({
      files: filesBySession[B],
      usage: { fileCount: 1, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 1e9 },
    }),
  })
  const rawA = localStorage.getItem(key(A))

  writes = []
  renders = []
  recordWrites()
  await render(B)
  await flush(5)
  stopRecording()

  return { A, B, rawA }
}

for (const aFileIds of [[], ['a1'], ['a1', 'a2']]) {
  for (const bCached of [false, true]) {
    const label = `A with ${aFileIds.length ? `fileIds ${JSON.stringify(aFileIds)}` : 'no fileIds'}, B's files ${bCached ? 'already cached' : 'fetched after the switch'}`
    test(`switch A→B on one instance (${label}): B shows b1 and its stored fileIds are never emptied`, async () => {
      const { A, B, rawA } = await switchCase({ aFileIds, bCached })

      // After the switch settles: B's tile, B's draft.
      expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['b1'])
      expect(draft.text).toBe('beta')
      expect(stored(B)).toEqual({ text: 'beta', fileIds: ['b1'] })

      // Every write that touched B's key left ['b1'] — never [] or a removal.
      const bWrites = fileIdsWrittenFor(B)
      expect(bWrites.filter((ids) => ids.length !== 1 || ids[0] !== 'b1')).toEqual([])

      // No render under B ever showed one of A's tiles, or A's text.
      expect(renders.filter((r) => r.sessionId === B && r.tiles.some((t) => t !== 'b1'))).toEqual(
        [],
      )

      // A's stored draft untouched, byte for byte, and never written.
      expect(localStorage.getItem(key(A))).toBe(rawA)
      expect(writes.filter((w) => w.key === key(A))).toEqual([])
    })
  }
}

test('switch A→B→A: each keeps its own tiles and stored ids', async () => {
  const { A, B } = await switchCase({ aFileIds: ['a1'], bCached: false })
  await render(A)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['a1'])
  expect(draft.text).toBe('alpha')
  expect(storedFileIds(A)).toEqual(['a1'])
  expect(storedFileIds(B)).toEqual(['b1'])
  await render(B)
  await flush()
  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['b1'])
})

test("switching while A's upload is in flight: its finish lands in A only, B's ids untouched", async () => {
  const A = fresh('d7a')
  const B = fresh('d7b')
  updateDraft(B, { fileIds: ['b1'] })
  filesBySession[B] = [sessionFile('b1', B)]
  await render(A)
  await act(async () => {
    files.attach([file()])
  })
  recordWrites()
  await render(B)
  await flush()
  uploadCalls[0]?.resolve(sessionFile('a-new', A))
  await flush()
  stopRecording()

  expect(files.uploads.map((u) => u.serverFile?.id)).toEqual(['b1'])
  expect(storedFileIds(B)).toEqual(['b1'])
  expect(storedFileIds(A)).toEqual(['a-new'])
  expect(fileIdsWrittenFor(B).filter((ids) => ids.join() !== 'b1')).toEqual([])
})

// --- D8. removal and clearSent drop ids from the stored draft -------------------

test('dismissing a done tile removes its id from the stored draft', async () => {
  const S = fresh('d8')
  await render(S)
  await act(async () => {
    draft.setText('t')
    files.attach([file('a.txt'), file('b.txt')])
  })
  uploadCalls[0]?.resolve(sessionFile('fa', S))
  uploadCalls[1]?.resolve(sessionFile('fb', S))
  await flush()
  expect(storedFileIds(S)).toEqual(['fa', 'fb'])

  const tileA = files.uploads.find((u) => u.serverFile?.id === 'fa')
  await act(async () => {
    if (tileA) files.dismiss(tileA.id)
  })
  expect(storedFileIds(S)).toEqual(['fb'])
  expect(stored(S)).toEqual({ text: 't', fileIds: ['fb'] })
})

test('dismissing a rehydrated tile removes its id too', async () => {
  const S = fresh('d8')
  updateDraft(S, { fileIds: ['r1', 'r2'] })
  filesBySession[S] = [sessionFile('r1', S), sessionFile('r2', S)]
  await render(S)
  await flush()
  const r1 = files.uploads.find((u) => u.serverFile?.id === 'r1')
  await act(async () => {
    if (r1) files.dismiss(r1.id)
  })
  expect(storedFileIds(S)).toEqual(['r2'])
})

test('clearSent removes exactly the sent ids; an empty draft then leaves no key at all', async () => {
  const S = fresh('d8')
  await render(S)
  await act(async () => {
    files.attach([file('a.txt'), file('b.txt')])
  })
  uploadCalls[0]?.resolve(sessionFile('fa', S))
  uploadCalls[1]?.resolve(sessionFile('fb', S))
  await flush()

  await act(async () => {
    files.clearSent(['fa'])
  })
  expect(storedFileIds(S)).toEqual(['fb'])
  await act(async () => {
    files.clearSent(['fb'])
  })
  expect(localStorage.getItem(key(S))).toBeNull()
})

test('an uploading tile is never persisted; it joins fileIds only once done', async () => {
  const S = fresh('d8')
  await render(S)
  await act(async () => {
    files.attach([file()])
  })
  expect(localStorage.getItem(key(S))).toBeNull()
  uploadCalls[0]?.resolve(sessionFile('fz', S))
  await flush()
  expect(storedFileIds(S)).toEqual(['fz'])
})
