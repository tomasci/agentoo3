import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { getApiIdeasIdBlocksQueryKey } from '@/shared/api/generated/hooks/useGetApiIdeasIdBlocks'
import {
  ActionsMenu,
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Inline,
  Input,
  PageHeader,
  Select,
  type SelectOption,
  Spinner,
  Stack,
  Textarea,
} from '@/shared/ui'
import { useIdeaAssets } from '../hooks/use-idea-assets'
import {
  type IdeaBlock,
  type IdeaBlockKind,
  type IdeaGroup,
  useCreateIdeaBlock,
  useCreateIdeaGroup,
  useDeleteIdeaBlock,
  useDeleteIdeaGroup,
  useIdeaBlocks,
  useIdeaGroups,
  useUpdateIdeaBlock,
  useUpdateIdeaGroup,
} from '../hooks/use-idea-canvas'
import { blockLabel } from '../lib/block-label'
import { ideaBlockFormSchema } from '../model/idea-block.schema'
import styles from './idea-canvas.module.scss'

// ~60KB gzipped (the spatial canvas's own flow-graph dependency, confined to
// features/ideas/canvas per its own adapter) that a reader who never opens
// the Idea Manager should not have to pay for in the initial chunk — every
// other import above resolves to code this page always renders.
const IdeaFlowCanvas = lazy(() => import('../canvas/idea-flow-canvas'))

const BLOCK_KINDS: IdeaBlockKind[] = ['note', 'requirement', 'example', 'link', 'image']

// `seq` is allocated once at insert (`ideas.nextSeq`, backend `db/schema.ts`)
// and, since nothing left in this UI ever calls `POST /ideas/{id}/blocks/
// reorder`, is never mutated afterwards — so ascending `seq` is exactly
// creation order. The id tiebreaker only matters for two rows minted in the
// same request, where `seq` could tie.
const bySeq = <T extends { seq: number; id: string }>(a: T, b: T) =>
  a.seq - b.seq || a.id.localeCompare(b.id)

/** The shape a fresh add-block form starts from — one branch per kind, so
 * switching the kind selector always hands the rest of the form a value of
 * the right shape rather than carrying over a field the new kind has no use
 * for. */
function blankValuesFor(kind: IdeaBlockKind): Record<string, string> {
  switch (kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return { text: '' }
    case 'link':
      return { url: '', label: '' }
    case 'image':
      return { assetId: '', caption: '' }
  }
}

/**
 * Add or edit one block. Plain `useState` and a manual `safeParse` against
 * `ideaBlockFormSchema` on submit, not `react-hook-form`: that schema is a
 * discriminated union keyed on `kind`, and this form's `kind` selector
 * reshapes the rest of the fields out from under it every time it changes —
 * RHF's single `defaultValues` shape fights that more than it helps here,
 * where `create-project-form.tsx`'s single, unchanging schema shape is
 * exactly what RHF is good at.
 */
