// Adversarial verification of the composer's visual (CodeMirror) mode, on top
// of what tests/markdown-editor.test.tsx and tests/composer.test.tsx already
// pin. Three layers, each mounted the same way those files mount theirs:
//
//   1. `MarkdownEditor` alone — byte-identical round-trip for text a
//      rich-text editor would escape or rewrite, line-ending handling, the
//      live-preview layer per construct and for globs/intraword markup, and
//      constructs whose syntax spans a line break;
//   2. `Composer` under a controlled, SessionPage-shaped parent — a session
//      switch while focused with a selection, an external clear/restore
//      while typing, rapid mode toggling, a stored mode that is not 'raw';
//   3. the real `SessionPage` with its generated clients mocked (same
//      approach as tests/session-page-drafts.test.tsx) — what actually goes
//      out in the send body, draft storage on load, bad stored modes through
//      the page's own `composerModeAtom`, and Enter while an upload is pending.
//
// Driving CodeMirror follows tests/markdown-editor.test.tsx's header:
// transactions via `EditorView.dispatch({ userEvent: 'input.type' })` inside
// `act`, keys as real `KeyboardEvent`s on `.cm-content`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider, useAtom } from 'jotai'
import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { SessionFile } from '../src/features/sessions/hooks/use-session-files'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { mockModule } from './mock-module'
import { type StorageWrite, swapLocalStorage } from './storage-spy'

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

// --- mocked clients (only the SessionPage section uses them) ------------------

const T = '2026-09-04T10:00:00.000Z'
const sessionDto = (id: string): SessionDto => ({
  id,
  projectId: 'p1',
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

let sends: { sessionId: string; body: unknown }[] = []
let uploadCalls: { resolve: (f: SessionFile) => void }[] = []

await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({ data: sessionDto(opts.path.id) }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 1e9 } },
  }),
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdMessages', () => ({
  postApiSessionsIdMessages: async (opts: { path: { id: string }; body?: unknown }) => {
    sends.push({ sessionId: opts.path.id, body: opts.body })
    return { data: { id: `m${sends.length}`, seq: 999 } }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdFiles', () => ({
  postApiSessionsIdFiles: () =>
    new Promise((resolve) => {
      uploadCalls.push({ resolve: (data) => resolve({ data }) })
    }),
}))
await mockModule('@/shared/api/generated/clients/deleteApiSessionsIdFilesFileid', () => ({
  deleteApiSessionsIdFilesFileid: async () => ({ data: undefined }),
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

const { MarkdownEditor } = await import('../src/shared/components/markdown-editor')
const { Composer } = await import('../src/features/sessions/components/composer')
const { SessionPage } = await import('../src/features/sessions/components/session-page')
const { composerModeAtom } = await import('../src/shared/store/ui')

type ComposerProps = Parameters<typeof Composer>[0]
type Mode = 'visual' | 'raw'

// --- shared mounting -------------------------------------------------------------

let container: HTMLDivElement | undefined
let root: Root | undefined

async function renderInto(node: ReactNode) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(node)
  })
}

async function unmountAll() {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = undefined
  container?.remove()
  container = undefined
}

const c = () => {
  if (!container) throw new Error('nothing mounted')
  return container
}
const cmEditor = () => c().querySelector('.cm-editor') as HTMLElement | null
const cmContent = () => {
  const el = c().querySelector('.cm-content') as HTMLElement | null
  if (!el) throw new Error('no .cm-content')
  return el
}
const view = () => {
  const el = cmEditor()
  if (!el) throw new Error('no CodeMirror editor mounted')
  const v = EditorView.findFromDOM(el)
  if (!v) throw new Error('no view')
  return v
}
const doc = () => view().state.doc.toString()

async function dispatchTyping(insert: string, at?: number) {
  await act(async () => {
    const pos = at ?? view().state.doc.length
    // Caret mapped through the change rather than `pos + insert.length`:
    // CodeMirror normalizes `\r\n` in `insert`, so the two can differ.
    const changes = view().state.changes({ from: pos, insert })
    view().dispatch({ changes, selection: { anchor: changes.mapPos(pos, 1) }, userEvent: 'input.type' })
  })
}
async function select(anchor: number, head = anchor) {
  await act(async () => {
    view().dispatch({ selection: { anchor, head } })
  })
}
async function pressKey(init: KeyboardEventInit) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => {
    cmContent().dispatchEvent(ev)
  })
  return ev
}
const TOGGLE = 'sessions.composerMode.source'
const toggleButton = () => {
  const b = c().querySelector<HTMLButtonElement>(`[aria-label="${TOGGLE}"]`)
  if (!b) throw new Error('no mode toggle')
  return b
}

