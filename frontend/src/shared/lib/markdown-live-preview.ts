import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Line, Range, Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

/**
 * The Obsidian-style trick that makes this editor different from a rich-text
 * one: the markdown string is never parsed into a document and reserialized
 * back out (see `markdown-editor.tsx`'s own comment on why — a rich-text
 * model escapes literal markup on the way out, which corrupts an agent
 * prompt). Formatting is purely a layer of decorations over the same text
 * CodeMirror already holds, built from the markdown grammar's own syntax
 * tree — hide a construct's marker characters and style its content when the
 * caret is elsewhere, show the raw markup when the caret is inside it, the
 * same as Obsidian's editor does.
 *
 * Classes are literal strings, not composed at runtime — Tailwind's scanner
 * reads source text (`frontend/README.md`'s "Styling" section), and they
 * intentionally mirror `shared/components/markdown.tsx`'s own `components`
 * map so a sent message looks the same rendered in the transcript as it did
 * while it was being composed.
 */

/** True if any selection range touches `[from, to]`, inclusive of its own
 * edges — a caret sitting right at a marker's boundary counts as "inside" so
 * that clicking up against `**` from either side reveals it rather than
 * requiring one more keystroke to land past it. */
function touches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.to >= from && range.from <= to)
}

/** Every doc line touched by `[from, to)` — a plain loop rather than
 * `doc.iterLines` because callers need the `Line` objects themselves (for
 * `.from`/`.to`/`.number`), not just their text. */
function linesIn(doc: Text, from: number, to: number): Line[] {
  const lines: Line[] = []
  let pos = from
  for (;;) {
    const line = doc.lineAt(pos)
    lines.push(line)
    if (line.to >= to) break
    pos = line.to + 1
  }
  return lines
}

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: 'text-xl font-semibold',
  ATXHeading2: 'text-lg font-semibold',
  ATXHeading3: 'text-base font-semibold',
  ATXHeading4: 'text-base font-semibold',
  ATXHeading5: 'text-base font-semibold',
  ATXHeading6: 'text-base font-semibold',
}

const EMPHASIS_CLASS: Record<string, string> = {
  StrongEmphasis: 'font-bold',
  Emphasis: 'italic',
  Strikethrough: 'line-through',
}

