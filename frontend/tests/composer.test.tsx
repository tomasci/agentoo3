// The session composer on its own: layout of the footer (queue line, tray,
// input box, alerts), the compact/expanded input-group switch, the attach and
// send buttons, paste/drop, and the tray's per-upload tiles (state,
// description, object-URL preview and its cleanup, lightbox vs the X action).
//
// Rendered under a private `cimode` i18n instance so `t()` returns the bare
// key — see tests/transcript-attachments.test.tsx for why this must never be
// react-i18next's process-wide default. One test uses a second, private `en`
// instance to check the usage line's interpolated values, which cimode hides.
//
// Only the literal-newline path into expanded mode is exercised here: the
// wrap-by-width path compares real layout heights, and happy-dom reports 0
// for all of them.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import i18next, { type i18n } from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { Composer, type ComposerAttachments } from '../src/features/sessions/components/composer'
import type {
  AttachmentUpload,
  SessionFilesUsage,
} from '../src/features/sessions/hooks/use-session-files'
import en from '../src/shared/i18n/locales/en.json'

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

type ComposerProps = Parameters<typeof Composer>[0]

// --- URL.createObjectURL / revokeObjectURL stubs ---------------------------

let created: { url: string; file: unknown }[] = []
let revoked: string[] = []
let urlSeq = 0
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL

