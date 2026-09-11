// Render smoke test for the Idea Manager's spatial canvas (T12): proves the
// canvas mounts under happy-dom and that a node is keyboard-reachable — not
// that dragging works, since d3-drag (both node dragging and pane panning
// are built on it) needs real `getBoundingClientRect` layout happy-dom does
// not provide (`nodesDraggable`/`panOnDrag` are `false` below for exactly
// that reason).
//
// The invariant the whole design rests on — a drag never writes `seq` — is
// checked two ways. `resolveDragStopPatch` (`../src/features/ideas/canvas/
// to-nodes.ts`) is a plain function of node/block data with no DOM or
// pointer gesture in it at all, so its return value is asserted directly
// across every branch (plain move, reparent in, no-op, group); that is the
// primary guard. Alongside it, "remove from group" — a node action that *is*
// a real click under happy-dom, unlike a drag — is exercised end to end and
// the PATCH body it produces is inspected the same way. This used to be a
// nudge button; the nudge buttons are gone (a node now carries no stepper
// row and no `#<seq>` ordinal badge at all), which the "a node carries no
// ordinal badge and no nudge controls" test below pins down.
//
// The other thing asserted here is an `image` block's own body: a real
// `<img>` against the hand-built download route when the asset is a known
// inline image type, and the old filename/caption text button in every other
// branch (unknown asset, non-image mime type, or an `<img>` that fails to
// load).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '@/shared/i18n'
import {
  blockNodeId,
  groupNodeId,
  type IdeaBlockNode,
  type IdeaCanvasNode,
  type IdeaGroupNode,
  resolveDragStopPatch,
} from '../src/features/ideas/canvas/to-nodes'
import type { IdeaBlock, IdeaGroup } from '../src/features/ideas/hooks/use-idea-canvas'
import { mockModule } from './mock-module'

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

  test('a grouped block dropped outside every group un-parents it, still without a seq', () => {
    // The `extent: 'parent'` branch that a looser extent would make
    // reachable: absolute (0, 0) is outside the only group's rect while the
    // block itself still claims `groupId: 'g-1'`.
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-2'),
      type: 'ideaBlock',
      position: { x: 0, y: 0 },
      data: { block: blocksById.get('b-2') as IdeaBlock, assetsById: new Map() },
    }
    const patch = resolveDragStopPatch(dragged, blocksById, nodesById)
    expect(patch).toEqual({ target: 'block', id: 'b-2', body: { groupId: null, x: 0, y: 0 } })
    expect(Object.keys(patch?.body ?? {})).not.toContain('seq')
  })

  test('a node whose block is already gone patches nothing at all', () => {
    // A drag finishing against a block another tab has just deleted: no
    // request, rather than a PATCH against a dead id.
    const dragged: IdeaBlockNode = {
      id: blockNodeId('b-deleted'),
      type: 'ideaBlock',
      position: { x: 30, y: 40 },
      data: { block: blocksById.get('b-1') as IdeaBlock, assetsById: new Map() },
    }
    expect(resolveDragStopPatch(dragged, blocksById, nodesById)).toBeNull()
  })
})

let container: HTMLDivElement
let root: Root
let client: QueryClient

type Asset = { originalFilename: string; mimeType: string }

type MountOptions = { groups?: IdeaGroup[]; assetsById?: Map<string, Asset> }

/** Renders into the root `mount` created, without tearing it down — for the
 *  cases that need the *same* node (same node id, so React Flow keeps the same
 *  `BlockNode` instance) to be handed changed data, the way an edit followed
 *  by a refetch does in the real app. */
