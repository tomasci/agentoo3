import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { formatBytes } from '@/features/system'
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Inline,
  PageHeader,
  Spinner,
  Stack,
} from '@/shared/ui'
import {
  type IdeaAsset,
  type IdeaAssetUpload,
  useDeleteIdeaAsset,
  useIdeaAssets,
  useIdeaAssetUploads,
} from '../hooks/use-idea-assets'
import { ideaAssetDownloadUrl } from '../lib/asset-url'
import styles from './idea-assets.module.scss'

const STATUS_TONE = { ready: 'neutral', missing: 'danger', unreadable: 'danger' } as const

function UploadChip({
  upload,
  onCancel,
  onDismiss,
}: {
  upload: IdeaAssetUpload
  onCancel: (id: string) => void
  onDismiss: (id: string) => void
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
            ? t('ideas.assets.tooLargeForIdea')
            : apiErrorMessage(upload.error, t('ideas.assets.uploadFailed'))}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => (upload.status === 'uploading' ? onCancel(upload.id) : onDismiss(upload.id))}
        aria-label={
          upload.status === 'uploading'
            ? t('ideas.assets.cancel', { name: upload.file.name })
            : t('ideas.assets.remove', { name: upload.file.name })
        }
      >
        ✕
      </Button>
    </li>
  )
}

function AssetRow({ asset, ideaId }: { asset: IdeaAsset; ideaId: string }) {
  const { t } = useTranslation()
  const remove = useDeleteIdeaAsset(ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <li className={styles.chip} data-status={asset.status}>
      {asset.status === 'ready' ? (
        <a
          className={styles.chipName}
          href={ideaAssetDownloadUrl(asset.id)}
          download={asset.originalFilename}
          title={asset.originalFilename}
        >
          {asset.originalFilename}
        </a>
      ) : (
        <span className={styles.chipName} title={asset.originalFilename}>
          {asset.originalFilename}
        </span>
      )}
      <span className={styles.chipSize}>{formatBytes(asset.sizeBytes)}</span>
      {asset.status !== 'ready' && (
        <Badge tone={STATUS_TONE[asset.status]}>{t(`ideas.assets.status.${asset.status}`)}</Badge>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirmDelete(true)}
        aria-label={t('ideas.assets.remove', { name: asset.originalFilename })}
      >
        ✕
      </Button>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ideas.assets.delete.title')}
        description={t('ideas.assets.delete.confirm', { name: asset.originalFilename })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { id: asset.id } }, { onSettled: () => setConfirmDelete(false) })
        }
      />
    </li>
  )
}

/** The idea's own file attachments — copied into the session's working
 * directory at handoff (this track's brief), never inlined into the
 * generated prompt itself (only their names and sizes are, per
 * `serialize.ts`'s asset manifest on the backend). */
export function IdeaAssets({ ideaId }: { ideaId: string }) {
  const { t } = useTranslation()
  const assets = useIdeaAssets(ideaId)
  const uploads = useIdeaAssetUploads(ideaId)
  const fileInput = useRef<HTMLInputElement>(null)

  const files = assets.data?.files ?? []
  const usage = assets.data?.usage

  // A finished upload is also, by then, a row in `files` above (the upload's
  // own `onSuccess` already invalidated the assets query) — cleared from the
  // transient tray the moment it lands so the same file never shows twice.
  useEffect(() => {
    const doneIds = uploads.uploads
      .filter((u) => u.status === 'uploaded')
      .map((u) => u.serverFile?.id)
      .filter((id): id is string => id !== undefined)
    if (doneIds.length > 0) uploads.clearSent(doneIds)
  }, [uploads.uploads, uploads.clearSent])

  return (
    <Card>
      <Stack gap={3}>
        <PageHeader
          level={2}
          title={t('ideas.assets.heading')}
          actions={
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className={styles.fileInput}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (picked.length > 0) uploads.attach(picked, usage)
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                {t('ideas.assets.attach')}
              </Button>
            </>
          }
        />

        {assets.isError && (
          <Alert tone="danger">{apiErrorMessage(assets.error, t('ideas.assets.loadFailed'))}</Alert>
        )}
        {assets.isPending && <Spinner label={t('common.loading')} block />}

        {!assets.isPending &&
          !assets.isError &&
          files.length === 0 &&
          uploads.uploads.length === 0 && <EmptyState size="sm" title={t('ideas.assets.empty')} />}

        {(files.length > 0 || uploads.uploads.length > 0) && (
          <ul className={styles.list}>
            {uploads.uploads.map((upload) => (
              <UploadChip
                key={upload.id}
                upload={upload}
                onCancel={uploads.cancel}
                onDismiss={uploads.dismiss}
              />
            ))}
            {files.map((asset) => (
              <AssetRow key={asset.id} asset={asset} ideaId={ideaId} />
            ))}
          </ul>
        )}

        {usage && (
          <Inline gap={2}>
            <span className={styles.usage}>
              {t('ideas.assets.usage', {
                count: usage.fileCount,
                maxFiles: usage.maxFiles,
                used: formatBytes(usage.sizeBytes),
                max: formatBytes(usage.maxIdeaBytes),
              })}
            </span>
          </Inline>
        )}
      </Stack>
    </Card>
  )
}
