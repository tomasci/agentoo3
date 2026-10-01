// `shared/components/markdown-field.tsx` — the whole-document markdown field
// the library's agent and skill editors use: CodeMirror (`MarkdownEditor`,
// visual mode, the default) or a monospace `Textarea` (raw mode), switched by
// a toggle whose choice persists in `documentEditorModeAtom`
// (`agentoo:document-editor-mode`), never in the composer's own
// `agentoo:composer-mode`.
//
// Also pins `MarkdownEditor`'s new `spellCheck` prop at the component level,
// including the composer's unchanged default (spellcheck on).
//
// Isolation: `atomWithStorage` keeps its value per jotai store and re-reads
// localStorage in `onMount`, so each mount gets a fresh `createStore()` and
// localStorage is cleared before every test. The `getOnInit` read itself
// happens once, when `shared/store/ui.ts` is evaluated, so that path is
// exercised on a fresh module instance (`?fresh=N`) evaluated after the
// stored value is in place — same approach as
// tests/composer-markdown-verification.test.tsx.
//
// Driving CodeMirror follows tests/markdown-editor.test.tsx's header:
// transactions via `view.dispatch(...)` inside `act`, never DOM input events.
//
// Rendered under a private `cimode` i18n instance, so `t()` returns the key.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { MarkdownEditor } from '../src/shared/components/markdown-editor'
import { MarkdownField, type MarkdownFieldProps } from '../src/shared/components/markdown-field'
import { composerModeAtom, documentEditorModeAtom } from '../src/shared/store/ui'

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

const DOC_KEY = 'agentoo:document-editor-mode'
const COMPOSER_KEY = 'agentoo:composer-mode'
const TOGGLE = 'markdownField.source'

// --- mounting -----------------------------------------------------------------

let container: HTMLDivElement
let root: Root | undefined
let store: ReturnType<typeof createStore>

function tree(node: ReactNode) {
  return (
    <I18nextProvider i18n={cimode}>
      <JotaiProvider store={store}>{node}</JotaiProvider>
    </I18nextProvider>
  )
}

async function mountNode(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  const r = createRoot(container)
  root = r
  await act(async () => {
    r.render(tree(node))
  })
}

async function rerenderNode(node: ReactNode) {
  await act(async () => {
    root?.render(tree(node))
  })
}

let changes: string[]
const props = (o: Partial<MarkdownFieldProps> = {}): MarkdownFieldProps => ({
  id: 'doc-field',
  label: 'Prompt',
  value: '',
  onChange: (v) => changes.push(v),
  ...o,
})

const mount = (p: MarkdownFieldProps) => mountNode(<MarkdownField {...p} />)
const rerender = (p: MarkdownFieldProps) => rerenderNode(<MarkdownField {...p} />)

beforeEach(() => {
  localStorage.clear()
  store = createStore()
  changes = []
})

afterEach(async () => {
  const r = root
  if (r) {
    await act(async () => {
      r.unmount()
    })
  }
  root = undefined
  container?.remove()
  localStorage.clear()
})

const cmEditor = () => container.querySelector('.cm-editor') as HTMLElement | null
const cmContent = () => container.querySelector('.cm-content') as HTMLElement | null
const textarea = () => container.querySelector('textarea')
const view = () => {
  const el = cmEditor()
  const v = el && EditorView.findFromDOM(el)
  if (!v) throw new Error('no CodeMirror view mounted')
  return v
}
const doc = () => view().state.doc.toString()
const toggle = () => {
  const b = container.querySelector<HTMLElement>(`[aria-label="${TOGGLE}"]`)
  if (!b) throw new Error('no source toggle')
  return b
}
const clickToggle = async () => {
  await act(async () => {
    toggle().click()
  })
}

async function typeInEditor(text: string) {
  await act(async () => {
    view().dispatch({
      changes: { from: 0, to: view().state.doc.length, insert: text },
      userEvent: 'input.type',
    })
  })
}