/** console.error/console.warn captured for one test — React's own
 *  "uncaught error" and CodeMirror's `logException` both land in one of them. */
function captureConsole() {
  const seen: string[] = []
  // SessionPage is mounted without a router here (same as
  // tests/session-page-drafts.test.tsx), which makes TanStack Router warn;
  // that is this harness, not the composer, so it is not counted.
  const harnessNoise = (line: string) => line.includes('useRouter must be used inside a <RouterProvider>')
  const origError = console.error
  const origWarn = console.warn
  console.error = (...a: unknown[]) => {
    const line = `error: ${a.map(String).join(' ').slice(0, 300)}`
    if (!harnessNoise(line)) seen.push(line)
  }
  console.warn = (...a: unknown[]) => {
    const line = `warn: ${a.map(String).join(' ').slice(0, 300)}`
    if (!harnessNoise(line)) seen.push(line)
  }
  return {
    seen,
    restore: () => {
      console.error = origError
      console.warn = origWarn
    },
  }
}

afterEach(async () => {
  await unmountAll()
  document.body.replaceChildren()
})

// --- fixtures ------------------------------------------------------------------------

const TABLE = '| col a | col_b |\n|---|:---:|\n| 1 | **2** |'
const FENCE = '```ts\nconst x = "**not bold**" // snake_case\n```'
const FIFTY_KB = (() => {
  const unit = 'line with **bold**, snake_case, <tag attr>, a & b &amp; c, `code`, *args\n'
  let s = ''
  while (s.length < 50 * 1024) s += unit
  return s
})()

const ROUND_TRIP: [string, string][] = [
  ['snake_case', 'snake_case_name'],
  ['glob', '**/*.tsx'],
  ['jsx tag', '<Button onClick>'],
  ['html', '<div>raw</div>'],
  ['entities', 'a & b &amp; c'],
  ['star args', '*args'],
  ['brackets', 'arr[0]'],
  ['gfm table', TABLE],
  ['fence with bold inside', FENCE],
  ['one newline', 'a\nb'],
  ['blank line', 'a\n\nb'],
  ['trailing spaces', 'trailing   '],
  ['leading spaces', '   leading'],
  ['tabs', '\tindented\tand\ttabbed'],
  ['emoji and surrogate pairs', 'ok 👍🏽 fam 👨‍👩‍👧 math 𝕏'],
  ['rtl', 'שלום עולם مرحبا بالعالم'],
  ['50 KB', FIFTY_KB],
]

// =====================================================================================
// 1. MarkdownEditor alone
// =====================================================================================

function Editor(p: { value: string; onChange: (v: string) => void }) {
  return <MarkdownEditor value={p.value} onChange={p.onChange} />
}

describe('round-trip: mount fires no onChange, doc is the value, appending x emits value+x', () => {
  for (const [name, value] of ROUND_TRIP) {
    test(name, async () => {
      const emitted: string[] = []
      await renderInto(<Editor value={value} onChange={(v) => emitted.push(v)} />)
      expect(emitted).toEqual([])
      expect(doc()).toBe(value)
      await dispatchTyping('x')
      expect(emitted).toHaveLength(1)
      expect(emitted[0] === `${value}x`).toBe(true) // strict, and cheap to print for 50 KB
    })
  }
})

describe('round-trip through an external replace (a session switch): no onChange, then value+x', () => {
  for (const [name, value] of ROUND_TRIP) {
    test(name, async () => {
      const emitted: string[] = []
      await renderInto(<Editor value="previous session" onChange={(v) => emitted.push(v)} />)
      await renderInto(<Editor value={value} onChange={(v) => emitted.push(v)} />)
      expect(emitted).toEqual([])
      expect(doc() === value).toBe(true)
      await dispatchTyping('x')
      expect(emitted).toHaveLength(1)
      expect(emitted[0] === `${value}x`).toBe(true)
    })
  }
})

