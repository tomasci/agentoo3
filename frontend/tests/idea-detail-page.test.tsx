// Render smoke test for the Idea Manager's detail page (T11), against its
// left pane: a structure-only explorer — an editor's file tree, not a
// rendering of block contents.
//
// What it pins down:
//   * reading order is ascending `seq` (which, since nothing in the UI
//     mutates `seq` any more, is creation order) — the order the prompt
//     generator reads blocks in (backend's `serializeIdea`), never the order
//     the list endpoint happened to hand them back in;
//   * a row is one truncated line and a kind badge — no ordinal number, no
//     `<ol>`, no markdown body, no `<img>`;
//   * a row offers exactly two actions, Edit and Delete;
//   * a group is a collapsible folder whose members nest beneath it rather
//     than appearing as top-level rows.
//
// Class names are useless as selectors here: CSS-module imports are not
// processed under `bun test`, so `styles.row` and friends stringify to
// `undefined`. Everything below selects on structure, `title`, `aria-*` or
// text instead.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import type { IdeaBlock, IdeaGroup } from '../src/features/ideas/hooks/use-idea-canvas'
import type { Idea } from '../src/features/ideas/hooks/use-ideas'
import { BLOCK_LABEL_MAX_LENGTH } from '../src/features/ideas/lib/block-label'
import { mockModule } from './mock-module'

const IDEA_CLIENT = '@/shared/api/generated/clients/getApiIdeasId'
const BLOCKS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdBlocks'
const GROUPS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdGroups'
const ASSETS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdAssets'
const COMMENTS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdComments'
const PROMPTS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdPrompts'
const RUNS_CLIENT = '@/shared/api/generated/clients/getApiIdeasIdRuns'

const T = '2026-09-04T10:00:00.000Z'

const idea = (overrides: Partial<Idea> = {}): Idea => ({
  id: 'idea-1',
  projectId: 'p1',
  title: 'An idea',
  status: 'backlog',
  boardPosition: 0,
  sessionId: null,
  orchestrator: null,
  baseBranch: null,
  maxBudgetUsd: null,
  lastError: null,
  blockCount: 3,
  commentCount: 0,
  assetCount: 0,
  latestPrompt: null,
  sessionStatus: null,
  openRun: null,
  createdAt: T,
  updatedAt: T,
  ...overrides,
})

const note = (id: string, seq: number, text: string, groupId: string | null = null): IdeaBlock => ({
  id,
  ideaId: 'idea-1',
  groupId,
  seq,
  x: 0,
  y: 0,
  w: null,
  h: null,
  kind: 'note',
  text,
})

// Deliberately out of `seq` order — the DTO order this list actually hands
// back is not what the reading order is; only `seq` is.
const BLOCKS: IdeaBlock[] = [
  note('b-c', 5, 'Third: seq 5'),
  note('b-a', 1, 'First: seq 1'),
  note('b-b', 3, 'Second: seq 3'),
]

const group = (id: string, seq: number, title: string): IdeaGroup => ({
  id,
  ideaId: 'idea-1',
  seq,
  title,
  x: 0,
  y: 0,
  w: null,
  h: null,
})

let currentIdea = idea()
// Per-test fixtures: each test sets these before `mount()`, and each mount
// builds a fresh QueryClient, so nothing is cached across them.
let currentBlocks: IdeaBlock[] = BLOCKS
let currentGroups: IdeaGroup[] = []

await mockModule(IDEA_CLIENT, () => ({
  getApiIdeasId: async () => ({ data: currentIdea }),
}))
await mockModule(BLOCKS_CLIENT, () => ({
  getApiIdeasIdBlocks: async () => ({ data: currentBlocks }),
}))
await mockModule(GROUPS_CLIENT, () => ({
  getApiIdeasIdGroups: async () => ({ data: currentGroups }),
}))
await mockModule(ASSETS_CLIENT, () => ({
  getApiIdeasIdAssets: async () => ({
    data: {
      files: [],
      usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxIdeaBytes: 50_000_000 },
    },
  }),
}))
await mockModule(COMMENTS_CLIENT, () => ({
  getApiIdeasIdComments: async () => ({ data: [] }),
}))
await mockModule(PROMPTS_CLIENT, () => ({
  getApiIdeasIdPrompts: async () => ({ data: [] }),
}))
await mockModule(RUNS_CLIENT, () => ({
  getApiIdeasIdRuns: async () => ({ data: [] }),
}))

