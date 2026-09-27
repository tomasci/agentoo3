import { CornerDownLeftIcon, FileIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { formatBytes } from '@/features/system'
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
 * `submit`/`text` stay owned by `SessionPage` — see its own comment on why
 * `text` clears the moment Enter is pressed rather than in `onSuccess` — this
 * component only renders them and the attachment tray built on top.
 */
export function Composer({
  sessionId,
  value,
  onChange,
  onSubmit,
  onKeyDown,
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
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
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
  const fileInput = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { uploads, usage, usagePending, usageError, pendingCount, onAttach, onCancel, onRemove } =
    attachments

  // Whether the box has grown past one line — a literal newline, or wrapped
  // text — and switched to the expanded layout (full-width textarea, +/send
  // moved to a row underneath). `singleLineHeight` is the one-line baseline
  // this compares against, captured (and recaptured, every time the box goes
  // back to empty) from the textarea's own `clientHeight`.
  const [expanded, setExpanded] = useState(false)
  const singleLineHeight = useRef<number | null>(null)

  // Keyed on `value` rather than checked inside the textarea's own
  // `onChange`: by the time this effect runs the DOM node's layout already
  // reflects the just-committed value on every browser, which a raw event
  // handler reading the same node mid-event cannot promise.
  //
  // Two independent signs of "wrapped", not one, because which one fires
  // depends on the browser: where CSS `field-sizing: content` is supported
  // (`shared/ui/textarea.tsx`) the element grows to fit its content and never
  // overflows, so a real wrap only ever shows up as `clientHeight` growing
  // past the one-line baseline; where it is not supported, the element stays
  // fixed at that baseline and a real wrap instead overflows it, which
  // `scrollHeight > clientHeight` catches. Neither is ever true for one
  // ordinary line, in either browser.
  //
  // Sticky once true — checked before either measurement fires, and cleared
  // only by the `value === ''` branch above it — because expanding widens
  // the textarea, which can make the very same text fit back on one line.
  // Without this, that would immediately collapse it again: a resize loop
  // the reader would see as the box breathing in and out while they type.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (value === '') {
      setExpanded(false)
      singleLineHeight.current = el.clientHeight
      return
    }
    if (expanded) return
    if (value.includes('\n')) {
      setExpanded(true)
      return
    }
    if (singleLineHeight.current === null) singleLineHeight.current = el.clientHeight
    if (el.scrollHeight > el.clientHeight || el.clientHeight > singleLineHeight.current + 1) {
      setExpanded(true)
    }
  }, [value, expanded])

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onAttach(files, usage)
  }

  const showSend = value.trim().length > 0 || sending

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

      <InputGroup>
        {!expanded && <InputGroupAddon align="inline-start">{attachButton}</InputGroupAddon>}
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
          onKeyDown={onKeyDown}
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
        {!expanded && (showSend || canStop) && (
          <InputGroupAddon align="inline-end">
            {stopButton}
            {sendButton}
          </InputGroupAddon>
        )}
        {expanded && (
          <InputGroupAddon align="block-end" className="justify-between">
            {attachButton}
            <span className="flex items-center gap-1">
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