describe('line endings', () => {
  // A draft is plain localStorage JSON — nothing stops a `\r` reaching it
  // (another tool, an older client, a future "insert prompt" path) — and the
  // editor must at least mount on it rather than take the page down.
  for (const [name, value] of [
    ['CRLF', 'a\r\nb'],
    ['lone CR', 'a\rb'],
  ] as const) {
    test(`a ${name} value mounts without throwing`, async () => {
      let thrown: unknown = null
      const cap = captureConsole()
      try {
        await renderInto(<Editor value={value} onChange={() => {}} />)
      } catch (e) {
        thrown = e
      } finally {
        cap.restore()
      }
      expect(String(thrown)).toBe('null')
      expect(cmEditor()).not.toBeNull()
    })

    test(`a ${name} value arriving as an external replace does not throw`, async () => {
      await renderInto(<Editor value="before" onChange={() => {}} />)
      let thrown: unknown = null
      const cap = captureConsole()
      try {
        await renderInto(<Editor value={value} onChange={() => {}} />)
      } catch (e) {
        thrown = e
      } finally {
        cap.restore()
      }
      expect(String(thrown)).toBe('null')
    })
  }

  test('CRLF typed/pasted into the editor is emitted as LF (same as a <textarea> value)', async () => {
    const emitted: string[] = []
    await renderInto(<Editor value="" onChange={(v) => emitted.push(v)} />)
    await dispatchTyping('a\r\nb')
    expect(emitted).toEqual(['a\nb'])
  })
})

// --- live preview -----------------------------------------------------------------

/** Mount, park the caret at `caret`, and return the rendered text. */
async function renderedWithCaretAt(value: string, caret: number) {
  await renderInto(<Editor value={value} onChange={() => {}} />)
  await select(caret)
  return c().textContent ?? ''
}

describe('live preview: markers hidden with the caret outside, revealed inside', () => {
  const cases: { name: string; value: string; inside: number; hidden: string; shown: string; cls: string }[] = [
    { name: 'bold', value: 'x **bold** y', inside: 5, hidden: '**', shown: 'x bold y', cls: '.font-bold' },
    { name: 'em', value: 'x *em* y', inside: 4, hidden: '*', shown: 'x em y', cls: '.italic' },
    { name: 'strike', value: 'x ~~gone~~ y', inside: 5, hidden: '~~', shown: 'x gone y', cls: '.line-through' },
    { name: 'code', value: 'x `code` y', inside: 4, hidden: '`', shown: 'x code y', cls: '.font-mono' },
    { name: 'link', value: 'x [text](https://e.x/p) y', inside: 5, hidden: '](', shown: 'x text y', cls: '.underline' },
  ]
  for (const k of cases) {
    test(k.name, async () => {
      const outside = await renderedWithCaretAt(k.value, 0)
      expect(outside).toBe(k.shown)
      expect(outside).not.toContain(k.hidden)
      expect(c().querySelector(k.cls)).not.toBeNull()
      await select(k.inside)
      expect(c().textContent).toBe(k.value)
    })
  }

  test('heading: "# " hidden off the line, shown on it, line styled either way', async () => {
    const value = '# Title\nbody'
    const off = await renderedWithCaretAt(value, value.length)
    expect(off).toBe('Titlebody')
    expect(c().querySelector('.cm-line')?.className).toContain('text-xl')
    await select(3)
    expect(c().textContent).toBe('# Titlebody')
    expect(c().querySelector('.cm-line')?.className).toContain('text-xl')
  })

  test('quote: "> " hidden off the line, shown on it, line styled either way', async () => {
    const value = '> quoted\nbody'
    const off = await renderedWithCaretAt(value, value.length)
    expect(off).toBe('quotedbody')
    expect(c().querySelector('.cm-line')?.className).toContain('border-l-2')
    await select(4)
    expect(c().textContent).toBe('> quotedbody')
  })

  test('list markers and table rows stay visible and styled', async () => {
    const value = `- item\n1. one\n\n${TABLE}\n\nend`
    const text = await renderedWithCaretAt(value, value.length)
    expect(text).toContain('- item')
    expect(text).toContain('1. one')
    expect(text).toContain('| col a | col_b |')
    expect(c().querySelector('.text-muted-foreground')?.textContent).toBe('-')
    // Header and body rows get the mono line; the `|---|:---:|` delimiter row
    // is not a TableRow node and is styled through its muted delimiter mark
    // instead (checked below), still fully visible.
    const lines = [...c().querySelectorAll('.cm-line')]
    const tableLines = lines.filter((l) => l.className.includes('font-mono'))
    expect(tableLines.map((l) => l.textContent)).toEqual(['| col a | col_b |', '| 1 | **2** |'.replace('**2**', '2')])
    const delimiterLine = lines.find((l) => l.textContent === '|---|:---:|')
    expect(delimiterLine?.querySelector('.text-muted-foreground')).not.toBeNull()
  })

  test('a fence gets the muted box and nothing inside it is emphasised or hidden', async () => {
    const value = `${FENCE}\nafter`
    const text = await renderedWithCaretAt(value, value.length)
    expect(text).toContain('**not bold**')
    expect(c().querySelector('.font-bold')).toBeNull()
    const fenceLines = [...c().querySelectorAll('.cm-line')].filter((l) => l.className.includes('bg-muted'))
    expect(fenceLines.length).toBe(3)
  })
})

