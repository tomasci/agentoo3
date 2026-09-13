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
// The second half of the file (from "the run settings" below) pins the page's
// own shape instead: title first, canvas under it, and the run-settings form
// reachable only through the header's Settings dialog.
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
import type { AgentSummary } from '../src/features/library'
import type { IdeaBlock, IdeaGroup } from '../src/features/ideas/hooks/use-idea-canvas'
import type { IdeaPrompt, IdeaRun } from '../src/features/ideas/hooks/use-idea-prompts'
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
const UPDATE_CLIENT = '@/shared/api/generated/clients/patchApiIdeasId'

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
let currentAgents: AgentSummary[] = []
/** The prompt-preview history and the run history the page reads — mutable so
 *  a test can put a previewed prompt, or a run carrying markdown, behind the
 *  same two endpoints every other test leaves empty. */
let currentPrompts: IdeaPrompt[] = []
let currentRuns: IdeaRun[] = []

/** Every PATCH /api/ideas/:id the page made, in order — the settings form's
 *  only observable output. */
let updateCalls: { path: { id: string }; body: Record<string, unknown> }[] = []
/** Set to make the next PATCH reject with an axios-shaped API failure, the
 *  shape `apiErrorMessage` reads its message out of. */
let updateFailure: unknown = null

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
  getApiIdeasIdPrompts: async () => ({ data: currentPrompts }),
}))
await mockModule(RUNS_CLIENT, () => ({
  getApiIdeasIdRuns: async () => ({ data: currentRuns }),
}))
await mockModule(UPDATE_CLIENT, () => ({
  patchApiIdeasId: async (options: {
    path: { id: string }
    body: Record<string, unknown>
  }) => {
    updateCalls.push({ path: options.path, body: options.body })
    if (updateFailure) throw updateFailure
    currentIdea = { ...currentIdea, ...(options.body as Partial<Idea>) }
    return { data: currentIdea }
  },
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
  client.setQueryData([{ url: '/api/library/agents' }], currentAgents)

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
  currentAgents = []
  currentPrompts = []
  currentRuns = []
  updateCalls = []
  updateFailure = null
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

// ---------------------------------------------------------------------------
// The page's own shape: title first, canvas under it, run settings only in a
// dialog. Everything below selects by field `name`, label text or button text
// — the settings dialog portals out of `container` into document.body, so
// "not on the page" and "in the dialog" are two different scopes, and each
// assertion says which one it means.
// ---------------------------------------------------------------------------

/** The id `idea-settings-dialog.tsx` gives its `<form>` and, separately,
 *  gives its footer submit button's `form=` attribute. Hard-coded rather than
 *  imported because the point of the test is that the two spellings the
 *  component emits agree with each other, not with a constant. */
const SETTINGS_FORM_ID = 'idea-settings-form'

const settle = async (ticks = 4) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const agent = (name: string, role: AgentSummary['role']): AgentSummary => ({
  name,
  role,
  team: false,
  description: `${name} description`,
  path: `/agents/${name}.md`,
  promptLines: 4,
  usedByProjects: 0,
})

/** Every `<button>` under `scope` whose visible text is exactly `text`. */
const buttonsByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)

const settingsForm = () => document.getElementById(SETTINGS_FORM_ID) as HTMLFormElement | null

/** The dialog panel holding the settings form — `data-part="content"` is
 *  Ark's own naming, and it is the element carrying open/closed state. */
const settingsPanel = () => settingsForm()?.closest('[data-part="content"]') as HTMLElement | null

const openSettings = async () => {
  const triggers = buttonsByText(container, 'Settings')
  expect(triggers).toHaveLength(1)
  await act(async () => {
    triggers[0]?.click()
  })
  await settle()
}

/** Found by text inside the dialog panel, deliberately *not* by
 *  `[form=…]`: the `form` attribute is the thing under test in the wiring
 *  test below, so locating the button through it would assume the answer. */
const saveButton = () => {
  const panel = settingsPanel()
  if (!panel) throw new Error('settings dialog not in the document')
  const found = [...panel.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Save changes'),
  )
  if (!found) throw new Error('no Save changes button in the settings dialog')
  return found
}

/**
 * Types into a controlled field the way a browser does — see the identical
 * helper in tests/session-page-scroll.test.tsx: assigning `.value` leaves
 * React's own value tracker in step, so `onChange` never fires.
 */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const field = <T extends HTMLElement>(selector: string) =>
  settingsForm()?.querySelector(selector) as T | null

/**
 * Raises the budget by one step through the NumberInput's own increment
 * trigger.
 *
 * Not by typing: Zag's number input reads keystrokes through React's
 * `onInput`, which — unlike `onChange` — React does not dispatch for a
 * programmatic `input` event, so a synthetic keystroke changes the DOM node's
 * value and nothing else (verified against `NumberInput` in isolation). The
 * trigger is a real user affordance and goes through the same
 * `onValueChange` -> `Controller` path a keystroke would.
 */
const bumpBudget = async () => {
  const inc = settingsForm()?.querySelector(
    '[data-part="increment-trigger"]',
  ) as HTMLElement | null
  if (!inc) throw new Error('no budget increment trigger in the settings dialog')
  // pointerdown starts Zag's press-and-hold spinner, pointerup ends it; the
  // click alone is not what the machine listens for.
  await act(async () => {
    inc.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    inc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    inc.click()
  })
  await settle()
}

test('the title is the first thing on the page, with the canvas directly under it', async () => {
  await mount()

  const heading = [...container.querySelectorAll('h1')].find((h) => h.textContent === 'An idea')
  expect(heading).toBeDefined()

  // PageHeader is `<div.root><div.text><h1/></div><div.actions/></div>`, so
  // two hops up from the h1 is the header element, and one more is the page.
  const header = heading?.parentElement?.parentElement as HTMLElement
  const page = header.parentElement as HTMLElement

  // Nothing above the title — in particular not the back-to-board row.
  expect(page.firstElementChild).toBe(header)

  // The canvas is the very next block, and the sections keep their order
  // under it. `Runs` lives inside the prompts block, hence five children.
  expect([...page.querySelectorAll('h1, h2')].map((h) => h.textContent)).toEqual([
    'An idea',
    'Canvas',
    'Files',
    'Feedback',
    'Prompt Preview',
    'Runs',
  ])
  expect(page.children[1]?.textContent).toContain('Canvas')

  // Back to board is inside the header's actions, not a row of its own.
  const back = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Back to board')
  expect(back).toBeDefined()
  expect(header.contains(back ?? null)).toBe(true)
  expect(back?.getAttribute('href')).toBe('/projects/p1/ideas')
})

test('the lastError alert sits between the header and the canvas', async () => {
  currentIdea = idea({ lastError: 'Handoff exploded' })
  await mount()

  const heading = [...container.querySelectorAll('h1')].find((h) => h.textContent === 'An idea')
  const header = heading?.parentElement?.parentElement as HTMLElement
  const page = header.parentElement as HTMLElement

  expect(page.children[1]?.textContent).toContain('Handoff exploded')
  expect(page.children[2]?.textContent).toContain('Canvas')
})

test('the run settings are nowhere on the page body — the dialog holding them is closed', async () => {
  await mount()

  // None of the four controls, and none of their labels, in the page itself.
  expect(container.querySelector('input[name="title"]')).toBeNull()
  expect(container.querySelector('select[name="orchestrator"]')).toBeNull()
  expect(container.querySelector('input[name="baseBranch"]')).toBeNull()
  expect(container.querySelector('input[name="maxBudgetUsd"]')).toBeNull()
  expect(buttonsByText(container, 'Save changes')).toHaveLength(0)
  expect(container.textContent).not.toContain('Save changes')
  expect(container.textContent).not.toContain('Base branch')
  expect(container.textContent).not.toContain('Spend cap')
  expect(container.textContent).not.toContain('Orchestrator')

  // The form is mounted — Ark keeps a closed dialog's content in the DOM —
  // but in document.body's portal, behind a `hidden` panel, never in the page.
  const form = settingsForm()
  expect(form).not.toBeNull()
  expect(container.contains(form)).toBe(false)
  const panel = settingsPanel()
  expect(panel?.getAttribute('data-state')).toBe('closed')
  expect(panel?.hasAttribute('hidden')).toBe(true)
})

test('the Settings button opens a dialog holding all four run-settings fields', async () => {
  currentIdea = idea({ orchestrator: 'lead', baseBranch: 'release/7', maxBudgetUsd: 42 })
  currentAgents = [agent('lead', 'orchestrator')]
  await mount()
  await openSettings()

  const panel = settingsPanel() as HTMLElement
  expect(panel.getAttribute('data-state')).toBe('open')
  expect(panel.hasAttribute('hidden')).toBe(false)

  // Each field is present, labelled, and seeded from the loaded row.
  const labelled = (text: string) => {
    const label = [...panel.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text))
    expect(label).toBeDefined()
    const control = document.getElementById(label?.getAttribute('for') ?? '')
    expect(control).not.toBeNull()
    return control as HTMLInputElement | HTMLSelectElement
  }
  expect(labelled('Title').getAttribute('name')).toBe('title')
  expect((labelled('Title') as HTMLInputElement).value).toBe('An idea')
  expect(labelled('Orchestrator').getAttribute('name')).toBe('orchestrator')
  expect((labelled('Orchestrator') as HTMLSelectElement).value).toBe('lead')
  expect(labelled('Base branch').getAttribute('name')).toBe('baseBranch')
  expect((labelled('Base branch') as HTMLInputElement).value).toBe('release/7')
  expect(labelled('Spend cap (USD)').getAttribute('name')).toBe('maxBudgetUsd')
  expect((labelled('Spend cap (USD)') as HTMLInputElement).value).toBe('42')

  expect(saveButton()).toBeDefined()
})

test('the budget field still bounds itself to 1..1000', async () => {
  currentIdea = idea({ maxBudgetUsd: 500 })
  await mount()
  await openSettings()

  const budget = field<HTMLInputElement>('input[name="maxBudgetUsd"]') as HTMLInputElement
  expect(budget.getAttribute('aria-valuemin')).toBe('1')
  expect(budget.getAttribute('aria-valuemax')).toBe('1000')
})

test('the orchestrator options are the library\'s orchestrators plus None — subagents excluded', async () => {
  currentAgents = [
    agent('lead', 'orchestrator'),
    agent('helper', 'subagent'),
    agent('second-lead', 'orchestrator'),
  ]
  await mount()
  await openSettings()

  const select = field<HTMLSelectElement>('select[name="orchestrator"]') as HTMLSelectElement
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ['', 'None'],
    ['lead', 'lead'],
    ['second-lead', 'second-lead'],
  ])

  // With orchestrators in the library the field shows the hint, not the
  // "library is empty" message.
  const panel = settingsPanel() as HTMLElement
  expect(panel.textContent).toContain(
    'The agent from the library that drives the session once this idea is handed off.',
  )
  expect(panel.textContent).not.toContain('No orchestrator agents in the library yet')
})

