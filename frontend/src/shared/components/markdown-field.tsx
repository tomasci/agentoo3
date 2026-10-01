import { useAtom } from 'jotai'
import { CodeIcon } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { documentEditorModeAtom } from '@/shared/store/ui'
import { FieldLabel } from '@/shared/ui/field'
import { Textarea } from '@/shared/ui/textarea'
import { Toggle } from '@/shared/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor'

export interface MarkdownFieldProps {
  id: string
  /** Rendered as the field's own label (left of the toggle) and handed to
   * both surfaces as their `aria-label` — there is no second, separate
   * accessible name to keep in sync with it. */
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

/**
 * A whole markdown *document* — an agent's prompt, a skill's body, a system
 * prompt's body — edited the same way the session composer's visual mode
 * does: CodeMirror plus the Obsidian-style live-preview layer
 * (`markdown-editor.tsx`, `shared/lib/markdown-live-preview.ts`), with a
 * toggle back to a plain monospace `Textarea` for a reader who wants the raw
 * source. Unlike the composer this is a document-sized field, not a
 * chat-sized box: fixed height, its own border standing in for the
 * `Textarea` it replaces rather than an `InputGroup`, and no caret handoff
 * between surfaces on toggle — a plain remount reading `value` is enough
 * here, since switching modes mid-edit on a multi-paragraph document is rare
 * enough not to warrant the composer's `CaretHandoff` machinery.
 *
 * The mode preference (`documentEditorModeAtom`) is shared by every page
 * that renders this component, deliberately separate from the composer's own
 * `composerModeAtom` — a reader's taste for one surface says nothing about
 * the other.
 */
export function MarkdownField({
  id,
  label,
  value,
  onChange,
  placeholder,
  className,
}: MarkdownFieldProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useAtom(documentEditorModeAtom)
  const isRaw = mode === 'raw'
  const editorRef = useRef<MarkdownEditorHandle>(null)

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel
          htmlFor={id}
          // In raw mode `for` already does this natively (the textarea
          // actually carries `id`); in visual mode nothing in the DOM carries
          // it, so the browser's own label-click-focuses-the-target behaviour
          // has nothing to find. `mousedown`, not `click`: focusing here
          // before the browser's own default mousedown handling runs is what
          // keeps that default from blurring straight back out, the same
          // reason the box's own handler below needs `preventDefault()`.
          onMouseDown={
            isRaw
              ? undefined
              : (e) => {
                  e.preventDefault()
                  editorRef.current?.focus()
                }
          }
        >
          {label}
        </FieldLabel>
        <Tooltip>
          <TooltipTrigger
            data-slot="toggle"
            aria-label={t('markdownField.source')}
            render={
              <Toggle
                size="sm"
                className="size-6 min-w-6 px-0"
                pressed={isRaw}
                onPressedChange={(pressed) => setMode(pressed ? 'raw' : 'visual')}
              />
            }
          >
            <CodeIcon />
          </TooltipTrigger>
          <TooltipContent>
            {isRaw ? t('markdownField.showFormatted') : t('markdownField.showSource')}
          </TooltipContent>
        </Tooltip>
      </div>

      {isRaw ? (
        <Textarea
          id={id}
          className="field-sizing-fixed font-mono"
          rows={20}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: a focus target standing in for the `Textarea` it replaces, not a control of its own — see the `onMouseDown` comment below for what it's for.
        <div
          // Looks like the `Textarea` it replaces: same rounded box, same
          // border/padding, focus shown on this wrapper (`focus-within`)
          // rather than on CodeMirror's own contenteditable, which sits a
          // layer inside it.
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          // `.cm-content` already fills the whole box on its own (CodeMirror's
          // own `minHeight: 100%` on it) — below the last line, inside the
          // scroller, dragging its scrollbar are all still inside `.cm-editor`
          // and are left entirely to CodeMirror/the browser, untouched. The
          // only part of this box CodeMirror knows nothing about is outside
          // `.cm-editor` altogether: this wrapper's own padding, and the
          // `MarkdownEditor` host div around `.cm-editor` (neither one carries
          // any padding of its own, but both sit between this border and the
          // editor). `preventDefault` stops the browser's own default
          // mousedown behaviour (moving focus off whatever was focused) from
          // undoing the manual focus a moment later. Plain `focus()`, not a
          // forced caret position — a click on padding has no document
          // position of its own, but there is no reason to move the one
          // already there either; on a long, scrolled document that would
          // yank the view away from wherever the reader actually was.
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('.cm-editor')) return
            e.preventDefault()
            editorRef.current?.focus()
          }}
        >
          <MarkdownEditor
            ref={editorRef}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={label}
            spellCheck={false}
            // Fixed height, roughly the old 20-row textarea's footprint —
            // unlike the composer's own `max-h-48`, this field never grows
            // past it; the editor scrolls internally instead.
            className="[&_.cm-editor]:h-120 [&_.cm-scroller]:overflow-y-auto"
          />
        </div>
      )}
    </div>
  )
}