describe('live preview: prompt-shaped text is never emphasised or hidden', () => {
  const plain: [string, string][] = [
    ['intraword underscores', 'call get_user_by_id now'],
    ['one glob', 'match **/*.tsx everywhere'],
    ['python splats', 'def f(*args, **kwargs):'],
    ['shell globs', 'rm *.log *.tmp'],
    ['index', 'arr[0] and arr[1]'],
  ]
  for (const [name, value] of plain) {
    test(name, async () => {
      const text = await renderedWithCaretAt(value, value.length)
      expect(c().querySelector('.italic')?.textContent ?? null).toBeNull()
      expect(c().querySelector('.font-bold')?.textContent ?? null).toBeNull()
      expect(text).toBe(value)
    })
  }
})

// Two globs on one line *are* strong emphasis in CommonMark (the transcript
// renders it the same way), so the preview styling it is accepted behaviour.
// What must hold is that the text itself is never touched.
test('two globs on one line: the text is unchanged byte for byte', async () => {
  const value = 'edit src/**/*.ts and lib/**/*.tsx'
  const emitted: string[] = []
  await renderInto(<Editor value={value} onChange={(v) => emitted.push(v)} />)
  await select(value.length)
  await select(0)
  expect(emitted).toEqual([])
  expect(doc()).toBe(value)
  await dispatchTyping('x')
  expect(emitted).toEqual([`${value}x`])
})

describe('live preview: constructs whose syntax spans a line break', () => {
  // CommonMark allows a link destination (or title) to start on the next
  // line. Hiding `](...)` then spans a line break, which CodeMirror refuses
  // from a ViewPlugin with a RangeError.
  for (const [name, value] of [
    ['destination on the next line', 'x [a](\n/url) y'],
    ['title on the next line', 'x [a](/url\n"title") y'],
  ] as const) {
    test(`a draft with a link, ${name}, mounts without throwing`, async () => {
      let thrown: unknown = null
      const cap = captureConsole()
      try {
        await renderInto(<Editor value={value} onChange={() => {}} />)
      } catch (e) {
        thrown = e
      } finally {
        cap.restore()
      }
      expect(String(thrown)).toBe('null')
      expect(cmEditor()).not.toBeNull()
    })

    test(`typing a link, ${name}, then moving the caret out does not throw`, async () => {
      await renderInto(<Editor value="" onChange={() => {}} />)
      let thrown: unknown = null
      const cap = captureConsole()
      try {
        await dispatchTyping(value)
        await select(0)
      } catch (e) {
        thrown = e
      } finally {
        cap.restore()
      }
      expect(String(thrown)).toBe('null')
      expect(doc()).toBe(value)
    })
  }
})

// =====================================================================================
// 2. Composer under a controlled, SessionPage-shaped parent
// =====================================================================================

const noopAttachments: ComposerProps['attachments'] = {
  uploads: [],
  usage: undefined,
  usagePending: false,
  usageError: null,
  pendingCount: 0,
  onAttach: () => {},
  onCancel: () => {},
  onRemove: () => {},
}

