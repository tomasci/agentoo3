// Render smoke test for the Idea Manager's spatial canvas (T12): proves the
// canvas mounts under happy-dom and that a node is keyboard-reachable — not
// that dragging works, since d3-drag (both node dragging and pane panning
// are built on it) needs real `getBoundingClientRect` layout happy-dom does
// not provide (`nodesDraggable`/`panOnDrag` are `false` below for exactly
// that reason).
//
// The invariant the whole design rests on — a drag never writes `seq` — is
// checked two ways: `resolveDragStopPatch` (`../src/features/ideas/canvas/
// to-nodes.ts`) is a plain function of node/block data with no DOM or
// pointer gesture in it at all, so its return value is asserted directly
// across every branch (plain move, reparent in, no-op); and a nudge button
// (`block-node.tsx`), which *is* a real, clickable interaction under
// happy-dom, is clicked end-to-end and the resulting PATCH request is
// inspected the same way.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '@/shared/i18n'
import { mockModule } from './mock-module'
import type { IdeaBlock, IdeaGroup } from '../src/features/ideas/hooks/use-idea-canvas'
import {
  blockNodeId,
  groupNodeId,
  type IdeaBlockNode,
  type IdeaCanvasNode,
  type IdeaGroupNode,
  resolveDragStopPatch,
} from '../src/features/ideas/canvas/to-nodes'

// React Flow's own documented fix for happy-dom's missing layout: no real
// `offsetWidth`/`offsetHeight`, so every element measures 0×0 and React Flow
// throws its error #004 ("parent container needs a width and a height").
// Scoped to this file, not tests/setup.ts, per this track's own brief.
function mockReactFlow() {
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 1
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1
      },
    },
  })
}
mockReactFlow()

const PATCH_BLOCK_CLIENT = '@/shared/api/generated/clients/patchApiIdeaBlocksId'

type PatchCall = { path: { id: string }; body: Record<string, unknown> }
let patchCalls: PatchCall[] = []

await mockModule(PATCH_BLOCK_CLIENT, () => ({
  patchApiIdeaBlocksId: async (opts: PatchCall) => {
    patchCalls.push({ path: opts.path, body: opts.body })
    return { data: {} }
  },
}))

const { default: IdeaFlowCanvas } = await import('../src/features/ideas/canvas/idea-flow-canvas')

const block = (overrides: Partial<IdeaBlock> = {}): IdeaBlock =>
  ({
    id: 'b-1',
    ideaId: 'idea-1',
    groupId: null,
    seq: 1,
    x: 0,
    y: 0,
    w: null,
    h: null,
    kind: 'note',
    text: 'First block',
    ...overrides,
  }) as IdeaBlock

const group = (overrides: Partial<IdeaGroup> = {}): IdeaGroup => ({
  id: 'g-1',
  ideaId: 'idea-1',
  seq: 1,
  title: 'A group',
  x: 0,
  y: 0,
  w: null,
  h: null,
  ...overrides,
})

