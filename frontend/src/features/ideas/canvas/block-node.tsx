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
  Dialog,
  Markdown,
  type MenuAction,
  Textarea,
  toast,
} from '@/shared/ui'
import { type IdeaBlock, useDeleteIdeaBlock, useUpdateIdeaBlock } from '../hooks/use-idea-canvas'
import { ideaAssetDownloadUrl, isInlineImage } from '../lib/asset-url'
import { useIdeaCanvasActions } from './actions-context'
import styles from './nodes.module.scss'
import type { IdeaBlockNode } from './to-nodes'

/** Below this zoom, a `Textarea` renders too small to use — the click that
 * would start editing opens the shared `BlockDialog` (an Ark `Dialog`,
 * portalled to `document.body`) instead, which escapes the viewport
 * transform entirely rather than rendering a text field at 60% scale. */
const INLINE_EDIT_MIN_ZOOM = 0.6

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

/**
 * One image block's own canvas surface: a thumbnail that opens a full-size
 * `Dialog` lightbox — the same "known inline type, else a plain file chip"
 * split as `sessions/components/transcript.tsx`'s own `AttachmentItem`, keyed
 * off this feature's `assetsById` cache instead of a session's attachment
 * list. Editing stays reachable through the node's own ActionsMenu in every
 * branch, so a broken or non-image asset never traps the block with no way
 * to change what it points at.
 */
function ImageBlockBody({
  block,
  assetsById,
  onOpenEdit,
}: {
  block: Extract<IdeaBlock, { kind: 'image' }>
  assetsById: Map<string, { originalFilename: string; mimeType: string }>
  onOpenEdit: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Flips true only if the browser itself fails to load the thumbnail — a GC
  // race between the asset list and the download, say. Never trusted as the
  // sole signal an asset is gone; this only ever guards against a broken
  // `<img>`, same reasoning as `transcript.tsx`'s own `AttachmentItem`.
  const [broken, setBroken] = useState(false)
  const asset = assetsById.get(block.assetId)
  const url = ideaAssetDownloadUrl(block.assetId)

  if (asset && isInlineImage(asset.mimeType) && !broken) {
    const title = block.caption || asset.originalFilename
    return (
      <>
        <button
          type="button"
          className={`nodrag ${styles.imageThumbButton}`}
          onClick={() => setOpen(true)}
        >
          <img
            src={url}
            alt={title}
            className={styles.imageThumb}
            onError={() => setBroken(true)}
          />
        </button>
        {block.caption && <p className={styles.imageCaption}>{block.caption}</p>}
        <Dialog open={open} onOpenChange={setOpen} title={title} size="lg">
          <img src={url} alt={title} className={styles.imageFull} />
        </Dialog>
      </>
    )
  }

  return (
    <button
      type="button"
      aria-label={t('common.edit')}
      className={`nodrag ${styles.contentButton}`}
      onClick={onOpenEdit}
    >
      {asset?.originalFilename ?? block.assetId}
      {block.caption ? ` — ${block.caption}` : ''}
    </button>
  )
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
            // `key` is load-bearing, not decorative: React Flow keeps the same
            // `BlockNode` instance for the life of this node id, so editing an
            // image block to point at a different asset would otherwise leave
            // `ImageBlockBody`'s own `broken` state (set by a now-unrelated
            // asset's `<img>` failing to load) stuck `true` forever. Keying on
            // the asset id forces a fresh mount — and a fresh `broken` — every
            // time the block starts pointing somewhere else.
            <ImageBlockBody
              key={block.assetId}
              block={block}
              assetsById={assetsById}
              onOpenEdit={() => onEditBlock(block)}
            />
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