beforeEach(() => {
  created = []
  revoked = []
  URL.createObjectURL = ((obj: unknown) => {
    const url = `blob:http://localhost/test-${urlSeq++}`
    created.push({ url, file: obj })
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL
})

// --- fixtures ---------------------------------------------------------------

const usage: SessionFilesUsage = {
  fileCount: 2,
  maxFiles: 10,
  sizeBytes: 1024,
  maxSessionBytes: 1024 * 1024,
} as SessionFilesUsage

const mkFile = (name: string, type: string, size = 2048) =>
  new File([new Uint8Array(size)], name, { type })

let uploadSeq = 0
const upload = (o: Partial<AttachmentUpload> & { file: File }): AttachmentUpload => ({
  id: `u-${uploadSeq++}`,
  progress: 0,
  status: 'done',
  ...o,
})

let calls: {
  onChange: string[]
  onSubmit: number
  onAttach: { files: File[]; usage?: SessionFilesUsage }[]
  onCancel: string[]
  onRemove: AttachmentUpload[]
}

const attachments = (o: Partial<ComposerAttachments> = {}): ComposerAttachments => ({
  uploads: [],
  usage: undefined,
  usagePending: false,
  usageError: null,
  pendingCount: 0,
  onAttach: (files, u) => calls.onAttach.push({ files, usage: u }),
  onCancel: (id) => calls.onCancel.push(id),
  onRemove: (u) => calls.onRemove.push(u),
  ...o,
})

const props = (o: Partial<ComposerProps> = {}): ComposerProps => ({
  value: '',
  onChange: (v) => calls.onChange.push(v),
  onSubmit: () => {
    calls.onSubmit++
  },
  onKeyDown: () => {},
  sending: false,
  canSend: true,
  orchestratorMissing: false,
  queueLine: '',
  error: null,
  attachments: attachments(),
  ...o,
})

// --- mounting ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root | undefined
let mounted = false

function render(p: ComposerProps, instance: i18n = cimode) {
  act(() => {
    root?.render(
      <I18nextProvider i18n={instance}>
        <Composer {...p} />
      </I18nextProvider>,
    )
  })
}

function mount(p: ComposerProps, instance: i18n = cimode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mounted = true
  render(p, instance)
}

function unmount() {
  if (!mounted) return
  act(() => {
    root?.unmount()
  })
  mounted = false
}

beforeEach(() => {
  calls = { onChange: [], onSubmit: 0, onAttach: [], onCancel: [], onRemove: [] }
})

afterEach(() => {
  unmount()
  root = undefined
  document.body.replaceChildren()
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

const q = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = container) =>
  scope.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = container) =>
  Array.from(scope.querySelectorAll<T>(sel))
const byLabel = (label: string, scope: ParentNode = container) =>
  q<HTMLButtonElement>(`[aria-label="${label}"]`, scope)
const footer = () => {
  const f = container.firstElementChild
  if (!f) throw new Error('composer rendered nothing')
  return f as HTMLElement
}
const inputGroup = () => {
  const g = q('[data-slot="input-group"]')
  if (!g) throw new Error('no input group')
  return g
}
const addon = (align: string) =>
  q(`[data-slot="input-group-addon"][data-align="${align}"]`, inputGroup())
const textarea = () => {
  const t = q<HTMLTextAreaElement>('textarea')
  if (!t) throw new Error('no textarea')
  return t
}
const tiles = () => qa('[data-slot="attachment"]')
const before = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

const ATTACH = 'sessions.attachments.attach'
const SEND = 'sessions.send'
const SENDING = 'sessions.sending'

// --- 1. footer layout -------------------------------------------------------

test('root is a <footer> ordering queue line, tray, input box, then the two alerts', () => {
  mount(
    props({
      queueLine: 'QUEUE-LINE',
      orchestratorMissing: true,
      error: 'SEND-FAILED',
      attachments: attachments({ uploads: [upload({ file: mkFile('a.txt', 'text/plain') })] }),
    }),
  )

  const f = footer()
  expect(f.tagName).toBe('FOOTER')

  const queue = Array.from(f.querySelectorAll('span')).find((s) => s.textContent === 'QUEUE-LINE')
  const tray = q('[data-slot="attachment-group"]')
  const group = inputGroup()
  const status = q('[role="status"]', f)
  const alerts = qa('[data-slot="alert"], [role="alert"]', f)
  const destructive = alerts.find((a) => a.textContent?.includes('SEND-FAILED'))

  expect(queue).toBeDefined()
  expect(tray).not.toBeNull()
  expect(status?.textContent).toContain('sessions.needsOrchestrator')
  expect(destructive).toBeDefined()
  if (!queue || !tray || !status || !destructive) throw new Error('missing a region')

  expect(before(queue, tray)).toBe(true)
  expect(before(tray, group)).toBe(true)
  expect(before(group, status)).toBe(true)
  expect(before(status, destructive)).toBe(true)
  // Neither alert lives inside the input box.
  expect(group.contains(status)).toBe(false)
  expect(group.contains(destructive)).toBe(false)
})

test('an empty queueLine renders no queue line, and no alerts without their flags', () => {
  mount(props())
  expect(q('[role="status"]')).toBeNull()
  expect(qa('[data-slot="alert"]').length).toBe(0)
  // The footer holds only the hidden file input and the input group.
  const kids = Array.from(footer().children)
  expect(kids.map((k) => k.tagName)).toEqual(['INPUT', 'DIV'])
})

// --- 2. tray + usage only with uploads -------------------------------------

test('with zero uploads there is no tray and no usage/blocking/usage-error text, even with usage given', () => {
  mount(
    props({
      attachments: attachments({
        usage,
        usagePending: true,
        usageError: new Error('USAGE-BOOM'),
        pendingCount: 2,
      }),
    }),
  )
  expect(q('[data-slot="attachment-group"]')).toBeNull()
  const text = container.textContent ?? ''
  expect(text).not.toContain('sessions.attachments.usage')
  expect(text).not.toContain('USAGE-BOOM')
  expect(text).not.toContain('sessions.attachments.usageLoadFailed')
  expect(text).not.toContain('sessions.attachments.blockingSend')
  expect(q('[data-slot="spinner"]')).toBeNull()
})

test('with zero uploads the real English usage string is absent too', () => {
  mount(props({ attachments: attachments({ usage }) }), english)
  expect(container.textContent ?? '').not.toContain('files ·')
})

test('with uploads the usage line sits directly below the tray, above the input box', () => {
  mount(
    props({
      attachments: attachments({
        usage,
        uploads: [upload({ file: mkFile('a.txt', 'text/plain') })],
      }),
    }),
  )
  const tray = q('[data-slot="attachment-group"]')
  const usageSpan = Array.from(container.querySelectorAll('span')).find(
    (s) => s.textContent === 'sessions.attachments.usage',
  )
  expect(tray).not.toBeNull()
  expect(usageSpan).toBeDefined()
  if (!tray || !usageSpan) return
  expect(tray.contains(usageSpan)).toBe(false)
  expect(before(tray, usageSpan)).toBe(true)
  expect(before(usageSpan, inputGroup())).toBe(true)
})

test('the usage line interpolates count, maxFiles, used and max', () => {
  mount(
    props({
      attachments: attachments({
        usage,
        uploads: [upload({ file: mkFile('a.txt', 'text/plain') })],
      }),
    }),
    english,
  )
  expect(container.textContent).toContain('2 of 10 files · 1.0 KB of 1.0 MB')
})

test('with uploads, the usage spinner, the usage error and the blocking line show when their inputs say so', () => {
  mount(
    props({
      attachments: attachments({
        usagePending: true,
        usageError: new Error('USAGE-BOOM'),
        pendingCount: 1,
        uploads: [upload({ file: mkFile('a.txt', 'text/plain') })],
      }),
    }),
  )
  expect(q('[data-slot="spinner"]', footer())).not.toBeNull()
  expect(container.textContent).toContain('USAGE-BOOM')
  expect(container.textContent).toContain('sessions.attachments.blockingSend')
  // None of it inside the input box.
  expect(inputGroup().textContent).not.toContain('USAGE-BOOM')
})

test('a usage error with no message of its own falls back to usageLoadFailed', () => {
  mount(
    props({
      attachments: attachments({
        usageError: { some: 'thing' },
        uploads: [upload({ file: mkFile('a.txt', 'text/plain') })],
      }),
    }),
  )
  expect(container.textContent).toContain('sessions.attachments.usageLoadFailed')
})

test('pendingCount 0 with uploads shows no blocking line', () => {
  mount(
    props({
      attachments: attachments({ uploads: [upload({ file: mkFile('a.txt', 'text/plain') })] }),
    }),
  )
  expect(container.textContent).not.toContain('sessions.attachments.blockingSend')
})

// --- 3. empty value ---------------------------------------------------------

test('empty value: attach button at the start of the box and no send button', () => {
  mount(props({ value: '' }))
  const attach = byLabel(ATTACH)
  expect(attach).not.toBeNull()
  expect(addon('inline-start')?.contains(attach)).toBe(true)
  expect(byLabel(SEND)).toBeNull()
  expect(byLabel(SENDING)).toBeNull()
  expect(addon('inline-end')).toBeNull()
  expect(addon('block-end')).toBeNull()
})

test('whitespace-only value is treated as empty for the send button', () => {
  mount(props({ value: '   ' }))
  expect(byLabel(SEND)).toBeNull()
})

test('clicking attach clicks the hidden multi-file input, which sits outside the input group', () => {
  mount(props())
  const input = q<HTMLInputElement>('input[type="file"]')
  expect(input).not.toBeNull()
  if (!input) return
  expect(input.multiple).toBe(true)
  expect(inputGroup().contains(input)).toBe(false)

  let clicks = 0
  input.click = () => {
    clicks++
  }
  act(() => {
    byLabel(ATTACH)?.click()
  })
  expect(clicks).toBe(1)
})

// --- 4. compact, non-empty --------------------------------------------------

test('non-empty single-line value: attach inline-start, icon-only send inline-end', () => {
  mount(props({ value: 'hello' }))
  const attach = byLabel(ATTACH)
  const send = byLabel(SEND)
  expect(attach).not.toBeNull()
  expect(send).not.toBeNull()
  expect(addon('inline-start')?.contains(attach)).toBe(true)
  expect(addon('inline-end')?.contains(send)).toBe(true)
  expect(addon('block-end')).toBeNull()
  expect(send?.textContent).toBe('')
  expect(send?.querySelector('svg')).not.toBeNull()
  expect(send?.querySelector('[data-slot="spinner"]')).toBeNull()
})

test('send is disabled when canSend is false, and clicking it then does nothing', () => {
  mount(props({ value: 'hello', canSend: false }))
  const send = byLabel(SEND)
  expect(send?.disabled).toBe(true)
  act(() => {
    send?.click()
  })
  expect(calls.onSubmit).toBe(0)
})

test('send enabled: clicking it calls onSubmit once', () => {
  mount(props({ value: 'hello', canSend: true }))
  const send = byLabel(SEND)
  expect(send?.disabled).toBe(false)
  act(() => {
    send?.click()
  })
  expect(calls.onSubmit).toBe(1)
})

test('sending with an empty value still shows the send button, with a spinner and the sending label', () => {
  mount(props({ value: '', sending: true, canSend: false }))
  expect(byLabel(SEND)).toBeNull()
  const sending = byLabel(SENDING)
  expect(sending).not.toBeNull()
  expect(sending?.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(addon('inline-end')?.contains(sending)).toBe(true)
})

test('typing calls onChange with the new value', async () => {
  mount(props())
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  await act(async () => {
    setter.call(textarea(), 'hi')
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(calls.onChange).toEqual(['hi'])
})

// --- 5/6/7. expanded mode ---------------------------------------------------

test('a newline moves both buttons into one block-end addon, attach first, send last', () => {
  mount(props({ value: 'line one\nline two' }))
  const block = addon('block-end')
  expect(block).not.toBeNull()
  expect(addon('inline-start')).toBeNull()
  expect(addon('inline-end')).toBeNull()
  const buttons = qa<HTMLButtonElement>('button', block ?? container)
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([ATTACH, SEND])
})

test('expanded is sticky until the value is emptied; rows follow it; the textarea node never remounts', () => {
  mount(props({ value: '' }))
  const ta = textarea()
  expect(ta.getAttribute('rows')).toBe('1')
  expect(addon('block-end')).toBeNull()

  render(props({ value: 'a\nb' }))
  expect(textarea()).toBe(ta)
  expect(ta.getAttribute('rows')).toBe('3')
  expect(addon('block-end')).not.toBeNull()
  expect(addon('inline-start')).toBeNull()

  // No newline any more — still expanded.
  render(props({ value: 'ab' }))
  expect(textarea()).toBe(ta)
  expect(ta.getAttribute('rows')).toBe('3')
  expect(addon('block-end')).not.toBeNull()
  expect(addon('inline-start')).toBeNull()
  expect(addon('inline-end')).toBeNull()

  // Whitespace only is not '' — still expanded.
  render(props({ value: ' ' }))
  expect(addon('block-end')).not.toBeNull()

  // Only '' collapses.
  render(props({ value: '' }))
  expect(textarea()).toBe(ta)
  expect(ta.getAttribute('rows')).toBe('1')
  expect(addon('block-end')).toBeNull()
  expect(addon('inline-start')?.contains(byLabel(ATTACH))).toBe(true)

  // And a plain single line afterwards stays compact.
  render(props({ value: 'plain' }))
  expect(textarea()).toBe(ta)
  expect(ta.getAttribute('rows')).toBe('1')
  expect(addon('inline-end')?.contains(byLabel(SEND))).toBe(true)
})

test('focus survives the compact -> expanded switch', () => {
  mount(props({ value: 'a' }))
  const ta = textarea()
  ta.focus()
  expect(document.activeElement).toBe(ta)
  render(props({ value: 'a\n' }))
  expect(addon('block-end')).not.toBeNull()
  expect(document.activeElement).toBe(ta)
})

test('expanded with empty value but sending shows attach and the sending button in block-end', () => {
  mount(props({ value: 'a\nb' }))
  render(props({ value: 'a\nb', sending: true }))
  const block = addon('block-end')
  const labels = qa('button', block ?? container).map((b) => b.getAttribute('aria-label'))
  expect(labels).toEqual([ATTACH, SENDING])
})

// --- 8. paste / drop --------------------------------------------------------

function eventWith(type: string, key: 'clipboardData' | 'dataTransfer', files: File[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, key, { value: { files, types: files.length ? ['Files'] : [] } })
  return ev
}

test('pasting clipboard files calls onAttach(files, usage) and prevents the default paste', () => {
  const withUsage = attachments({ usage })
  mount(props({ attachments: withUsage }))
  const files = [mkFile('shot.png', 'image/png'), mkFile('b.txt', 'text/plain')]
  const ev = eventWith('paste', 'clipboardData', files)
  act(() => {
    textarea().dispatchEvent(ev)
  })
  expect(calls.onAttach.length).toBe(1)
  expect(calls.onAttach[0]?.files).toEqual(files)
  expect(calls.onAttach[0]?.usage).toBe(usage)
  expect(ev.defaultPrevented).toBe(true)
})

test('pasting plain text (no files) does not call onAttach and leaves the paste alone', () => {
  mount(props())
  const ev = eventWith('paste', 'clipboardData', [])
  act(() => {
    textarea().dispatchEvent(ev)
  })
  expect(calls.onAttach.length).toBe(0)
  expect(ev.defaultPrevented).toBe(false)
})

test('dropping files onto the footer calls onAttach(files, usage)', () => {
  mount(props({ attachments: attachments({ usage }) }))
  const files = [mkFile('a.md', 'text/markdown')]
  act(() => {
    footer().dispatchEvent(eventWith('drop', 'dataTransfer', files))
  })
  expect(calls.onAttach.length).toBe(1)
  expect(calls.onAttach[0]?.files).toEqual(files)
  expect(calls.onAttach[0]?.usage).toBe(usage)
})

test('dropping with no files does not call onAttach', () => {
  mount(props())
  act(() => {
    footer().dispatchEvent(eventWith('drop', 'dataTransfer', []))
  })
  expect(calls.onAttach.length).toBe(0)
})

test('dragover on the footer is prevented so it is a valid drop target', () => {
  mount(props())
  const ev = eventWith('dragover', 'dataTransfer', [])
  act(() => {
    footer().dispatchEvent(ev)
  })
  expect(ev.defaultPrevented).toBe(true)
})

// --- 9/10. tile state + description ----------------------------------------

test('every tray tile is vertical and carries data-state from the upload status', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [
          upload({ file: mkFile('a.txt', 'text/plain'), status: 'uploading', progress: 10 }),
          upload({ file: mkFile('b.txt', 'text/plain'), status: 'error' }),
          upload({ file: mkFile('c.txt', 'text/plain'), status: 'done' }),
        ],
      }),
    }),
  )
  const t = tiles()
  expect(t.length).toBe(3)
  expect(t.map((x) => x.getAttribute('data-orientation'))).toEqual([
    'vertical',
    'vertical',
    'vertical',
  ])
  expect(t.map((x) => x.getAttribute('data-state'))).toEqual(['uploading', 'error', 'done'])
  // Every tile sits inside the attachment group.
  const group = q('[data-slot="attachment-group"]')
  for (const x of t) expect(group?.contains(x)).toBe(true)
})

