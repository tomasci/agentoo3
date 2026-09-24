import { useQueryClient } from '@tanstack/react-query'
import type { NodeProps } from '@xyflow/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiIdeasIdBlocksQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import { ActionsMenu, ConfirmDialog, type MenuAction } from '@/shared/components'
import { Card, CardAction, CardHeader, CardTitle } from '@/shared/ui/card'
import { useDeleteIdeaGroup } from '../hooks/use-idea-canvas'
import { useIdeaCanvasActions } from './actions-context'
import type { IdeaGroupNode } from './to-nodes'

/**
 * The container a block gets dropped into (`to-nodes.ts`'s `parentId` +
 * `extent: 'parent'`) and, downstream, a heading in the generated prompt —
 * nothing here renders its own members: React Flow already renders every
 * block node with this group as `parentId` on top of it, in document order
 * (`to-nodes.ts`'s `buildIdeaCanvasNodes` places every group node before any
 * block), so this component owns only the frame and the title bar. Fixed at
 * `DEFAULT_GROUP_WIDTH`/`DEFAULT_GROUP_HEIGHT` (`to-nodes.ts`) since no
 * resize control exists in this track.
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
    <>
      <Card size="sm" className="h-64 w-104 border-2 border-dashed bg-muted/40">
        {/* `CardHeader` + `CardAction` (the same pairing `block-node.tsx`'s own
            header and `session-card.tsx` use) rather than a manual flex
            override: only a `CardAction` child switches `CardHeader`'s grid
            into the two-column, title-beside-actions layout
            (`ui/card.tsx`'s `has-data-[slot=card-action]`). */}
        <CardHeader>
          <CardTitle className="min-w-0 truncate" title={group.title}>
            {group.title}
          </CardTitle>
          <CardAction>
            <div className="nodrag">
              <ActionsMenu
                label={t('ideas.actionsFor', { title: group.title })}
                actions={actions}
              />
            </div>
          </CardAction>
        </CardHeader>
      </Card>

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
    </>
  )
}