async function typeInTextarea(value: string) {
  const ta = textarea()
  if (!ta) throw new Error('no textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A controlled parent, the shape both library pages have: owns the string,
 * feeds it back as `value`. */
function Controlled({ initial, log }: { initial: string; log: string[] }) {
  const [v, setV] = useState(initial)
  return (
    <MarkdownField
      id="doc-field"
      label="Prompt"
      value={v}
      onChange={(next) => {
        log.push(next)
        setV(next)
      }}
    />
  )
}

// --- 1. visual mode by default ------------------------------------------------

describe('visual mode (default)', () => {
  test('renders CodeMirror, no textarea, and shows the value', async () => {
    await mount(props({ value: 'hello get_user_by_id' }))
    expect(cmEditor()).not.toBeNull()
    expect(textarea()).toBeNull()
    expect(doc()).toBe('hello get_user_by_id')
    expect(container.textContent).toContain('hello get_user_by_id')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  test('contenteditable carries the label as aria-label and spellcheck/autocorrect/autocapitalize off', async () => {
    await mount(props({ label: 'The agent prompt' }))
    const content = cmContent()
    expect(content).not.toBeNull()
    expect(content?.getAttribute('aria-label')).toBe('The agent prompt')
    expect(content?.getAttribute('spellcheck')).toBe('false')
    expect(content?.getAttribute('autocorrect')).toBe('off')
    expect(content?.getAttribute('autocapitalize')).toBe('off')
  })

  test('the field label is rendered and points at the id', async () => {
    await mount(props({ label: 'The agent prompt' }))
    const label = container.querySelector('label')
    expect(label?.textContent).toBe('The agent prompt')
    expect(label?.getAttribute('for')).toBe('doc-field')
  })

  test('mounting fires no onChange', async () => {
    await mount(props({ value: 'already here' }))
    expect(changes).toEqual([])
  })

  test('mounting with nothing stored writes nothing to either mode key', async () => {
    await mount(props({ value: 'x' }))
    expect(localStorage.getItem(DOC_KEY)).toBeNull()
    expect(localStorage.getItem(COMPOSER_KEY)).toBeNull()
  })
})

// --- 2. a user edit -----------------------------------------------------------

test('a user edit through a CodeMirror transaction calls onChange with the exact new string', async () => {
  await mount(props({ value: 'ab' }))
  const typed = 'ab `<tag>` **/*.tsx get_user_by_id\n\n```ts\nconst x = 1\n```\n'
  await typeInEditor(typed)
  expect(changes).toEqual([typed])
})

// --- 3. external value after mount --------------------------------------------

test('an external value arriving after mount (query resolving) is shown and fires no onChange', async () => {
  await mount(props({ value: '' }))
  expect(doc()).toBe('')
  const loaded = '# Loaded\n\nuse get_user_by_id on **/*.tsx'
  await rerender(props({ value: loaded }))
  expect(doc()).toBe(loaded)
  expect(changes).toEqual([])
})

// --- 4. toggling --------------------------------------------------------------

describe('toggle to raw and back', () => {
  test('raw mode is a monospace textarea with the identical value, id, rows=20, spellcheck off', async () => {
    const value = 'line one\n\n- `<tag>` get_user_by_id\n'
    await mount(props({ value }))
    await clickToggle()
    expect(cmEditor()).toBeNull()
    const ta = textarea()
    expect(ta).not.toBeNull()
    expect(ta?.value).toBe(value)
    expect(ta?.id).toBe('doc-field')
    expect(ta?.className.split(/\s+/)).toContain('font-mono')
    expect(ta?.getAttribute('rows')).toBe('20')
    expect(ta?.getAttribute('spellcheck')).toBe('false')
    expect(ta?.getAttribute('aria-label')).toBe('Prompt')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    // Toggling alone is not an edit.
    expect(changes).toEqual([])
  })

  test('typing in the raw textarea calls onChange with the exact string', async () => {
    await mount(props({ value: 'a' }))
    await clickToggle()
    await typeInTextarea('a **b** _c_')
    expect(changes).toEqual(['a **b** _c_'])
  })

  test('an edit made in raw mode is what the editor shows after toggling back', async () => {
    const log: string[] = []
    await mountNode(<Controlled initial="start" log={log} />)
    await clickToggle()
    await typeInTextarea('edited in raw: get_user_by_id')
    expect(log).toEqual(['edited in raw: get_user_by_id'])
    await clickToggle()
    expect(textarea()).toBeNull()
    expect(cmEditor()).not.toBeNull()
    expect(doc()).toBe('edited in raw: get_user_by_id')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    // Re-mounting CodeMirror on the way back is not an edit either.
    expect(log).toEqual(['edited in raw: get_user_by_id'])
  })

  test('an edit made in visual mode is what the textarea shows after toggling', async () => {
    const log: string[] = []
    await mountNode(<Controlled initial="start" log={log} />)
    await typeInEditor('edited in visual\n\n* item')
    await clickToggle()
    expect(textarea()?.value).toBe('edited in visual\n\n* item')
  })

  test('localStorage reflects the choice under its own key; the composer key is never written', async () => {
    localStorage.setItem(COMPOSER_KEY, '"visual"')
    const composerBefore = store.get(composerModeAtom)
    await mount(props({ value: 'x' }))
    await clickToggle()
    expect(localStorage.getItem(DOC_KEY)).toBe('"raw"')
    expect(store.get(documentEditorModeAtom)).toBe('raw')
    expect(localStorage.getItem(COMPOSER_KEY)).toBe('"visual"')
    await clickToggle()
    expect(localStorage.getItem(DOC_KEY)).toBe('"visual"')
    expect(localStorage.getItem(COMPOSER_KEY)).toBe('"visual"')
    expect(store.get(composerModeAtom)).toBe(composerBefore)
  })

  test('with nothing stored for the composer, toggling never creates its key', async () => {
    await mount(props({ value: 'x' }))
    await clickToggle()
    await clickToggle()
    await clickToggle()
    expect(localStorage.getItem(COMPOSER_KEY)).toBeNull()
    expect(localStorage.getItem(DOC_KEY)).toBe('"raw"')
  })

  test('a stored composer mode of "raw" does not put this field in raw mode', async () => {
    localStorage.setItem(COMPOSER_KEY, '"raw"')
    await mount(props({ value: 'x' }))
    expect(cmEditor()).not.toBeNull()
    expect(textarea()).toBeNull()
  })

  test('two fields on one page share the mode', async () => {
    await mountNode(
      <>
        <MarkdownField {...props({ id: 'one', label: 'One', value: 'a' })} />
        <MarkdownField {...props({ id: 'two', label: 'Two', value: 'b' })} />
      </>,
    )
    const toggles = container.querySelectorAll<HTMLElement>(`[aria-label="${TOGGLE}"]`)
    expect(toggles.length).toBe(2)
    await act(async () => {
      toggles[0]?.click()
    })
    expect([...container.querySelectorAll('textarea')].map((t) => t.id)).toEqual(['one', 'two'])
  })
})

// --- toggle tooltip ---------------------------------------------------------------

// Base UI tooltips open on focus under happy-dom with no provider (see
// tests/composer-tooltips.test.tsx's header); they portal to <body>.
const openTooltips = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent ?? '')

async function focusToggle() {
  // Blur first: a click closes the tooltip, and focusing an element that
  // already has focus fires no focus event to reopen it.
  await act(async () => {
    toggle().blur()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
  await act(async () => {
    toggle().focus()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

test('the toggle tooltip offers the source in visual mode and the formatted view in raw mode', async () => {
  await mount(props({ value: 'x' }))
  await focusToggle()
  expect(openTooltips()).toEqual(['markdownField.showSource'])
  await clickToggle()
  await focusToggle()
  expect(openTooltips()).toEqual(['markdownField.showFormatted'])
  await clickToggle()
  await focusToggle()
  expect(openTooltips()).toEqual(['markdownField.showSource'])
})

// --- 5. stored mode on mount ----------------------------------------------------

describe('stored mode on mount', () => {
  test('a stored "raw" mounts straight into raw mode', async () => {
    localStorage.setItem(DOC_KEY, '"raw"')
    await mount(props({ value: 'stored raw' }))
    expect(cmEditor()).toBeNull()
    expect(textarea()?.value).toBe('stored raw')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
  })

  for (const [name, stored] of [
    ['"banana"', '"banana"'],
    ['invalid JSON', 'not-json'],
    ['bare raw without JSON quotes', 'raw'],
    ['null', 'null'],
    ['a number', '123'],
    ['an object', '{"mode":"raw"}'],
    ['empty string', ''],
  ] as const) {
    test(`a stored ${name} mounts in visual mode, and the toggle still goes to raw`, async () => {
      localStorage.setItem(DOC_KEY, stored)
      await mount(props({ value: 'v' }))
      expect(cmEditor()).not.toBeNull()
      expect(textarea()).toBeNull()
      expect(toggle().getAttribute('aria-pressed')).toBe('false')
      await clickToggle()
      expect(textarea()?.value).toBe('v')
      expect(localStorage.getItem(DOC_KEY)).toBe('"raw"')
    })
  }

  // The `getOnInit` read proper: a fresh evaluation of shared/store/ui.ts
  // with the value already stored must start at it synchronously, before any
  // effect — that is what spares a raw-mode reader a visual flash.
  let n = 0
  for (const [stored, expected] of [
    ['"raw"', 'raw'],
    ['"visual"', 'visual'],
    ['not-json', 'visual'],
  ] as const) {
    test(`getOnInit: a fresh store reads ${stored} synchronously as ${expected}`, async () => {
      localStorage.setItem(DOC_KEY, stored)
      const mod = await import(`../src/shared/store/ui.ts?fresh=${++n}`)
      const atom = mod.documentEditorModeAtom as typeof documentEditorModeAtom
      expect(createStore().get(atom)).toBe(expected)
    })
  }

  test('getOnInit: with nothing stored the default is visual', async () => {
    const mod = await import(`../src/shared/store/ui.ts?fresh=${++n}`)
    expect(createStore().get(mod.documentEditorModeAtom as typeof documentEditorModeAtom)).toBe(
      'visual',
    )
  })
})

// --- focus via the box's own padding, and what is left to CodeMirror ------------
//
// The bordered wrapper's `onMouseDown` acts only on a target outside
// `.cm-editor` — the wrapper's own padding, or the `MarkdownEditor` host div
// between it and `.cm-editor` — and there calls `preventDefault()` plus a
// plain `focus()` that leaves the selection where it was. Anything inside
// `.cm-editor` (`.cm-scroller`, where a scrollbar grab lands, or `.cm-editor`
// itself) is left alone: not prevented, selection untouched.
//
// CodeMirror registers its own mouse handlers on `.cm-content` only
// (`InputState.ensureHandlers` → `view.contentDOM`), so a mousedown dispatched
// on `.cm-scroller`/`.cm-editor` reaches only the wrapper's handler on its way
// up — exactly the path under test. A mousedown on `.cm-content` itself is not
// covered: under happy-dom, once the editor holds DOM focus, a synthetic one
// there triggers a re-entrant `selectionchange` inside CodeMirror ("Calls to
// EditorView.update are not allowed while an update is in progress") — a
// harness artefact, see tests/markdown-editor.test.tsx's header.

/** 200 numbered lines; long enough that "end of doc" and "middle" differ. */
const LONG_DOC = Array.from({ length: 200 }, (_, i) => `line ${i + 1} get_user_by_id`).join('\n')

async function mountLongAtMiddle() {
  await mount(props({ value: LONG_DOC }))
  const line100 = view().state.doc.line(100)
  // A non-empty range in the middle, so "moved to a cursor" and "moved to the
  // end" are both distinguishable from "untouched".
  const anchor = line100.from + 2
  const head = line100.from + 6
  await act(async () => {
    view().dispatch({ selection: { anchor, head } })
  })
  const main = view().state.selection.main
  expect({ anchor: main.anchor, head: main.head }).toEqual({ anchor, head })
  return { anchor, head }
}

const selection = () => {
  const main = view().state.selection.main
  return { anchor: main.anchor, head: main.head }
}

async function mousedownOn(el: HTMLElement) {
  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
  await act(async () => {
    el.dispatchEvent(ev)
  })
  return ev
}

const wrapper = () => {
  const box = cmEditor()?.parentElement?.parentElement as HTMLElement
  // The wrapper is the bordered box around the editor, not the editor itself.
  expect(box.className).toContain('border-input')
  return box
}

describe('mousedown inside .cm-editor is left alone', () => {
  for (const [name, target] of [
    ['.cm-scroller (a scrollbar grab)', () => container.querySelector('.cm-scroller')],
    ['.cm-editor', () => cmEditor()],
  ] as const) {
    test(`${name}: not defaultPrevented, mid-doc selection unchanged, doc unchanged`, async () => {
      const before = await mountLongAtMiddle()
      const el = target() as HTMLElement | null
      expect(el).not.toBeNull()
      const ev = await mousedownOn(el as HTMLElement)
      expect(ev.defaultPrevented).toBe(false)
      expect(selection()).toEqual(before)
      expect(selection().head).not.toBe(view().state.doc.length)
      expect(doc() === LONG_DOC).toBe(true)
      expect(changes).toEqual([])
    })
  }

  test('.cm-scroller with scrollTop set: the scroll position is not touched', async () => {
    const before = await mountLongAtMiddle()
    const scroller = container.querySelector('.cm-scroller') as HTMLElement
    scroller.scrollTop = 200
    // happy-dom does no layout, so scrollTop may not stick; only compare
    // against whatever it actually holds after the assignment.
    const top = scroller.scrollTop
    await mousedownOn(scroller)
    expect(scroller.scrollTop).toBe(top)
    expect(selection()).toEqual(before)
  })
})

describe("mousedown on the box's own padding", () => {
  test('the wrapper itself: defaultPrevented, editor focused, mid-doc selection not moved', async () => {
    const before = await mountLongAtMiddle()
    expect(document.activeElement).not.toBe(cmContent())
    const ev = await mousedownOn(wrapper())
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cmContent())
    expect(selection()).toEqual(before)
    expect(selection().head).not.toBe(view().state.doc.length)
    expect(changes).toEqual([])
  })

  test('the MarkdownEditor host div between wrapper and .cm-editor: same as the padding', async () => {
    const before = await mountLongAtMiddle()
    const host = cmEditor()?.parentElement as HTMLElement
    expect(host).not.toBe(wrapper())
    expect(host.classList.contains('cm-editor')).toBe(false)
    const ev = await mousedownOn(host)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cmContent())
    expect(selection()).toEqual(before)
  })

  test('a short doc: focus lands in the editor (the original padding case)', async () => {
    await mount(props({ value: 'x' }))
    expect(document.activeElement).not.toBe(cmContent())
    const ev = await mousedownOn(wrapper())
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cmContent())
  })
})

// --- the field label --------------------------------------------------------------

const fieldLabel = () => {
  const l = container.querySelector<HTMLLabelElement>('label[data-slot="field-label"]')
  if (!l) throw new Error('no field label')
  return l
}

test('visual mode: a mousedown on the label is defaultPrevented and focuses the editor, selection kept', async () => {
  const before = await mountLongAtMiddle()
  expect(document.activeElement).not.toBe(cmContent())
  const ev = await mousedownOn(fieldLabel())
  expect(ev.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(cmContent())
  expect(selection()).toEqual(before)
})

test('raw mode: the label targets the textarea by for/id and its mousedown is not prevented', async () => {
  localStorage.setItem(DOC_KEY, '"raw"')
  await mount(props({ id: 'raw-field', value: 'r' }))
  const ta = textarea()
  expect(ta).not.toBeNull()
  expect(fieldLabel().getAttribute('for')).toBe('raw-field')
  expect(ta?.id).toBe('raw-field')
  expect(document.getElementById('raw-field')).toBe(ta)
  expect(fieldLabel().htmlFor).toBe('raw-field')
  const ev = await mousedownOn(fieldLabel())
  expect(ev.defaultPrevented).toBe(false)
})

test('the label handler follows the mode: toggling raw → visual makes the label focus the editor again', async () => {
  await mount(props({ value: 'x' }))
  await clickToggle()
  expect((await mousedownOn(fieldLabel())).defaultPrevented).toBe(false)
  await clickToggle()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  const ev = await mousedownOn(fieldLabel())
  expect(ev.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(cmContent())
})

// --- 6. MarkdownEditor spellCheck prop --------------------------------------------

describe('MarkdownEditor spellCheck', () => {
  test('default (composer): spellcheck=true, autocorrect=on, autocapitalize=sentences', async () => {
    await mountNode(<MarkdownEditor value="" onChange={() => {}} />)
    const content = cmContent()
    expect(content?.getAttribute('spellcheck')).toBe('true')
    expect(content?.getAttribute('autocorrect')).toBe('on')
    expect(content?.getAttribute('autocapitalize')).toBe('sentences')
  })

  test('spellCheck={true} explicitly matches the default', async () => {
    await mountNode(<MarkdownEditor value="" onChange={() => {}} spellCheck />)
    const content = cmContent()
    expect(content?.getAttribute('spellcheck')).toBe('true')
    expect(content?.getAttribute('autocorrect')).toBe('on')
    expect(content?.getAttribute('autocapitalize')).toBe('sentences')
  })

  test('spellCheck={false}: spellcheck=false, autocorrect=off, autocapitalize=off', async () => {
    await mountNode(<MarkdownEditor value="" onChange={() => {}} spellCheck={false} />)
    const content = cmContent()
    expect(content?.getAttribute('spellcheck')).toBe('false')
    expect(content?.getAttribute('autocorrect')).toBe('off')
    expect(content?.getAttribute('autocapitalize')).toBe('off')
  })

  test('aria-label and data-slot still ride along with spellCheck={false}', async () => {
    await mountNode(
      <MarkdownEditor
        value=""
        onChange={() => {}}
        spellCheck={false}
        aria-label="lbl"
        data-slot="input-group-control"
      />,
    )
    const content = cmContent()
    expect(content?.getAttribute('aria-label')).toBe('lbl')
    expect(content?.getAttribute('data-slot')).toBe('input-group-control')
  })
})
