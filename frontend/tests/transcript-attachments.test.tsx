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

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx,
// tests/transcript-row.test.tsx and tests/transcript-time.test.tsx: `Transcript`
// pulls in the `@/shared/ui` barrel too, and whichever of them `bun test`
// evaluates first decides how those ten modules are cached for the run — see
// the long note in transcript-time.test.tsx. Copied verbatim, not widened.
import { plugin } from 'bun'

const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'transcript-attachments-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { Transcript } = await import('../src/features/sessions/components/transcript')

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
    root.render(<Transcript messages={[promptMessage(files)]} sessionId="s1" />)
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
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
  expect(link?.textContent).toContain('notes.txt')
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