let onChangeLog: { session: string; value: string }[] = []
let submitCount = 0
let api: {
  switchTo: (id: string) => void
  setDraft: (id: string, v: string | ((cur: string) => string)) => void
  drafts: () => Record<string, string>
} | null = null

/** What SessionPage does with a draft, minus the network: one `value` per
 *  session id, `onChange` writing into whichever session is current, mode
 *  owned above the composer and fed back down. */
function DraftsParent(p: { initial: Record<string, string>; start: string; mode?: Mode; canSend?: boolean }) {
  const [drafts, setDrafts] = useState(p.initial)
  const [current, setCurrent] = useState(p.start)
  const [mode, setMode] = useState<Mode>(p.mode ?? 'visual')
  api = {
    switchTo: setCurrent,
    setDraft: (id, v) =>
      setDrafts((d) => ({ ...d, [id]: typeof v === 'function' ? v(d[id] ?? '') : v })),
    drafts: () => drafts,
  }
  return (
    <I18nextProvider i18n={cimode}>
      <Composer
        sessionId={current}
        value={drafts[current] ?? ''}
        onChange={(v) => {
          onChangeLog.push({ session: current, value: v })
          setDrafts((d) => ({ ...d, [current]: v }))
        }}
        onSubmit={() => {
          submitCount++
        }}
        mode={mode}
        onModeChange={setMode}
        sending={false}
        canSend={p.canSend ?? true}
        queueLine=""
        error={null}
        attachments={noopAttachments}
      />
    </I18nextProvider>
  )
}
const theApi = () => {
  if (!api) throw new Error('parent not mounted')
  return api
}

beforeEach(() => {
  onChangeLog = []
  submitCount = 0
  api = null
})

describe('composer: session switch on one mounted parent', () => {
  test('focused with a selection: B shows, no onChange, A untouched, undo cannot bring A back', async () => {
    await renderInto(<DraftsParent initial={{ A: 'alpha text', B: 'beta' }} start="A" />)
    await dispatchTyping(' more') // real history in A
    expect(onChangeLog).toEqual([{ session: 'A', value: 'alpha text more' }])
    await act(async () => {
      view().focus()
    })
    await select(2, 7)
    expect(document.activeElement).toBe(cmContent())
    onChangeLog = []

    await act(async () => {
      theApi().switchTo('B')
    })
    expect(doc()).toBe('beta')
    expect(onChangeLog).toEqual([])

    // Keyboard Ctrl+Z first (the reader's reflex), then the command itself.
    await pressKey({ key: 'z', ctrlKey: true })
    expect(doc()).toBe('beta')
    expect(undo(view())).toBe(false)
    expect(doc()).toBe('beta')
    expect(onChangeLog).toEqual([])
    expect(theApi().drafts()).toEqual({ A: 'alpha text more', B: 'beta' })
  })

  test('positive control: Ctrl+Z on .cm-content really does undo within one session', async () => {
    await renderInto(<DraftsParent initial={{ A: 'a' }} start="A" />)
    await dispatchTyping('b')
    expect(doc()).toBe('ab')
    await pressKey({ key: 'z', ctrlKey: true })
    expect(doc()).toBe('a')
  })

  test('A typed then emptied by hand, B empty: undo in B cannot bring back A\'s text', async () => {
    await renderInto(<DraftsParent initial={{ A: '', B: '' }} start="A" />)
    await dispatchTyping('secret for A')
    await act(async () => {
      view().dispatch({ changes: { from: 0, to: view().state.doc.length }, userEvent: 'delete' })
    })
    expect(doc()).toBe('')
    onChangeLog = []

    await act(async () => {
      theApi().switchTo('B')
    })
    expect(doc()).toBe('')
    await pressKey({ key: 'z', ctrlKey: true })
    expect(doc()).toBe('')
    expect(theApi().drafts().B).toBe('')
    expect(onChangeLog).toEqual([])
  })
})