test('an empty agent library swaps the orchestrator hint for the empty-library message', async () => {
  currentAgents = []
  await mount()
  await openSettings()

  const select = field<HTMLSelectElement>('select[name="orchestrator"]') as HTMLSelectElement
  expect([...select.options].map((o) => o.value)).toEqual([''])

  const panel = settingsPanel() as HTMLElement
  expect(panel.textContent).toContain(
    'No orchestrator agents in the library yet. Add one with role: orchestrator.',
  )
  expect(panel.textContent).not.toContain('The agent from the library that drives the session')
})

test('the footer save button sits outside the form and is wired to it by id', async () => {
  await mount()
  await openSettings()

  const form = settingsForm() as HTMLFormElement
  const save = saveButton()

  expect(form.id).toBe(SETTINGS_FORM_ID)
  // The whole point of the `form=` attribute: the button is not a descendant.
  expect(form.contains(save)).toBe(false)
  expect(save.getAttribute('type')).toBe('submit')
  expect(save.getAttribute('form')).toBe(form.id)
  // Resolved association, not just matching strings.
  expect(save.form).toBe(form)
})

test('clicking the footer save button submits the form and PATCHes the idea', async () => {
  currentIdea = idea({ orchestrator: 'lead', baseBranch: 'release/7', maxBudgetUsd: 42 })
  currentAgents = [agent('lead', 'orchestrator')]
  await mount()
  await openSettings()

  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.path).toEqual({ id: 'idea-1' })
  expect(updateCalls[0]?.body).toEqual({
    title: 'An idea',
    orchestrator: 'lead',
    baseBranch: 'release/7',
    maxBudgetUsd: 42,
  })

  // A saved dialog closes itself.
  expect(settingsPanel()?.getAttribute('data-state')).toBe('closed')
})

