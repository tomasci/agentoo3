import { CodeIcon, CornerDownLeftIcon, FileIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import type { DragEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { formatBytes } from '@/features/system'
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownEditorSelection,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/shared/ui/attachment'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/shared/ui/input-group'
import { Spinner } from '@/shared/ui/spinner'
import { Toggle } from '@/shared/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import type { AttachmentUpload, SessionFilesUsage } from '../hooks/use-session-files'
import { attachmentDescription, isInlineImage, sessionFileUrl } from '../lib/attachments'
import { AttachmentLightbox } from './attachment-lightbox'

export interface ComposerAttachments {
  uploads: AttachmentUpload[]
  usage?: SessionFilesUsage
  usagePending: boolean
  usageError: unknown
  pendingCount: number
  onAttach: (files: File[], usage?: SessionFilesUsage) => void
  onCancel: (id: string) => void
  /** Dismisses an error chip, or removes an already-uploaded file from the
   * session — which one depends on the chip's own status, which is why this
   * takes the whole upload rather than just its id. */
  onRemove: (upload: AttachmentUpload) => void
}

/**
 * One tray tile — uploading, failed or done, image or not — as the same
 * vertical `Attachment` the transcript's own tiles use. An image gets a
 * preview from whichever source the tile actually has: a fresh `File` (an
 * upload started in this tab) gets a client-side `URL.createObjectURL` —
 * needs nothing from the network, so the thumbnail is there the instant a
 * file is picked rather than only once the upload finishes — created here in
 * an effect keyed on the file itself and revoked in that same effect's
 * cleanup, on removal, on unmount, and on StrictMode's throwaway extra mount
 * alike, so nothing outlives the tile that made it. A tile rehydrated from a
 * server file id (`use-session-files.ts`'s `rehydrate`, after a reload) has
 * no `File` to hand `createObjectURL`, only a `serverFile` — its preview is
 * the same `/api/sessions/:id/files/:fileId` URL the transcript's own
 * attachments use, needing no object URL or cleanup of its own at all.
 */
function AttachmentTile({
  sessionId,
  upload,
  onCancel,
  onRemove,
}: {
  sessionId: string
  upload: AttachmentUpload
  onCancel: (id: string) => void
  onRemove: (upload: AttachmentUpload) => void
}) {
  const { t } = useTranslation()
  const state =
    upload.status === 'uploading' ? 'uploading' : upload.status === 'error' ? 'error' : 'done'
  const isImage = isInlineImage(upload.mimeType)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  // Flips true only if the browser itself fails to decode the preview —
  // never trusted as the sole signal of anything about the upload itself,
  // same as the transcript's own broken-thumbnail guard.
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    if (!isImage || !upload.file) return
    const url = URL.createObjectURL(upload.file)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [isImage, upload.file])

  const previewSrc = upload.file
    ? objectUrl
    : upload.serverFile
      ? sessionFileUrl(sessionId, upload.serverFile.id)
      : null
  const showImage = isImage && previewSrc !== null && !broken

  const description =
    upload.status === 'error'
      ? upload.precheckFailed
        ? t('sessions.attachments.tooLargeForSession')
        : apiErrorMessage(upload.error, t('sessions.attachments.uploadFailed'))
      : upload.status === 'uploading'
        ? attachmentDescription(upload.name, `${upload.progress}%`)
        : attachmentDescription(upload.name, formatBytes(upload.size))

  return (
    <Attachment orientation="vertical" state={state}>
      <AttachmentMedia variant={showImage ? 'image' : 'icon'}>
        {showImage ? (
          <img src={previewSrc} alt={upload.name} onError={() => setBroken(true)} />
        ) : upload.status === 'uploading' ? (
          <Spinner />
        ) : (
          <FileIcon aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={upload.name}>{upload.name}</AttachmentTitle>
        {/* The vertical tile truncates this line, so the failure a reader
            most needs the full text of is the one case this carries a
            `title` of its own — every other description is short enough
            (a size, a percentage) that truncation never hides anything. */}
        <AttachmentDescription title={upload.status === 'error' ? description : undefined}>
          {description}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          aria-label={
            upload.status === 'uploading'
              ? t('sessions.attachments.cancel', { name: upload.name })
              : t('sessions.attachments.remove', { name: upload.name })
          }
          onClick={() => (upload.status === 'uploading' ? onCancel(upload.id) : onRemove(upload))}
        >
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
      {/* Only once there is something real to show — an object URL the
          browser has actually decoded, not merely one requested — so the
          lightbox never opens onto a broken image. */}
      {showImage && (
        <AttachmentLightbox
          filename={upload.name}
          src={previewSrc}
          triggerLabel={t('sessions.attachments.preview', { name: upload.name })}
        />
      )}
    </Attachment>
  )
}

/** What the surface being left behind had — its selection and whether it was
 * actually focused — captured so the surface taking over can put the caret
 * back in the same place instead of always landing at the end. Neither
 * surface reads this reactively: the raw textarea gets it applied
 * imperatively (`setSelectionRange`, native — there is no "initial selection"
 * prop for a `<textarea>`), the editor gets it as `initialSelection`, a prop
 * `MarkdownEditor` only ever reads once, at its own mount. */
interface CaretHandoff {
  anchor: number
  head: number
  focused: boolean
}

/**
 * Whether a surface's measured height indicates the text has actually
 * wrapped past one line, given a `baseline` captured while it was empty. A
 * plain function of numbers, not DOM — so it is unit-testable without a
 * layout engine, which happy-dom does not have (see this repo's other
 * composer tests on why the wrap-by-width path itself stays untested there).
 *
 * The raw textarea signals a wrap two ways, depending on whether the browser
 * supports CSS `field-sizing: content` (`shared/ui/textarea.tsx`): where it
 * does, the element grows with its content and never overflows, so a wrap
 * only shows up as `clientHeight` growing past the baseline; where it does
 * not, the element stays fixed at the baseline and a wrap instead overflows
 * it (`scrollHeight > clientHeight`). Either signal is exact for a plain
 * textarea — nothing else changes a single line's own height.
 *
 * The visual surface's `clientHeight` is not that clean: inline code's own
 * padding, a heading's larger line-height, or simply crossing the `md`
 * breakpoint between the baseline being captured and this check each grow
 * one *unwrapped* line by a few pixels — enough to clear `baseline + 1`
 * without a second line ever existing (found by an operator testing the
 * real thing in a browser, not by anything happy-dom could have caught). A
 * genuine wrap roughly doubles the line box, so a coarser cutoff — over one
 * and a half lines — is what actually tells "still one line, just taller"
 * from "there are now two" apart.
 */
export function hasWrapped(
  surface: 'raw' | 'visual',
  measurements: { clientHeight: number; scrollHeight: number; baseline: number },
): boolean {
  const { clientHeight, scrollHeight, baseline } = measurements
  if (surface === 'raw') return scrollHeight > clientHeight || clientHeight > baseline + 1
  return clientHeight > baseline * 1.5
}

/**
 * The message composer: text, attachments, send. Extracted from
 * `session-page.tsx` once attachments gave it enough of its own concerns
 * (attach button, drag-and-drop, paste, a chip tray, per-session usage) to
 * earn a file the way `transcript.tsx` already has one.
 *
 * Built on shadcn's `input-group`: one bordered box that reflows between a
 * single compact row (attach, text, send) and an expanded shape (text on its
 * own row, attach/send on a row below it) as the message grows past one
 * line — see the `expanded` state below for how that switch is detected and
 * why it is one-way once tripped.
 *
 * Two text surfaces share the same box: `mode === 'visual'` renders
 * `MarkdownEditor` (CodeMirror plus `shared/lib/markdown-live-preview.ts`),
 * showing markdown formatting inline as it is typed; `mode === 'raw'` is
 * today's plain `InputGroupTextarea`, unchanged. Either way `value` stays a
 * plain markdown string — this component (and `SessionPage` above it) never
 * knows which surface is currently showing it. CodeMirror rather than a
 * rich-text editor (Tiptap, Lexical, …) for exactly that reason: a rich-text
 * model parses markdown in and re-serializes it back out, escaping literal
 * markup on the way (`snake_case` grows a backslash, a stray `<tag>` in the
 * prompt gets entity-escaped) — fine for prose, not for text that is itself
 * an agent prompt or a shell-glob-laden file path. CodeMirror's document
 * *is* the markdown string; nothing here ever re-parses or reserializes it.
 *
 * `submit`/`text` stay owned by `SessionPage` — see its own comment on why
 * `text` clears the moment Enter is pressed rather than in `onSuccess` — this
 * component only renders them and the attachment tray built on top.
 */
export function Composer({
  sessionId,
  value,
  onChange,
  onSubmit,
  mode,
  onModeChange,
  sending,
  canSend,
  canStop,
  stopping,
  onStop,
  queueLine,
  error,
  attachments,
}: {
  /** Only ever read to build a rehydrated tile's preview URL
   * (`sessionFileUrl`, in `AttachmentTile` above) — a fresh upload's preview
   * comes from its own `File` instead, needing no session id at all. */
  sessionId: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Anything other than the literal `'raw'` renders as `'visual'` — the
   * same rule `composerModeAtom` documents for a corrupted or pre-this-
   * feature stored value. */
  mode: 'visual' | 'raw'
  onModeChange: (mode: 'visual' | 'raw') => void
  sending: boolean
  canSend: boolean
  /** Whether the session can currently be stopped — renders the stop button
   * immediately before send, in whichever addon holds it, and renders nothing
   * at all when false. Optional, reading as falsy: tests that mount this
   * component without a session to stop never have to pass it. */
  canStop?: boolean
  stopping?: boolean
  onStop?: () => void
  queueLine: string
  error: string | null
  attachments: ComposerAttachments
}) {
  const { t } = useTranslation()
  const isRaw = mode === 'raw'
  const fileInput = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const { uploads, usage, usagePending, usageError, pendingCount, onAttach, onCancel, onRemove } =
    attachments

  // Whether the box has grown past one line — a literal newline, or wrapped
  // text — and switched to the expanded layout (full-width text surface,
  // +/send moved to a row underneath). `singleLineHeight` is the one-line
  // baseline this compares against, captured (and recaptured, every time the
  // box goes back to empty) from the active surface's own `clientHeight` —
  // one baseline per surface, since the textarea and the editor's own
  // contenteditable are not the same height for the same one line of text.
  const [expanded, setExpanded] = useState(false)
  const singleLineHeight = useRef<{ raw: number | null; visual: number | null }>({
    raw: null,
    visual: null,
  })

  // Keyed on `value`/`mode` rather than checked inside the surface's own
  // `onChange`: by the time this effect runs the DOM node's layout already
  // reflects the just-committed value on every browser, which a raw event
  // handler reading the same node mid-event cannot promise.
  //
  // What actually counts as "wrapped" is `hasWrapped`, above — different
  // per surface, and worth its own comment rather than repeating it here.
  //
  // Sticky once true — checked before `hasWrapped` ever runs, and cleared
  // only by the `value === ''` branch above it — because expanding widens
  // the box, which can make the very same text fit back on one line.
  // Without this, that would immediately collapse it again: a resize loop
  // the reader would see as the box breathing in and out while they type.
  // Switching surfaces alone never trips it either way — only re-baselines
  // whichever surface just became active.
  useLayoutEffect(() => {
    const el = mode === 'raw' ? textareaRef.current : (editorRef.current?.contentElement ?? null)
    if (!el) return
    if (value === '') {
      setExpanded(false)
      singleLineHeight.current[mode] = el.clientHeight
      return
    }
    if (expanded) return
    if (value.includes('\n')) {
      setExpanded(true)
      return
    }
    if (singleLineHeight.current[mode] === null) singleLineHeight.current[mode] = el.clientHeight
    const baseline = singleLineHeight.current[mode] ?? 0
    if (
      hasWrapped(mode, { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, baseline })
    ) {
      setExpanded(true)
    }
  }, [value, expanded, mode])

  // Set by the toggle's own handler, below, at the instant it fires — the
  // surface being left behind is still mounted then, so its selection is
  // still there to read. `null` once there is nothing left to hand over.
  const [handoff, setHandoff] = useState<CaretHandoff | null>(null)

  // Applies a pending handoff to the raw textarea, which (unlike the editor)
  // has no "initial selection" prop of its own to read it through instead.
  // Runs once per mode change; a no-op on the initial mount (nothing has
  // toggled yet, so `handoff` is still null) and a no-op switching *into*
  // visual mode (the editor already consumed the same `handoff` as
  // `initialSelection`/`autoFocus` props at its own mount, in this same
  // commit — this effect only has to forget it afterwards).
  useLayoutEffect(() => {
    if (!handoff) return
    if (mode === 'raw') {
      const el = textareaRef.current
      if (el) {
        const from = Math.min(handoff.anchor, handoff.head)
        const to = Math.max(handoff.anchor, handoff.head)
        el.setSelectionRange(from, to, handoff.anchor <= handoff.head ? 'forward' : 'backward')
        if (handoff.focused) el.focus()
      }
    }
    setHandoff(null)
  }, [mode, handoff])

  const captureHandoff = (): CaretHandoff | null => {
    if (mode === 'raw') {
      const el = textareaRef.current
      if (!el) return null
      const focused = document.activeElement === el
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      return el.selectionDirection === 'backward'
        ? { anchor: end, head: start, focused }
        : { anchor: start, head: end, focused }
    }
    const editor = editorRef.current
    if (!editor) return null
    const focused = document.activeElement === editor.contentElement
    const selection: MarkdownEditorSelection = editor.getSelection()
    return { ...selection, focused }
  }

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onAttach(files, usage)
  }

  const showSend = value.trim().length > 0 || sending

  // Enter sends; Shift+Enter is a newline. A prompt is usually one line, and
  // reaching for the mouse for every send is worse. One rule for both
  // surfaces (moved here, from `session-page.tsx`, once the raw textarea
  // stopped being the only text surface): sends in either mode, including
  // inside a list item or a fence — there is no markdown-aware exception,
  // and no separate check for composing IME input either, since `!isComposing`
  // already covers it. `onSubmit` itself already refuses an empty or
  // whitespace-only `text`/a pending upload (`SessionPage`'s own `submit`),
  // so this never needs to check either.
  const sendOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      onSubmit()
    }
  }

  // Each tray/send/stop control is a Tooltip wrapping the button rather than
  // the button carrying a `title=` — same reason the status bar's own host
  // metrics use one (app/status-bar.tsx): a `title` attribute never reaches a
  // keyboard user, and Base UI's Tooltip already knows to open on focus, not
  // only on hover. `TooltipTrigger`'s own props (aria-label, onClick,
  // disabled) merge onto the `render` element the same way `PopoverTrigger`
  // does for the details button below in session-page.tsx, so the click
  // handler and the icon-only button both stay exactly as they were.
  //
  // `data-slot="button"` is restated on every `TooltipTrigger` below: it
  // stamps its own literal `data-slot="tooltip-trigger"` onto whatever it
  // clones its `render` element into, which lands after `InputGroupButton`'s
  // own (inherited from `Button`) in prop order and so wins — silently
  // renaming it unless restated here, the same fix `app/tab-bar.tsx` uses for
  // its own Tooltip-wrapped controls.
  const attachButton = (
    <Tooltip>
      <TooltipTrigger
        data-slot="button"
        aria-label={t('sessions.attachments.attach')}
        onClick={() => fileInput.current?.click()}
        render={<InputGroupButton size="icon-xs" />}
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipContent>{t('sessions.attachments.attachTooltip')}</TooltipContent>
    </Tooltip>
  )

  const sendButton = showSend && (
    <Tooltip>
      {/* `disabled` goes on the rendered button itself, not (only) on
          `TooltipTrigger`: the trigger only ever reads its own `disabled` to
          decide whether hover/focus should be allowed to open the tooltip —
          it does not forward it to the element `render` points at, so the
          native `disabled` attribute the composer's own click-does-nothing
          contract depends on has to be set here too. */}
      <TooltipTrigger
        data-slot="button"
        aria-label={sending ? t('sessions.sending') : t('sessions.send')}
        disabled={!canSend}
        onClick={onSubmit}
        render={<InputGroupButton size="icon-xs" disabled={!canSend} />}
      >
        {sending ? <Spinner /> : <CornerDownLeftIcon />}
      </TooltipTrigger>
      {/* A disabled trigger never opens its tooltip (Base UI, and
          `disabled:pointer-events-none` on the button itself besides) — fine
          here: there is nothing to add to "why can't I send" that the queue
          line/blocking text above the box does not already say. */}
      <TooltipContent>{t('sessions.sendTooltip')}</TooltipContent>
    </Tooltip>
  )

  // Sits immediately before send, in whichever addon holds it — compact or
  // expanded never affects whether this shows, only send's own emptiness
  // check does that.
  const stopButton = canStop && (
    <Tooltip>
      <TooltipTrigger
        data-slot="button"
        aria-label={t('sessions.stop')}
        disabled={stopping}
        onClick={onStop}
        render={<InputGroupButton size="icon-xs" disabled={stopping} />}
      >
        <SquareIcon className="fill-current" />
      </TooltipTrigger>
      <TooltipContent>{t('sessions.stopTooltip')}</TooltipContent>
    </Tooltip>
  )

  // The formatted/source switch, always present (compact or expanded, empty
  // or not) — unlike attach/stop/send it is never conditional on the text,
  // so a reader who prefers raw markdown can always get to it. `aria-label`
  // is the constant `sessions.composerMode.source`, never the direction
  // it currently switches to — that lives in the tooltip instead, the same
  // split `sending`'s label/tooltip pair uses above. `onMouseDown` prevents
  // the default focus-follows-mousedown behaviour: without it, clicking the
  // toggle would move focus onto the button itself, and `captureHandoff`'s
  // own `focused` check (`document.activeElement === …`) would then see the
  // text as unfocused even though the reader's caret was there a moment
  // ago. Preventing that default keeps focus in the text surface through a
  // mouse click the same way it already stays there through a keyboard
  // activation, so the handoff's `focused` flag — and so whether the new
  // surface gets `autoFocus`/a refocused textarea — reflects reality either
  // way.
  const toggleButton = (
    <Tooltip>
      <TooltipTrigger
        data-slot="toggle"
        aria-label={t('sessions.composerMode.source')}
        onMouseDown={(e) => e.preventDefault()}
        render={
          <Toggle
            size="sm"
            className="size-6 min-w-6 px-0"
            pressed={isRaw}
            onPressedChange={(pressed) => {
              setHandoff(captureHandoff())
              onModeChange(pressed ? 'raw' : 'visual')
            }}
          />
        }
      >
        <CodeIcon />
      </TooltipTrigger>
      <TooltipContent>
        {isRaw ? t('sessions.composerMode.showFormatted') : t('sessions.composerMode.showSource')}
      </TooltipContent>
    </Tooltip>
  )

  const textSurface = isRaw ? (
    <InputGroupTextarea
      ref={textareaRef}
      value={value}
      // Only load-bearing where `field-sizing: content` is unsupported:
      // otherwise the textarea's own default of 2 rows would render the
      // compact box two lines tall and delay the `scrollHeight >
      // clientHeight` wrap check above until a *third* line. Where
      // content-sizing does apply, it overrides this and the box still
      // grows with the text as usual.
      rows={expanded ? 3 : 1}
      className="min-h-0 max-h-48"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => sendOnEnter(e.nativeEvent)}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files)
        if (files.length > 0) {
          // A pasted screenshot carries no text representation at
          // all, so there is no typed content here to preserve —
          // this only ever pre-empts the no-op paste the browser
          // would otherwise do.
          e.preventDefault()
          onAttach(files, usage)
        }
      }}
      placeholder={t('sessions.composerPlaceholder')}
    />
  ) : (
    <MarkdownEditor
      ref={editorRef}
      value={value}
      onChange={onChange}
      onKeyDown={sendOnEnter}
      onPasteFiles={(files) => onAttach(files, usage)}
      placeholder={t('sessions.composerPlaceholder')}
      aria-label={t('sessions.composerPlaceholder')}
      data-slot="input-group-control"
      initialSelection={handoff ? { anchor: handoff.anchor, head: handoff.head } : undefined}
      autoFocus={handoff?.focused ?? false}
      // `w-full`: `InputGroup`'s own `items-center` (`input-group.tsx`) is
      // unconditional, not just for the compact row — once `block-end`/
      // `block-start` flips it to `flex-col` for the expanded layout,
      // `items-center` centers cross-axis too, which is now horizontal, and
      // a bare `<div>` (unlike the raw `<textarea>`, which has its own
      // intrinsic sizing) shrinks to its content's width and centers in the
      // column. `w-full` gives it an explicit width, which flexbox honours
      // over `align-items` regardless of layout, in both directions.
      // `pl-1`: lines up the first glyph with raw mode's — the raw
      // textarea's own `px-2.5` (`shared/ui/textarea.tsx`) puts it 10px in
      // from the group's inner edge; CodeMirror's `.cm-line` already
      // contributes 6px of that on its own, so 4px (`pl-1`) here makes up
      // the rest.
      className="w-full min-w-0 flex-1 py-2 pl-1 [&_.cm-editor]:max-h-48 [&_.cm-scroller]:overflow-y-auto"
    />
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target, not a control — the file input and its own button below are the operable, keyboard-reachable way to attach a file; dropping anywhere onto the composer is a mouse-only convenience layered on top, same as every other drag-and-drop surface.
    <footer className="flex flex-col gap-2" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {queueLine && <span className="text-xs text-muted-foreground">{queueLine}</span>}

      {uploads.length > 0 && (
        <div className="flex flex-col gap-1">
          <AttachmentGroup>
            {uploads.map((upload) => (
              <AttachmentTile
                key={upload.id}
                sessionId={sessionId}
                upload={upload}
                onCancel={onCancel}
                onRemove={onRemove}
              />
            ))}
          </AttachmentGroup>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {usagePending && <Spinner aria-hidden="true" />}
            {Boolean(usageError) && (
              <span className="text-destructive">
                {apiErrorMessage(usageError, t('sessions.attachments.usageLoadFailed'))}
              </span>
            )}
            {usage && (
              <span className="tabular-nums">
                {t('sessions.attachments.usage', {
                  count: usage.fileCount,
                  maxFiles: usage.maxFiles,
                  used: formatBytes(usage.sizeBytes),
                  max: formatBytes(usage.maxSessionBytes),
                })}
              </span>
            )}
          </div>

          {pendingCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('sessions.attachments.blockingSend', { count: pendingCount })}
            </span>
          )}
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length > 0) onAttach(files, usage)
        }}
      />

      <InputGroup className="h-auto">
        {!expanded && <InputGroupAddon align="inline-start">{attachButton}</InputGroupAddon>}
        {textSurface}
        {!expanded && (
          <InputGroupAddon align="inline-end">
            {toggleButton}
            {stopButton}
            {sendButton}
          </InputGroupAddon>
        )}
        {expanded && (
          <InputGroupAddon align="block-end" className="justify-between">
            {attachButton}
            <span className="flex items-center gap-1">
              {toggleButton}
              {stopButton}
              {sendButton}
            </span>
          </InputGroupAddon>
        )}
      </InputGroup>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </footer>
  )
}
