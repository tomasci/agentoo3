import { CircleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { formatBytes } from '@/features/system'
import { ConfirmDialog, Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/shared/ui/attachment'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Progress } from '@/shared/ui/progress'
import {
  type IdeaAsset,
  type IdeaAssetUpload,
  useDeleteIdeaAsset,
  useIdeaAssets,
  useIdeaAssetUploads,
} from '../hooks/use-idea-assets'
import { ideaAssetDownloadUrl } from '../lib/asset-url'

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
  // `Attachment`'s own `state` vocabulary ('idle'/'uploading'/'processing'/
  // 'error'/'done') is a superset of this upload's three-value status —
  // 'uploaded' maps to 'done' for the brief instant before the tray clears it
  // (see `IdeaAssets`'s own effect below).
  const state =
    upload.status === 'uploading' ? 'uploading' : upload.status === 'error' ? 'error' : 'done'

  return (
    <li>
      <Attachment state={state} className="w-full">
        <AttachmentContent>
          <AttachmentTitle>{upload.file.name}</AttachmentTitle>
          <AttachmentDescription>
            {upload.status === 'error'
              ? upload.precheckFailed
                ? t('ideas.assets.tooLargeForIdea')
                : apiErrorMessage(upload.error, t('ideas.assets.uploadFailed'))
              : formatBytes(upload.file.size)}
          </AttachmentDescription>
          {upload.status === 'uploading' && <Progress value={upload.progress} className="mt-1.5" />}
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction
            aria-label={
              upload.status === 'uploading'
                ? t('ideas.assets.cancel', { name: upload.file.name })
                : t('ideas.assets.remove', { name: upload.file.name })
            }
            onClick={() =>
              upload.status === 'uploading' ? onCancel(upload.id) : onDismiss(upload.id)
            }
          >
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      </Attachment>
    </li>
  )
}

function AssetRow({ asset, ideaId }: { asset: IdeaAsset; ideaId: string }) {
  const { t } = useTranslation()
  const remove = useDeleteIdeaAsset(ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ready = asset.status === 'ready'

  return (
    <li>
      <Attachment state={ready ? 'done' : 'error'} className="w-full">
        {ready && (
          <AttachmentTrigger
            render={<a href={ideaAssetDownloadUrl(asset.id)} download={asset.originalFilename} />}
            aria-label={asset.originalFilename}
          />
        )}
        <AttachmentContent>
          <AttachmentTitle>{asset.originalFilename}</AttachmentTitle>
          <AttachmentDescription>
            {formatBytes(asset.sizeBytes)}
            {!ready && ` · ${t(`ideas.assets.status.${asset.status}`)}`}
          </AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction
            aria-label={t('ideas.assets.remove', { name: asset.originalFilename })}
            onClick={() => setConfirmDelete(true)}
          >
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      </Attachment>

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
      <CardContent className="flex flex-col gap-3">
        <PageHeader
          level={2}
          title={t('ideas.assets.heading')}
          actions={
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
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
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                {t('ideas.assets.attach')}
              </Button>
            </>
          }
        />

        {assets.isError && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {apiErrorMessage(assets.error, t('ideas.assets.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {assets.isPending && <Loading label={t('common.loading')} block />}

        {!assets.isPending &&
          !assets.isError &&
          files.length === 0 &&
          uploads.uploads.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('ideas.assets.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

        {(files.length > 0 || uploads.uploads.length > 0) && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
          <span className="text-xs text-muted-foreground">
            {t('ideas.assets.usage', {
              count: usage.fileCount,
              maxFiles: usage.maxFiles,
              used: formatBytes(usage.sizeBytes),
              max: formatBytes(usage.maxIdeaBytes),
            })}
          </span>
        )}
      </CardContent>
    </Card>
  )
}