test('edited values reach the PATCH body, with the base branch trimmed', async () => {
  currentIdea = idea({ maxBudgetUsd: 42 })
  await mount()
  await openSettings()

  await type(field<HTMLInputElement>('input[name="title"]') as HTMLInputElement, 'Renamed idea')
  await type(
    field<HTMLInputElement>('input[name="baseBranch"]') as HTMLInputElement,
    '  release/8  ',
  )
  await bumpBudget()

  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.body).toEqual({
    title: 'Renamed idea',
    orchestrator: null,
    baseBranch: 'release/8',
    maxBudgetUsd: 43,
  })
})

test('cleared and never-set optional fields go over the wire as null, not "" or NaN', async () => {
  // Base branch set (so clearing it is a real change), budget and
  // orchestrator never set — between them the three shapes the mapping has
  // to turn into `null`.
  currentIdea = idea({ orchestrator: null, baseBranch: 'release/7', maxBudgetUsd: null })
  await mount()
  await openSettings()

  // Whitespace only: zod's own `.trim()` plus the submit mapping's
  // `trim() ? … : null` have to agree that this is "cleared".
  await type(field<HTMLInputElement>('input[name="baseBranch"]') as HTMLInputElement, '   ')

  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.body).toEqual({
    title: 'An idea',
    orchestrator: null,
    baseBranch: null,
    maxBudgetUsd: null,
  })
})

