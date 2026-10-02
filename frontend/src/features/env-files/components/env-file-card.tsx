import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ConfirmDialog, toast } from '@/shared/components'
import { Button } from '@/shared/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Spinner } from '@/shared/ui/spinner'
import { Textarea } from '@/shared/ui/textarea'
import { type EnvFile, useDeleteEnvFile, usePutEnvFile } from '../hooks/use-env-files'
import { formatFileSize, formatUpdatedAt } from '../lib/format'

interface EnvFileCardProps {
  projectId: string
  file: EnvFile
  /** Attaches this card's root node so the page can scroll/focus it — see
   * env-files-page.tsx's `nodes` ref. */
  cardRef: (node: HTMLDivElement | null) => void
}

/**
 * One stored file: its path, size and last-saved time, and a textarea that
 * edits it.
 *
 * `draft` starts from `file.content` but is never resynced from it after
 * that — keyed by `file.path` (env-files-page.tsx's `key={file.path}` on the
 * list), so this component instance, and the draft state inside it, survives
 * the list refetching after some *other* file is saved. A save of *this*
 * file does not need to resync `draft` either: the content it just saved and
 * the content the refetch answers back with are the same string.
 */
export function EnvFileCard({ projectId, file, cardRef }: EnvFileCardProps) {
  const { t } = useTranslation()
  const put = usePutEnvFile(projectId)
  const del = useDeleteEnvFile(projectId)
  const [draft, setDraft] = useState(file.content)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirty = draft !== file.content

  const save = () => {
    if (!dirty || put.isPending) return
    put.mutate(
      { path: { id: projectId }, body: { path: file.path, content: draft } },
      {
        onSuccess: () =>
          toast.add({ title: t('envFiles.card.saved', { path: file.path }), type: 'success' }),
        onError: (error) =>
          toast.add({
            title: apiErrorMessage(error, t('envFiles.card.saveFailed')),
            type: 'error',
          }),
      },
    )
  }

  const remove = () => {
    del.mutate(
      { path: { id: projectId }, query: { path: file.path } },
      {
        onSuccess: () =>
          toast.add({ title: t('envFiles.card.deleted', { path: file.path }), type: 'success' }),
        onError: (error) =>
          toast.add({
            title: apiErrorMessage(error, t('envFiles.card.deleteFailed')),
            type: 'error',
          }),
        onSettled: () => setConfirmDelete(false),
      },
    )
  }

  const updatedAt = formatUpdatedAt(file.updatedAt)

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <CardTitle className="truncate font-mono text-sm font-normal">{file.path}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {updatedAt
            ? t('envFiles.card.meta', { size: formatFileSize(file.size), updatedAt })
            : formatFileSize(file.size)}
        </p>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              save()
            }
          }}
          rows={6}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
          aria-label={t('envFiles.card.contentLabel', { path: file.path })}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={!dirty || put.isPending} onClick={save}>
            {put.isPending && <Spinner data-icon="inline-start" />}
            {t('common.save')}
          </Button>
          {dirty && !put.isPending && (
            <span className="text-xs text-muted-foreground">{t('envFiles.card.unsaved')}</span>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('envFiles.card.deleteConfirmTitle')}
        description={t('envFiles.card.deleteConfirmBody', { path: file.path })}
        busy={del.isPending}
        onConfirm={remove}
      />
    </Card>
  )
}
