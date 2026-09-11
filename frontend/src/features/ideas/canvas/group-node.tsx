import { useQueryClient } from '@tanstack/react-query'
import type { NodeProps } from '@xyflow/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiIdeasIdBlocksQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import { ActionsMenu, ConfirmDialog, type MenuAction } from '@/shared/ui'
import { useDeleteIdeaGroup } from '../hooks/use-idea-canvas'
import { useIdeaCanvasActions } from './actions-context'
import styles from './nodes.module.scss'
import type { IdeaGroupNode } from './to-nodes'

/**
 * The container a block gets dropped into (`to-nodes.ts`'s `parentId` +
 * `extent: 'parent'`) and, downstream, a heading in the generated prompt —
 * nothing here renders its own members: React Flow already renders every
 * block node with this group as `parentId` on top of it, in document order
 * (`to-nodes.ts`'s `buildIdeaCanvasNodes` places every group node before any
 * block), so this component owns only the frame and the title bar.
 */
export function GroupNode({ data }: NodeProps<IdeaGroupNode>) {
  const { group } = data
  const { t } = useTranslation()
  const { onRenameGroup } = useIdeaCanvasActions()
  const queryClient = useQueryClient()
  const remove = useDeleteIdeaGroup(group.ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const actions: MenuAction[] = [
    { id: 'rename', label: t('common.edit'), onSelect: () => onRenameGroup(group) },
    {
      id: 'delete',
      label: t('common.delete'),
      destructive: true,
      onSelect: () => setConfirmDelete(true),
    },
  ]

  return (
    <div className={styles.groupRoot}>
      <div className={styles.groupHeader}>
        <span className={styles.groupTitle}>{group.title}</span>
        <div className="nodrag">
          <ActionsMenu label={t('ideas.actionsFor', { title: group.title })} actions={actions} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ideas.canvas.deleteGroup.title')}
        description={t('ideas.canvas.deleteGroup.confirm', { title: group.title })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { path: { id: group.id } },
            {
              // Same compensation `idea-canvas.tsx`'s own explorer applies:
              // the server nulls `groupId` on this group's former members, but
              // `useDeleteIdeaGroup` only invalidates the groups list.
              onSuccess: () =>
                queryClient.invalidateQueries({
                  queryKey: getApiIdeasIdBlocksQueryKey({ path: { id: group.ideaId } }),
                }),
              onSettled: () => setConfirmDelete(false),
            },
          )
        }
      />
    </div>
  )
}