const FENCE_LINE_BASE = 'bg-muted font-mono text-sm px-3!'

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  const tree = syntaxTree(state)
  const ranges: Range<Decoration>[] = []

  const mark = (from: number, to: number, cls: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: cls }).range(from, to))
  }
  // No replace decoration from a `ViewPlugin` may ever cross a line break —
  // CodeMirror throws `RangeError: Decorations that replace line breaks may
  // not be specified via plugins` rather than silently doing something odd
  // with the line structure. Every current call site is already safe by
  // construction except a link's `](url)` (CommonMark allows the destination
  // or title to start on the next line) — this guard is the backstop for
  // that one and for whatever spans a future construct adds. A link whose
  // hidden span crosses a line just stays visible instead of hiding.
  const hide = (from: number, to: number) => {
    if (from < to && !doc.sliceString(from, to).includes('\n')) {
      ranges.push(Decoration.replace({}).range(from, to))
    }
  }
  const line = (pos: number, cls: string) => {
    ranges.push(Decoration.line({ class: cls }).range(pos))
  }
  // A marker plus the single space commonmark requires after it (`# `, `> `)
  // — hiding only the marker would leave the content awkwardly indented by
  // exactly one space once the `#`/`>` itself disappears.
  const hideMarkAndSpace = (from: number, to: number) => {
    const hasSpace = doc.sliceString(to, to + 1) === ' '
    hide(from, hasSpace ? to + 1 : to)
  }

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const strongEmphasisOrStrikethrough = EMPHASIS_CLASS[node.name]
        if (strongEmphasisOrStrikethrough) {
          mark(node.from, node.to, strongEmphasisOrStrikethrough)
          if (!touches(state, node.from, node.to)) {
            const markName = node.name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
            for (const m of node.node.getChildren(markName)) hide(m.from, m.to)
          }
          return
        }

        const headingClass = HEADING_CLASS[node.name]
        if (headingClass) {
          const headingLine = doc.lineAt(node.from)
          line(headingLine.from, headingClass)
          if (!touches(state, headingLine.from, headingLine.to)) {
            const headerMark = node.node.getChild('HeaderMark')
            if (headerMark) hideMarkAndSpace(headerMark.from, headerMark.to)
          }
          return
        }

        switch (node.name) {
          case 'InlineCode': {
            mark(node.from, node.to, 'rounded border bg-muted px-1.5 py-0.5 font-mono text-sm')
            if (!touches(state, node.from, node.to)) {
              for (const m of node.node.getChildren('CodeMark')) hide(m.from, m.to)
            }
            break
          }
          case 'Link': {
            // A `Link` node with no `URL` child is a shortcut (`[a]`) or
            // reference (`[a][b]`) form — it only ever becomes a real link
            // if a matching link-reference definition exists elsewhere in
            // the document, which prompt text like `arr[0]` never has.
            // react-markdown renders exactly that same fallback (plain
            // text, brackets and all) in the transcript, so styling or
            // hiding anything here would show a link that isn't one.
            if (!node.node.getChild('URL')) break
            mark(node.from, node.to, 'font-medium text-primary underline underline-offset-4')
            if (!touches(state, node.from, node.to)) {
              const marks = node.node.getChildren('LinkMark')
              const open = marks[0]
              const rest = marks.slice(1)
              const lastRest = rest[rest.length - 1]
              if (open) hide(open.from, open.to)
              if (rest[0] && lastRest) hide(rest[0].from, lastRest.to)
            }
            break
          }
          case 'Blockquote': {
            for (const l of linesIn(doc, node.from, node.to)) {
              line(l.from, 'border-l-2 border-border pl-3! text-muted-foreground')
            }
            break
          }
          case 'QuoteMark': {
            const quoteLine = doc.lineAt(node.from)
            if (!touches(state, quoteLine.from, quoteLine.to)) hideMarkAndSpace(node.from, node.to)
            break
          }
          case 'FencedCode': {
            const lines = linesIn(doc, node.from, node.to)
            const markerLines = new Set(
              node.node.getChildren('CodeMark').map((m) => doc.lineAt(m.from).number),
            )
            lines.forEach((l, i) => {
              const edge =
                i === 0
                  ? 'rounded-t-md border-x border-t'
                  : i === lines.length - 1
                    ? 'rounded-b-md border-x border-b'
                    : 'border-x'
              const muted = markerLines.has(l.number) ? ' text-muted-foreground' : ''
              line(l.from, `${FENCE_LINE_BASE} ${edge}${muted}`)
            })
            break
          }
          case 'ListMark':
          case 'TaskMarker':
          case 'HorizontalRule': {
            mark(node.from, node.to, 'text-muted-foreground')
            break
          }
          case 'TableDelimiter': {
            // A lone `|` between cells (length 1) carries no delimiter-row
            // meaning of its own — only the `|---|---|` separator line does.
            if (node.to - node.from > 1) mark(node.from, node.to, 'text-muted-foreground')
            break
          }
          case 'TableHeader':
          case 'TableRow': {
            line(doc.lineAt(node.from).from, 'font-mono text-sm')
            break
          }
          default:
            break
        }
      },
    })
  }

  return Decoration.set(ranges, true)
}

class LivePreviewPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view)
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      syntaxTree(update.state) !== syntaxTree(update.startState)
    ) {
      this.decorations = buildDecorations(update.view)
    }
  }
}

/** Decorations only, built fresh from the syntax tree on every doc change,
 * viewport change, selection change and background reparse — comparing
 * `syntaxTree(...)` by reference is the documented way to catch the last of
 * those, since parsing beyond the viewport happens on an idle callback that
 * dispatches no document change of its own. */
export function livePreview(): Extension {
  return ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (v) => v.decorations,
  })
}