function BlockDialog({
  ideaId,
  open,
  onOpenChange,
  block,
  assetOptions,
  createPosition,
}: {
  ideaId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absent means "add"; present means "edit this one". */
  block?: IdeaBlock
  assetOptions: SelectOption[]
  /** Where the canvas's create-at-pointer command asked this block to land
   * (`idea-flow-canvas.tsx`'s `screenToFlowPosition`) — `null` for every
   * other way of opening this dialog (the header's own "Add block", or an
   * edit), which is why this only ever rides along on a *create* submit. */
  createPosition?: { x: number; y: number } | null
}) {
  const { t } = useTranslation()
  const isEdit = block !== undefined
  const create = useCreateIdeaBlock(ideaId)
  const update = useUpdateIdeaBlock(ideaId)
  const [kind, setKind] = useState<IdeaBlockKind>('note')
  const [values, setValues] = useState<Record<string, string>>(blankValuesFor('note'))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (block) {
      setKind(block.kind)
      setValues(
        block.kind === 'link'
          ? { url: block.url, label: block.label ?? '' }
          : block.kind === 'image'
            ? { assetId: block.assetId, caption: block.caption ?? '' }
            : { text: block.text },
      )
    } else {
      setKind('note')
      setValues(blankValuesFor('note'))
    }
    setFieldErrors({})
    setServerError(null)
  }, [open, block])

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }))

  const busy = create.isPending || update.isPending

  const submit = () => {
    const candidate: Record<string, unknown> =
      kind === 'link'
        ? { kind, url: values.url, ...(values.label?.trim() ? { label: values.label.trim() } : {}) }
        : kind === 'image'
          ? {
              kind,
              assetId: values.assetId,
              ...(values.caption?.trim() ? { caption: values.caption.trim() } : {}),
            }
          : { kind, text: values.text }

    const result = ideaBlockFormSchema.safeParse(candidate)
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors as Record<string, string[] | undefined>
      const next: Record<string, string> = {}
      for (const [field, messages] of Object.entries(flat)) {
        if (messages?.[0]) next[field] = t(messages[0])
      }
      setFieldErrors(next)
      return
    }
    setFieldErrors({})
    setServerError(null)

    const onError = (e: unknown) =>
      setServerError(
        apiErrorMessage(
          e,
          isEdit ? t('ideas.canvas.updateFailed') : t('ideas.canvas.createFailed'),
        ),
      )
    const onSuccess = () => onOpenChange(false)

    if (isEdit && block) {
      // `kind` never lands in a PATCH body — it cannot change what kind of
      // block this is, only its content — so it is dropped here rather than
      // sent as a field the server has no use for.
      const { kind: _kind, ...patchBody } = result.data
      update.mutate({ path: { id: block.id }, body: patchBody }, { onSuccess, onError })
    } else {
      const body = createPosition ? { ...result.data, ...createPosition } : result.data
      create.mutate({ path: { id: ideaId }, body }, { onSuccess, onError })
    }
  }

  const kindOptions: SelectOption[] = BLOCK_KINDS.map((k) => ({
    value: k,
    label: t(`ideas.canvas.kind.${k}`),
  }))

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('common.edit') : t('ideas.canvas.addBlock')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" loading={busy} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <Field label={t('ideas.canvas.block.kindLabel')}>
          <Select
            options={kindOptions}
            value={kind}
            disabled={isEdit}
            onValueChange={(value) => {
              const next = (value ?? 'note') as IdeaBlockKind
              setKind(next)
              setValues(blankValuesFor(next))
              setFieldErrors({})
            }}
          />
        </Field>

        {(kind === 'note' || kind === 'requirement' || kind === 'example') && (
          <Field label={t('ideas.canvas.block.textLabel')} error={fieldErrors.text}>
            <Textarea
              rows={4}
              value={values.text ?? ''}
              onChange={(e) => set('text', e.target.value)}
            />
          </Field>
        )}

        {kind === 'link' && (
          <>
            <Field label={t('ideas.canvas.block.urlLabel')} error={fieldErrors.url}>
              <Input mono value={values.url ?? ''} onChange={(e) => set('url', e.target.value)} />
            </Field>
            <Field label={t('ideas.canvas.block.labelLabel')} error={fieldErrors.label}>
              <Input value={values.label ?? ''} onChange={(e) => set('label', e.target.value)} />
            </Field>
          </>
        )}

        {kind === 'image' && (
          <>
            <Field label={t('ideas.canvas.block.assetLabel')} error={fieldErrors.assetId}>
              <Select
                options={assetOptions}
                value={values.assetId || null}
                placeholder={t('ideas.canvas.block.chooseAsset')}
                onValueChange={(value) => set('assetId', value ?? '')}
              />
            </Field>
            <Field label={t('ideas.canvas.block.captionLabel')} error={fieldErrors.caption}>
              <Input
                value={values.caption ?? ''}
                onChange={(e) => set('caption', e.target.value)}
              />
            </Field>
          </>
        )}

        {serverError && <Alert tone="danger">{serverError}</Alert>}
      </Stack>
    </Dialog>
  )
}

