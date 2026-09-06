import type { DragEvent, KeyboardEvent } from 'react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { formatBytes } from '@/features/system'
import { Alert, Button, Spinner, Stack, Textarea } from '@/shared/ui'
import type { AttachmentUpload, SessionFilesUsage } from '../hooks/use-session-files'
import styles from './composer.module.scss'

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

  return (
    <li className={styles.chip} data-status={upload.status}>
      <span className={styles.chipName} title={upload.file.name}>
        {upload.file.name}
      </span>
      <span className={styles.chipSize}>{formatBytes(upload.file.size)}</span>

      {upload.status === 'uploading' && (
        <progress className={styles.chipProgress} value={upload.progress} max={100}>
          {upload.progress}%
        </progress>
      )}

      {upload.status === 'error' && (
        <span className={styles.chipError}>
          {upload.precheckFailed
            ? t('sessions.attachments.tooLargeForSession')
            : apiErrorMessage(upload.error, t('sessions.attachments.uploadFailed'))}
        </span>
      )}

      <button
        type="button"
        className={styles.chipRemove}
        onClick={() => (upload.status === 'uploading' ? onCancel(upload.id) : onRemove(upload))}
        aria-label={
          upload.status === 'uploading'
            ? t('sessions.attachments.cancel', { name: upload.file.name })
            : t('sessions.attachments.remove', { name: upload.file.name })
        }
      >
        ✕
      </button>
    </li>
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
    <footer className={styles.composer}>
      <Stack gap={2}>
        {queueLine && <span className={styles.queueStatus}>{queueLine}</span>}

        {uploads.length > 0 && (
          <ul className={styles.chips}>
            {uploads.map((upload) => (
              <AttachmentChip
                key={upload.id}
                upload={upload}
                onCancel={onCancel}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}

        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target,
            not a control — the file input and its own button above are the
            operable, keyboard-reachable way to attach a file; dropping onto
            this row is a mouse-only convenience layered on top, same as every
            other drag-and-drop surface. */}
        <div className={styles.composerRow} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <input
            ref={fileInput}
            type="file"
            multiple
            className={styles.fileInput}
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
            size="sm"
            aria-label={t('sessions.attachments.attach')}
            onClick={() => fileInput.current?.click()}
          >
            📎
          </Button>
          <div className={styles.textareaWrap}>
            <Textarea
              value={value}
              autoresize
              rows={2}
              maxRows={8}
              resize="none"
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
          <span className={styles.queueStatus}>
            {t('sessions.attachments.blockingSend', { count: pendingCount })}
          </span>
        )}

        <div className={styles.usage}>
          {usagePending && <Spinner size="sm" label={t('common.loading')} />}
          {Boolean(usageError) && (
            <span className={styles.usageError}>
              {apiErrorMessage(usageError, t('sessions.attachments.usageLoadFailed'))}
            </span>
          )}
          {usage && (
            <span className={styles.usageText}>
              {t('sessions.attachments.usage', {
                count: usage.fileCount,
                maxFiles: usage.maxFiles,
                used: formatBytes(usage.sizeBytes),
                max: formatBytes(usage.maxSessionBytes),
              })}
            </span>
          )}
        </div>

        {orchestratorMissing && <Alert tone="warning">{t('sessions.needsOrchestrator')}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </Stack>
    </footer>
  )
}
