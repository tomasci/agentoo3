// Render smoke tests for the Idea Manager's board (T11): every column shows
// even with nothing in it, a stuck card's `lastError` is surfaced, and moving
// a card into `selected_for_development` — the one move that starts real,
// paid work — asks first and only fires the request once that is confirmed.
//
// Mounted through the real router (same technique as tests/workspace.test.tsx)
// rather than the bare component: `IdeaCard` links to the detail route with a
// real `<Link>`, which throws outside a mounted router, and `ProjectLayout`
// (the parent of every `/projects/$projectId/*` route) needs a real
// `useProjects()` answer before it renders this page's `Outlet` at all.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import { routeTree } from '../src/app/router'
import type { Idea } from '../src/features/ideas/hooks/use-ideas'

const IDEAS_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdIdeas'
const MOVE_CLIENT = '@/shared/api/generated/clients/postApiIdeasIdMove'

let ideas: Idea[] = []
let moveCalls: { path: { id: string }; body?: { status: string } }[] = []

/** Strips whatever the generated client adds beyond `path`/`body` (today,
 * `throwOnError: true`) — this file only cares what status a call moved an
 * idea to, not the transport option every call carries identically. */
const asMoveCall = (opts: { path: { id: string }; body?: { status: string } }) => ({
  path: opts.path,
  body: opts.body,
})

await mockModule(IDEAS_CLIENT, () => ({
  getApiProjectsIdIdeas: async () => ({ data: ideas }),
}))

await mockModule(MOVE_CLIENT, () => ({
  postApiIdeasIdMove: async (opts: { path: { id: string }; body?: { status: string } }) => {
    moveCalls.push(asMoveCall(opts))
    const found = ideas.find((i) => i.id === opts.path.id)
    return { data: { ...(found as Idea), status: opts.body?.status ?? found?.status } }
  },
}))

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
  blockCount: 0,
  commentCount: 0,
  assetCount: 0,
  latestPrompt: null,
  sessionStatus: null,
  openRun: null,
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
  ...overrides,
})

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

async function mount(path = '/projects/p1/ideas') {
  container = document.createElement('div')
  document.body.append(container)

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded directly rather than mocked: neither is under test here, and
  // seeding is what `ProjectLayout`/the shell need to render this page's
  // `Outlet` at all (see tests/workspace.test.tsx's identical `mount`).
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
  await settle()
}

const settle = async () => {
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
  ideas = []
  moveCalls = []
})

afterEach(unmount)

const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

/** Every card's own menu trigger, in document order — scoped to `<main>` so
 * the tab bar's own dropdown (the mobile tab switcher, `aria-haspopup="menu"`
 * too) never counts as card 0. Same idiom as tests/storage-page.test.tsx's
 * `menuTriggers`, scoped the same way that file's own `main()` helper is. */
const menuTriggers = () =>
  [
    ...(container.querySelector('main')?.querySelectorAll('button[aria-haspopup="menu"]') ?? []),
  ] as HTMLElement[]

/** Opens the given card's menu and selects the item labelled `label` — two
 * events, each its own `act`, for the same reason storage-page.test.tsx's
 * `selectRowMenuItem` documents (Zag's menu machine sets `highlightedValue`
 * off `pointerdown` and reads it back on `click`). */
async function selectMenuItem(triggerIndex: number, label: string) {
  const trigger = menuTriggers()[triggerIndex]
  if (!trigger) throw new Error(`no menu trigger at index ${triggerIndex}`)
  await act(async () => {
    trigger.click()
  })
  const items = [
    ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
  ] as HTMLElement[]
  const item = items.find((el) => el.textContent?.includes(label))
  if (!item) {
    throw new Error(`no open menu item "${label}" among ${items.map((i) => i.textContent).join(', ')}`)
  }
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
  })
  await act(async () => {
    item.click()
  })
  await settle()
}

/** The one `ConfirmDialog` open at a time, if any — see
 * tests/storage-page.test.tsx's identical helper and its own comment on why
 * `data-state="open"` is load-bearing (Ark's Dialog never unmounts its
 * `Content`, so a bare `[role="alertdialog"]` would match a closed one). */
const openDialogButtons = () => {
  const dialog = document.body.querySelector('[role="alertdialog"][data-state="open"]')
  return dialog ? ([...dialog.querySelectorAll('button')] as HTMLElement[]) : []
}
const findDialogButton = (text: string) => openDialogButtons().find((b) => b.textContent?.includes(text))

test('every column renders, including the ones with nothing in it', async () => {
  ideas = [idea({ id: 'i1', title: 'Only one so far', status: 'backlog' })]
  await mount()

  // All six, in board order — the columns this idea's own status never
  // touches say so themselves rather than not existing.
  for (const heading of [
    'Backlog',
    'To do',
    'Selected for development',
    'In progress',
    'Verification',
    'Done',
  ]) {
    expect(container.textContent).toContain(heading)
  }
  expect(container.textContent).toContain('Only one so far')
  // Five empty columns, each saying so.
  const emptyCount = [...container.querySelectorAll('p')].filter(
    (p) => p.textContent === 'No ideas in this column yet.',
  ).length
  expect(emptyCount).toBe(5)
})

test('a card with lastError surfaces it prominently, not silently', async () => {
  ideas = [
    idea({
      id: 'i1',
      title: 'Stuck idea',
      status: 'in_progress_dev',
      lastError: 'The worktree could not be created: disk full',
    }),
  ]
  await mount()

  expect(container.textContent).toContain('Why this is stuck')
  expect(container.textContent).toContain('The worktree could not be created: disk full')
})

test('moving a card into "Selected for development" asks first, and only fires on confirm', async () => {
  ideas = [idea({ id: 'i1', title: 'Ready to build', status: 'todo' })]
  await mount()

  await selectMenuItem(0, 'Selected for development')

  // Asked, not acted on yet.
  expect(moveCalls).toEqual([])
  expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Start development on this idea?')

  const confirm = findDialogButton('Start development')
  if (!confirm) throw new Error('no confirm button in the move dialog')
  await click(confirm)

  expect(moveCalls).toEqual([{ path: { id: 'i1' }, body: { status: 'selected_for_development' } }])
})

test('moving a card anywhere else fires immediately, with no confirmation', async () => {
  ideas = [idea({ id: 'i1', title: 'Not ready', status: 'backlog' })]
  await mount()

  await selectMenuItem(0, 'To do')

  expect(moveCalls).toEqual([{ path: { id: 'i1' }, body: { status: 'todo' } }])
  expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).toBeNull()
})

test('dismissing the confirm dialog never moves the card', async () => {
  ideas = [idea({ id: 'i1', title: 'Ready to build', status: 'todo' })]
  await mount()

  await selectMenuItem(0, 'Selected for development')
  const cancel = findDialogButton('Cancel')
  if (!cancel) throw new Error('no cancel button in the move dialog')
  await click(cancel)

  expect(moveCalls).toEqual([])
})
