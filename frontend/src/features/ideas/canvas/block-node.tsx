import type { NodeProps } from '@xyflow/react'
import { useViewport } from '@xyflow/react'
import { type KeyboardEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Markdown,
  type MenuAction,
  Textarea,
  toast,
} from '@/shared/ui'
import { useDeleteIdeaBlock, useUpdateIdeaBlock } from '../hooks/use-idea-canvas'
import { useIdeaCanvasActions } from './actions-context'
import styles from './nodes.module.scss'
import type { IdeaBlockNode } from './to-nodes'

/** Below this zoom, a `Textarea` renders too small to use — the click that
 * would start editing opens the shared `BlockDialog` (an Ark `Dialog`,
 * portalled to `document.body`) instead, which escapes the viewport
 * transform entirely rather than rendering a text field at 60% scale. */
const INLINE_EDIT_MIN_ZOOM = 0.6

/** Per click, in canvas units (not pixels — these move with zoom). Plain
 * enough to feel like a keyboard nudge without a settings surface for it. */
const NUDGE_STEP = 24

const TEXT_KINDS = new Set(['note', 'requirement', 'example'])

/** A `<button>` cannot legally contain `Markdown`'s block-level output (a
 * `<p>`, a `<table>`, …), so the click/keyboard-activatable read surface is a
 * plain `div` with the button role wired on by hand rather than a real
 * `<button>` — same reasoning `ideas.canvas.block`'s dialog form never
 * needed, since nothing there renders rich content inline. */
function onActivateKeyDown(event: KeyboardEvent, activate: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activate()
  }
}

export function BlockNode({ data, selected }: NodeProps<IdeaBlockNode>) {
  const { block, assetsById } = data
  const { t } = useTranslation()
  const { onEditBlock, groupsById } = useIdeaCanvasActions()
  const { zoom } = useViewport()
  const update = useUpdateIdeaBlock(block.ideaId)
  const remove = useDeleteIdeaBlock(block.ideaId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const isTextKind = TEXT_KINDS.has(block.kind)
  const canInlineEdit = isTextKind && zoom >= INLINE_EDIT_MIN_ZOOM

  const activateContent = () => {
    if (
      canInlineEdit &&
      (block.kind === 'note' || block.kind === 'requirement' || block.kind === 'example')
    ) {
      setDraft(block.text)
      setEditing(true)
      return
    }
    onEditBlock(block)
  }

  const commitInlineEdit = () => {
    if (block.kind !== 'note' && block.kind !== 'requirement' && block.kind !== 'example') return
    const text = draft.trim()
    if (!text) return
    update.mutate(
      { path: { id: block.id }, body: { text } },
      {
        onSuccess: () => setEditing(false),
        // The draft is left exactly as typed on failure — `editing` stays
        // true — so a network error costs a retry, not the words already
        // written (the same principle `idea-canvas.tsx`'s `BlockDialog`
        // follows for its own server errors).
        onError: (e) =>
          toast({ tone: 'danger', title: apiErrorMessage(e, t('ideas.canvas.updateFailed')) }),
      },
    )
  }

  const nudge = (dx: number, dy: number) => {
    update.mutate(
      { path: { id: block.id }, body: { x: block.x + dx, y: block.y + dy } },
      {
        onError: (e) =>
          toast({ tone: 'danger', title: apiErrorMessage(e, t('ideas.canvas.updateFailed')) }),
      },
    )
  }

  const removeFromGroup = () => {
    if (!block.groupId) return
    const group = groupsById.get(block.groupId)
    if (!group) return
    // Converts this block's stored relative-to-group (x, y) back to an
    // absolute canvas position — the inverse of `to-nodes.ts`'s own
    // convention — since leaving the group also leaves that coordinate
    // space, and nothing else does this conversion for a menu-triggered
    // (not drag-ended) change.
    update.mutate({
      path: { id: block.id },
      body: { groupId: null, x: block.x + group.x, y: block.y + group.y },
    })
  }

  const actions: MenuAction[] = [
    { id: 'edit', label: t('common.edit'), onSelect: () => onEditBlock(block) },
    ...(block.groupId
      ? [
          {
            id: 'remove-from-group',
            label: t('ideas.canvas.flow.removeFromGroup'),
            onSelect: removeFromGroup,
          },
        ]
      : []),
    {
      id: 'delete',
      label: t('common.delete'),
      destructive: true,
      onSelect: () => setConfirmDelete(true),
    },
  ]

  return (
    <div className={styles.root} data-selected={selected || undefined}>
      <span className={styles.orderBadge}>
        <Badge tone="neutral" variant="outline">
          #{block.seq}
        </Badge>
      </span>

      <Card padding="sm">
        <div className={styles.header}>
          <Badge tone="accent" variant="soft">
            {t(`ideas.canvas.kind.${block.kind}`)}
          </Badge>
          <div className="nodrag">
            <ActionsMenu label={t('ideas.actionsFor', { title: block.kind })} actions={actions} />
          </div>
        </div>

        <div className={styles.body}>
          {block.kind === 'link' && (
            <div className="nodrag">
              <a href={block.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
                {block.label || block.url}
              </a>
            </div>
          )}

          {block.kind === 'image' && (
            <button
              type="button"
              aria-label={t('common.edit')}
              className={`nodrag ${styles.contentButton}`}
              onClick={activateContent}
            >
              {assetsById.get(block.assetId)?.originalFilename ?? block.assetId}
              {block.caption ? ` — ${block.caption}` : ''}
            </button>
          )}

          {isTextKind && !editing && block.kind !== 'link' && block.kind !== 'image' && (
            /* biome-ignore lint/a11y/useSemanticElements: a real <button> cannot
               legally contain Markdown's block-level output (a <p>, a <table>, …);
               role/tabIndex/onKeyDown below reproduce a button's keyboard contract
               by hand instead. */
            <div
              role="button"
              tabIndex={0}
              aria-label={t('common.edit')}
              className={`nodrag nowheel ${styles.contentButton} ${styles.contentScroll}`}
              onClick={activateContent}
              onKeyDown={(e) => onActivateKeyDown(e, activateContent)}
            >
              <Markdown compact>{block.text}</Markdown>
            </div>
          )}

          {isTextKind && editing && (
            <div className="nodrag">
              <Textarea
                rows={3}
                maxRows={8}
                autoresize
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className={styles.editActions}>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={update.isPending}
                  onClick={commitInlineEdit}
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
          )}
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
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ideas.canvas.deleteBlock.title')}
        description={t('ideas.canvas.deleteBlock.confirm')}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { id: block.id } }, { onSettled: () => setConfirmDelete(false) })
        }
      />
    </div>
  )
}