const description = (tile: Element) => q('[data-slot="attachment-description"]', tile)
const title = (tile: Element) => q('[data-slot="attachment-title"]', tile)

test('done tile: title is the filename, description is "<EXT> · <size>", no title attribute', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [upload({ file: mkFile('report.pdf', 'application/pdf', 2048) })],
      }),
    }),
  )
  const [tile] = tiles()
  if (!tile) throw new Error('no tile')
  expect(title(tile)?.textContent).toBe('report.pdf')
  expect(description(tile)?.textContent).toBe('PDF · 2.0 KB')
  expect(description(tile)?.hasAttribute('title')).toBe(false)
})

test('uploading tile: description is "<EXT> · <progress>%"', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [
          upload({ file: mkFile('notes.md', 'text/markdown'), status: 'uploading', progress: 42 }),
        ],
      }),
    }),
  )
  const [tile] = tiles()
  if (!tile) throw new Error('no tile')
  expect(description(tile)?.textContent).toBe('MD · 42%')
})

test('error tile with precheckFailed: tooLargeForSession, mirrored into title', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [
          upload({ file: mkFile('big.bin', ''), status: 'error', precheckFailed: true }),
        ],
      }),
    }),
  )
  const [tile] = tiles()
  if (!tile) throw new Error('no tile')
  const d = description(tile)
  expect(d?.textContent).toBe('sessions.attachments.tooLargeForSession')
  expect(d?.getAttribute('title')).toBe('sessions.attachments.tooLargeForSession')
})