describe('resolveDragStopPatch never writes seq', () => {
  const blocksById = new Map<string, IdeaBlock>([
    ['b-1', block({ id: 'b-1', x: 10, y: 10 })],
    ['b-2', block({ id: 'b-2', x: 500, y: 500, groupId: 'g-1' })],
  ])

  const groupNode: IdeaGroupNode = {
    id: groupNodeId('g-1'),
    type: 'ideaGroup',
    position: { x: 400, y: 400 },
    data: { group: group({ id: 'g-1', x: 400, y: 400 }) },
  }

  const nodesById = new Map<string, IdeaCanvasNode>([[groupNode.id, groupNode]])

  test('a plain move on an ungrouped block patches only x/y', () => {
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-1'),
      type: 'ideaBlock',
      position: { x: 30, y: 40 },
      data: { block: blocksById.get('b-1') as IdeaBlock, assetsById: new Map() },
    }
    const patch = resolveDragStopPatch(dragged, blocksById, nodesById)
    expect(patch).toEqual({ target: 'block', id: 'b-1', body: { x: 30, y: 40 } })
    expect(Object.keys(patch?.body ?? {})).not.toContain('seq')
  })

  test('dropping an ungrouped block fully inside a group reparents it', () => {
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-1'),
      type: 'ideaBlock',
      // Absolute (410, 420) — inside the group's (400, 400)–(820, 660) rect.
      position: { x: 410, y: 420 },
      data: { block: blocksById.get('b-1') as IdeaBlock, assetsById: new Map() },
    }
    const patch = resolveDragStopPatch(dragged, blocksById, nodesById)
    expect(patch).toEqual({
      target: 'block',
      id: 'b-1',
      body: { groupId: 'g-1', x: 10, y: 20 },
    })
    expect(Object.keys(patch?.body ?? {})).not.toContain('seq')
  })

  test('a grouped block dragged within its own group patches relative x/y', () => {
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-2'),
      type: 'ideaBlock',
      parentId: groupNode.id,
      extent: 'parent',
      // Relative to the group's own (400, 400) — absolute (550, 550), still
      // inside its (400, 400)-(820, 660) rect, so this stays put rather than
      // un-parenting.
      position: { x: 150, y: 150 },
      data: { block: blocksById.get('b-2') as IdeaBlock, assetsById: new Map() },
    }
    const patch = resolveDragStopPatch(dragged, blocksById, nodesById)
    expect(patch).toEqual({ target: 'block', id: 'b-2', body: { x: 150, y: 150 } })
    expect(Object.keys(patch?.body ?? {})).not.toContain('seq')
  })

  test('an unchanged position is a no-op — no request at all', () => {
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-1'),
      type: 'ideaBlock',
      position: { x: 10, y: 10 },
      data: { block: blocksById.get('b-1') as IdeaBlock, assetsById: new Map() },
    }
    expect(resolveDragStopPatch(dragged, blocksById, nodesById)).toBeNull()
  })

  test('a group itself patches only its own x/y', () => {
    const draggedGroup: IdeaGroupNode = { ...groupNode, position: { x: 450, y: 460 } }
    const patch = resolveDragStopPatch(draggedGroup, blocksById, nodesById)
    expect(patch).toEqual({ target: 'group', id: 'g-1', body: { x: 450, y: 460 } })
    expect(Object.keys(patch?.body ?? {})).not.toContain('seq')
  })
})

let container: HTMLDivElement
let root: Root
let client: QueryClient

async function mount(blocks: IdeaBlock[]) {
  container = document.createElement('div')
  // React Flow measures this against the mocked offsetWidth/offsetHeight
  // above (which floors to 1×1 with no inline style at all), not against
  // this — an explicit size just keeps `fitView` from computing a degenerate
  // transform on top of the mocked geometry.
  container.style.width = '800px'
  container.style.height = '600px'
  document.body.append(container)

  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <IdeaFlowCanvas
          ideaId="idea-1"
          blocks={blocks}
          groups={[]}
          assetsById={new Map()}
          onEditBlock={() => {}}
          onRenameGroup={() => {}}
          onCreateBlockAt={() => {}}
          nodesDraggable={false}
          panOnDrag={false}
        />
      </QueryClientProvider>,
    )
  })
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
}

describe('rendering the canvas', () => {
  beforeEach(() => {
    patchCalls = []
  })

  afterEach(unmount)

  test('both blocks render and every node is keyboard-reachable', async () => {
    await mount([
      block({ id: 'b-1', text: 'First block' }),
      block({ id: 'b-2', x: 300, y: 0, text: 'Second block' }),
    ])

    expect(container.textContent).toContain('First block')
    expect(container.textContent).toContain('Second block')

    const nodeEls = [...container.querySelectorAll('[data-testid^="rf__node-"]')] as HTMLElement[]
    expect(nodeEls).toHaveLength(2)
    for (const el of nodeEls) {
      expect(el.tabIndex).toBe(0)
    }
  })

  test("a nudge — the replacement for React Flow's own disabled arrow-key move — patches only x/y, never seq", async () => {
    await mount([block({ id: 'b-1', x: 100, y: 100, seq: 7, text: 'Nudge me' })])

    const nudgeUp = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Nudge up',
    )
    expect(nudgeUp).toBeDefined()

    await act(async () => {
      nudgeUp?.click()
    })
    for (let i = 0; i < 5 && patchCalls.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }

    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]).toEqual({ path: { id: 'b-1' }, body: { x: 100, y: 76 } })
    expect(Object.keys(patchCalls[0]?.body ?? {})).not.toContain('seq')
  })
})
