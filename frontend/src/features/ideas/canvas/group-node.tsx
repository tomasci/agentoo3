import { useQueryClient } from '@tanstack/react-query'
import type { NodeProps } from '@xyflow/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiIdeasIdBlocksQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import { ActionsMenu, ConfirmDialog, type MenuAction } from '@/shared/ui'
import { useDeleteIdeaGroup, useUpdateIdeaGroup } from '../hooks/use-idea-canvas'
import { useIdeaCanvasActions } from './actions-context'
import styles from './nodes.module.scss'
import type { IdeaGroupNode } from './to-nodes'

/** Same per-click distance as `block-node.tsx`'s own nudge — kept in sync by
 * eye rather than shared, since sharing a one-line constant across two files
 * for this is not worth the import. */
const NUDGE_STEP = 24

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
  const update = useUpdateIdeaGroup(group.ideaId)
  const remove = useDeleteIdeaGroup(group.ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const nudge = (dx: number, dy: number) => {
    update.mutate({ path: { id: group.id }, body: { x: group.x + dx, y: group.y + dy } })
  }

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

      <div className={`nodrag ${styles.nudgeRow}`}>
        <button
          type="button"
          aria-label={t('ideas.canvas.flow.nudge.up')}
          onClick={() => nudge(0, -NUDGE_STEP)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={t('ideas.canvas.flow.nudge.down')}
          onClick={() => nudge(0, NUDGE_STEP)}
        >
          ↓
        </button>
        <button
          type="button"
          aria-label={t('ideas.canvas.flow.nudge.left')}
          onClick={() => nudge(-NUDGE_STEP, 0)}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={t('ideas.canvas.flow.nudge.right')}
          onClick={() => nudge(NUDGE_STEP, 0)}
        >
          →
        </button>
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
              // Same compensation `idea-canvas.tsx`'s own `GroupSection` applies:
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