test('error tile from the server: the server message, mirrored into title', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [
          upload({
            file: mkFile('x.exe', ''),
            status: 'error',
            error: { response: { data: { error: 'File type not allowed' } } },
          }),
        ],
      }),
    }),
  )
  const [tile] = tiles()
  if (!tile) throw new Error('no tile')
  const d = description(tile)
  expect(d?.textContent).toBe('File type not allowed')
  expect(d?.getAttribute('title')).toBe('File type not allowed')
})

test('error tile with no usable message falls back to uploadFailed, mirrored into title', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [upload({ file: mkFile('x.txt', 'text/plain'), status: 'error' })],
      }),
    }),
  )
  const [tile] = tiles()
  if (!tile) throw new Error('no tile')
  const d = description(tile)
  expect(d?.textContent).toBe('sessions.attachments.uploadFailed')
  expect(d?.getAttribute('title')).toBe('sessions.attachments.uploadFailed')
})

// --- 11. object-URL previews ------------------------------------------------

for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
  test(`a ${type} upload shows an <img> from URL.createObjectURL(file)`, () => {
    const file = mkFile('pic', type)
    mount(props({ attachments: attachments({ uploads: [upload({ file })] }) }))
    expect(created.length).toBe(1)
    expect(created[0]?.file).toBe(file)
    const img = q<HTMLImageElement>('[data-slot="attachment"] img')
    expect(img?.getAttribute('src')).toBe(created[0]?.url ?? 'missing')
  })
}