function GroupDialog({
  ideaId,
  open,
  onOpenChange,
  group,
}: {
  ideaId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absent means "add"; present means "rename this one". */
  group?: IdeaGroup
}) {
  const { t } = useTranslation()
  const isEdit = group !== undefined
  const create = useCreateIdeaGroup(ideaId)
  const update = useUpdateIdeaGroup(ideaId)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setTitle(group?.title ?? '')
    setError(null)
  }, [open, group])

  const busy = create.isPending || update.isPending

  const submit = () => {
    const value = title.trim()
    if (!value) return
    setError(null)
    const onSuccess = () => onOpenChange(false)
    const onError = (e: unknown) =>
      setError(
        apiErrorMessage(
          e,
          isEdit ? t('ideas.canvas.groupUpdateFailed') : t('ideas.canvas.groupCreateFailed'),
        ),
      )
    if (isEdit && group) {
      update.mutate({ path: { id: group.id }, body: { title: value } }, { onSuccess, onError })
    } else {
      create.mutate({ path: { id: ideaId }, body: { title: value } }, { onSuccess, onError })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('ideas.canvas.addGroup')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" loading={busy} disabled={!title.trim()} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <Field label={t('ideas.canvas.groupTitlePlaceholder')}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('ideas.canvas.groupTitlePlaceholder')}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </Stack>
    </Dialog>
  )
}

/**
 * One block's row in the structure explorer: a kind marker, its one-line
 * name (`blockLabel`), and an actions menu — never the block's own body, and
 * never more than the one line CSS (`styles.rowName`'s own ellipsis) allows.
 * The name doubles as the row's click target (`styles.rowButton`), which
 * reveals this block on the canvas pane the way clicking a file opens it in
 * an editor's tree; a real `<button>` is legal here (unlike `block-node.tsx`'s
 * own markdown surface) because this row's content is always plain text.
 */
function ExplorerBlockRow({
  block,
  ideaId,
  assetsById,
  onEdit,
  onReveal,
}: {
  block: IdeaBlock
  ideaId: string
  assetsById: Map<string, { originalFilename: string; mimeType: string }>
  onEdit: (block: IdeaBlock) => void
  onReveal: (blockId: string) => void
}) {
  const { t } = useTranslation()
  const remove = useDeleteIdeaBlock(ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const assetFilename =
    block.kind === 'image' ? assetsById.get(block.assetId)?.originalFilename : undefined
  // A block with nothing written into it yet (a fresh, still-empty note) has
  // no name of its own — the kind label is the only thing worth showing.
  const name = blockLabel(block, assetFilename) || t(`ideas.canvas.kind.${block.kind}`)

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        title={name}
        aria-label={t('ideas.canvas.explorer.reveal', { title: name })}
        onClick={() => onReveal(block.id)}
      >
        <Badge tone="neutral" variant="outline">
          {t(`ideas.canvas.kind.${block.kind}`)}
        </Badge>
        <span className={styles.rowName}>{name}</span>
      </button>
      <ActionsMenu
        label={t('ideas.actionsFor', { title: name })}
        actions={[
          { id: 'edit', label: t('common.edit'), onSelect: () => onEdit(block) },
          {
            id: 'delete',
            label: t('common.delete'),
            destructive: true,
            onSelect: () => setConfirmDelete(true),
          },
        ]}
      />
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
    </li>
  )
}

/**
 * One group's row: a folder, not a section heading — a collapse toggle (▸/▾,
 * expanded by default), the title, an actions menu, and its member blocks
 * nested underneath in their own `<ul>` when expanded. Never an `<ol>`: an
 * ordinal number is exactly what this pane no longer shows anywhere.
 */
