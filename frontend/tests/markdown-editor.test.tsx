// `shared/components/markdown-editor.tsx` on its own — the CodeMirror wrapper
// and its live-preview layer (`shared/lib/markdown-live-preview.ts`), with no
// session or draft anywhere in the picture:
//
//   value/onChange contract — no onChange on mount, an external replace (a
//   different `value` prop) fires none either and cannot be undone back, the
//   editor's own echo of its latest edit is a no-op, a genuine user edit does
//   fire onChange;
//   the callbacks (onChange/onKeyDown/onPasteFiles) are read fresh every
//   render, never captured once at mount;
//   Enter/Shift+Enter: a consumer's `preventDefault()` in `onKeyDown` claims
//   the key before CodeMirror's own keymap ever sees it; Shift+Enter falls
//   through to `insertNewlineContinueMarkup` for every construct the design
//   calls out, and to a plain `\n` inside a fence;
//   paste/drop: a clipboard or drop carrying files is claimed and nothing is
//   inserted, but a drop still bubbles; plain text — including text that
//   looks like markup — lands verbatim;
//   the DOM contract `input-group.tsx`'s focus ring and an accessible name
//   depend on (role, data-slot, aria-label, aria-placeholder);
//   the live-preview layer: classes applied, markers hidden away from the
//   caret and revealed inside it, and the two constructs the design calls
//   out by name as never emphasised (`get_user_by_id`, `**/*.tsx`).
//
// Driving CodeMirror under happy-dom, found by probing before this was
// written:
//   typing goes through a real transaction —
//   `EditorView.findFromDOM(el.querySelector('.cm-editor'))!.dispatch(...)`
//   inside `act` — not through DOM input events, which happy-dom's
//   contenteditable does not turn into the mutations CodeMirror listens for;
//   a key reaches the editor as a real `KeyboardEvent` dispatched on
//   `.cm-content`, `isComposing` included (a synthetic `compositionstart`
//   does not set CodeMirror's own composing flag, so a key event's own
//   `isComposing` is the only way to exercise that guard here);
//   selection changes go through `view.dispatch({ selection })`, never
//   through the DOM `Selection` API — a synthetic paste followed by a DOM
//   selection change was seen to throw a re-entrant `selectionchange` error.

import { expect, test } from 'bun:test'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownEditorProps,
} from '../src/shared/components/markdown-editor'

// --- mounting -----------------------------------------------------------------

let container: HTMLDivElement
let root: Root | undefined

async function mount(props: MarkdownEditorProps) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<MarkdownEditor {...props} />)
  })
}

async function rerender(props: MarkdownEditorProps) {
  await act(async () => {
    root?.render(<MarkdownEditor {...props} />)
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container.remove()
}

const cmEditor = () => container.querySelector('.cm-editor') as HTMLElement
const cmContent = () => container.querySelector('.cm-content') as HTMLElement
const view = () => {
  const v = EditorView.findFromDOM(cmEditor())
  if (!v) throw new Error('no CodeMirror view mounted')
  return v
}

/** A real transaction, not a DOM input event — see the file's own header
 * comment on why. Replaces the whole document, the simplest "the user typed
 * something" this suite needs. */
async function typeText(text: string) {
  await act(async () => {
    view().dispatch({
      changes: { from: 0, to: view().state.doc.length, insert: text },
      userEvent: 'input.type',
    })
  })
}

/** A real `KeyboardEvent`, dispatched where CodeMirror's own listener is
 * attached (`.cm-content`), with `preventDefault` observable afterwards the
 * same way a consumer's own handler would see it. */
async function pressKey(init: KeyboardEventInit) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => {
    cmContent().dispatchEvent(ev)
  })
  return ev
}

function pasteEvent(o: { text?: string; files?: File[] }) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      files: o.files ?? [],
      types: o.files?.length ? ['Files'] : ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? (o.text ?? '') : ''),
    },
  })
  return ev
}

function dropEvent(files: File[]) {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { files, types: ['Files'] } })
  return ev
}

let calls: { onChange: string[] }
const props = (o: Partial<MarkdownEditorProps> = {}): MarkdownEditorProps => ({
  value: '',
  onChange: (v) => calls.onChange.push(v),
  ...o,
})

function reset() {
  calls = { onChange: [] }
}

// --- value/onChange contract --------------------------------------------------

test('mounting fires no onChange', async () => {
  reset()
  await mount(props({ value: 'already here' }))
  expect(calls.onChange).toEqual([])
  expect(view().state.doc.toString()).toBe('already here')
  await unmount()
})