for (const type of ['text/markdown', 'image/heic', '', 'image/svg+xml']) {
  test(`a "${type}" upload shows no <img> and creates no object URL`, () => {
    mount(
      props({
        attachments: attachments({ uploads: [upload({ file: mkFile('file.x', type) })] }),
      }),
    )
    expect(tiles().length).toBe(1)
    expect(q('img')).toBeNull()
    expect(created.length).toBe(0)
    expect(byLabel('sessions.attachments.preview')).toBeNull()
  })
}

test('an uploading image already shows its preview', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [upload({ file: mkFile('a.png', 'image/png'), status: 'uploading', progress: 3 })],
      }),
    }),
  )
  expect(q('[data-slot="attachment"] img')).not.toBeNull()
})

test('removing an image upload from uploads revokes exactly its object URL', () => {
  const a = upload({ file: mkFile('a.png', 'image/png') })
  const b = upload({ file: mkFile('b.png', 'image/png') })
  mount(props({ attachments: attachments({ uploads: [a, b] }) }))
  expect(created.length).toBe(2)
  const urlA = created.find((c) => c.file === a.file)?.url
  const urlB = created.find((c) => c.file === b.file)?.url
  expect(revoked).toEqual([])

  render(props({ attachments: attachments({ uploads: [b] }) }))
  expect(revoked).toEqual([urlA ?? 'missing'])
  expect(q<HTMLImageElement>('img')?.getAttribute('src')).toBe(urlB ?? 'missing')
})

