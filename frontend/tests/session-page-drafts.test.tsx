// Per-session drafts through the real `SessionPage`: the composer's text
// (hooks/use-session-draft.ts) and the attachment tray
// (hooks/use-session-files.ts), both persisted to
// `agentoo:draft:<sessionId>` by lib/drafts.ts.
//
//   D3  text survives navigating away and back, and a reload; a successful
//       send clears it, a failed one hands it back;
//   D4  several sessions' drafts coexist without touching each other;
//   D5  a file attached, then left mid-upload, is there and done on return;
//   D6  after a reload the tray is rebuilt from the stored ids, previewing an
//       image through the session file URL;
//   D7  one mounted page re-rendered from session A to session B (what
//       `SessionRoute` does — no `key`) shows B's rehydrated tile and never
//       writes an empty `fileIds` to B's key, nor anything to A's;
//   D8  removing a tile (the delete succeeding) or sending drops its id.
//
// Rendered like tests/session-page-scroll.test.tsx: the real page and hooks,
// generated clients mocked per file through ./mock-module, a private
// `cimode` i18n instance so every label is its key, a fresh Jotai store and
// a cleared localStorage per test. No router: none of the sessions here is
// `isolated`, so the header renders no `<Link>` (the Docker/Editor links'
// tooltips are covered in tests/session-page-header.test.tsx, which does
// mount one).
//
// Module state: use-session-files.ts's `settledSessions` and tray-atom cache
// live for the whole file, as for a whole page load in the browser. A test
// that needs "first visit after a reload" semantics for the tray therefore
// uses a session id nothing else in this file has used (`fresh()`); for
// text alone, localStorage is all there is, so a fresh store + client is the
// whole reload.
//
// Assertions compare primitives, never DOM nodes — see
// tests/session-page-header.test.tsx on why.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { SessionFile } from '../src/features/sessions/hooks/use-session-files'
import { updateDraft } from '../src/features/sessions/lib/drafts'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { composerModeAtom } from '../src/shared/store/ui'
import { mockModule } from './mock-module'
import { type StorageWrite, swapLocalStorage } from './storage-spy'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-09-04T10:00:00.000Z'

const sessionDto = (id: string, projectId = 'p1'): SessionDto => ({
  id,
  projectId,
  ideaId: null,
  title: `Session ${id}`,
  status: 'idle',
  orchestrator: 'claude',
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/alpha',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
})

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

// --- mocked clients ----------------------------------------------------------

let projectOf: Record<string, string> = {}
let filesBySession: Record<string, SessionFile[]> = {}
let sends: { sessionId: string; body: unknown }[] = []
let sendReject: unknown = null
let sendGate: Promise<void> | null = null
let deletes: { id: string; fileId: string }[] = []
let deleteReject: unknown = null
interface UploadCall {
  sessionId: string
  file: File
  resolve: (data: SessionFile) => void
  reject: (e: unknown) => void
}
let uploadCalls: UploadCall[] = []