function ExplorerGroupRow({
  group,
  blocks,
  ideaId,
  assetsById,
  onEditBlock,
  onReveal,
}: {
  group: IdeaGroup
  blocks: IdeaBlock[]
  ideaId: string
  assetsById: Map<string, { originalFilename: string; mimeType: string }>
  onEditBlock: (block: IdeaBlock) => void
  onReveal: (blockId: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const remove = useDeleteIdeaGroup(ideaId)
  const [expanded, setExpanded] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <li className={styles.groupItem}>
      <div className={styles.groupRow}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-label={t(
            expanded ? 'ideas.canvas.explorer.collapse' : 'ideas.canvas.explorer.expand',
            { title: group.title },
          )}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className={styles.groupTitle} title={group.title}>
          {group.title}
        </span>
        <ActionsMenu
          label={t('ideas.actionsFor', { title: group.title })}
          actions={[
            { id: 'edit', label: t('common.edit'), onSelect: () => setRenaming(true) },
            {
              id: 'delete',
              label: t('common.delete'),
              destructive: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      </div>

      {expanded && blocks.length > 0 && (
        <ul className={styles.sublist}>
          {blocks.map((block) => (
            <ExplorerBlockRow
              key={block.id}
              block={block}
              ideaId={ideaId}
              assetsById={assetsById}
              onEdit={onEditBlock}
              onReveal={onReveal}
            />
          ))}
        </ul>
      )}

      <GroupDialog ideaId={ideaId} open={renaming} onOpenChange={setRenaming} group={group} />
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
              // The server nulls `groupId` on this group's former members
              // (ideas.canvas.deleteGroup.confirm's own "kept, ungrouped"),
              // but `useDeleteIdeaGroup` (hooks/use-idea-canvas.ts) only
              // invalidates the groups list, not blocks — compensated for
              // here rather than in that file; see the report.
              onSuccess: () =>
                queryClient.invalidateQueries({
                  queryKey: getApiIdeasIdBlocksQueryKey({ path: { id: ideaId } }),
                }),
              onSettled: () => setConfirmDelete(false),
            },
          )
        }
      />
    </li>
  )
}

/**
 * The idea's canvas: a structure-only explorer — like an editor's file tree,
 * never a rendering of block contents — docked beside the spatial
 * drag-and-drop surface (`../canvas/idea-flow-canvas`, lazy-loaded — see the
 * report). Both read the same `blocks`/`groups` query data; only the
 * explorer is a phone's — `idea-canvas.module.scss`'s own `bp.up(sm)` hides
 * the canvas pane below that width rather than mounting a pan/zoom surface
 * on a 360px screen a finger cannot usefully drag around.
 *
 * Reading order — the one thing dragging on the canvas is not allowed to
 * change — follows `serializeIdea` on the backend exactly: ungrouped blocks
 * first (ascending `seq`), then each group in ascending `seq` with its own
 * members ascending by `seq` beneath it. `seq` itself is allocated once at
 * insert and never mutated afterwards (see `bySeq`'s own comment) — nothing
 * in this UI calls `POST /ideas/{id}/blocks/reorder` anymore, so that
 * reading order is simply creation order.
 *
 * Clicking a row reveals that block on the canvas pane (`reveal` state below,
 * passed to `IdeaFlowCanvas` — see its own comment on the prop), the way
 * clicking a file opens it in an editor's tree.
 */
export function IdeaCanvas({ ideaId }: { ideaId: string }) {
  const { t } = useTranslation()
  const blocks = useIdeaBlocks(ideaId)
  const groups = useIdeaGroups(ideaId)
  const assets = useIdeaAssets(ideaId)
  const [addingBlock, setAddingBlock] = useState(false)
  const [editingBlock, setEditingBlock] = useState<IdeaBlock | undefined>(undefined)
  const [createPosition, setCreatePosition] = useState<{ x: number; y: number } | null>(null)
  const [addingGroup, setAddingGroup] = useState(false)
  const [renamingGroupViaCanvas, setRenamingGroupViaCanvas] = useState<IdeaGroup | undefined>(
    undefined,
  )
  const [reveal, setReveal] = useState<{ blockId: string; nonce: number } | null>(null)
  // A plain counter rather than deriving the nonce from `reveal` itself: a
  // fresh object every click (even for the same block twice in a row) is
  // what makes `IdeaFlowCanvas`'s own effect re-fire and re-center.
  const revealNonce = useRef(0)
  const revealBlock = (blockId: string) => {
    revealNonce.current += 1
    setReveal({ blockId, nonce: revealNonce.current })
  }

  const isPending = blocks.isPending || groups.isPending
  const isError = blocks.isError || groups.isError

  // Memoised on the query data itself (a stable reference from react-query
  // until it actually refetches), not derived fresh every render: these three
  // are exactly what `IdeaFlowCanvas`'s own node-rebuild effect depends on
  // (`idea-flow-canvas.tsx`), and an unstable reference here used to rebuild
  // its canvas nodes — discarding selection and any unpersisted local node
  // state — on every keystroke typed anywhere else on this page, and made
  // the `reveal` effect (also keyed on that same rebuilt `nodes` state)
  // re-fire and snap the viewport back on every one of those renders too.
  const allBlocks = useMemo(() => blocks.data ?? [], [blocks.data])
  const allGroups = useMemo(() => [...(groups.data ?? [])].sort(bySeq), [groups.data])
  const ungrouped = useMemo(
    () => allBlocks.filter((b) => b.groupId === null).sort(bySeq),
    [allBlocks],
  )
  const membersOf = (groupId: string) => allBlocks.filter((b) => b.groupId === groupId).sort(bySeq)

  const readyAssets = useMemo(
    () => (assets.data?.files ?? []).filter((f) => f.status === 'ready'),
    [assets.data],
  )
  const assetsById = useMemo(
    () =>
      new Map(
        readyAssets.map((f) => [
          f.id,
          { originalFilename: f.originalFilename, mimeType: f.mimeType },
        ]),
      ),
    [readyAssets],
  )
  const assetOptions: SelectOption[] = useMemo(
    () => readyAssets.map((f) => ({ value: f.id, label: f.originalFilename })),
    [readyAssets],
  )

  const total = allBlocks.length + allGroups.length
  const editorBlock = editingBlock !== undefined
  const blockDialogOpen = addingBlock || editorBlock

  const closeBlockDialog = (open: boolean) => {
    if (open) return
    setAddingBlock(false)
    setEditingBlock(undefined)
    setCreatePosition(null)
  }

  return (
    <Stack gap={3}>
      <PageHeader
        level={2}
        title={t('ideas.canvas.heading')}
        actions={
          <Inline gap={2}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAddingBlock(true)}
            >
              {t('ideas.canvas.addBlock')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAddingGroup(true)}
            >
              {t('ideas.canvas.addGroup')}
            </Button>
          </Inline>
        }
      />

      {isError && (
        <Alert tone="danger">
          {apiErrorMessage(blocks.error ?? groups.error, t('ideas.canvas.loadFailed'))}
        </Alert>
      )}
      {isPending && <Spinner label={t('common.loading')} block />}

      {!isPending && !isError && total === 0 && (
        <EmptyState size="sm" title={t('ideas.canvas.empty')} />
      )}

      {!isPending && !isError && total > 0 && (
        <div className={styles.layout}>
          <div className={styles.listPane}>
            <ul className={styles.tree}>
              {ungrouped.map((block) => (
                <ExplorerBlockRow
                  key={block.id}
                  block={block}
                  ideaId={ideaId}
                  assetsById={assetsById}
                  onEdit={setEditingBlock}
                  onReveal={revealBlock}
                />
              ))}
              {allGroups.map((group) => (
                <ExplorerGroupRow
                  key={group.id}
                  group={group}
                  blocks={membersOf(group.id)}
                  ideaId={ideaId}
                  assetsById={assetsById}
                  onEditBlock={setEditingBlock}
                  onReveal={revealBlock}
                />
              ))}
            </ul>
          </div>

          <div className={styles.canvasPane}>
            <Suspense fallback={<Spinner label={t('common.loading')} block />}>
              <IdeaFlowCanvas
                ideaId={ideaId}
                blocks={allBlocks}
                groups={allGroups}
                assetsById={assetsById}
                onEditBlock={setEditingBlock}
                onRenameGroup={setRenamingGroupViaCanvas}
                onCreateBlockAt={(position) => {
                  setCreatePosition(position)
                  setAddingBlock(true)
                }}
                reveal={reveal}
              />
            </Suspense>
          </div>
        </div>
      )}

      <BlockDialog
        ideaId={ideaId}
        open={blockDialogOpen}
        onOpenChange={closeBlockDialog}
        block={editingBlock}
        assetOptions={assetOptions}
        createPosition={editorBlock ? null : createPosition}
      />

      <GroupDialog ideaId={ideaId} open={addingGroup} onOpenChange={setAddingGroup} />
      <GroupDialog
        ideaId={ideaId}
        open={renamingGroupViaCanvas !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenamingGroupViaCanvas(undefined)
        }}
        group={renamingGroupViaCanvas}
      />
    </Stack>
  )
}