test('choosing an orchestrator in the dialog carries it into the PATCH body', async () => {
  currentAgents = [agent('lead', 'orchestrator'), agent('helper', 'subagent')]
  await mount()
  await openSettings()

  const panel = settingsPanel() as HTMLElement
  const trigger = panel.querySelector(
    '[data-scope="select"][data-part="trigger"]',
  ) as HTMLElement
  await act(async () => {
    trigger.click()
  })
  await settle()
  const option = [...document.body.querySelectorAll('[data-scope="select"][role="option"]')].find(
    (el) => el.textContent?.startsWith('lead'),
  ) as HTMLElement
  expect(option).toBeDefined()
  // Two events in two `act`s — see selectRowMenuItem in storage-page.test.tsx
  // for why zag needs the highlight transition to land before the click.
  await act(async () => {
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
  })
  await act(async () => {
    option.click()
  })
  await settle()

  expect((field<HTMLSelectElement>('select[name="orchestrator"]') as HTMLSelectElement).value).toBe(
    'lead',
  )

  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.body.orchestrator).toBe('lead')
})

test('an empty title is refused by the resolver and never reaches the API', async () => {
  await mount()
  await openSettings()

  await type(field<HTMLInputElement>('input[name="title"]') as HTMLInputElement, '')
  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(0)
  expect(settingsPanel()?.textContent).toContain('Give the idea a title')
  // Still open, so the reader can fix it.
  expect(settingsPanel()?.getAttribute('data-state')).toBe('open')
})

test('a rejected save shows the API message and leaves the dialog open', async () => {
  updateFailure = { response: { data: { error: 'Base branch does not exist' } } }
  await mount()
  await openSettings()

  await act(async () => {
    saveButton().click()
  })
  await settle()

  expect(updateCalls).toHaveLength(1)
  expect(settingsPanel()?.textContent).toContain('Base branch does not exist')
  expect(settingsPanel()?.getAttribute('data-state')).toBe('open')
  // Re-enabled, not stuck in its loading state.
  expect(saveButton().hasAttribute('disabled')).toBe(false)
})

