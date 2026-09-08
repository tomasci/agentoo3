import type { Node } from '@xyflow/react'
import type { IdeaBlock, IdeaGroup } from '../hooks/use-idea-canvas'

// The one seam React Flow's own types cross into this feature. Nothing in
// `shared/ui`, the generated client, or the rest of `features/ideas` may
// import `@xyflow/react` — this module (plus the node components and canvas
// component beside it) is the whole of that boundary, so swapping the
// library later means rewriting this file and the two node components, not
// hunting `@xyflow` imports across the app.

export const BLOCK_NODE_TYPE = 'ideaBlock' as const
export const GROUP_NODE_TYPE = 'ideaGroup' as const

/** No group has been given a size yet (no resize UI exists in this track —
 * see the report), so every group renders at this footprint regardless of
 * how many blocks it holds. Generous enough that a handful of default-sized
 * blocks fit without immediately overflowing the container a fresh group
 * presents as. */
export const DEFAULT_GROUP_WIDTH = 420
export const DEFAULT_GROUP_HEIGHT = 260

const BLOCK_NODE_PREFIX = 'block:'
const GROUP_NODE_PREFIX = 'group:'

export function blockNodeId(blockId: string): string {
  return `${BLOCK_NODE_PREFIX}${blockId}`
}

export function groupNodeId(groupId: string): string {
  return `${GROUP_NODE_PREFIX}${groupId}`
}

/** The inverse of `blockNodeId`/`groupNodeId` — strips this adapter's own
 * prefix back to the database id a drag handler PATCHes. Works on either
 * prefix since a caller already knows which kind of node it has (from
 * `node.type`) and only needs the id underneath. */
export function entityIdFromNodeId(nodeId: string): string {
  return nodeId.slice(nodeId.indexOf(':') + 1)
}

export interface IdeaBlockNodeData extends Record<string, unknown> {
  block: IdeaBlock
  assetsById: Map<string, { originalFilename: string }>
}

export interface IdeaGroupNodeData extends Record<string, unknown> {
  group: IdeaGroup
}

export type IdeaBlockNode = Node<IdeaBlockNodeData, typeof BLOCK_NODE_TYPE>
export type IdeaGroupNode = Node<IdeaGroupNodeData, typeof GROUP_NODE_TYPE>
export type IdeaCanvasNode = IdeaBlockNode | IdeaGroupNode

export function groupsToNodes(groups: IdeaGroup[]): IdeaGroupNode[] {
  return groups.map((group) => ({
    id: groupNodeId(group.id),
    type: GROUP_NODE_TYPE,
    position: { x: group.x, y: group.y },
    data: { group },
  }))
}

/**
 * `block.x`/`block.y` mean two different things depending on `block.groupId`,
 * and which one applies is exactly what lets a plain, ungrouped-vs-grouped
 * column carry both without the backend ever translating between them (see
 * `service.ts`'s `updateIdeaBlock`: it writes whatever x/y arrives, verbatim,
 * regardless of `groupId`):
 *
 * - ungrouped (`groupId === null`): x/y is the absolute canvas position.
 * - grouped: x/y is relative to the owning group's own (x, y) — which is
 *   also exactly what React Flow's `parentId` + `extent: 'parent'` (a node
 *   nested in another) already expects a child's `position` to mean, so
 *   nesting costs this adapter nothing beyond picking the right field to
 *   read. The one place this convention has to be produced or undone by hand
 *   is a block changing group membership, which is a drag ending inside or
 *   outside a group's rect rather than a plain move — see
 *   `idea-flow-canvas.tsx`'s `onNodeDragStop`.
 */
export function blocksToNodes(
  blocks: IdeaBlock[],
  assetsById: Map<string, { originalFilename: string }>,
): IdeaBlockNode[] {
  return blocks.map((block) => ({
    id: blockNodeId(block.id),
    type: BLOCK_NODE_TYPE,
    position: { x: block.x, y: block.y },
    parentId: block.groupId ? groupNodeId(block.groupId) : undefined,
    // Confines a grouped block to the container it was dropped into — it can
    // only leave via the node's own "remove from group" action (see
    // `block-node.tsx`), never by dragging past the edge. Un-grouped blocks
    // get no `extent` at all, so they move freely until dropped onto a group.
    extent: block.groupId ? 'parent' : undefined,
    data: { block, assetsById },
  }))
}

/**
 * Groups first, blocks after: a `parentId` React Flow has not seen a node
 * for yet renders that child at (0, 0) for a frame (xyflow's own "Sub Flows"
 * guide) — trivially avoided by building the array in that order, since nodes
 * mount in array order.
 */