await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: sessionDto(opts.path.id, projectOf[opts.path.id]),
  }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async (opts: { path: { id: string } }) => {
    const files = filesBySession[opts.path.id] ?? []
    return {
      data: {
        files,
        usage: { fileCount: files.length, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 1e9 },
      },
    }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdMessages', () => ({
  postApiSessionsIdMessages: async (opts: { path: { id: string }; body?: unknown }) => {
    sends.push({ sessionId: opts.path.id, body: opts.body })
    if (sendGate) await sendGate
    if (sendReject) throw sendReject
    return { data: { id: 'x', seq: 999 } }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdFiles', () => ({
  postApiSessionsIdFiles: (opts: { path: { id: string }; body: { file: File }; signal?: AbortSignal }) =>
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
await mockModule('@/shared/api/generated/clients/deleteApiSessionsIdFilesFileid', () => ({
  deleteApiSessionsIdFilesFileid: async (opts: { path: { id: string; fileId: string } }) => {
    deletes.push({ ...opts.path })
    if (deleteReject) throw deleteReject
    return { data: undefined }
  },
}))

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { SessionPage } = await import('../src/features/sessions/components/session-page')

// --- mounting ----------------------------------------------------------------

let client: QueryClient
let store: ReturnType<typeof createStore>
let container: HTMLDivElement | undefined
let root: Root | undefined

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** Renders (or re-renders, on the same root — the no-`key` session switch)
 *  the page for `sessionId`. */
async function show(sessionId: string) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <SessionPage projectId={projectOf[sessionId] ?? 'p1'} sessionId={sessionId} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  if (!container?.textContent?.includes(`Session ${sessionId}`)) {
    throw new Error(`session page for ${sessionId} never rendered its title`)
  }
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  container = undefined
}

/** A page reload, as far as anything but module state goes: nothing mounted,
 *  a new Jotai store, a new query cache — only localStorage survives. */
async function reload() {
  await unmount()
  client.clear()
  client = newClient()
  store = createStore()
  // Every test here is written against the raw textarea; a reload must not
  // hand it a fresh visual-mode editor instead.
  store.set(composerModeAtom, 'raw')
}

let seq = 0
const fresh = (label: string) => `${label}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

const key = (id: string) => `agentoo:draft:${id}`
const stored = (id: string): unknown => {
  const raw = localStorage.getItem(key(id))
  return raw === null ? null : JSON.parse(raw)
}
const storedFileIds = (id: string) =>
  (stored(id) as { fileIds?: string[] } | null)?.fileIds ?? null

const textarea = () => {
  const t = container?.querySelector('textarea')
  if (!t) throw new Error('no textarea')
  return t as HTMLTextAreaElement
}
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  await act(async () => {
    setter.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function paste(files: File[]) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: { files, types: ['Files'] } })
  await act(async () => {
    textarea().dispatchEvent(ev)
  })
}
const byLabel = (label: string) =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
    (b) => b.getAttribute('aria-label') === label,
  )
async function clickSend() {
  const [send] = byLabel('sessions.send')
  if (!send) throw new Error('no send button')
  await act(async () => {
    send.click()
  })
  await settle()
}
/** Every tray tile as `name:state`. */
const tiles = () =>
  [...(container?.querySelectorAll('[data-slot="attachment"]') ?? [])].map(
    (el) => `${el.querySelector('[title]')?.getAttribute('title') ?? '?'}:${el.getAttribute('data-state')}`,
  )

let writes: StorageWrite[] = []
let restoreStorage: () => void = () => {}

beforeEach(() => {
  projectOf = {}
  filesBySession = {}
  sends = []
  sendReject = null
  sendGate = null
  deletes = []
  deleteReject = null
  uploadCalls = []
  writes = []
  localStorage.clear()
  client = newClient()
  store = createStore()
  // Pinned to raw — see `reload`'s own comment above.
  store.set(composerModeAtom, 'raw')
})

afterEach(async () => {
  restoreStorage()
  await unmount()
  client.clear()
  document.body.replaceChildren()
})

// --- D3. text: away and back, reload, send ------------------------------------

test('text typed in a session is there again after navigating away and back', async () => {
  await show('s-a')
  await type('draft for a')
  expect(stored('s-a')).toEqual({ text: 'draft for a', fileIds: [] })
  await unmount()
  await show('s-a')
  expect(textarea().value).toBe('draft for a')
})

test('text typed in a session is restored after a reload, from localStorage alone', async () => {
  await show('s-a')
  await type('survives reload')
  await reload()
  await show('s-a')
  expect(textarea().value).toBe('survives reload')
})

test('switching sessions on one mounted page swaps the text, and back again', async () => {
  await show('s-a')
  await type('alpha text')
  await show('s-b')
  expect(textarea().value).toBe('')
  await type('beta text')
  await show('s-a')
  expect(textarea().value).toBe('alpha text')
  expect(stored('s-a')).toEqual({ text: 'alpha text', fileIds: [] })
  expect(stored('s-b')).toEqual({ text: 'beta text', fileIds: [] })
})

test('a successful send clears the box and the stored text', async () => {
  await show('s-a')
  await type('  hello there  ')
  await clickSend()
  expect(sends).toEqual([{ sessionId: 's-a', body: { text: 'hello there' } }])
  expect(textarea().value).toBe('')
  // Nothing left worth keeping: the key is gone, not left as an empty record.
  expect(localStorage.getItem(key('s-a'))).toBeNull()
  // And a reload after the send restores nothing.
  await reload()
  await show('s-a')
  expect(textarea().value).toBe('')
})

test('a failed send puts the text back, in the box and in storage', async () => {
  sendReject = { response: { status: 500, data: { error: 'boom' } } }
  await show('s-a')
  await type('please work')
  await clickSend()
  expect(sends).toHaveLength(1)
  expect(textarea().value).toBe('please work')
  expect(stored('s-a')).toEqual({ text: 'please work', fileIds: [] })
  expect(container?.textContent ?? '').toContain('boom')
})

test('a failed send does not overwrite what was typed while it was in flight', async () => {
  let release: () => void = () => {}
  sendGate = new Promise<void>((r) => {
    release = r
  })
  sendReject = new Error('nope')
  await show('s-a')
  await type('first')
  await clickSend()
  expect(textarea().value).toBe('')
  await type('second')
  await act(async () => {
    release()
  })
  await settle()
  expect(textarea().value).toBe('second')
  expect(stored('s-a')).toEqual({ text: 'second', fileIds: [] })
})

// --- D4. independent drafts across sessions and projects ------------------------

test('drafts in sessions of different projects coexist, and editing one leaves the others alone', async () => {
  projectOf = { 'p1-s': 'p1', 'p2-s': 'p2', 'p3-s': 'p3' }
  await show('p1-s')
  await type('one')
  await show('p2-s')
  await type('two')
  await unmount()
  await show('p3-s')
  await type('three')
  const raw1 = localStorage.getItem(key('p1-s'))
  const raw2 = localStorage.getItem(key('p2-s'))

  await type('three, edited')
  await type('')
  expect(localStorage.getItem(key('p3-s'))).toBeNull()
  expect(localStorage.getItem(key('p1-s'))).toBe(raw1)
  expect(localStorage.getItem(key('p2-s'))).toBe(raw2)

  await reload()
  for (const [id, text] of [
    ['p1-s', 'one'],
    ['p2-s', 'two'],
    ['p3-s', ''],
  ] as const) {
    await show(id)
    expect(textarea().value).toBe(text)
  }
})

// --- D5. an upload left behind finishes into the tray and the draft ---------------

test('a file attached, then left mid-upload, is in the tray and done on return', async () => {
  const S = fresh('d5')
  await show(S)
  await paste([new File(['x'], 'left-behind.txt', { type: 'text/plain' })])
  expect(uploadCalls).toHaveLength(1)
  expect(tiles()).toEqual(['left-behind.txt:uploading'])

  await unmount()
  uploadCalls[0]?.resolve(sessionFile('srv-5', S, { originalFilename: 'left-behind.txt' }))
  await settle(3)
  expect(storedFileIds(S)).toEqual(['srv-5'])

  await show(S)
  expect(tiles()).toEqual(['left-behind.txt:done'])
})

// --- D6. rehydration after a reload ------------------------------------------------

test('after a reload the tray is rebuilt from stored ids still ready; an image previews via the file URL', async () => {
  // Fresh id: first visit after a "reload" as far as module state goes.
  const S = fresh('d6')
  updateDraft(S, { text: 'look', fileIds: ['f1', 'f2'] })
  filesBySession[S] = [
    sessionFile('f1', S, { originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 2048 }),
  ]
  await show(S)
  expect(textarea().value).toBe('look')
  expect(tiles()).toEqual(['shot.png:done'])
  const img = container?.querySelector('[data-slot="attachment"] img')
  expect(img?.getAttribute('src')).toBe(`/api/sessions/${S}/files/f1`)
  expect(img?.getAttribute('alt')).toBe('shot.png')
  expect(stored(S)).toEqual({ text: 'look', fileIds: ['f1'] })
})

test('a rehydrated non-image tile shows no preview image, and its size from the SessionFile', async () => {
  const S = fresh('d6')
  updateDraft(S, { fileIds: ['doc'] })
  filesBySession[S] = [
    sessionFile('doc', S, { originalFilename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 2048 }),
  ]
  await show(S)
  expect(tiles()).toEqual(['notes.md:done'])
  const tile = container?.querySelector('[data-slot="attachment"]')
  expect(tile?.querySelector('img')).toBeNull()
  // Name and size come from the SessionFile, since there is no File.
  expect(tile?.querySelector('[data-slot="attachment-description"]')?.textContent).toBe('MD · 2.0 KB')
})

// --- D7. the regression: A → B on one mounted page ---------------------------------

for (const aFileIds of [[], ['a1']]) {
  test(`re-rendering one page from A (${aFileIds.length ? 'with' : 'without'} fileIds) to B shows B's b1 tile and never empties B's stored fileIds`, async () => {
    // Fresh ids: B's first visit this page load, its tray empty in memory.
    const A = fresh('d7a')
    const B = fresh('d7b')
    updateDraft(A, { text: 'alpha', fileIds: aFileIds })
    filesBySession[A] = aFileIds.map((id) => sessionFile(id, A))
    updateDraft(B, { text: 'beta', fileIds: ['b1'] })
    filesBySession[B] = [sessionFile('b1', B, { originalFilename: 'b1.txt' })]

    await show(A)
    expect(tiles()).toEqual(aFileIds.map((id) => `${id}.txt:done`))
    const rawA = localStorage.getItem(key(A))

    restoreStorage = swapLocalStorage({ onWrite: (w) => writes.push(w) })
    await show(B)
    await settle()
    restoreStorage()

    expect(tiles()).toEqual(['b1.txt:done'])
    expect(textarea().value).toBe('beta')
    expect(stored(B)).toEqual({ text: 'beta', fileIds: ['b1'] })

    const bad = writes
      .filter((w) => w.key === key(B))
      .filter((w) => {
        if (w.op === 'remove') return true
        const ids = (JSON.parse(w.value ?? '{}') as { fileIds?: string[] }).fileIds ?? []
        return ids.join() !== 'b1'
      })
    expect(bad).toEqual([])
    expect(writes.filter((w) => w.key === key(A))).toEqual([])
    expect(localStorage.getItem(key(A))).toBe(rawA)

    // And a reload now still finds B's attachment.
    await reload()
    await show(B)
    expect(storedFileIds(B)).toEqual(['b1'])
  })
}

// --- D8. removing and sending drop ids -----------------------------------------------

test("removing a done tile deletes the file and drops its id from the stored draft", async () => {
  const S = fresh('d8')
  updateDraft(S, { text: 'keep text', fileIds: ['r1', 'r2'] })
  filesBySession[S] = [sessionFile('r1', S), sessionFile('r2', S)]
  await show(S)
  expect(tiles()).toEqual(['r1.txt:done', 'r2.txt:done'])

  // cimode: `sessions.attachments.remove` with no interpolated name.
  const [x] = byLabel('sessions.attachments.remove')
  await act(async () => {
    x?.click()
  })
  await settle()
  expect(deletes).toEqual([{ id: S, fileId: 'r1' }])
  expect(tiles()).toEqual(['r2.txt:done'])
  expect(stored(S)).toEqual({ text: 'keep text', fileIds: ['r2'] })
})

test('a failed delete keeps the tile and its stored id', async () => {
  const S = fresh('d8')
  updateDraft(S, { fileIds: ['r1'] })
  filesBySession[S] = [sessionFile('r1', S)]
  deleteReject = new Error('500')
  await show(S)
  const [x] = byLabel('sessions.attachments.remove')
  await act(async () => {
    x?.click()
  })
  await settle()
  expect(deletes).toHaveLength(1)
  expect(tiles()).toEqual(['r1.txt:done'])
  expect(storedFileIds(S)).toEqual(['r1'])
})

test('a successful send clears the sent tiles and leaves no draft key at all', async () => {
  const S = fresh('d8')
  updateDraft(S, { fileIds: ['r1'] })
  filesBySession[S] = [sessionFile('r1', S)]
  await show(S)
  await type('with attachment')
  await clickSend()
  expect(sends).toEqual([{ sessionId: S, body: { text: 'with attachment' } }])
  expect(tiles()).toEqual([])
  expect(localStorage.getItem(key(S))).toBeNull()
})

test('a failed send keeps the tiles and their stored ids for the retry', async () => {
  const S = fresh('d8')
  updateDraft(S, { fileIds: ['r1'] })
  filesBySession[S] = [sessionFile('r1', S)]
  sendReject = new Error('nope')
  await show(S)
  await type('retry me')
  await clickSend()
  expect(tiles()).toEqual(['r1.txt:done'])
  expect(stored(S)).toEqual({ text: 'retry me', fileIds: ['r1'] })
})

// --- D9. visual mode: the same drafting contract, through CodeMirror ---------
//
// Everything above is written against the raw textarea (`store.set` in
// `beforeEach`/`reload` pins it there). This section overrides that per test
// to check the same claims hold for the visual surface `MarkdownEditor`
// renders instead — no textarea, no `use-session-draft.ts`/`lib/drafts.ts`
// change of any kind, so the same storage spy from D7 is reused verbatim.

const cmView = () => {
  const el = container?.querySelector('.cm-editor')
  if (!el) throw new Error('no CodeMirror editor mounted')
  const view = EditorView.findFromDOM(el as HTMLElement)
  if (!view) throw new Error('no CodeMirror view for the mounted editor')
  return view
}
async function typeInEditor(value: string) {
  await act(async () => {
    cmView().dispatch({
      changes: { from: 0, to: cmView().state.doc.length, insert: value },
      userEvent: 'input.type',
    })
  })
}

test('visual mode: A -> B session switch on one mounted page writes nothing to storage', async () => {
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  await typeInEditor('alpha text')
  expect(stored('s-a')).toEqual({ text: 'alpha text', fileIds: [] })

  restoreStorage = swapLocalStorage({ onWrite: (w) => writes.push(w) })
  await show('s-b')
  await settle()
  restoreStorage()

  expect(cmView().state.doc.toString()).toBe('')
  expect(writes).toEqual([])
})

test('visual mode: typing after the switch lands only in the new session', async () => {
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  await typeInEditor('alpha text')
  await show('s-b')
  expect(cmView().state.doc.toString()).toBe('')
  await typeInEditor('beta text')
  await show('s-a')
  expect(cmView().state.doc.toString()).toBe('alpha text')
  expect(stored('s-a')).toEqual({ text: 'alpha text', fileIds: [] })
  expect(stored('s-b')).toEqual({ text: 'beta text', fileIds: [] })
})

test('visual mode: a successful send clears the editor and the stored text', async () => {
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  await typeInEditor('hello there')
  await clickSend()
  expect(sends).toEqual([{ sessionId: 's-a', body: { text: 'hello there' } }])
  expect(cmView().state.doc.toString()).toBe('')
  expect(localStorage.getItem(key('s-a'))).toBeNull()
})

test('visual mode: a failed send restores the text into what send had just emptied', async () => {
  sendReject = { response: { status: 500, data: { error: 'boom' } } }
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  await typeInEditor('please work')
  await clickSend()
  expect(cmView().state.doc.toString()).toBe('please work')
  expect(stored('s-a')).toEqual({ text: 'please work', fileIds: [] })
})

test('visual mode: a reload restores the text into the editor', async () => {
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  await typeInEditor('survives reload')
  await reload()
  // `reload()` pins a fresh store back to raw (every other test in this file
  // wants that) — this test is the one exception.
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  expect(cmView().state.doc.toString()).toBe('survives reload')
})
