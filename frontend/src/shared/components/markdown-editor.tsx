import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdownLanguage,
} from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type StateCommand,
} from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { livePreview } from '@/shared/lib/markdown-live-preview'
import { cn } from '@/shared/lib/utils'

export interface MarkdownEditorSelection {
  anchor: number
  head: number
}

export interface MarkdownEditorHandle {
  focus(): void
  getSelection(): MarkdownEditorSelection
  /** CodeMirror's own contenteditable — grows with the text, so it is what a
   * caller measures for "has this wrapped past one line" the way the raw
   * textarea's `clientHeight` is measured today (`composer.tsx`). */
  readonly contentElement: HTMLElement | null
}

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  /** Native keydown on the contenteditable, before the editor's own keymap —
   * `preventDefault()` claims the key and stops CodeMirror from acting on it
   * at all (composer.tsx's Enter-sends rule). */
  onKeyDown?: (event: KeyboardEvent) => void
  /** Clipboard carries files: the paste is claimed and nothing is inserted. */
  onPasteFiles?: (files: File[]) => void
  placeholder?: string
  'aria-label'?: string
  /** Forwarded to the contenteditable, not this wrapper — `input-group.tsx`'s
   * focus ring keys off `[data-slot=input-group-control]:focus-visible` on
   * the actual focusable control. */
  'data-slot'?: string
  /** Read once, at mount — see the mount effect below for why a later change
   * has no effect on an already-live editor. */
  initialSelection?: MarkdownEditorSelection
  autoFocus?: boolean
  className?: string
  ref?: Ref<MarkdownEditorHandle>
}

const clamp = (pos: number, length: number) => Math.max(0, Math.min(pos, length))

// A line that is nothing but a list marker (optionally a task checkbox)
// and no content of its own.
const EMPTY_LIST_ITEM_LINE = /^(?:[-*+]|\d+[.)])(?: \[[ xX]\])? ?$/

// A line that is nothing but one or more blockquote markers (`>`, `> `,
// `> > `, …) and no content of its own.
const EMPTY_QUOTE_LINE = /^(?:>\s?)+$/

function isInside(state: EditorState, pos: number, typeName: string): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === typeName) return true
  }
  return false
}

/**
 * Shift+Enter (or Enter) on an otherwise-empty list item or blockquote line
 * exits the construct instead of continuing it forever — `@codemirror/
 * lang-markdown`'s own `insertNewlineContinueMarkup` has no such behaviour
 * for either; its `nonTightLists` option (a separate config, not used here)
 * only turns a *tight* list loose, still with the empty item and its marker
 * in place, one keystroke short of actually leaving it.
 *
 * Leaves a blank line behind on purpose, rather than just dropping the
 * marker: CommonMark's lazy-continuation rule means a line typed directly
 * after a bare exit (no blank line separating it) still parses as part of
 * the same list item or blockquote, so a reader who pressed "exit" would
 * still be visibly inside it — the live-preview layer would keep drawing
 * the quote's border, or the list's own indent, under text that looks like
 * it left.
 *
 * Declines (so the keymap falls through to `insertNewlineContinueMarkup`, then to
 * a plain newline) unless the line is *only* that construct's own markup —
 * checked against the syntax tree, not just the text, so a line that merely
 * *looks* like an empty list item or quote inside a fenced code block is
 * left alone.
 */
const exitEmptyListOrQuote: StateCommand = ({ state, dispatch }) => {
  const { main } = state.selection
  if (!main.empty) return false
  const line = state.doc.lineAt(main.head)
  if (main.head !== line.to) return false
  const exits =
    (EMPTY_LIST_ITEM_LINE.test(line.text) && isInside(state, main.head, 'ListItem')) ||
    (EMPTY_QUOTE_LINE.test(line.text) && isInside(state, main.head, 'Blockquote'))
  if (!exits) return false
  dispatch(
    state.update({
      // A newline *replacing* the marker, not a plain deletion: that is
      // what turns "- a\n- " into "- a\n\n" (a blank separating line, caret
      // on the fresh one after it) rather than "- a\n" (caret right back up
      // against the previous line, which lazy continuation would still
      // read as part of it).
      changes: { from: line.from, to: line.to, insert: '\n' },
      scrollIntoView: true,
      userEvent: 'delete',
    }),
  )
  return true
}