const project = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  source: 'clone',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`,
  createdAt: '',
  updatedAt: '',
})

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root

async function mount(path = '/projects/p1/ideas/idea-1') {
  container = document.createElement('div')
  document.body.append(container)

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project('p1', 'Alpha')])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/library/agents' }], [])

  root = createRoot(container)
  await act(async () => {
    root.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
}

beforeEach(() => {
  localStorage.clear()
  currentIdea = idea()
  currentBlocks = BLOCKS
  currentGroups = []
})

afterEach(unmount)

/**
 * The explorer's own tree root: the first `<ul>` in document order holding
 * either a block row (`<li><button title=…>`) or a group row
 * (`<li><div><button aria-expanded=…>`). Both anchors are needed — a tree of
 * nothing but a collapsed group has no block row in it at all. Neither the
 * workspace tab bar's `<ul>` nor the sidebar carries either shape, and a
 * group's nested sublist always comes after the tree containing it.
 */
function tree(): HTMLElement {
  const found = [...container.querySelectorAll('ul')].find(
    (ul) =>
      ul.querySelector('li > button[title]') ||
      ul.querySelector('li > div > button[aria-expanded]'),
  )
  if (!found) throw new Error('no explorer tree in the rendered page')
  return found
}

/** Every block row's name, in render order — the row's `title` is exactly the
 *  single-line name it displays. */
const rowNames = (scope: HTMLElement = tree()) =>
  [...scope.querySelectorAll('li > button[title]')].map((b) => b.getAttribute('title'))

/** Only the tree's own top-level items — a group's members live in a nested
 *  `<ul>` and must not show up here. */
const topLevelItems = (): HTMLElement[] =>
  [...tree().children].filter((el): el is HTMLElement => el.tagName === 'LI')

/** Opens `trigger`'s menu and returns its item labels. Two events in two
 *  separate `act`s is only needed to *select* an item (see
 *  tests/storage-page.test.tsx); reading the labels needs the open click. */
async function openMenuLabels(trigger: HTMLElement): Promise<(string | null)[]> {
  await act(async () => {
    trigger.click()
  })
  return [
    ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
  ].map((el) => el.textContent)
}

test('the explorer lists blocks in seq order, not in the order the DTO array arrives in', async () => {
  await mount()

  // The fixture arrives seq 5, 1, 3 — so "same as the DTO" and "sorted by
  // seq" are genuinely different answers here.
  expect(currentBlocks.map((b) => b.seq)).toEqual([5, 1, 3])
  expect(rowNames()).toEqual(['First: seq 1', 'Second: seq 3', 'Third: seq 5'])
})

test('the explorer is structure only — no ordinals, no <ol>, no body, no images', async () => {
  const long = `${'A'.repeat(BLOCK_LABEL_MAX_LENGTH + 20)} tail`
  currentBlocks = [note('b-long', 1, `${long}\nA second line that is body, not a name`)]
  await mount()

  const pane = tree()
  // An ordinal number is exactly what this pane no longer shows.
  expect(pane.textContent).not.toContain('#')
  expect(pane.querySelectorAll('ol')).toHaveLength(0)
  expect(container.querySelectorAll('ol')).toHaveLength(0)
  expect(pane.querySelectorAll('img')).toHaveLength(0)

  // One line, truncated by `blockLabel` — never the block's second line.
  const name = rowNames()[0] ?? ''
  expect(name).toBe(`${'A'.repeat(BLOCK_LABEL_MAX_LENGTH)}…`)
  expect(name).not.toContain('\n')
  expect(pane.textContent).not.toContain('A second line that is body, not a name')

  // A kind badge, and the name — nothing else in the row's own click target.
  const rowButton = pane.querySelector('li > button[title]') as HTMLElement
  expect([...rowButton.children].map((el) => el.tagName)).toEqual(['SPAN', 'SPAN'])
  expect(rowButton.children[0]?.textContent).toBe('Note')
})

test('a block row offers exactly two actions: Edit and Delete', async () => {
  await mount()

  const row = topLevelItems()[0] as HTMLElement
  expect(row.querySelector('button[title]')?.getAttribute('title')).toBe('First: seq 1')

  const triggers = [...row.querySelectorAll('button[aria-haspopup="menu"]')]
  expect(triggers).toHaveLength(1)

  expect(await openMenuLabels(triggers[0] as HTMLElement)).toEqual(['Edit', 'Delete'])
})

test("a group's members nest beneath its group row rather than as top-level rows", async () => {
  // Groups arrive out of seq order, and the one ungrouped block has a higher
  // seq than either — so "ungrouped first, then groups by seq" is a different
  // answer from both the DTO order and a flat sort by seq.
  currentGroups = [group('g-late', 3, 'Group Late'), group('g-early', 1, 'Group Early')]
  currentBlocks = [
    note('b-late-2', 6, 'Late member: seq 6', 'g-late'),
    note('b-early', 4, 'Early member: seq 4', 'g-early'),
    note('b-out', 9, 'Ungrouped: seq 9'),
    note('b-late-1', 5, 'Late member: seq 5', 'g-late'),
  ]
  await mount()

  // Three top-level items: the ungrouped block's row, then the two groups in
  // ascending seq.
  const items = topLevelItems()
  expect(items).toHaveLength(3)
  expect(rowNames(items[0] as HTMLElement)).toEqual(['Ungrouped: seq 9'])
  expect((items[1] as HTMLElement).textContent).toContain('Group Early')
  expect((items[2] as HTMLElement).textContent).toContain('Group Late')

  // Every member is inside its own group's nested <ul>, in seq order — and
  // nowhere else.
  const earlySublist = (items[1] as HTMLElement).querySelector('ul') as HTMLElement
  const lateSublist = (items[2] as HTMLElement).querySelector('ul') as HTMLElement
  expect(earlySublist).not.toBeNull()
  expect(rowNames(earlySublist)).toEqual(['Early member: seq 4'])
  expect(rowNames(lateSublist)).toEqual(['Late member: seq 5', 'Late member: seq 6'])
  expect(rowNames()).toEqual([
    'Ungrouped: seq 9',
    'Early member: seq 4',
    'Late member: seq 5',
    'Late member: seq 6',
  ])
})

test('a group row is a folder: expanded by default, and collapsing hides its members', async () => {
  currentGroups = [group('g-1', 1, 'Group A')]
  currentBlocks = [note('b-in', 2, 'Member: seq 2', 'g-1')]
  await mount()

  const toggle = tree().querySelector('button[aria-expanded]') as HTMLElement
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(rowNames()).toEqual(['Member: seq 2'])

  await act(async () => {
    toggle.click()
  })

  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(tree().querySelectorAll('li > button[title]')).toHaveLength(0)
})

test('a group row offers exactly two actions: Edit and Delete', async () => {
  currentGroups = [group('g-1', 1, 'Group A')]
  currentBlocks = []
  await mount()

  const groupRow = topLevelItems()[0] as HTMLElement
  const trigger = groupRow.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  expect(trigger).not.toBeNull()
  expect(await openMenuLabels(trigger)).toEqual(['Edit', 'Delete'])
})
