import '@xyflow/react/dist/base.css'
import './idea-canvas-theme.scss'

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type NodeChange,
  type OnNodeDrag,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button, toast } from '@/shared/ui'
import type { IdeaBlock, IdeaGroup } from '../hooks/use-idea-canvas'
import { useUpdateIdeaBlock, useUpdateIdeaGroup } from '../hooks/use-idea-canvas'
import { IdeaCanvasActionsProvider } from './actions-context'
import { BlockNode } from './block-node'
import { GroupNode } from './group-node'
import styles from './idea-flow-canvas.module.scss'
import {
  absolutePositionOf,
  BLOCK_NODE_TYPE,
  buildIdeaCanvasNodes,
  GROUP_NODE_TYPE,
  type IdeaBlockNode,
  type IdeaCanvasNode,
  resolveDragStopPatch,
} from './to-nodes'
import { useReorderIdeaBlocks } from './use-reorder-idea-blocks'

const NODE_TYPES = { [BLOCK_NODE_TYPE]: BlockNode, [GROUP_NODE_TYPE]: GroupNode }

export interface IdeaFlowCanvasProps {
  ideaId: string
  blocks: IdeaBlock[]
  groups: IdeaGroup[]
  assetsById: Map<string, { originalFilename: string }>
  onEditBlock: (block: IdeaBlock) => void
  onRenameGroup: (group: IdeaGroup) => void
  onCreateBlockAt: (position: { x: number; y: number }) => void
  /** Real usage never overrides either: both default to `true`. The render
   * smoke test (`idea-flow-canvas.test.tsx`) sets both `false` — d3-drag,
   * which node dragging and pane panning are both built on, needs real
   * `getBoundingClientRect` layout that happy-dom does not provide. */
  nodesDraggable?: boolean
  panOnDrag?: boolean
}

function IdeaFlowCanvasInner({
  ideaId,
  blocks,
  groups,
  assetsById,
  onEditBlock,
  onRenameGroup,
  onCreateBlockAt,
  nodesDraggable = true,
  panOnDrag = true,
}: IdeaFlowCanvasProps) {
  const { t } = useTranslation()
  const { screenToFlowPosition } = useReactFlow<IdeaCanvasNode>()
  const updateBlock = useUpdateIdeaBlock(ideaId)
  const updateGroup = useUpdateIdeaGroup(ideaId)
  const reorder = useReorderIdeaBlocks(ideaId)

  const [nodes, setNodes] = useState<IdeaCanvasNode[]>([])

  // Postgres is the truth; this array is authoritative only for the
  // duration of a drag (see the report). Neither `blocks` nor `groups`
  // polls (`hooks/use-idea-canvas.ts`'s own comment), so this only re-fires
  // when a mutation this canvas itself made invalidates one of them — never
  // mid-drag from an unrelated background refetch.
  useEffect(() => {
    setNodes(buildIdeaCanvasNodes(blocks, groups, assetsById))
  }, [blocks, groups, assetsById])

  const blocksById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks])

  const onNodesChange = useCallback((changes: NodeChange<IdeaCanvasNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const onNodeDragStop: OnNodeDrag<IdeaCanvasNode> = useCallback(
    (_event, node) => {
      const nodesById = new Map(nodes.map((n) => [n.id, n]))
      const patch = resolveDragStopPatch(node, blocksById, nodesById)
      if (!patch) return

      if (patch.target === 'group') {
        updateGroup.mutate({ path: { id: patch.id }, body: patch.body })
      } else {
        updateBlock.mutate({ path: { id: patch.id }, body: patch.body })
      }
    },
    [blocksById, nodes, updateBlock, updateGroup],
  )

  const reorderFromLayout = () => {
    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    const sorted = [...nodes]
      .filter((n): n is IdeaBlockNode => n.type === BLOCK_NODE_TYPE)
      .sort((a, b) => {
        const posA = absolutePositionOf(a, nodesById)
        const posB = absolutePositionOf(b, nodesById)
        return posA.y - posB.y || posA.x - posB.x
      })
    const order = sorted.map((n) => n.data.block.id)

    reorder.mutate(
      { path: { id: ideaId }, body: { order } },
      {
        onSuccess: () => toast({ title: t('ideas.canvas.flow.reorderFromLayoutSuccess') }),
        onError: (e) =>
          toast({
            tone: 'danger',
            title: apiErrorMessage(e, t('ideas.canvas.flow.reorderFromLayoutFailed')),
          }),
      },
    )
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A double-click lands on some node's own DOM even after bubbling to
    // this wrapper — that click is for the node (or is swallowed by one of
    // its own `nodrag`/interactive children), not a request to create
    // something new at this point.
    if ((event.target as HTMLElement).closest('.react-flow__node')) return
    onCreateBlockAt(screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }

  const actionsValue = useMemo(
    () => ({ onEditBlock, onRenameGroup, groupsById: new Map(groups.map((g) => [g.id, g])) }),
    [onEditBlock, onRenameGroup, groups],
  )

  return (
    <IdeaCanvasActionsProvider value={actionsValue}>
      <section
        className={styles.canvas}
        aria-label={t('ideas.canvas.flow.heading')}
        onDoubleClick={onDoubleClick}
      >
        <ReactFlow<IdeaCanvasNode>
          nodes={nodes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={NODE_TYPES}
          edges={[]}
          nodesConnectable={false}
          nodesDraggable={nodesDraggable}
          panOnDrag={panOnDrag}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2}
          fitView
          // React Flow's own arrow-key node movement bypasses this app's
          // `onNodesChange`/`onNodeDragStop` pipeline (it writes straight into
          // the store), so a nudge through it would move a node on screen and
          // then never persist. `block-node.tsx`/`group-node.tsx`'s own nudge
          // buttons are the replacement — see the report for how this was
          // found, since the concern it looks like it would raise (arrow keys
          // fighting a focused `Textarea`) turned out not to apply: React
          // Flow's own per-node key handler already checks
          // `isInputDOMNode(event)` and bails out for one.
          disableKeyboardA11y
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls />
          <Panel position="top-right">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={reorderFromLayout}
              loading={reorder.isPending}
            >
              {t('ideas.canvas.flow.reorderFromLayout')}
            </Button>
          </Panel>
        </ReactFlow>
      </section>
    </IdeaCanvasActionsProvider>
  )
}

export default function IdeaFlowCanvas(props: IdeaFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <IdeaFlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