describe('composer: external clear (send) and restore (failed send) while typing', () => {
  test('clear, type more, restore-if-empty: keeps exactly the new keystrokes', async () => {
    await renderInto(<DraftsParent initial={{ A: '' }} start="A" />)
    for (const ch of 'hello') await dispatchTyping(ch)
    expect(doc()).toBe('hello')
    await act(async () => {
      theApi().setDraft('A', '') // submit(): draft.setText('')
    })
    expect(doc()).toBe('')
    await dispatchTyping('n')
    await dispatchTyping('e')
    await act(async () => {
      theApi().setDraft('A', (cur) => (cur === '' ? 'hello' : cur)) // onError
    })
    expect(doc()).toBe('ne')
    expect(theApi().drafts().A).toBe('ne')
    expect(onChangeLog.map((e) => e.value)).toEqual(['h', 'he', 'hel', 'hell', 'hello', 'n', 'ne'])
  })

  test('clear, nothing typed, restore: the sent text comes back once, and typing continues after it', async () => {
    await renderInto(<DraftsParent initial={{ A: '' }} start="A" />)
    await dispatchTyping('hello')
    await act(async () => {
      theApi().setDraft('A', '')
    })
    await act(async () => {
      theApi().setDraft('A', (cur) => (cur === '' ? 'hello' : cur))
    })
    expect(doc()).toBe('hello')
    expect(view().state.selection.main.head).toBe(5)
    await dispatchTyping('!')
    expect(doc()).toBe('hello!')
    expect(theApi().drafts().A).toBe('hello!')
    expect(onChangeLog.map((e) => e.value)).toEqual(['hello', 'hello!'])
  })

  test('clear and restore inside one React batch leave the editor as it was', async () => {
    await renderInto(<DraftsParent initial={{ A: '' }} start="A" />)
    await dispatchTyping('hello')
    await act(async () => {
      theApi().setDraft('A', '')
      theApi().setDraft('A', (cur) => (cur === '' ? 'hello' : cur))
    })
    expect(doc()).toBe('hello')
    await dispatchTyping('x')
    expect(theApi().drafts().A).toBe('hellox')
  })
})

describe('composer: toggling modes', () => {
  test('visual -> raw -> visual with a selection: value unchanged, selection kept, no onChange, no console noise', async () => {
    const value = 'snake_case **x** <B> **/*.tsx'
    const cap = captureConsole()
    try {
      await renderInto(<DraftsParent initial={{ A: value }} start="A" />)
      await select(6, 11)
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          toggleButton().click()
        })
        const ta = c().querySelector('textarea')
        expect(ta?.value).toBe(value)
        expect([ta?.selectionStart, ta?.selectionEnd]).toEqual([6, 11])
        expect(toggleButton().getAttribute('aria-pressed')).toBe('true')
        await act(async () => {
          toggleButton().click()
        })
        expect(c().querySelector('textarea')).toBeNull()
        expect(doc()).toBe(value)
        const sel = view().state.selection.main
        expect([sel.anchor, sel.head]).toEqual([6, 11])
        expect(toggleButton().getAttribute('aria-pressed')).toBe('false')
      }
    } finally {
      cap.restore()
    }
    expect(onChangeLog).toEqual([])
    expect(theApi().drafts().A).toBe(value)
    expect(cap.seen).toEqual([])
  })

  test('two toggle clicks inside one act (faster than a render) end back in visual with the value intact', async () => {
    const value = 'a **b** c'
    const cap = captureConsole()
    try {
      await renderInto(<DraftsParent initial={{ A: value }} start="A" />)
      await act(async () => {
        toggleButton().click()
        toggleButton().click()
      })
    } finally {
      cap.restore()
    }
    expect(cap.seen).toEqual([])
    expect(onChangeLog).toEqual([])
    // Whichever surface is up, it shows the identical text.
    const ta = c().querySelector('textarea')
    if (ta) expect(ta.value).toBe(value)
    else expect(doc()).toBe(value)
  })

  test('for every round-trip value, raw shows the identical string and toggling back changes nothing', async () => {
    for (const [, value] of ROUND_TRIP.filter(([n]) => n !== '50 KB')) {
      onChangeLog = []
      await renderInto(<DraftsParent initial={{ A: value }} start="A" />)
      await act(async () => {
        toggleButton().click()
      })
      expect(c().querySelector('textarea')?.value === value).toBe(true)
      await act(async () => {
        toggleButton().click()
      })
      expect(doc() === value).toBe(true)
      expect(onChangeLog).toEqual([])
      await unmountAll()
    }
  })
})