test('a genuine user edit fires onChange with the new document', async () => {
  reset()
  await mount(props({ value: 'ab' }))
  await typeText('abc')
  expect(calls.onChange).toEqual(['abc'])
  await unmount()
})

test('re-rendering with the value this editor just emitted (its own echo) is a no-op', async () => {
  reset()
  await mount(props({ value: 'a' }))
  await typeText('ab')
  expect(calls.onChange).toEqual(['ab'])
  const before = view()
  await rerender(props({ value: 'ab' }))
  expect(view()).toBe(before)
  expect(view().state.doc.toString()).toBe('ab')
  expect(calls.onChange).toEqual(['ab']) // still just the one, real edit
  await unmount()
})

test('an external replace lands the new text, fires no onChange, and cannot be undone back', async () => {
  reset()
  await mount(props({ value: 'session a text' }))
  await typeText('session a text, edited')
  expect(calls.onChange).toEqual(['session a text, edited'])
  calls.onChange = []

  await rerender(props({ value: 'session b text' }))
  expect(view().state.doc.toString()).toBe('session b text')
  expect(calls.onChange).toEqual([])

  // Undo history was discarded along with the old state — a reflexive
  // Ctrl+Z after the switch cannot pull session a's text back in.
  expect(undo(view())).toBe(false)
  expect(view().state.doc.toString()).toBe('session b text')
  await unmount()
})

test('a plain multi-line value round-trips byte-identical', async () => {
  for (const value of ['a\nb', 'a\n\nb']) {
    reset()
    await mount(props({ value }))
    expect(view().state.doc.toString()).toBe(value)
    expect(calls.onChange).toEqual([])
    await unmount()
  }
})

test('the latest onChange is used after a rerender, not the one captured at mount', async () => {
  const seenA: string[] = []
  const seenB: string[] = []
  await mount(props({ value: 'x', onChange: (v) => seenA.push(v) }))
  await rerender(props({ value: 'x', onChange: (v) => seenB.push(v) }))
  await typeText('xy')
  expect(seenA).toEqual([])
  expect(seenB).toEqual(['xy'])
  await unmount()
})

// --- Enter / Shift+Enter ------------------------------------------------------

test("preventDefault in onKeyDown claims Enter before CodeMirror's own keymap", async () => {
  let calledSubmit = 0
  await mount(
    props({
      value: 'a',
      onKeyDown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          calledSubmit++
        }
      },
    }),
  )
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  const ev = await pressKey({ key: 'Enter' })
  expect(calledSubmit).toBe(1)
  expect(ev.defaultPrevented).toBe(true)
  // Never reached CodeMirror's own Enter handling: no newline was inserted.
  expect(view().state.doc.toString()).toBe('a')
})

async function shiftEnterAtEnd(value: string) {
  await mount(props({ value }))
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  await pressKey({ key: 'Enter', shiftKey: true })
  const result = view().state.doc.toString()
  await unmount()
  return result
}

test('Shift+Enter on a plain line inserts a plain newline', async () => {
  expect(await shiftEnterAtEnd('plain line')).toBe('plain line\n')
})

test('Shift+Enter continues a bullet list item', async () => {
  expect(await shiftEnterAtEnd('- a')).toBe('- a\n- ')
})

test('Shift+Enter continues an ordered list item, incrementing the marker', async () => {
  expect(await shiftEnterAtEnd('1. a')).toBe('1. a\n2. ')
})

test('Shift+Enter continues a task list item', async () => {
  expect(await shiftEnterAtEnd('- [ ] a')).toBe('- [ ] a\n- [ ] ')
})

test('Shift+Enter continues a blockquote', async () => {
  expect(await shiftEnterAtEnd('> a')).toBe('> a\n> ')
})

test('Shift+Enter on an empty list item removes the marker instead of continuing it', async () => {
  // A blank line is left behind (see the "empty second item" test below for
  // why), even with nothing before it to separate from.
  expect(await shiftEnterAtEnd('- ')).toBe('\n')
})

test('Shift+Enter inside a fence is a plain newline, not markup continuation', async () => {
  expect(await shiftEnterAtEnd('```\ncode')).toBe('```\ncode\n')
})

