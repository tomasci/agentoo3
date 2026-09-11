import '@xyflow/react/dist/base.css'
import './idea-canvas-theme.scss'

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type NodeChange,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IdeaBlock, IdeaGroup } from '../hooks/use-idea-canvas'
import { useUpdateIdeaBlock, useUpdateIdeaGroup } from '../hooks/use-idea-canvas'
import { IdeaCanvasActionsProvider } from './actions-context'
import { BlockNode } from './block-node'
import { GroupNode } from './group-node'
import styles from './idea-flow-canvas.module.scss'
import {
  BLOCK_NODE_TYPE,
  blockNodeId,
  buildIdeaCanvasNodes,
  GROUP_NODE_TYPE,
  type IdeaCanvasNode,
  resolveDragStopPatch,
} from './to-nodes'

const NODE_TYPES = { [BLOCK_NODE_TYPE]: BlockNode, [GROUP_NODE_TYPE]: GroupNode }

export interface IdeaFlowCanvasProps {
  ideaId: string
  blocks: IdeaBlock[]
  groups: IdeaGroup[]
  assetsById: Map<string, { originalFilename: string; mimeType: string }>
  onEditBlock: (block: IdeaBlock) => void
  onRenameGroup: (group: IdeaGroup) => void
  onCreateBlockAt: (position: { x: number; y: number }) => void
  /** Set by the explorer pane (`components/idea-canvas.tsx`) when a row is
   * clicked — the canvas equivalent of an editor jumping to a file. `nonce`
   * is what makes clicking the same row twice re-center it: the object is a
   * fresh reference every click regardless of `blockId`, so the effect below
   * (keyed on this prop) always re-fires. */
  reveal?: { blockId: string; nonce: number } | null
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
  reveal,
  nodesDraggable = true,
  panOnDrag = true,
}: IdeaFlowCanvasProps) {
  const { t } = useTranslation()
  const { screenToFlowPosition, fitView, getNode } = useReactFlow<IdeaCanvasNode>()
  const updateBlock = useUpdateIdeaBlock(ideaId)
  const updateGroup = useUpdateIdeaGroup(ideaId)

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

  // The explorer pane's "click a row to see it on the canvas" affordance: a
  // no-op whenever `reveal` is unset or names a block this canvas has no node
  // for yet. `getNode` reads React Flow's own store rather than this
  // component's own `nodes` state directly, but `nodes` still has to sit in
  // this effect's deps: `IdeaFlowCanvas` mounts lazily behind a `<Suspense>`
  // boundary while the explorer pane renders as soon as its data lands, so a
  // `reveal` set before this component ever mounted runs this effect in the
  // same commit as the rebuild effect above — `setNodes` there has only
  // scheduled a re-render, the store is still empty, and `getNode` returns
  // `undefined` on that first pass. Without `nodes` in the deps nothing would
  // ever re-run this once `reveal` itself stopped changing, so that first,
  // premature miss would be permanent — the click would be silently dropped.
  // With `nodes` back in the deps the effect retries on every subsequent
  // render until the node it is looking for actually exists, which is
  // exactly the "re-fires on an unrelated render" failure this file used to
  // have, minus the one thing that makes it safe this time: `handledNonce`.
  // A nonce already handled can never trigger `fitView` again, no matter how
  // many more times `nodes` changes afterwards (an unrelated edit elsewhere
  // on the page, say) — only an unhandled nonce keeps retrying, and only
  // until a matching node appears.
  const handledNonce = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodes is the retry trigger explained above, not a value read inside this effect
  useEffect(() => {
    if (!reveal || reveal.nonce === handledNonce.current) return
    const target = getNode(blockNodeId(reveal.blockId))
    if (!target) return // nodes not built yet — retry when they are
    handledNonce.current = reveal.nonce
    fitView({ nodes: [{ id: target.id }], duration: 400, maxZoom: 1 })
  }, [reveal, nodes, getNode, fitView])

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
          // React Flow's own built-in arrow-key node movement writes straight
          // into its store, bypassing this app's own onNodesChange/
          // onNodeDragStop pipeline entirely — moving a selected node with
          // the keyboard through it would shift it on screen and then never
          // persist anything. There is no keyboard replacement for it:
          // dragging is the only way to move a node on this canvas.
          disableKeyboardA11y
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls />
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
