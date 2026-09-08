import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, ConfirmDialog, type MenuAction, toast } from '@/shared/ui'
import { type Idea, type IdeaStatus, useDeleteIdea, useMoveIdea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUSES } from '../lib/status'

/**
 * The one place a card moves from — board and detail both render this rather
 * than each wiring their own menu, confirm dialogs and mutations. One action
 * per status (`MenuAction.current` marks the column already occupied,
 * disabled so choosing it is a no-op rather than a same-status round trip),
 * plus delete.
 *
 * Move and delete failures go to a toast, not an inline `Alert`: there is no
 * form here for a block-level error to sit under (component-contract.md's
 * three error levels — Field/Block/Transient — and a menu selection is
 * squarely the transient case).
 */
export function IdeaActionsMenu({
  idea,
  projectId,
  showOpen,
  onDeleted,
}: {
  idea: Idea
  projectId: string
  /** The card offers "Open"; the detail page you are already on does not. */
  showOpen: boolean
  /** The detail page navigates back to the board once its own idea is gone. */
  onDeleted?: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const move = useMoveIdea(projectId)
  const remove = useDeleteIdea(projectId)
  const [pendingMove, setPendingMove] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const doMove = (status: IdeaStatus) => {
    move.mutate(
      { path: { id: idea.id }, body: { status } },
      {
        onError: (e) =>
          toast({ tone: 'danger', title: apiErrorMessage(e, t('ideas.move.failed')) }),
      },
    )
  }

  const actions: MenuAction[] = [
    ...(showOpen
      ? [
          {
            id: 'open',
            label: t('ideas.open'),
            onSelect: () =>
              void navigate({
                to: '/projects/$projectId/ideas/$ideaId',
                params: { projectId, ideaId: idea.id },
              }),
          },
        ]
      : []),
    ...IDEA_STATUSES.map((status) => ({
      id: `move-${status}`,
      label: t(IDEA_STATUS_I18N_KEY[status]),
      current: idea.status === status,
      disabled: idea.status === status,
      onSelect: () =>
        status === 'selected_for_development' ? setPendingMove(true) : doMove(status),
    })),
    {
      id: 'delete',
      label: t('common.delete'),
      destructive: true,
      onSelect: () => setConfirmDelete(true),
    },
  ]

  return (
    <>
      <ActionsMenu label={t('ideas.actionsFor', { title: idea.title })} actions={actions} />

      <ConfirmDialog
        open={pendingMove}
        onOpenChange={setPendingMove}
        title={t('ideas.move.selectForDevelopment.title')}
        description={t('ideas.move.selectForDevelopment.body')}
        confirmLabel={t('ideas.move.selectForDevelopment.confirm')}
        destructive={false}
        busy={move.isPending}
        onConfirm={() =>
          move.mutate(
            { path: { id: idea.id }, body: { status: 'selected_for_development' } },
            {
              onError: (e) =>
                toast({ tone: 'danger', title: apiErrorMessage(e, t('ideas.move.failed')) }),
              onSettled: () => setPendingMove(false),
            },
          )
        }
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ideas.delete.title')}
        description={t('ideas.delete.confirm', { title: idea.title })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { path: { id: idea.id } },
            {
              onSuccess: () => onDeleted?.(),
              onError: (e) =>
                toast({ tone: 'danger', title: apiErrorMessage(e, t('ideas.delete.failed')) }),
              onSettled: () => setConfirmDelete(false),
            },
          )
        }
      />
    </>
  )
}