test('a status change on the same file does not recreate or revoke its URL', () => {
  const file = mkFile('a.png', 'image/png')
  const u = upload({ file, status: 'uploading', progress: 50 })
  mount(props({ attachments: attachments({ uploads: [u] }) }))
  render(props({ attachments: attachments({ uploads: [{ ...u, status: 'done', progress: 100 }] }) }))
  expect(created.length).toBe(1)
  expect(revoked).toEqual([])
})

test('unmounting the composer revokes every object URL it created', () => {
  mount(
    props({
      attachments: attachments({
        uploads: [
          upload({ file: mkFile('a.png', 'image/png') }),
          upload({ file: mkFile('b.gif', 'image/gif') }),
          upload({ file: mkFile('c.txt', 'text/plain') }),
        ],
      }),
    }),
  )
  expect(created.length).toBe(2)
  unmount()
  expect([...revoked].sort()).toEqual(created.map((c) => c.url).sort())
})

test('an <img> that fails to decode falls back to the icon tile', () => {
  mount(
    props({
      attachments: attachments({ uploads: [upload({ file: mkFile('a.png', 'image/png') })] }),
    }),
  )
  const img = q('img')
  expect(img).not.toBeNull()
  act(() => {
    img?.dispatchEvent(new Event('error'))
  })
  const [tile] = tiles()
  expect(tile).toBeDefined()
  expect(q('img')).toBeNull()
  expect(q('[data-slot="attachment-media"] svg', tile)).not.toBeNull()
  // No preview onto a broken image either.
  expect(byLabel('sessions.attachments.preview')).toBeNull()
})

