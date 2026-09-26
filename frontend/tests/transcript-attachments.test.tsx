// Attachments rendered under a `prompt` node, driven straight off
// `message.files` — no in-memory pairing, no second fetch. An image gets a
// thumbnail, a non-image gets a download chip, and — the acceptance criterion
// this track names explicitly — a file id that no longer resolves to
// something fetchable (hard-deleted, or merely flipped off `ready`) renders a
// "file removed" placeholder rather than a broken `<img>` or a crash. Because
// this reads only the message the caller passes in, the same fixture used
// here for "one prompt among many" is exactly what a reload, a second tab, or
// history paged back into view would hand the component — there is no
// separate "does it survive a reload" mechanism to test.

import { afterEach, expect, test } from 'bun:test'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { Transcript } from '../src/features/sessions/components/transcript'

// The placeholder is asserted by its raw key, so this file renders under a
// private `cimode` instance (i18next's always-return-the-key mode) rather
// than react-i18next's process-wide default. That default is installed by
// whichever earlier file first imports `@/shared/i18n` (directly, or through
// `src/app/router`); after it, a provider-less render shows "File removed"
// and the placeholder assertions below failed, while the "renders none of
// this" case turned vacuous. Never `.use(initReactI18next)` on this instance —
// see tests/settings-page.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

type M = Parameters<typeof Transcript>[0]['messages'][number]
type MessageFile = M['files'][number]

const file = (o: Partial<MessageFile> & { id: string | null }): MessageFile => ({
  originalFilename: null,
  mimeType: null,
  sizeBytes: null,
  status: null,
  ...o,
})

let n = 0
const promptMessage = (files: MessageFile[]): M =>
  ({
    id: `msg-${n++}`,
    sessionId: 's1',
    seq: n,
    type: 'prompt',
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: { text: 'here is what I mean' },
    files,
    createdAt: '2026-09-04T10:00:00.000Z',
  }) as M

let container: HTMLDivElement
let root: Root

function mount(files: MessageFile[]) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <Transcript messages={[promptMessage(files)]} sessionId="s1" />
      </I18nextProvider>,
    )
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  // A lightbox opened by one test portals outside `container`.
  document.body.replaceChildren()
})

test('a ready image file renders as a thumbnail pointed at the hand-built download route', () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 100, status: 'ready' }),
  ])

  const img = container.querySelector('img')
  expect(img).not.toBeNull()
  expect(img?.getAttribute('src')).toBe('/api/sessions/s1/files/img-1')
  expect(img?.getAttribute('alt')).toBe('shot.png')
})

test('a ready non-image file renders as a chip linking at the download route', () => {
  mount([
    file({ id: 'doc-1', originalFilename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 42, status: 'ready' }),
  ])

  const link = container.querySelector('a')
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('/api/sessions/s1/files/doc-1')
  // The link is a childless overlay across the whole tile (shadcn's
  // `AttachmentTrigger render={<a/>}`), so the filename is not its own text:
  // it lives in the sibling title, in the same tile, and the link announces
  // itself through its aria-label instead.
  expect(link?.getAttribute('download')).toBe('notes.txt')
  expect(link?.getAttribute('aria-label')).toBe('sessions.attachments.download')
  const tile = link?.closest('[data-slot="attachment"]')
  expect(tile).not.toBeNull()
  expect(tile?.querySelector('[data-slot="attachment-title"]')?.textContent).toBe('notes.txt')
  expect(container.querySelector('img')).toBeNull()
})

// The acceptance criterion this track names explicitly: `message_files.fileId`
// is nullable (ON DELETE SET NULL), so a hard-deleted file surfaces as an
// entry with `id: null` and `mimeType`/`sizeBytes`/`status` all null too, with
// only the denormalised `originalFilename` (itself nullable) surviving. Never
// a broken image, never a crash — the placeholder, exactly like any other
// removed file.
test('a hard-deleted file (id: null) renders the "removed" placeholder, not a crash', () => {
  mount([file({ id: null, originalFilename: 'wiped.png' })])

  expect(container.textContent).toContain('sessions.attachments.removed')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
})

test('a hard-deleted file with no filename left either still renders the placeholder', () => {
  mount([file({ id: null, originalFilename: null })])

  expect(container.textContent).toContain('sessions.attachments.removed')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
})

test('a row that still exists but is no longer "ready" also renders "removed", never a broken image', () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 100, status: 'missing' }),
  ])

  expect(container.textContent).toContain('sessions.attachments.removed')
  expect(container.querySelector('img')).toBeNull()
})

test('an <img> that fails to load falls back to the chip instead of staying broken', () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 100, status: 'ready' }),
  ])

  const img = container.querySelector('img')
  expect(img).not.toBeNull()
  act(() => {
    img?.dispatchEvent(new Event('error'))
  })

  expect(container.querySelector('img')).toBeNull()
  const link = container.querySelector('a')
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('/api/sessions/s1/files/img-1')
})

test('a prompt with no recorded attachments renders none of this at all', () => {
  mount([])

  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
  expect(container.textContent).not.toContain('sessions.attachments.removed')
})

