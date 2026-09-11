// The seam between the Idea Manager's two panes: clicking a row in the
// structure explorer (`src/features/ideas/components/idea-canvas.tsx`)
// centres that block on the spatial canvas beside it
// (`src/features/ideas/canvas/idea-flow-canvas.tsx`).
//
// Both regressions this pins down came from the same root cause — `IdeaCanvas`
// rebuilding `assetsById`/`allGroups` on every render, which handed the canvas
// fresh-but-equivalent props and made its node-rebuild effect fire for renders
// that changed no data at all:
//
//   * the viewport re-centred on whatever was last revealed every time
//     anything else on the page re-rendered (opening the "Add block" dialog,
//     say), and
//   * a canvas node's own selection was thrown away with the rebuilt nodes.
//
// So the assertions here are counted `fitView` calls and a surviving
// selection, driven through the real UI: real explorer rows, a real node
// click, a real dialog. `fitView` is the one thing that cannot be observed
// from the DOM — happy-dom has no layout for React Flow to compute a viewport
// transform from — so it, and only it, is stubbed, by wrapping the
// `useReactFlow` this feature calls. Everything else is the real component.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '@/shared/i18n'
import type { IdeaBlock } from '../src/features/ideas/hooks/use-idea-canvas'
import { mockModule } from './mock-module'

// React Flow's own documented fix for happy-dom's missing layout — see
// tests/idea-flow-canvas.test.tsx's own copy of this and its comment. Without
// it React Flow refuses to render the graph (its error #004) and there are no
// nodes to select or centre.
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

const note = (id: string, seq: number, text: string, x = 0): IdeaBlock => ({
  id,
  ideaId: 'idea-1',
  groupId: null,
  seq,
  x,
  y: 0,
  w: null,
  h: null,
  kind: 'note',
  text,
})

const BLOCKS: IdeaBlock[] = [
  {
    id: 'b-1',
    ideaId: 'idea-1',
    groupId: null,
    seq: 1,
    x: 0,
    y: 0,
    w: null,
    h: null,
    kind: 'note',
    text: 'One',
  },
  {
    id: 'b-2',
    ideaId: 'idea-1',
    groupId: null,
    seq: 2,
    x: 300,
    y: 0,
    w: null,
    h: null,
    kind: 'note',
    text: 'Two',
  },
]

// Reassigned by the one test that needs the blocks list to actually change
// under the canvas, the way another tab's edit plus a refetch would; reset in
// `beforeEach`.
let currentBlocks: IdeaBlock[] = BLOCKS

await mockModule('@/shared/api/generated/clients/getApiIdeasIdBlocks', () => ({
  getApiIdeasIdBlocks: async () => ({ data: currentBlocks }),
}))
await mockModule('@/shared/api/generated/clients/getApiIdeasIdGroups', () => ({
  getApiIdeasIdGroups: async () => ({ data: [] }),
}))
await mockModule('@/shared/api/generated/clients/getApiIdeasIdAssets', () => ({
  getApiIdeasIdAssets: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxIdeaBytes: 1 } },
  }),
}))

/**
 * `fitView` is the only thing swapped out, and the wrapper is deliberately
 * built from a *copy* of the module's namespace (`{ ...(await import(…)) }`)
 * rather than the namespace object itself: `mock.module` mutates that object
 * in place, so reading `useReactFlow` back off the live namespace inside the
 * factory would call the wrapper from the wrapper. Everything else —
 * `ReactFlow`, `ReactFlowProvider`, the hooks the node components use — is
 * re-exported unchanged, so component identity is preserved and
 * `tests/mock-module.ts`'s own `afterAll` restore puts an equivalent plain
 * copy back for any file that loads this package afterwards.
 */