test('Enter with isComposing is not claimed by a send-on-enter consumer, so CodeMirror still processes it', async () => {
  // Mirrors composer.tsx's own `sendOnEnter` guard exactly: `!e.isComposing`
  // decides whether this claims the key at all.
  let claimed = 0
  await mount(
    props({
      value: '',
      onKeyDown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault()
          claimed++
        }
      },
    }),
  )
  await pressKey({ key: 'Enter', isComposing: true })
  expect(claimed).toBe(0)
  // Declined by the consumer, so CodeMirror's own Enter handling ran instead
  // (a plain newline, into what was an empty document).
  expect(view().state.doc.toString()).toBe('\n')
  await unmount()
})

// --- paste / drop --------------------------------------------------------------

test('pasting clipboard files calls onPasteFiles and inserts nothing', async () => {
  let pasted: File[] = []
  await mount(props({ value: '', onPasteFiles: (files) => { pasted = files } }))
  const file = new File(['x'], 'shot.png', { type: 'image/png' })
  const ev = pasteEvent({ files: [file] })
  await act(async () => {
    cmContent().dispatchEvent(ev)
  })
  expect(pasted).toEqual([file])
  expect(ev.defaultPrevented).toBe(true)
  expect(view().state.doc.toString()).toBe('')
  await unmount()
})

test('pasting plain text lands verbatim, markdown-looking characters and all', async () => {
  await mount(props({ value: '' }))
  const text = '**x** snake_case <B>'
  const ev = pasteEvent({ text })
  await act(async () => {
    cmContent().dispatchEvent(ev)
  })
  expect(view().state.doc.toString()).toBe(text)
  await unmount()
})

test('dropping files is not inserted, but the event still bubbles to an ancestor', async () => {
  let bubbled = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      // biome-ignore lint/a11y/noStaticElementInteractions: a test fixture, not real UI.
      <div onDrop={() => { bubbled = true }}>
        <MarkdownEditor value="" onChange={() => {}} />
      </div>,
    )
  })
  const file = new File(['x'], 'a.txt', { type: 'text/plain' })
  await act(async () => {
    cmContent().dispatchEvent(dropEvent([file]))
  })
  expect(bubbled).toBe(true)
  expect(view().state.doc.toString()).toBe('')
  await unmount()
})

// --- DOM contract ---------------------------------------------------------------

test('the contenteditable carries role=textbox, data-slot, aria-label and aria-placeholder', async () => {
  await mount(
    props({
      value: '',
      placeholder: 'type here',
      'aria-label': 'the composer',
      'data-slot': 'input-group-control',
    }),
  )
  const content = cmContent()
  expect(content.getAttribute('role')).toBe('textbox')
  expect(content.getAttribute('data-slot')).toBe('input-group-control')
  expect(content.getAttribute('aria-label')).toBe('the composer')
  expect(content.getAttribute('aria-placeholder')).toBe('type here')
  await unmount()
})

test('the handle exposes focus/getSelection/contentElement, and autoFocus + initialSelection are read at mount', async () => {
  const ref = createRef<MarkdownEditorHandle>()
  await mount(
    props({
      value: 'hello world',
      ref,
      initialSelection: { anchor: 2, head: 5 },
      autoFocus: true,
    }),
  )
  const content = cmContent()
  expect(document.activeElement).toBe(content)
  expect(ref.current?.getSelection()).toEqual({ anchor: 2, head: 5 })
  expect(ref.current?.contentElement).toBe(content)
  await unmount()
})

test('initialSelection clamps to the document length', async () => {
  const ref = createRef<MarkdownEditorHandle>()
  await mount(props({ value: 'hi', ref, initialSelection: { anchor: 50, head: 999 } }))
  expect(ref.current?.getSelection()).toEqual({ anchor: 2, head: 2 })
  await unmount()
})

// --- live preview ----------------------------------------------------------------

test('bold, italic, strikethrough and inline code get their classes, marks hidden away from the caret', async () => {
  // Leading/trailing plain text so a caret at either end sits unambiguously
  // outside every construct — the first and last ones would otherwise start
  // or end exactly where the caret is, which counts as "inside" (see the
  // "reveals again" test below for that inclusive-edge behaviour on purpose).
  await mount(props({ value: 'x **bold** *em* ~~gone~~ `code` y' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: 0 } })
  })
  expect(container.querySelector('.font-bold')?.textContent).toBe('bold')
  expect(container.querySelector('.italic')?.textContent).toBe('em')
  expect(container.querySelector('.line-through')?.textContent).toBe('gone')
  expect(
    container.querySelector('.rounded.border.bg-muted.px-1\\.5.py-0\\.5.font-mono.text-sm')
      ?.textContent,
  ).toBe('code')
  // Every marker hidden — none of the raw punctuation shows up as text.
  const text = container.textContent ?? ''
  expect(text).not.toContain('**')
  expect(text).not.toContain('~~')
  expect(text).not.toContain('`')
})