// --- 12. preview trigger vs X action ---------------------------------------

const dialogContent = () => document.querySelector('[data-slot="dialog-content"]')

test('an image tile preview trigger opens a dialog showing the image', async () => {
  mount(
    props({
      attachments: attachments({ uploads: [upload({ file: mkFile('shot.png', 'image/png') })] }),
    }),
  )
  const trigger = byLabel('sessions.attachments.preview')
  expect(trigger).not.toBeNull()
  const [tile] = tiles()
  expect(tile?.contains(trigger)).toBe(true)
  expect(dialogContent()).toBeNull()

  await act(async () => {
    trigger?.click()
  })
  await flush()

  const dlg = dialogContent()
  expect(dlg).not.toBeNull()
  const img = dlg?.querySelector('img')
  expect(img?.getAttribute('src')).toBe(created[0]?.url ?? 'missing')
  expect(img?.getAttribute('alt')).toBe('shot.png')
  expect(dlg?.textContent).toContain('shot.png')
})

test('the X on a done image tile calls onRemove(upload) and does not open the dialog', async () => {
  const u = upload({ file: mkFile('shot.png', 'image/png') })
  mount(props({ attachments: attachments({ uploads: [u] }) }))
  const x = byLabel('sessions.attachments.remove')
  const trigger = byLabel('sessions.attachments.preview')
  expect(x).not.toBeNull()
  expect(trigger?.contains(x)).toBe(false)
  expect(x?.contains(trigger)).toBe(false)

  await act(async () => {
    x?.click()
  })
  await flush()
  expect(calls.onRemove).toEqual([u])
  expect(calls.onCancel).toEqual([])
  expect(dialogContent()).toBeNull()
})

test('the X on an uploading image tile calls onCancel(id) and does not open the dialog', async () => {
  const u = upload({ file: mkFile('shot.png', 'image/png'), status: 'uploading', progress: 5 })
  mount(props({ attachments: attachments({ uploads: [u] }) }))
  const x = byLabel('sessions.attachments.cancel')
  expect(x).not.toBeNull()
  expect(byLabel('sessions.attachments.remove')).toBeNull()

  await act(async () => {
    x?.click()
  })
  await flush()
  expect(calls.onCancel).toEqual([u.id])
  expect(calls.onRemove).toEqual([])
  expect(dialogContent()).toBeNull()
})

test('the X on an error tile calls onRemove(upload)', () => {
  const u = upload({ file: mkFile('x.txt', 'text/plain'), status: 'error' })
  mount(props({ attachments: attachments({ uploads: [u] }) }))
  act(() => {
    byLabel('sessions.attachments.remove')?.click()
  })
  expect(calls.onRemove).toEqual([u])
})