test('several files on one prompt each render on their own merits — mixed ready and removed', () => {
  // Exactly the "reload" case: a page freshly fetched from the server can
  // report one file still ready and another already gone, on the same
  // message, and both have to render correctly side by side.
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 100, status: 'ready' }),
    file({ id: null, originalFilename: 'gone.txt' }),
  ])

  expect(container.querySelector('img')).not.toBeNull()
  expect(container.textContent).toContain('sessions.attachments.removed')
})

// --- The vertical tile layout shared with the composer's tray ---------------

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

const tiles = () => Array.from(container.querySelectorAll('[data-slot="attachment"]'))
const dialogContent = () => document.querySelector('[data-slot="dialog-content"]')

test('every ready file is a vertical tile titled by filename, described "<EXT> · <size>"', () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, status: 'ready' }),
    file({ id: 'doc-1', originalFilename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 42, status: 'ready' }),
    file({ id: 'mk-1', originalFilename: 'Makefile', mimeType: 'text/plain', sizeBytes: 1536, status: 'ready' }),
  ])

  const t = tiles()
  expect(t.length).toBe(3)
  expect(t.map((x) => x.getAttribute('data-orientation'))).toEqual(['vertical', 'vertical', 'vertical'])
  expect(t.map((x) => x.getAttribute('data-state'))).toEqual(['done', 'done', 'done'])
  expect(t.map((x) => x.querySelector('[data-slot="attachment-title"]')?.textContent)).toEqual([
    'shot.png',
    'notes.txt',
    'Makefile',
  ])
  expect(t.map((x) => x.querySelector('[data-slot="attachment-description"]')?.textContent)).toEqual([
    'PNG · 2.0 KB',
    'TXT · 42 B',
    '1.5 KB',
  ])
})

test('an image tile has a preview trigger, not a download link, that opens a dialog with the full image', async () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 100, status: 'ready' }),
  ])
  const [tile] = tiles()
  expect(tile).toBeDefined()
  const thumb = tile?.querySelector('[data-slot="attachment-media"] img')
  expect(thumb?.getAttribute('src')).toBe('/api/sessions/s1/files/img-1')
  expect(tile?.querySelector('a')).toBeNull()

  const trigger = tile?.querySelector<HTMLButtonElement>('[aria-label="sessions.attachments.preview"]')
  expect(trigger).not.toBeNull()
  expect(trigger?.tagName).toBe('BUTTON')
  expect(dialogContent()).toBeNull()

  await act(async () => {
    trigger?.click()
  })
  await flush()

  const dlg = dialogContent()
  expect(dlg).not.toBeNull()
  const full = dlg?.querySelector('img')
  expect(full?.getAttribute('src')).toBe('/api/sessions/s1/files/img-1')
  expect(full?.getAttribute('alt')).toBe('shot.png')
  expect(dlg?.textContent).toContain('shot.png')
})

test('a non-image tile is a download-link overlay inside the tile, with no preview trigger', () => {
  mount([
    file({ id: 'pdf-1', originalFilename: 'spec.pdf', mimeType: 'application/pdf', sizeBytes: 10, status: 'ready' }),
  ])
  const [tile] = tiles()
  const link = tile?.querySelector('a')
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('/api/sessions/s1/files/pdf-1')
  expect(link?.getAttribute('download')).toBe('spec.pdf')
  expect(link?.getAttribute('aria-label')).toBe('sessions.attachments.download')
  expect(tile?.textContent).toContain('spec.pdf')
  expect(tile?.querySelector('[aria-label="sessions.attachments.preview"]')).toBeNull()
  expect(tile?.querySelector('img')).toBeNull()
})

test('a broken thumbnail falls back to the download-link tile with the same title and description', () => {
  mount([
    file({ id: 'img-1', originalFilename: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, status: 'ready' }),
  ])
  act(() => {
    container.querySelector('img')?.dispatchEvent(new Event('error'))
  })
  const [tile] = tiles()
  expect(tile?.querySelector('img')).toBeNull()
  expect(tile?.querySelector('[aria-label="sessions.attachments.preview"]')).toBeNull()
  const link = tile?.querySelector('a')
  expect(link?.getAttribute('download')).toBe('shot.png')
  expect(link?.getAttribute('aria-label')).toBe('sessions.attachments.download')
  expect(tile?.querySelector('[data-slot="attachment-title"]')?.textContent).toBe('shot.png')
  expect(tile?.querySelector('[data-slot="attachment-description"]')?.textContent).toBe('PNG · 2.0 KB')
})

test('a removed file is an idle vertical placeholder tile with no img and no link', () => {
  mount([file({ id: null, originalFilename: 'gone.png' })])
  const [tile] = tiles()
  expect(tile?.getAttribute('data-state')).toBe('idle')
  expect(tile?.getAttribute('data-orientation')).toBe('vertical')
  expect(tile?.textContent).toContain('sessions.attachments.removed')
  expect(tile?.querySelector('img')).toBeNull()
  expect(tile?.querySelector('a')).toBeNull()
  expect(tile?.querySelector('button')).toBeNull()
})