test('cancelling and reopening re-seeds the form from the saved row, not the abandoned edit', async () => {
  currentIdea = idea({ baseBranch: 'release/7' })
  await mount()
  await openSettings()

  await type(field<HTMLInputElement>('input[name="title"]') as HTMLInputElement, 'Abandoned edit')
  await type(field<HTMLInputElement>('input[name="baseBranch"]') as HTMLInputElement, 'scratch')

  const panel = settingsPanel() as HTMLElement
  const cancel = [...panel.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')
  expect(cancel).toBeDefined()
  await act(async () => {
    cancel?.click()
  })
  await settle()
  expect(settingsPanel()?.getAttribute('data-state')).toBe('closed')

  await openSettings()
  expect((field<HTMLInputElement>('input[name="title"]') as HTMLInputElement).value).toBe('An idea')
  expect((field<HTMLInputElement>('input[name="baseBranch"]') as HTMLInputElement).value).toBe(
    'release/7',
  )
  expect(updateCalls).toHaveLength(0)
})

test('a background refetch of the idea row does not overwrite what is being typed', async () => {
  await mount()
  await openSettings()

  await type(field<HTMLInputElement>('input[name="title"]') as HTMLInputElement, 'Half typed')

  // What the 1.5s busy poll does: the same row comes back with new values
  // while the dialog is open. The header must follow it; the open form must
  // not, or the reader loses the words under their cursor.
  currentIdea = idea({ title: 'Renamed elsewhere', baseBranch: 'release/9' })
  await act(async () => {
    await client.invalidateQueries({ queryKey: [{ url: '/api/ideas/:id', params: { id: 'idea-1' } }] })
  })
  await settle()

  expect([...container.querySelectorAll('h1')].map((h) => h.textContent)).toContain(
    'Renamed elsewhere',
  )
  expect((field<HTMLInputElement>('input[name="title"]') as HTMLInputElement).value).toBe(
    'Half typed',
  )
  expect((field<HTMLInputElement>('input[name="baseBranch"]') as HTMLInputElement).value).toBe('')
})

// ---------------------------------------------------------------------------
// The prompt section as a *preview*, the copy that says so, the link out to
// the session the idea was handed off to, and the run history's markdown.
//
// The wording matters here in a way it usually does not: the section used to
// be called "Generated prompts" with a "Generate prompt" button, which read
// as "this is the prompt that will be used". It is not — the real one is
// regenerated at hand-off. So these assert both the new spellings and the
// absence of the old ones, in the page and in the portalled dialogs it owns.
// ---------------------------------------------------------------------------

const PROMPT_HEADING = 'Prompt Preview'
const RUNS_HEADING = 'Runs'

/** The old wording, verbatim from the locale file before the relabelling
 *  (git 96148e3): the heading, the idle button, and the regenerate button. */
const OLD_PROMPT_WORDING = [/generated prompts/i, /generate prompt/i, /\bRegenerate\b/]

const prompt = (overrides: Partial<IdeaPrompt> = {}): IdeaPrompt => ({
  id: 'prompt-1',
  ideaId: 'idea-1',
  kind: 'initial',
  sourceDigest: 'digest',
  generatedTitle: null,
  generatedText: null,
  assumptions: null,
  model: null,
  costUsd: null,
  status: 'ready',
  error: null,
  createdAt: T,
  completedAt: T,
  ...overrides,
})

const run = (overrides: Partial<IdeaRun> = {}): IdeaRun => ({
  id: 'run-1',
  ideaId: 'idea-1',
  sessionId: 's-9',
  promptId: 'prompt-1',
  promptMessageId: null,
  kind: 'initial',
  status: 'closed',
  outcome: 'finished',
  detail: null,
  startedAt: T,
  // Ended: an open run makes `useIdeaRuns` poll every 1.5s, which none of
  // these tests need.
  endedAt: T,
  ...overrides,
})

/** The `<h2>` with exactly this text, and the two blocks around it:
 *  `PageHeader` renders `<div.root><div.text><h2/><p.description/></div>
 *  <div.actions/></div>`, so the heading's parent is the text block and its
 *  grandparent is the header. `body` is the element holding the header and
 *  whatever the section renders under it. */
function section(headingText: string) {
  const heading = [...container.querySelectorAll('h2')].find((h) => h.textContent === headingText)
  if (!heading) throw new Error(`no <h2> reading ${JSON.stringify(headingText)} on the page`)
  const text = heading.parentElement as HTMLElement
  const header = text.parentElement as HTMLElement
  return { heading, text, header, body: header.parentElement as HTMLElement }
}

/** The single action button in a section header — the prompt card has exactly
 *  one, and which label it carries is the thing under test. */
function headerAction(headingText: string): HTMLButtonElement {
  const { header } = section(headingText)
  const found = [...header.querySelectorAll('button')]
  // Counts, tag names and text throughout the tests below rather than the
  // nodes themselves: a failed `expect(node).not.toBeNull()` asks bun to
  // pretty-print a happy-dom element, which takes minutes, so every assertion
  // here is written to fail with a primitive.
  expect(found.length).toBe(1)
  return found[0] as HTMLButtonElement
}

/** Anchors are how a user leaves the page: found by their visible text, and
 *  checked by `href`, because `<Link>`'s own props are not what a click uses. */
const linkByText = (text: string) =>
  [...container.querySelectorAll('a')].filter((a) => a.textContent?.trim() === text)

test('the prompt section is headed Prompt Preview and offers Preview Prompt when nothing is previewed yet', async () => {
  currentPrompts = []
  await mount()

  const { heading, body } = section(PROMPT_HEADING)
  expect(heading.textContent).toBe(PROMPT_HEADING)
  expect(headerAction(PROMPT_HEADING).textContent?.trim()).toBe('Preview Prompt')
  expect(body.textContent).toContain('No prompt previewed yet.')

  // Nothing anywhere on the page — or in the dialogs it portals into
  // document.body — still says "generate"/"generated prompts".
  for (const pattern of OLD_PROMPT_WORDING) {
    expect(container.textContent ?? '').not.toMatch(pattern)
    expect(document.body.textContent ?? '').not.toMatch(pattern)
  }
})

test('once a prompt exists the action reads Refresh Preview, not Regenerate', async () => {
  currentPrompts = [prompt({ status: 'ready' })]
  await mount()

  expect(headerAction(PROMPT_HEADING).textContent?.trim()).toBe('Refresh Preview')
  expect(section(PROMPT_HEADING).heading.textContent).toBe(PROMPT_HEADING)
  for (const pattern of OLD_PROMPT_WORDING) {
    expect(container.textContent ?? '').not.toMatch(pattern)
    expect(document.body.textContent ?? '').not.toMatch(pattern)
  }
})

test('a prompt still being produced disables the action and labels it Previewing…', async () => {
  currentPrompts = [prompt({ status: 'pending', completedAt: null })]
  await mount()

  const action = headerAction(PROMPT_HEADING)
  expect(action.textContent?.trim()).toBe('Previewing…')
  expect(action.hasAttribute('disabled')).toBe(true)
  for (const pattern of OLD_PROMPT_WORDING) {
    expect(container.textContent ?? '').not.toMatch(pattern)
  }
})

test('the preview hint sits in the header description, and says both what the preview is and what replaces it', async () => {
  await mount()

  const { heading, text, header } = section(PROMPT_HEADING)

  // The description slot specifically: the `<p>` PageHeader renders directly
  // after the heading, inside the text block — not a paragraph somewhere
  // further down the card, and not in the actions.
  const description = heading.nextElementSibling as HTMLElement | null
  expect(description?.tagName ?? '(nothing after the heading)').toBe('P')
  expect(text.contains(description)).toBe(true)

  const copy = description?.textContent ?? ''
  // Claim one: it is the canvas as it is right now.
  expect(copy).toContain('canvas as it looks right now')
  // Claim two: the real prompt is regenerated at "Selected for development".
  expect(copy).toContain('Selected for development')
  expect(copy).toContain('regenerates the prompt fresh')
  // And it says outright that this is not the prompt that gets used.
  expect(copy).toContain("isn't the prompt that will actually be used")

  // Rendered next to the heading, not swallowed by the button row.
  const actions = header.querySelector('button')?.parentElement
  expect(actions?.contains(description ?? null)).toBe(false)
})

// A session exists in more than one state, and the link out to it is not a
// "currently running" indicator — it is the idea's record of where it went.
// Each state gets its own mount: `afterEach` unmounts exactly one page.
for (const sessionStatus of [null, 'idle', 'running', 'error', 'closed']) {
  test(`the header links to the session while its status is ${sessionStatus ?? 'unknown'}`, async () => {
    currentIdea = idea({ sessionId: 'sess-42', sessionStatus })
    await mount()

    const links = linkByText('View Session')
    expect(links.length).toBe(1)
    expect(links[0]?.getAttribute('href')).toBe('/projects/p1/sessions/sess-42')

    // In the page header's actions, next to Back to board.
    const h1 = [...container.querySelectorAll('h1')].find((h) => h.textContent === 'An idea')
    const header = h1?.parentElement?.parentElement as HTMLElement
    expect(header.contains(links[0] ?? null)).toBe(true)
  })
}

test('an idea with no session offers no link to one', async () => {
  currentIdea = idea({ sessionId: null })
  await mount()

  expect(linkByText('View Session').length).toBe(0)
  expect(container.textContent ?? '').not.toContain('View Session')
  expect(
    [...container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => href.includes('/sessions/')),
  ).toEqual([])
})

test("a run's detail renders as markdown elements, not as literal ## and - characters", async () => {
  const detail = '## Heading\n\n- one\n- two\n\n```js\ncode\n```\n\n[docs](https://example.com)'
  currentRuns = [run({ detail })]
  await mount()

  const { body } = section(RUNS_HEADING)
  const entries = [...body.querySelectorAll('li')].filter((li) =>
    li.textContent?.includes('Heading'),
  )
  expect(entries.length).toBe(1)
  const entry = entries[0] as HTMLElement

  // Real elements, with the text the source said — a heading level below the
  // section's own `<h2>`… (react-markdown maps `##` to `<h2>`, so this one is
  // found inside the entry rather than by document order).
  expect(entry.querySelector('h2')?.textContent ?? '(no <h2> in the run entry)').toBe(
    'Heading',
  )

  // …a real list…
  const items = [...entry.querySelectorAll('ul > li')].map((li) => li.textContent)
  expect(items).toEqual(['one', 'two'])

  // …and a real fenced block.
  expect(
    entry.querySelector('pre > code')?.textContent ?? '(no <pre><code> in the run entry)',
  ).toContain('code')

  // The failure this is really about: the whole detail arriving as one text
  // node with its own syntax still in it.
  expect(entry.textContent ?? '').not.toContain('##')
  expect(entry.textContent ?? '').not.toContain('```')
  expect(entry.textContent ?? '').not.toContain('- one')

  // The shared `Markdown` component and not some other renderer: only that one
  // forces links away from the app (shared/ui/core/markdown.tsx).
  const link = entry.querySelector('a[href="https://example.com"]')
  expect(link?.getAttribute('target') ?? '(no link to example.com)').toBe('_blank')
  expect(link?.getAttribute('rel') ?? '(no link to example.com)').toBe('noopener noreferrer')
})

test("a run's detail is displayed, never executed", async () => {
  // A run detail is written by the handoff track from whatever the session
  // reported, so it is not trusted markup. The shared renderer escapes raw
  // HTML (shared/ui/core/markdown.tsx); this pins that the run path gets the
  // same treatment rather than an `innerHTML` of its own.
  currentRuns = [run({ detail: 'Boom <img src=x onerror="alert(1)"> <script>alert(2)</script>' })]
  await mount()

  const { body } = section(RUNS_HEADING)
  const entry = [...body.querySelectorAll('li')].find((li) => li.textContent?.includes('Boom'))
  expect(entry === undefined).toBe(false)
  expect(entry?.querySelectorAll('img').length).toBe(0)
  expect(entry?.querySelectorAll('script').length).toBe(0)
  // Shown as text, which is the point.
  expect(entry?.textContent ?? '').toContain('onerror')
})

// `null` is what the API sends for "no detail"; `''` is what a zero-length
// string from the same column would look like. Neither should mount a
// renderer with nothing in it.
for (const detail of [null, '']) {
  test(`a run whose detail is ${detail === null ? 'null' : 'empty'} renders its badges and no empty markdown block`, async () => {
    currentRuns = [run({ detail, status: 'running', outcome: null, endedAt: T })]
    await mount()

    const { body } = section(RUNS_HEADING)
    const entries = [...body.querySelectorAll('li')].filter((li) =>
      li.textContent?.includes('Running'),
    )
    expect(entries.length).toBe(1)
    const entry = entries[0] as HTMLElement

    // Just the badge/timestamp row — nothing else mounted for an absent detail.
    expect(entry.children.length).toBe(1)
    expect(entry.querySelector('p')?.textContent ?? null).toBeNull()
    expect(entry.textContent).toContain('Initial')
    expect(entry.textContent).toContain('Running')
  })
}