describe('composer: Enter vs canSend (the composer contract is "always onSubmit")', () => {
  test('visual: Enter with canSend=false still calls onSubmit once while the send button is disabled', async () => {
    await renderInto(<DraftsParent initial={{ A: 'hi' }} start="A" canSend={false} />)
    const send = c().querySelector<HTMLButtonElement>('[aria-label="sessions.send"]')
    expect(send?.disabled).toBe(true)
    const ev = await pressKey({ key: 'Enter' })
    expect(ev.defaultPrevented).toBe(true)
    expect(submitCount).toBe(1)
    expect(doc()).toBe('hi') // no newline slipped in either
  })

  test('visual: Enter inside a list item and inside a fence submits and inserts nothing', async () => {
    for (const value of ['- item', '```\ncode']) {
      submitCount = 0
      await renderInto(<DraftsParent initial={{ A: value }} start="A" />)
      await select(value.length)
      await pressKey({ key: 'Enter' })
      expect(submitCount).toBe(1)
      expect(doc()).toBe(value)
      await unmountAll()
    }
  })

  test('visual: Shift+Enter continues -, 1., >', async () => {
    const cases: [string, string][] = [
      ['- a', '- a\n- '],
      ['1. a', '1. a\n2. '],
      ['> a', '> a\n> '],
    ]
    for (const [value, after] of cases) {
      submitCount = 0
      await renderInto(<DraftsParent initial={{ A: value }} start="A" />)
      await select(value.length)
      await pressKey({ key: 'Enter', shiftKey: true })
      expect(submitCount).toBe(0)
      expect(JSON.stringify(doc())).toBe(JSON.stringify(after))
      await unmountAll()
    }
  })

  test('visual: Shift+Enter on an empty item after a real one exits the list in one press', async () => {
    // Either shape is an exit — a blank line after the list, or none — as
    // long as no `- ` marker is left on the caret's line.
    await renderInto(<DraftsParent initial={{ A: '- a\n- ' }} start="A" />)
    await select('- a\n- '.length)
    await pressKey({ key: 'Enter', shiftKey: true })
    expect(submitCount).toBe(0)
    expect(['- a\n\n', '- a\n']).toContain(doc())
    const lastLine = doc().split('\n').at(-1) ?? ''
    expect(lastLine.startsWith('- ')).toBe(false)
  })
})

describe('composer: a stored mode that is not "raw" reads as visual (getOnInit path)', () => {
  // `composerModeAtom` uses `getOnInit`, which reads localStorage when the
  // module is evaluated — so each case gets its own module instance,
  // evaluated after the bad value is in place.
  const bad: [string, string | null][] = [
    ['"foo"', '"foo"'],
    ['not-json', 'not-json'],
    ['null', 'null'],
    ['a number', '123'],
    ['an object', '{"mode":"raw"}'],
    ['empty string', ''],
  ]
  let n = 0
  for (const [name, stored] of bad) {
    test(name, async () => {
      localStorage.clear()
      if (stored !== null) localStorage.setItem('agentoo:composer-mode', stored)
      const mod = await import(`../src/shared/store/ui.ts?verify=${++n}`)
      const atom = mod.composerModeAtom as typeof composerModeAtom
      function Reader() {
        const [mode, setMode] = useAtom(atom)
        return (
          <I18nextProvider i18n={cimode}>
            <Composer
              sessionId="s"
              value="hi"
              onChange={() => {}}
              onSubmit={() => {}}
              mode={mode}
              onModeChange={setMode}
              sending={false}
              canSend
              queueLine=""
              error={null}
              attachments={noopAttachments}
            />
          </I18nextProvider>
        )
      }
      const cap = captureConsole()
      try {
        await renderInto(
          <JotaiProvider store={createStore()}>
            <Reader />
          </JotaiProvider>,
        )
      } finally {
        cap.restore()
      }
      expect(cap.seen).toEqual([])
      expect(c().querySelector('textarea')).toBeNull()
      expect(cmEditor()).not.toBeNull()
      expect(toggleButton().getAttribute('aria-pressed')).toBe('false')
      // And the toggle still works from there, persisting a clean value.
      await act(async () => {
        toggleButton().click()
      })
      expect(c().querySelector('textarea')?.value).toBe('hi')
      expect(localStorage.getItem('agentoo:composer-mode')).toBe('"raw"')
      localStorage.clear()
    })
  }
})