/**
 * The composer's visual surface: CodeMirror 6 with a repo-owned live-preview
 * layer (`shared/lib/markdown-live-preview.ts`) instead of a rich-text editor
 * — see that file's own comment for why serializing a rich-text model back to
 * markdown is the wrong shape for text that is itself an agent prompt. This
 * component knows nothing about sessions or drafts; `value`/`onChange` are
 * its entire contract with the outside world, the same as a controlled
 * `<textarea>`.
 */
export function MarkdownEditor({
  value,
  onChange,
  onKeyDown,
  onPasteFiles,
  placeholder,
  'aria-label': ariaLabel,
  'data-slot': dataSlot,
  initialSelection,
  autoFocus,
  className,
  ref,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // The last string *this instance* handed to `onChange` — compared against
  // on every render so the value-sync effect below can tell "the parent
  // handed our own edit back to us" (a no-op) from "something outside this
  // editor changed the text" (session switch, a failed send restoring the
  // draft, `setText('')` on send), which needs a full state replace instead.
  const lastEmittedRef = useRef(value)

  // Read through refs and refreshed on every render, never captured once at
  // mount: `onChange` is `draft.setText`, whose identity changes with
  // `sessionId`, and `onKeyDown` closes over `submit`, which closes over
  // `draft.text` — a stale mount-time closure would write into whichever
  // session's draft (or send whichever session's text) happened to be
  // current the moment CodeMirror was constructed, not the one actually on
  // screen when the reader acts.
  const onChangeRef = useRef(onChange)
  const onKeyDownRef = useRef(onKeyDown)
  const onPasteFilesRef = useRef(onPasteFiles)
  onChangeRef.current = onChange
  onKeyDownRef.current = onKeyDown
  onPasteFilesRef.current = onPasteFiles

  const buildExtensions = (): Extension[] => [
    // Above the editor's own keymap (Prec.default, see @codemirror/view's
    // `keymap` facet) so a consumer's `preventDefault()` — composer.tsx's
    // Enter-sends rule — retires the key before CodeMirror's list/quote
    // continuation ever sees it, including inside a list item or a fence.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => {
          onKeyDownRef.current?.(event)
          return event.defaultPrevented
        },
      }),
    ),
    keymap.of([
      { key: 'Enter', run: exitEmptyListOrQuote, shift: exitEmptyListOrQuote },
      { key: 'Enter', run: insertNewlineContinueMarkup, shift: insertNewlineContinueMarkup },
      { key: 'Backspace', run: deleteMarkupBackward },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    // `markdownLanguage`, not `markdown()`: the latter also installs
    // lang-html (and, through it, lang-css and lang-javascript) for fenced
    // code blocks' embedded grammars, +~60KB gz this composer has no use for
    // — see frontend/README.md's Stack note on this editor.
    markdownLanguage.extension,
    history(),
    EditorView.lineWrapping,
    placeholderExtension(placeholder ?? ''),
    livePreview(),
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocorrect: 'on',
      autocapitalize: 'sentences',
      ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      ...(dataSlot ? { 'data-slot': dataSlot } : {}),
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      const text = update.state.doc.toString()
      lastEmittedRef.current = text
      onChangeRef.current(text)
    }),
    EditorView.domEventHandlers({
      // A pasted screenshot carries no text representation at all — see
      // composer.tsx's own textarea paste handler, which this mirrors.
      // Anything else (including plain text with markdown-looking
      // characters in it) is left alone so CodeMirror inserts it verbatim:
      // no filter here ever gets a chance to escape it.
      paste: (event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        onPasteFilesRef.current?.(files)
        return true
      },
      // Claims the drop so CodeMirror's own default (reading every dropped
      // file as text and inserting it) never runs, but only via
      // `preventDefault()` — returning `true` here never calls
      // `stopPropagation()`, so the same event still bubbles to the
      // composer footer's own `onDrop`, which is the tray's actual attach
      // path for a dropped file.
      drop: (event) => Array.from(event.dataTransfer?.files ?? []).length > 0,
    }),
  ]

  // Builds a state whose selection can never land past the end of its own
  // document. CodeMirror normalizes `\r\n` (and a lone `\r`) to `\n` when it
  // builds `doc` from a plain string, which can shrink the real document
  // shorter than the raw `value`/`initialSelection` this component was handed
  // — clamping against `state.doc.length` *after* construction, not
  // `value.length` (or an untouched `initialSelection`) before it, is what
  // keeps a CRLF draft from throwing `RangeError: Selection points outside of
  // document` the moment it mounts or arrives as an external replace.
  const createState = (
    doc: string,
    extensions: Extension[],
    selection?: MarkdownEditorSelection,
  ) => {
    const state = EditorState.create({ doc, extensions })
    const length = state.doc.length
    const range = selection
      ? EditorSelection.single(clamp(selection.anchor, length), clamp(selection.head, length))
      : EditorSelection.single(length)
    return state.update({ selection: range }).state
  }

  // Mount/unmount only. `value`/`initialSelection`/`autoFocus` here are only
  // ever this instance's *first* value — every later external replace (a
  // session switch reusing the same `SessionPage` instance, `setText('')` on
  // send, a failed send restoring the draft) goes through the sync effect
  // below, never through a remount, so reading them again on every render
  // would be wrong even if biome's exhaustive-deps rule wants them here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      state: createState(value, buildExtensions(), initialSelection),
      parent,
    })
    viewRef.current = view
    // The raw prop, deliberately not `view.state.doc.toString()`: the sync
    // effect below compares against this to recognise "the parent handed our
    // own edit back to us", and it runs on this very same commit (see that
    // effect's own comment) — matching what `value` actually was here, CRLF
    // and all, is what keeps a CRLF draft from being treated as an external
    // replace on the render immediately after mount.
    lastEmittedRef.current = value
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // The one place an external `value` is allowed to overwrite whatever
  // CodeMirror is currently showing. `view.setState` (not `dispatch`) is the
  // point of this: it fires no update listener, so this never loops back
  // into `onChange`, and it discards undo history along with the old state,
  // so a reader who switches sessions and then reflexively hits Ctrl+Z can't
  // pull the previous session's text back into this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `buildExtensions` is a fresh closure every render (it only ever reads props/refs current at call time); depending on it would rebuild CodeMirror's whole state on every render of the *parent*, not just on the external replaces this effect exists to catch
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentDoc = view.state.doc.toString()
    if (value === currentDoc || value === lastEmittedRef.current) return
    view.setState(createState(value, buildExtensions()))
    lastEmittedRef.current = value
  }, [value])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      getSelection: () => {
        const main = viewRef.current?.state.selection.main
        return { anchor: main?.anchor ?? 0, head: main?.head ?? 0 }
      },
      get contentElement() {
        return viewRef.current?.contentDOM ?? null
      },
    }),
    [],
  )

  return (
    <div
      ref={hostRef}
      className={cn(
        // `text-base md:text-sm`: shadcn's own `Textarea` breakpoint — 16px
        // on mobile is what keeps iOS from zooming the page in on focus.
        'text-base md:text-sm',
        // CodeMirror injects its own base stylesheet as a plain, unlayered
        // `<style>` tag, while Tailwind v4 wraps every utility in
        // `@layer utilities` — an unlayered rule beats a layered one
        // regardless of source order or specificity, so anything CM sets
        // needs `!` to win at all. See frontend/README.md's Styling note on
        // this editor for the same rule applied to the live-preview classes.
        '[&_.cm-content]:caret-foreground! [&_.cm-content]:py-0! [&_.cm-editor]:outline-none! [&_.cm-placeholder]:text-muted-foreground! [&_.cm-scroller]:font-sans! [&_.cm-scroller]:leading-[inherit]!',
        className,
      )}
    />
  )
}