async function rerender(blocks: IdeaBlock[], options: MountOptions = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <IdeaFlowCanvas
          ideaId="idea-1"
          blocks={blocks}
          groups={options.groups ?? []}
          assetsById={options.assetsById ?? new Map()}
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

async function mount(blocks: IdeaBlock[], options: MountOptions = {}) {
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
  await rerender(blocks, options)
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
}

/** Lets a mutation's promise settle and React flush the state it sets —
 *  several short turns rather than one, since the mocked client resolves on a
 *  microtask and react-query then schedules its own. */
async function settle() {
  for (let i = 0; i < 5 && patchCalls.length === 0; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const images = () => [...container.querySelectorAll('img')] as HTMLImageElement[]

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

  test('an image block whose asset is a known inline type renders a real <img> at the download route', async () => {
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-1', caption: 'A diagram' })], {
      assetsById: new Map([
        ['asset-1', { originalFilename: 'diagram.png', mimeType: 'image/png' }],
      ]),
    })

    const rendered = images()
    expect(rendered).toHaveLength(1)
    // The hand-built route (`lib/asset-url.ts`), addressed by asset id alone —
    // not a generated client call, and no idea id in the path.
    expect(rendered[0]?.getAttribute('src')).toBe('/api/idea-assets/asset-1/download')
    expect(rendered[0]?.getAttribute('alt')).toBe('A diagram')
  })

  test('an image block with no caption falls back to the asset filename for its alt text', async () => {
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-2', caption: null })], {
      assetsById: new Map([
        ['asset-2', { originalFilename: 'photo.jpeg', mimeType: 'image/jpeg' }],
      ]),
    })

    expect(images()).toHaveLength(1)
    expect(images()[0]?.getAttribute('src')).toBe('/api/idea-assets/asset-2/download')
    expect(images()[0]?.getAttribute('alt')).toBe('photo.jpeg')
  })

  test('an image block whose asset has a non-image mime type renders text, never an <img>', async () => {
    await mount(
      [block({ id: 'b-img', kind: 'image', assetId: 'asset-3', caption: 'Spec sheet' })],
      {
        assetsById: new Map([
          ['asset-3', { originalFilename: 'spec.pdf', mimeType: 'application/pdf' }],
        ]),
      },
    )

    expect(images()).toHaveLength(0)
    expect(container.textContent).toContain('spec.pdf')
    expect(container.textContent).toContain('Spec sheet')
  })

  test('an image block whose asset is unknown falls back to the raw asset id, with no <img>', async () => {
    // The asset row can be deleted out from under the block that points at
    // it, which is exactly the branch this covers.
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-gone', caption: null })], {
      assetsById: new Map(),
    })

    expect(images()).toHaveLength(0)
    expect(container.textContent).toContain('asset-gone')
  })

  test('an <img> that fails to load is replaced by the text fallback', async () => {
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-4', caption: 'Mockup' })], {
      assetsById: new Map([
        ['asset-4', { originalFilename: 'mockup.webp', mimeType: 'image/webp' }],
      ]),
    })

    const img = images()[0]
    expect(img).toBeDefined()

    await act(async () => {
      img?.dispatchEvent(new Event('error', { bubbles: false }))
    })

    expect(images()).toHaveLength(0)
    expect(container.textContent).toContain('mockup.webp')
    expect(container.textContent).toContain('Mockup')
  })

  test('a blank caption falls through to the filename for alt text, never an empty alt', async () => {
    // `caption: ''` is not reachable from this app's own block form (it only
    // sends a caption it has trimmed to something), but the API accepts it —
    // `caption: z.string().max(300).nullable().optional()`, backend
    // features/ideas/schema.ts — and an `<img alt="">` is announced as
    // decorative, hiding the block's only name from a screen reader.
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-5', caption: '' })], {
      assetsById: new Map([
        ['asset-5', { originalFilename: 'blank-caption.png', mimeType: 'image/png' }],
      ]),
    })

    expect(images()).toHaveLength(1)
    expect(images()[0]?.getAttribute('alt')).toBe('blank-caption.png')
  })

  test('an image block repointed at a loadable asset recovers from a failed <img>', async () => {
    const IMAGES = new Map([
      ['asset-bad', { originalFilename: 'bad.webp', mimeType: 'image/webp' }],
      ['asset-good', { originalFilename: 'good.png', mimeType: 'image/png' }],
    ])
    await mount([block({ id: 'b-img', kind: 'image', assetId: 'asset-bad', caption: 'Bad' })], {
      assetsById: IMAGES,
    })

    await act(async () => {
      images()[0]?.dispatchEvent(new Event('error'))
    })
    expect(images()).toHaveLength(0)

    // The same block id now points somewhere else — what editing the block and
    // letting the blocks query refetch does. React Flow keeps one `BlockNode`
    // instance per node id, so nothing here remounts on its own: without a
    // `key` on the image body, the failed asset's `broken` flag would still be
    // latched and this block would show a text chip until a full reload.
    await rerender(
      [block({ id: 'b-img', kind: 'image', assetId: 'asset-good', caption: 'Now fine' })],
      { assetsById: IMAGES },
    )

    expect(images()).toHaveLength(1)
    expect(images()[0]?.getAttribute('src')).toBe('/api/idea-assets/asset-good/download')
    expect(images()[0]?.getAttribute('alt')).toBe('Now fine')
  })

  test('a node carries no ordinal badge and no nudge controls, and the pane has no reorder button', async () => {
    await mount([block({ id: 'b-1', seq: 7, text: 'Ordinary block' })], {
      groups: [group({ id: 'g-1', seq: 2, title: 'A group' })],
    })

    // Reading order is not a thing this surface shows or edits any more.
    expect(container.textContent).not.toContain('#7')
    expect(container.textContent).not.toContain('#')
    expect(container.textContent).not.toContain('Reorder from layout')

    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[]
    const labels = buttons.map(
      (b) => `${b.getAttribute('aria-label') ?? ''}|${b.textContent ?? ''}`,
    )
    // Glyph-and-label based rather than i18n-string based: a nudge control was
    // an arrow either way round.
    for (const label of labels) {
      expect(label).not.toMatch(/[↑↓←→]/)
      expect(label.toLowerCase()).not.toContain('nudge')
    }
  })

  test('removing a block from its group patches groupId and x/y — never seq', async () => {
    // The end-to-end half of the invariant: a real click on a real node
    // action, through the same `useUpdateIdeaBlock` a drag stop uses.
    await mount([block({ id: 'b-1', groupId: 'g-1', x: 10, y: 20, seq: 7 })], {
      groups: [group({ id: 'g-1', x: 400, y: 400 })],
    })

    // Scoped to the *block* node: the group node beside it carries its own
    // ⋯ menu, and it renders first.
    const blockNode = container.querySelector(`[data-testid="rf__node-${blockNodeId('b-1')}"]`)
    expect(blockNode).not.toBeNull()
    const trigger = blockNode?.querySelector('button[aria-haspopup="menu"]') as
      | HTMLElement
      | undefined
    expect(trigger).toBeDefined()
    await act(async () => {
      trigger?.click()
    })

    const items = [
      ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
    ] as HTMLElement[]
    const removeFromGroup = items.find((el) => el.textContent === 'Remove from group')
    if (!removeFromGroup) {
      throw new Error(
        `no "Remove from group" item among: ${items.map((i) => i.textContent).join(', ')}`,
      )
    }

    // Two events, each its own `act` — Zag's menu machine reads back the
    // highlight it sets on pointerdown when it handles the click (see
    // tests/storage-page.test.tsx's own note on this).
    await act(async () => {
      removeFromGroup.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
      )
    })
    await act(async () => {
      removeFromGroup.click()
    })
    await settle()

    expect(patchCalls).toHaveLength(1)
    // (10, 20) relative to the group's own (400, 400) becomes absolute.
    expect(patchCalls[0]).toEqual({
      path: { id: 'b-1' },
      body: { groupId: null, x: 410, y: 420 },
    })
    expect(Object.keys(patchCalls[0]?.body ?? {})).not.toContain('seq')
  })
})
