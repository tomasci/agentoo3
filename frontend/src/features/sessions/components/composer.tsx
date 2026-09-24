import { PaperclipIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useRef } from 'react'
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
import { Button } from '@/shared/ui/button'
import { Progress } from '@/shared/ui/progress'
import { Spinner } from '@/shared/ui/spinner'
import { Textarea } from '@/shared/ui/textarea'
import type { AttachmentUpload, SessionFilesUsage } from '../hooks/use-session-files'

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

function AttachmentChip({
  upload,
  onCancel,
  onRemove,
}: {
  upload: AttachmentUpload
  onCancel: (id: string) => void
  onRemove: (upload: AttachmentUpload) => void
}) {
  const { t } = useTranslation()
  const state =
    upload.status === 'uploading' ? 'uploading' : upload.status === 'error' ? 'error' : 'done'

  return (
    <Attachment state={state} size="sm">
      <AttachmentMedia>
        <PaperclipIcon aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={upload.file.name}>{upload.file.name}</AttachmentTitle>
        <AttachmentDescription>
          {upload.status === 'error'
            ? upload.precheckFailed
              ? t('sessions.attachments.tooLargeForSession')
              : apiErrorMessage(upload.error, t('sessions.attachments.uploadFailed'))
            : formatBytes(upload.file.size)}
        </AttachmentDescription>
        {upload.status === 'uploading' && <Progress value={upload.progress} className="mt-1" />}
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          aria-label={
            upload.status === 'uploading'
              ? t('sessions.attachments.cancel', { name: upload.file.name })
              : t('sessions.attachments.remove', { name: upload.file.name })
          }
          onClick={() => (upload.status === 'uploading' ? onCancel(upload.id) : onRemove(upload))}
        >
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

/**
 * The message composer: text, attachments, send. Extracted from
 * `session-page.tsx` once attachments gave it enough of its own concerns
 * (attach button, drag-and-drop, paste, a chip tray, per-session usage) to
 * earn a file the way `transcript.tsx` already has one.
 *
 * `submit`/`text` stay owned by `SessionPage` — see its own comment on why
 * `text` clears the moment Enter is pressed rather than in `onSuccess` — this
 * component only renders them and the attachment tray built on top.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  sending,
  canSend,
  orchestratorMissing,
  queueLine,
  error,
  attachments,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  sending: boolean
  canSend: boolean
  orchestratorMissing: boolean
  queueLine: string
  error: string | null
  attachments: ComposerAttachments
}) {
  const { t } = useTranslation()
  const fileInput = useRef<HTMLInputElement>(null)
  const { uploads, usage, usagePending, usageError, pendingCount, onAttach, onCancel, onRemove } =
    attachments

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onAttach(files, usage)
  }

  return (
    <footer className="flex flex-col gap-2 border-t pt-2">
      {queueLine && <span className="text-xs text-muted-foreground">{queueLine}</span>}

      {uploads.length > 0 && (
        <AttachmentGroup>
          {uploads.map((upload) => (
            <AttachmentChip
              key={upload.id}
              upload={upload}
              onCancel={onCancel}
              onRemove={onRemove}
            />
          ))}
        </AttachmentGroup>
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target,
          not a control — the file input and its own button above are the
          operable, keyboard-reachable way to attach a file; dropping onto
          this row is a mouse-only convenience layered on top, same as every
          other drag-and-drop surface. */}
      <div className="flex items-end gap-2" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('sessions.attachments.attach')}
          onClick={() => fileInput.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <Textarea
            value={value}
            rows={2}
            className="max-h-48 resize-none"
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
        </div>
        <Button type="button" onClick={onSubmit} disabled={!canSend}>
          {sending ? t('sessions.sending') : t('sessions.send')}
        </Button>
      </div>

      {pendingCount > 0 && (
        <span className="text-xs text-muted-foreground">
          {t('sessions.attachments.blockingSend', { count: pendingCount })}
        </span>
      )}

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

      {orchestratorMissing && (
        <Alert role="status">
          <TriangleAlertIcon />
          <AlertDescription>{t('sessions.needsOrchestrator')}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </footer>
  )
}