test('the caret moving inside a construct reveals its markers again', async () => {
  await mount(props({ value: 'a **bold** b' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: 0 } })
  })
  expect(container.textContent).not.toContain('**')
  await act(async () => {
    // Inside "bold", between the two `**` pairs.
    view().dispatch({ selection: { anchor: 5 } })
  })
  expect(container.textContent).toContain('**bold**')
  await unmount()
})

test('a heading gets its own class and hides the "# " once the caret leaves the line', async () => {
  await mount(props({ value: '# Title\nbody' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  const heading = container.querySelector('.cm-line')
  expect(heading?.className).toContain('text-xl')
  expect(heading?.className).toContain('font-semibold')
  expect(container.textContent).not.toContain('#')
  expect(container.textContent).toContain('Title')
  await unmount()
})

test('get_user_by_id is never treated as emphasis', async () => {
  await mount(props({ value: 'call get_user_by_id please' }))
  expect(container.querySelector('.italic')).toBeNull()
  await unmount()
})

test('**/*.tsx is never treated as emphasis', async () => {
  await mount(props({ value: 'match **/*.tsx everywhere' }))
  expect(container.querySelector('.italic')).toBeNull()
  expect(container.querySelector('.font-bold')).toBeNull()
  await unmount()
})

// history() is required for `undo` (used above) to mean anything at all —
// this just pins that the extension list really includes it, in case a
// future edit to buildExtensions drops it silently.
test('history is wired: undo actually undoes a real edit', async () => {
  await mount(props({ value: 'a' }))
  await typeText('ab')
  expect(view().state.doc.toString()).toBe('ab')
  expect(undo(view())).toBe(true)
  expect(view().state.doc.toString()).toBe('a')
  await unmount()
})

// --- regressions found by adversarial verification ----------------------------
//
// (tests/composer-markdown-verification.test.tsx, owned by an independent
// tester — these pin the same defects here, at this component's own level.)

test('a CRLF value mounts without throwing, and normalizes to LF like CodeMirror always does', async () => {
  reset()
  await mount(props({ value: 'a\r\nb' }))
  expect(view().state.doc.toString()).toBe('a\nb')
  expect(calls.onChange).toEqual([])
  await unmount()
})

test('a lone CR value mounts without throwing', async () => {
  reset()
  await mount(props({ value: 'a\rb' }))
  expect(view().state.doc.toString()).toBe('a\nb')
  expect(calls.onChange).toEqual([])
  await unmount()
})

test('a CRLF value arriving as an external replace does not throw, and fires no onChange', async () => {
  reset()
  await mount(props({ value: 'before' }))
  await rerender(props({ value: 'a\r\nb' }))
  expect(view().state.doc.toString()).toBe('a\nb')
  expect(calls.onChange).toEqual([])
  await unmount()
})

test('initialSelection past a CRLF value clamps to the normalized document, not the raw string', async () => {
  reset()
  const ref = createRef<MarkdownEditorHandle>()
  // Raw string is 4 chars ('a\r\nb'); CodeMirror's own doc is 3 ('a\nb') —
  // an unclamped anchor of 4 is exactly the out-of-range case that used to
  // throw `RangeError: Selection points outside of document`.
  await mount(props({ value: 'a\r\nb', ref, initialSelection: { anchor: 4, head: 4 } }))
  expect(view().state.doc.length).toBe(3)
  expect(ref.current?.getSelection()).toEqual({ anchor: 3, head: 3 })
  await unmount()
})

test('CRLF typed into the editor is emitted as LF, the same as a <textarea> value', async () => {
  reset()
  await mount(props({ value: '' }))
  await act(async () => {
    view().dispatch({ changes: { from: 0, insert: 'a\r\nb' }, userEvent: 'input.type' })
  })
  expect(calls.onChange).toEqual(['a\nb'])
  await unmount()
})

test('a link whose destination starts on the next line mounts and can be typed without throwing', async () => {
  reset()
  const value = 'x [a](\n/url) y'
  await mount(props({ value }))
  expect(view().state.doc.toString()).toBe(value)
  await unmount()

  // Typed, then moving the caret out of it (the sequence that used to leave
  // the view in a broken "update in progress" state after the RangeError).
  reset()
  await mount(props({ value: '' }))
  await typeText(value)
  await act(async () => {
    view().dispatch({ selection: { anchor: 0 } })
  })
  expect(view().state.doc.toString()).toBe(value)
  await unmount()
})

test('a link whose title starts on the next line mounts without throwing', async () => {
  reset()
  const value = 'x [a](/url\n"title") y'
  await mount(props({ value }))
  expect(view().state.doc.toString()).toBe(value)
  await unmount()
})

test('a shortcut reference link (arr[0]) is left as plain text: no link class, brackets not hidden', async () => {
  reset()
  await mount(props({ value: 'arr[0] and arr[1]' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  expect(container.querySelector('.text-primary')).toBeNull()
  expect(container.textContent).toBe('arr[0] and arr[1]')
  await unmount()
})

test('a full reference link ([a][b]) is also left as plain text', async () => {
  reset()
  await mount(props({ value: 'x [a][b] y' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: 0 } })
  })
  expect(container.querySelector('.text-primary')).toBeNull()
  expect(container.textContent).toBe('x [a][b] y')
  await unmount()
})

test('a real inline link ([text](url)) still gets its class and hidden marks', async () => {
  reset()
  await mount(props({ value: 'x [text](https://example.com) y' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: 0 } })
  })
  expect(container.querySelector('.text-primary')?.textContent).toBe('text')
  expect(container.textContent).not.toContain('](')
  await unmount()
})

test('Shift+Enter on "- a\\n- " (an empty second item) drops the marker, leaves a blank line, exits the list', async () => {
  expect(await shiftEnterAtEnd('- a\n- ')).toBe('- a\n\n')
})

test('Shift+Enter on an empty blockquote line ("> quoted\\n> ") drops the marker, leaves a blank line, exits the quote', async () => {
  expect(await shiftEnterAtEnd('> quoted\n> ')).toBe('> quoted\n\n')
})

test('Shift+Enter still continues a non-empty blockquote line', async () => {
  expect(await shiftEnterAtEnd('> a')).toBe('> a\n> ')
})

test('a literal "> " inside a fenced code block is not treated as a blockquote to exit', async () => {
  // Same text a blockquote-exit would match, but inside a fence — must fall
  // through to a plain newline, the same as any other line in a fence.
  expect(await shiftEnterAtEnd('```\n> ')).toBe('```\n> \n')
})

test('text typed after exiting an empty blockquote line parses outside the quote (lazy continuation)', async () => {
  reset()
  // "> quoted\n> " with the caret at the end, Shift+Enter (exit), then type
  // a plain line — CommonMark's lazy-continuation rule would otherwise still
  // read a line placed directly under the quote (no blank line) as part of
  // it, which is exactly why the exit leaves one.
  await mount(props({ value: '> quoted\n> ' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  await pressKey({ key: 'Enter', shiftKey: true })
  expect(view().state.doc.toString()).toBe('> quoted\n\n')
  await act(async () => {
    const pos = view().state.doc.length
    view().dispatch({
      changes: { from: pos, insert: 'after the quote' },
      selection: { anchor: pos + 'after the quote'.length },
      userEvent: 'input.type',
    })
  })
  expect(view().state.doc.toString()).toBe('> quoted\n\nafter the quote')
  const lines = [...container.querySelectorAll('.cm-line')]
  const lastLine = lines[lines.length - 1]
  expect(lastLine?.textContent).toBe('after the quote')
  expect(lastLine?.className).not.toContain('border-l-2')
  await unmount()
})

test('text typed after exiting an empty list item parses outside the list (lazy continuation)', async () => {
  reset()
  await mount(props({ value: '- a\n- ' }))
  await act(async () => {
    view().dispatch({ selection: { anchor: view().state.doc.length } })
  })
  await pressKey({ key: 'Enter', shiftKey: true })
  expect(view().state.doc.toString()).toBe('- a\n\n')
  await act(async () => {
    const pos = view().state.doc.length
    view().dispatch({
      changes: { from: pos, insert: 'after the list' },
      selection: { anchor: pos + 'after the list'.length },
      userEvent: 'input.type',
    })
  })
  expect(view().state.doc.toString()).toBe('- a\n\nafter the list')
  const lines = [...container.querySelectorAll('.cm-line')]
  const lastLine = lines[lines.length - 1]
  expect(lastLine?.textContent).toBe('after the list')
  expect(lastLine?.querySelector('.text-muted-foreground')).toBeNull()
  await unmount()
})