const realFlow = { ...(await import('@xyflow/react')) } as typeof import('@xyflow/react')
let fitViewCalls: unknown[] = []
// One function object for the whole file. A fresh closure per render would be
// an unstable `fitView` in the reveal effect's own dependency array — which is
// exactly the kind of instability these tests exist to detect, and would fake
// the failure they are looking for.
const spyFitView = (options: unknown) => {
  fitViewCalls.push(options)
  return true
}
await mockModule('@xyflow/react', () => ({
  ...realFlow,
  useReactFlow: () => ({ ...realFlow.useReactFlow(), fitView: spyFitView }),
}))

const { IdeaCanvas } = await import('../src/features/ideas/components/idea-canvas')
const { default: IdeaFlowCanvas } = await import('../src/features/ideas/canvas/idea-flow-canvas')

let container: HTMLDivElement
let root: Root
let client: QueryClient

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <IdeaCanvas ideaId="idea-1" />
      </QueryClientProvider>,
    )
  })
  // The canvas pane is lazy (`React.lazy` + `Suspense`) and its three queries
  // resolve on their own microtasks; a few short turns is what it takes for
  // the chunk, the data and the nodes to all be in place.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
}

/** The explorer's own rows, in render order — the row's `title` is its name. */
const rows = () => [...container.querySelectorAll('li > button[title]')] as HTMLElement[]

const canvasNodes = () =>
  [...container.querySelectorAll('[data-testid^="rf__node-"]')] as HTMLElement[]

const selectedNodeCount = () => container.querySelectorAll('[data-selected]').length

const buttonWithText = (text: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLElement

beforeEach(() => {
  fitViewCalls = []
  currentBlocks = BLOCKS
  container = document.createElement('div')
  container.style.width = '800px'
  container.style.height = '600px'
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
})

test('clicking an explorer row centres that block on the canvas, exactly once', async () => {
  await mount()
  expect(rows().map((r) => r.getAttribute('title'))).toEqual(['One', 'Two'])
  // Nothing is revealed until something is clicked.
  expect(fitViewCalls).toHaveLength(0)

  await click(rows()[1] as HTMLElement)

  expect(fitViewCalls).toHaveLength(1)
  expect(fitViewCalls[0]).toEqual({
    nodes: [{ id: 'block:b-2' }],
    duration: 400,
    maxZoom: 1,
  })
})

test('a re-render that changes no data does not re-centre the canvas', async () => {
  await mount()
  await click(rows()[1] as HTMLElement)
  expect(fitViewCalls).toHaveLength(1)

  // Opening and closing the "Add block" dialog re-renders `IdeaCanvas` twice
  // over without touching a single query result — the plain-render case that
  // used to hand the canvas rebuilt props and snap the viewport back to
  // whatever was last revealed.
  await click(buttonWithText('Add block'))
  expect(fitViewCalls).toHaveLength(1)

  await click(buttonWithText('Cancel', document.body))
  expect(fitViewCalls).toHaveLength(1)
})

test('clicking the same row again re-centres it', async () => {
  await mount()
  const row = rows()[0] as HTMLElement

  await click(row)
  await click(row)

  // Same block twice: the nonce is what makes the second click count.
  expect(fitViewCalls).toHaveLength(2)
  expect(fitViewCalls[1]).toEqual(fitViewCalls[0])
})

test('a selected canvas node stays selected when an explorer row is clicked', async () => {
  await mount()
  const node = canvasNodes()[0]
  expect(node).toBeDefined()

  await click(node as HTMLElement)
  expect(selectedNodeCount()).toBe(1)
  expect((node as HTMLElement).className).toContain('selected')

  await click(rows()[1] as HTMLElement)

  // The nodes were rebuilt from scratch here before the fix, taking the
  // selection — and any un-persisted local node state — with them.
  expect(selectedNodeCount()).toBe(1)
  expect(canvasNodes()[0]?.className).toContain('selected')
})

test('a selected canvas node stays selected when an unrelated dialog opens', async () => {
  await mount()
  await click(canvasNodes()[0] as HTMLElement)
  expect(selectedNodeCount()).toBe(1)

  await click(buttonWithText('Add block'))

  expect(selectedNodeCount()).toBe(1)
})

/**
 * Renders the canvas pane on its own, with `reveal` already set at mount —
 * the shape `IdeaCanvas` produces when a row is clicked while the lazy canvas
 * chunk is still resolving behind its `<Suspense>` boundary, and the one the
 * explorer-driven tests above cannot reach, since by the time they can click
 * a row the canvas is long since mounted.
 */
async function mountFlowCanvas(
  blocks: IdeaBlock[],
  reveal: { blockId: string; nonce: number } | null,
) {
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
          reveal={reveal}
          nodesDraggable={false}
          panOnDrag={false}
        />
      </QueryClientProvider>,
    )
  })
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