export function buildIdeaCanvasNodes(
  blocks: IdeaBlock[],
  groups: IdeaGroup[],
  assetsById: Map<string, { originalFilename: string }>,
): IdeaCanvasNode[] {
  return [...groupsToNodes(groups), ...blocksToNodes(blocks, assetsById)]
}

/** A grouped block's `position` is relative to its parent group node (see
 * `blocksToNodes`'s own comment), so its position on the whole canvas needs
 * the parent's own (absolute) position added back in. Only one level of
 * nesting ever exists — a group is never itself parented — so this never
 * recurses. */
export function absolutePositionOf(
  node: IdeaCanvasNode,
  nodesById: Map<string, IdeaCanvasNode>,
): { x: number; y: number } {
  if (!node.parentId) return node.position
  const parent = nodesById.get(node.parentId)
  return parent
    ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
    : node.position
}

/** Which group (if any) an absolute canvas point falls fully inside — sized
 * by `DEFAULT_GROUP_WIDTH`/`DEFAULT_GROUP_HEIGHT` rather than a group node's
 * live measured DOM size, since a group's footprint is fixed today (see
 * those constants' own comment): this keeps the containment test a plain
 * function of the same data every other part of this adapter works from,
 * with nothing that depends on having actually rendered anything — which is
 * what makes `resolveDragStopPatch` below testable without a DOM at all. */
export function groupContaining(
  point: { x: number; y: number },
  groupNodes: IdeaGroupNode[],
): IdeaGroupNode | undefined {
  return groupNodes.find(
    (g) =>
      point.x >= g.position.x &&
      point.x <= g.position.x + DEFAULT_GROUP_WIDTH &&
      point.y >= g.position.y &&
      point.y <= g.position.y + DEFAULT_GROUP_HEIGHT,
  )
}

/** What a drag ending on `node` should persist, or `null` for "nothing
 * moved, skip the request" — a plain, dependency-free function of the
 * node's own post-drag state plus the current canvas, deliberately kept
 * separate from `idea-flow-canvas.tsx`'s `onNodeDragStop` (which only reads
 * this and picks a mutation to fire) so the one invariant the whole design
 * rests on — a drag never writes `seq` — is checkable without a DOM, a
 * pointer gesture, or React Flow's own drag machinery, none of which
 * function the same way under `bun test`'s happy-dom as they do in a real
 * browser. The return type's `body` shapes are exactly `PatchApiIdeaBlocksIdBody`/
 * `PatchApiIdeaGroupsIdBody`'s own position fields — structurally, `seq`
 * cannot appear here even by a future editing mistake, since neither shape
 * has a `seq` field to begin with. */
export type DragStopPatch =
  | { target: 'block'; id: string; body: { x: number; y: number; groupId?: string | null } }
  | { target: 'group'; id: string; body: { x: number; y: number } }
  | null

export function resolveDragStopPatch(
  node: IdeaCanvasNode,
  blocksById: Map<string, IdeaBlock>,
  nodesById: Map<string, IdeaCanvasNode>,
): DragStopPatch {
  if (node.type === GROUP_NODE_TYPE) {
    return {
      target: 'group',
      id: entityIdFromNodeId(node.id),
      body: { x: node.position.x, y: node.position.y },
    }
  }
  if (node.type !== BLOCK_NODE_TYPE) return null

  const blockId = entityIdFromNodeId(node.id)
  const block = blocksById.get(blockId)
  if (!block) return null

  const absolute = absolutePositionOf(node, nodesById)
  const groupNodes = [...nodesById.values()].filter(
    (n): n is IdeaGroupNode => n.type === GROUP_NODE_TYPE,
  )
  const containingGroup = groupContaining(absolute, groupNodes)

  if (containingGroup) {
    const newGroupId = entityIdFromNodeId(containingGroup.id)
    if (newGroupId !== block.groupId) {
      return {
        target: 'block',
        id: blockId,
        body: {
          groupId: newGroupId,
          x: absolute.x - containingGroup.position.x,
          y: absolute.y - containingGroup.position.y,
        },
      }
    }
  } else if (block.groupId) {
    // Unreached today: a grouped block's `extent: 'parent'` (`blocksToNodes`)
    // keeps it inside its own group's rect for the whole drag, so it can
    // never end one outside every group — leaving a group happens through
    // the node's own "remove from group" action instead (`block-node.tsx`).
    // Kept rather than asserted against, in case a looser extent ever lands.
    return { target: 'block', id: blockId, body: { groupId: null, x: absolute.x, y: absolute.y } }
  }

  if (node.position.x === block.x && node.position.y === block.y) return null
  return { target: 'block', id: blockId, body: { x: node.position.x, y: node.position.y } }
}