// =====================================================================================
// 3. The real SessionPage
// =====================================================================================

describe('SessionPage', () => {
  let client: QueryClient
  let store: ReturnType<typeof createStore>
  let writes: StorageWrite[] = []
  let restoreStorage: () => void = () => {}

  const newClient = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })

  async function settle(ticks = 10) {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
  }

  async function show(sessionId: string) {
    await renderInto(
      <I18nextProvider i18n={cimode}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <SessionPage projectId="p1" sessionId={sessionId} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
    await settle()
    if (!c().textContent?.includes(`Session ${sessionId}`)) {
      throw new Error(`session page for ${sessionId} never rendered`)
    }
  }

  const draftKey = (id: string) => `agentoo:draft:${id}`
  // `sessions.sending` while a send is in flight — same button, other label.
  const sendButton = () =>
    c().querySelector<HTMLButtonElement>('[aria-label="sessions.send"], [aria-label="sessions.sending"]')

  beforeEach(() => {
    sends = []
    uploadCalls = []
    writes = []
    localStorage.clear()
    client = newClient()
    store = createStore()
  })

  afterEach(async () => {
    restoreStorage()
    await unmountAll()
    client.clear()
  })

  test('visual is the default with nothing stored', async () => {
    await show('s-default')
    expect(cmEditor()).not.toBeNull()
    expect(c().querySelector('textarea')).toBeNull()
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false')
  })

  for (const [name, stored] of [
    ['"foo"', '"foo"'],
    ['not-json', 'not-json'],
    ['null', 'null'],
  ] as const) {
    test(`a stored mode of ${name} renders visual and does not crash the page`, async () => {
      localStorage.setItem('agentoo:composer-mode', stored)
      const cap = captureConsole()
      try {
        await show(`s-bad-${name}`)
      } finally {
        cap.restore()
      }
      expect(cap.seen).toEqual([])
      expect(cmEditor()).not.toBeNull()
      expect(c().querySelector('textarea')).toBeNull()
      expect(toggleButton().getAttribute('aria-pressed')).toBe('false')
    })
  }

  test('loading a tricky draft into the editor writes nothing to storage and shows it byte for byte', async () => {
    const text = `snake_case **x** <B> **/*.tsx\n\n${TABLE}\n\n${FENCE}\n  trailing  `
    localStorage.setItem(draftKey('s-load'), JSON.stringify({ text, fileIds: [] }))
    restoreStorage = swapLocalStorage({ onWrite: (w) => writes.push(w) })
    await show('s-load')
    await settle()
    restoreStorage()
    expect(doc() === text).toBe(true)
    expect(writes.filter((w) => w.key.startsWith('agentoo:draft:'))).toEqual([])
  })

  test('Enter sends the exact typed text and clears the composer and the stored draft', async () => {
    const typed = 'snake_case **x** <B> **/*.tsx'
    await show('s-send')
    await dispatchTyping(typed)
    expect(JSON.parse(localStorage.getItem(draftKey('s-send')) ?? 'null')).toEqual({ text: typed, fileIds: [] })
    await pressKey({ key: 'Enter' })
    await settle()
    expect(sends.map((s) => s.body)).toEqual([{ text: typed }])
    expect(doc()).toBe('')
    expect(localStorage.getItem(draftKey('s-send'))).toBeNull()
  })

  test('a multi-line markdown prompt goes out with its interior whitespace intact', async () => {
    const typed = `do this:\n\n- a_b\n  - c\n\n${FENCE}\n\n\ttab <x> &amp;`
    await show('s-multi')
    await dispatchTyping(typed)
    await pressKey({ key: 'Enter' })
    await settle()
    expect(sends).toHaveLength(1)
    expect((sends[0]?.body as { text: string }).text === typed).toBe(true)
  })

  test('Enter while an upload is still pending sends nothing and keeps the text', async () => {
    await show('s-upload')
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })], types: ['Files'] },
    })
    await act(async () => {
      cmContent().dispatchEvent(ev)
    })
    await settle()
    expect(uploadCalls).toHaveLength(1)
    await dispatchTyping('wait for it')
    expect(sendButton()?.disabled).toBe(true)
    await pressKey({ key: 'Enter' })
    await settle()
    expect(sends).toEqual([])
    expect(doc()).toBe('wait for it')
  })
})