test('a reveal already set when the canvas mounts still centres that block, once', async () => {
  // On the mounting commit the rebuild effect has only *scheduled* its
  // `setNodes`, so React Flow's store is still empty and the node cannot be
  // found — the effect has to retry on the render that follows. Dropping that
  // retry silently swallowed the click.
  await mountFlowCanvas([note('b-1', 1, 'One'), note('b-2', 2, 'Two', 300)], {
    blockId: 'b-2',
    nonce: 1,
  })

  expect(container.querySelector('[data-testid="rf__node-block:b-2"]')).not.toBeNull()
  expect(fitViewCalls).toHaveLength(1)
  expect(fitViewCalls[0]).toEqual({ nodes: [{ id: 'block:b-2' }], duration: 400, maxZoom: 1 })
})

test('the retry stops at one call — a rebuilt node set does not re-centre', async () => {
  // The direct counterpart of the test above: `nodes` is in the effect's deps
  // purely so an unfound node is retried, which on its own is the old
  // "re-fires on every render" bug. Only the handled-nonce guard separates
  // the two, and this is what pins it: same `reveal` object throughout, but a
  // genuinely different node set on the second render.
  const reveal = { blockId: 'b-1', nonce: 1 }
  await mountFlowCanvas([note('b-1', 1, 'One')], reveal)
  expect(fitViewCalls).toHaveLength(1)

  await mountFlowCanvas([note('b-1', 1, 'One'), note('b-3', 3, 'Three', 600)], reveal)

  // The node set really did change — otherwise this would pass for the wrong
  // reason.
  expect(container.querySelector('[data-testid="rf__node-block:b-3"]')).not.toBeNull()
  expect(fitViewCalls).toHaveLength(1)
})

test('adding a block after a reveal does not re-centre the canvas', async () => {
  // The same failure mode as the test above, but driven the way it actually
  // happens: a row click, then the blocks query returning a different list
  // (another tab's edit, or this page's own create) and the canvas rebuilding
  // its nodes off it.
  await mount()
  await click(rows()[1] as HTMLElement)
  expect(fitViewCalls).toHaveLength(1)

  currentBlocks = [...BLOCKS, note('b-3', 3, 'Three', 600)]
  await act(async () => {
    await client.invalidateQueries()
  })
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }

  // The refetch really landed: a third row and a third node.
  expect(rows().map((r) => r.getAttribute('title'))).toEqual(['One', 'Two', 'Three'])
  expect(canvasNodes()).toHaveLength(3)
  expect(fitViewCalls).toHaveLength(1)
})

test('a row clicked after that rebuild still centres normally', async () => {
  // Guards the other direction: the nonce guard must not latch the feature
  // shut once a rebuild has happened.
  await mount()
  await click(rows()[1] as HTMLElement)

  currentBlocks = [...BLOCKS, note('b-3', 3, 'Three', 600)]
  await act(async () => {
    await client.invalidateQueries()
  })
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
  expect(fitViewCalls).toHaveLength(1)

  await click(rows()[2] as HTMLElement)

  expect(fitViewCalls).toHaveLength(2)
  expect(fitViewCalls[1]).toEqual({ nodes: [{ id: 'block:b-3' }], duration: 400, maxZoom: 1 })
})
