// The per-project Sessions page (`ProjectSessions`, route
// `/projects/$projectId/sessions`) after its rework from an always-open form
// plus a card grid into a header button, a "New session" dialog and a
// searchable data table:
//
//   1. the create form lives in a modal opened from the page header — the
//      request body it builds, success closing it, an API error shown inside
//      it, a stale error never surviving a close/reopen, and the submit gated
//      on the project being `ready`;
//   2. the list is a four-column table (Title link, Date, Status, actions)
//      with none of the old card's extra fields, in the API's own order, and
//      an Open/Delete menu whose Delete confirms first and toasts a failure;
//   3. a search box filters on the *displayed* title, says so when nothing
//      matches, and is absent (with the table) when there are no sessions.
//
// Mounted through the real router, the way tests/idea-board-page.test.tsx
// mounts its page: the title cell is a real `<Link>` and `ProjectLayout`
// needs a seeded `useProjects()` answer before it renders the page at all.
// The three generated clients the page's hooks reach are mocked per-file
// through ./mock-module; everything above them (react-query, the hooks, the
// components) is real. Toasts are read off the real `<Toaster />` mounted
// beside the router, the way tests/session-page-header.test.tsx does.
//
// Copy is the real English bundle (the app's own i18n instance), so the
// assertions read the way the page does.
//
// Assertions compare primitives, never DOM nodes: bun pretty-printing a
// happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentSummary } from '../src/features/library'
import type { Session } from '../src/features/sessions/hooks/use-sessions'
import { mockModule } from './mock-module'

const LIST_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'
const CREATE_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdSessions'
const DELETE_CLIENT = '@/shared/api/generated/clients/deleteApiSessionsId'
// Only reached by the "Open" action navigating to the single-session route.
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'A session',
  status: 'idle',
  orchestrator: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/alpha',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
  ...overrides,
})

type CreateCall = { path: { id: string }; body: Record<string, unknown> }
type DeleteCall = { path: { id: string } }

let sessions: Session[] = []
let listCalls = 0
let createCalls: CreateCall[] = []
let createFailure: unknown = null
/** When set, the create client awaits this before settling. */
let createGate: Promise<void> | null = null
let deleteCalls: DeleteCall[] = []
let deleteFailure: unknown = null

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => {
    listCalls++
    return { data: sessions }
  },
}))
await mockModule(CREATE_CLIENT, () => ({
  postApiProjectsIdSessions: async (opts: CreateCall) => {
    createCalls.push({ path: { ...opts.path }, body: { ...opts.body } })
    if (createGate) await createGate
    if (createFailure) throw createFailure
    const created = session({ id: 'new-1', title: (opts.body.title as string) ?? null })
    sessions = [created, ...sessions]
    return { data: created }
  },
}))
await mockModule(DELETE_CLIENT, () => ({
  deleteApiSessionsId: async (opts: DeleteCall) => {
    deleteCalls.push({ path: { ...opts.path } })
    if (deleteFailure) throw deleteFailure
    sessions = sessions.filter((s) => s.id !== opts.path.id)
    return { data: { ok: true } }
  },
}))
await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: sessions.find((s) => s.id === opts.path.id) ?? session({ id: opts.path.id }),
  }),
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))

/** happy-dom ships no EventSource — only the Open-navigation test needs one. */
class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { routeTree } = await import('../src/app/router')
const { Toaster, toast } = await import('../src/shared/ui/toast')

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  source: 'clone',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: '/srv/alpha',
  createdAt: '',
  updatedAt: '',
  ...overrides,
})

const agent = (name: string, role: AgentSummary['role']): AgentSummary => ({
  name,
  role,
  team: false,
  description: `${name} description`,
  path: `/agents/${name}.md`,
  promptLines: 4,
  usedByProjects: 0,
})

let currentProject = project()
let currentAgents: AgentSummary[] = []

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount(path = '/projects/p1/sessions') {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [currentProject])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/library/agents' }], currentAgents)

  root = createRoot(container)
  await act(async () => {
    root.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
  if (!main().textContent?.includes('Sessions')) throw new Error('sessions page never rendered')
}

beforeEach(() => {
  localStorage.clear()
  sessions = []
  listCalls = 0
  createCalls = []
  createFailure = null
  createGate = null
  deleteCalls = []
  deleteFailure = null
  currentProject = project()
  currentAgents = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  toast.close()
  document.body.replaceChildren()
})

// --- helpers ---------------------------------------------------------------

const main = () => {
  const m = container.querySelector('main')
  if (!m) throw new Error('no <main>')
  return m as HTMLElement
}

const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

/** Types into a controlled input the way a browser does — see
 *  tests/idea-detail-page.test.tsx's identical helper. */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(2)
}

const buttonsByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)

const newSessionButton = () => {
  const found = buttonsByText(main(), 'New session')
  if (found.length !== 1) throw new Error(`expected one New session button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}

/** The open New-session dialog, or null. Base UI unmounts a closed popup. */
const dialog = () =>
  ([...document.body.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes('New session'),
  ) ?? null) as HTMLElement | null

const openDialog = async () => {
  expect(dialog()).toBeNull()
  await click(newSessionButton(), 'New session button')
  const d = dialog()
  if (!d) throw new Error('New session dialog did not open')
  return d
}

const labelledControl = (scope: ParentNode, text: string): HTMLElement => {
  const label = [...scope.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text))
  if (!label) throw new Error(`no label starting with ${JSON.stringify(text)}`)
  const control = document.getElementById(label.getAttribute('for') ?? '')
  if (!control) throw new Error(`no control for label ${JSON.stringify(text)}`)
  return control
}
const input = (text: string) => labelledControl(dialog() as HTMLElement, text) as HTMLInputElement

const submitButton = () => {
  const d = dialog()
  if (!d) throw new Error('dialog not open')
  const found = [...d.querySelectorAll('button')].find(
    (b) => b.getAttribute('type') === 'submit',
  )
  if (!found) throw new Error('no submit button in the dialog')
  return found as HTMLButtonElement
}

const chooseOrchestrator = async (optionText: string) => {
  await click(labelledControl(dialog() as HTMLElement, 'Orchestrator'), 'orchestrator trigger')
  const option = [...document.body.querySelectorAll('[role="option"]')].find((el) =>
    el.textContent?.startsWith(optionText),
  )
  if (!option) throw new Error(`no open option starting with ${JSON.stringify(optionText)}`)
  await click(option, 'orchestrator option')
}

const table = () => main().querySelector('table')
const headerTexts = () =>
  [...(table()?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent?.trim() ?? '')
const bodyRows = () => [...(table()?.querySelectorAll('tbody tr') ?? [])] as HTMLElement[]
/** The title link text of each data row, in display order. */
const rowTitles = () =>
  bodyRows()
    .map((r) => r.querySelector('td a')?.textContent ?? null)
    .filter((t): t is string => t !== null)
const cellTexts = (row: HTMLElement) =>
  [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '')

const searchInput = () =>
  main().querySelector('input[aria-label="Search sessions…"]') as HTMLInputElement | null

const menuTriggers = () =>
  [...main().querySelectorAll('button[aria-haspopup="menu"]')].filter((b) =>
    b.getAttribute('aria-label')?.startsWith('Actions for'),
  ) as HTMLElement[]

async function selectMenuItem(rowIndex: number, label: string) {
  await click(menuTriggers()[rowIndex], `menu trigger ${rowIndex}`)
  const items = [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')]
  const item = items.find((el) => el.textContent?.trim() === label)
  if (!item) {
    throw new Error(`no menu item "${label}" among ${items.map((i) => i.textContent).join(', ')}`)
  }
  await click(item, 'menu item')
}
const menuItemLabels = () =>
  [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? '',
  )

const alertDialog = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null

// --- 1. the New session dialog ---------------------------------------------

test('the form is not on the page by default; the header button opens it in a modal', async () => {
  sessions = [session()]
  await mount()

  // None of the form's labels or its submit anywhere in the document.
  expect(dialog()).toBeNull()
  expect(document.body.textContent).not.toContain('Spend cap (USD)')
  expect(document.body.textContent).not.toContain('Create session')
  expect(main().querySelectorAll('form').length).toBe(0)

  const d = await openDialog()
  // Modal: Base UI marks the popup itself, and it is portalled out of <main>.
  expect(main().contains(d)).toBe(false)
  expect(d.querySelector('h2')?.textContent).toBe('New session')
  expect(input('Title').tagName).toBe('INPUT')
  expect(input('Base branch').tagName).toBe('INPUT')
  expect(labelledControl(d, 'Orchestrator').tagName).toBe('BUTTON')
  expect(input('Spend cap (USD)').getAttribute('type')).toBe('number')
  expect(submitButton().textContent?.trim()).toBe('Create session')
})

test('the orchestrator select offers None plus the library orchestrators, defaulting to None', async () => {
  currentAgents = [agent('lead', 'orchestrator'), agent('helper', 'subagent')]
  await mount()
  await openDialog()
  const trigger = labelledControl(dialog() as HTMLElement, 'Orchestrator')
  expect(trigger.textContent).toContain('None')
  await click(trigger, 'orchestrator trigger')
  const options = [...document.body.querySelectorAll('[role="option"]')].map(
    (o) => o.querySelector('span')?.textContent?.trim() ?? '',
  )
  expect(options).toEqual(['None', 'lead'])
})

test('an untouched form POSTs an empty body — every optional field omitted', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(createCalls).toEqual([{ path: { id: 'p1' }, body: {} }])
})

test('filled fields reach the body: title and base branch trimmed, budget a number', async () => {
  currentAgents = [agent('lead', 'orchestrator')]
  await mount()
  await openDialog()
  await type(input('Title'), '  Refactor auth  ')
  await type(input('Base branch'), '  release/8  ')
  // Whole dollars: the field is `min="1"` with no `step`, so native
  // constraint validation (step base 1, step 1) refuses a fraction before
  // the form ever submits — pre-existing, and not what this test is about.
  await type(input('Spend cap (USD)'), '12')
  await chooseOrchestrator('lead')
  await click(submitButton(), 'submit')

  expect(createCalls.length).toBe(1)
  expect(createCalls[0]?.body).toEqual({
    title: 'Refactor auth',
    orchestrator: 'lead',
    maxBudgetUsd: 12,
    baseBranch: 'release/8',
  })
  expect(typeof createCalls[0]?.body.maxBudgetUsd).toBe('number')
})

test('whitespace-only title and base branch are omitted, not sent as "" or "   "', async () => {
  await mount()
  await openDialog()
  await type(input('Title'), '   ')
  await type(input('Base branch'), '   ')
  await click(submitButton(), 'submit')
  expect(createCalls.length).toBe(1)
  expect(createCalls[0]?.body).toEqual({})
})

test('picking an orchestrator and then None again omits orchestrator', async () => {
  currentAgents = [agent('lead', 'orchestrator')]
  await mount()
  await openDialog()
  await chooseOrchestrator('lead')
  await chooseOrchestrator('None')
  await click(submitButton(), 'submit')
  expect(createCalls.length).toBe(1)
  expect('orchestrator' in (createCalls[0]?.body ?? {})).toBe(false)
})

test('a successful create closes the dialog and the new session shows up in the list', async () => {
  sessions = [session({ id: 's1', title: 'Old one' })]
  await mount()
  await openDialog()
  await type(input('Title'), 'Fresh one')
  await click(submitButton(), 'submit')
  expect(createCalls.length).toBe(1)
  expect(dialog()).toBeNull()
  expect(rowTitles()).toEqual(['Fresh one', 'Old one'])
})

test('while the create is in flight the submit is disabled and reads Creating…', async () => {
  let release: () => void = () => {}
  createGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(submitButton().disabled).toBe(true)
  expect(submitButton().textContent?.trim()).toBe('Creating…')
  await act(async () => {
    release()
  })
  await settle()
  expect(dialog()).toBeNull()
})

test("an API error is shown inside the dialog, which stays open", async () => {
  createFailure = { response: { status: 400, data: { error: 'Branch "nope" does not exist' } } }
  await mount()
  await openDialog()
  await type(input('Base branch'), 'nope')
  await click(submitButton(), 'submit')

  expect(createCalls.length).toBe(1)
  const d = dialog()
  expect(d).not.toBeNull()
  expect(d?.textContent).toContain('Branch "nope" does not exist')
  // In the dialog, not on the page behind it.
  expect(main().textContent).not.toContain('Branch "nope" does not exist')
  // And the reader's input is still there to fix.
  expect(input('Base branch').value).toBe('nope')
})

test('an error with no API message of its own falls back to "Could not create the session"', async () => {
  createFailure = { response: { status: 500, data: 'upstream exploded' } }
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(dialog()?.textContent).toContain('Could not create the session')
})

test('Cancel after an error, then reopening, shows no stale error', async () => {
  createFailure = { response: { status: 400, data: { error: 'boom from the API' } } }
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(dialog()?.textContent).toContain('boom from the API')

  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')
  expect(dialog()).toBeNull()

  const reopened = await openDialog()
  expect(reopened.textContent).not.toContain('boom from the API')
})

test('Escape after an error, then reopening, shows no stale error', async () => {
  createFailure = { response: { status: 400, data: { error: 'boom from the API' } } }
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(dialog()?.textContent).toContain('boom from the API')

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await settle()
  expect(dialog()).toBeNull()

  const reopened = await openDialog()
  expect(reopened.textContent).not.toContain('boom from the API')
})

test('closing the dialog while a create is still in flight, then reopening after it fails, shows no stale error', async () => {
  // The slow path this page really has: a create fetches the base branch and
  // cuts a worktree before it answers, and Cancel is never disabled.
  let release: () => void = () => {}
  createGate = new Promise<void>((r) => {
    release = r
  })
  createFailure = { response: { status: 400, data: { error: 'late failure' } } }
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(submitButton().disabled).toBe(true)

  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')
  expect(dialog()).toBeNull()

  await act(async () => {
    release()
  })
  await settle()

  const reopened = await openDialog()
  expect(reopened.textContent).not.toContain('late failure')
})

test('a create that succeeds after the dialog was cancelled and reopened does not close or wipe the new one', async () => {
  // Beyond the brief's literal wording, same root cause as the test above:
  // the first attempt's `mutate` callbacks still act on the dialog after the
  // reader has moved on to a second attempt.
  let release: () => void = () => {}
  createGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await openDialog()
  await type(input('Title'), 'First attempt')
  await click(submitButton(), 'submit')
  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')

  await openDialog()
  await type(input('Title'), 'Second attempt, half typed')

  await act(async () => {
    release()
  })
  await settle()

  expect(dialog()).not.toBeNull()
  expect(dialog() ? input('Title').value : null).toBe('Second attempt, half typed')
})

for (const status of ['pending', 'cloning', 'failed'] as const) {
  test(`a project in status "${status}" disables the submit and says it has to finish setup`, async () => {
    currentProject = project({ status })
    await mount()
    await openDialog()
    expect(submitButton().disabled).toBe(true)
    expect(dialog()?.textContent).toContain('The project has to finish setup first.')
    await click(submitButton(), 'submit')
    expect(createCalls).toEqual([])
  })
}

test('a ready project: submit enabled, no finish-setup note', async () => {
  await mount()
  await openDialog()
  expect(submitButton().disabled).toBe(false)
  expect(dialog()?.textContent).not.toContain('The project has to finish setup first.')
})

// --- 2. the sessions table -------------------------------------------------

test('exactly four columns: Title, Date, Status and an unlabelled actions column', async () => {
  sessions = [session()]
  await mount()
  expect(headerTexts()).toEqual(['Title', 'Date', 'Status', ''])
  for (const row of bodyRows()) expect(row.querySelectorAll('td').length).toBe(4)
})

test('none of the old card fields reach the list', async () => {
  sessions = [
    session({
      id: 's-full',
      title: 'Loaded',
      orchestrator: 'lead-orch',
      branch: 'agentoo/s-full',
      baseBranch: 'release/9',
      baseSha: 'deadbeefcafebabe',
      baseNote: 'could not refresh origin',
      workingDir: '/srv/wt/alpha-full',
      worktreePath: '/srv/wt/alpha-full',
      isolated: true,
    }),
    session({ id: 's-shared', title: 'Shared', isolated: false, workingDir: '/srv/alpha-shared' }),
  ]
  await mount()
  const text = main().textContent ?? ''
  for (const forbidden of [
    'lead-orch',
    'agentoo/s-full',
    'release/9',
    'deadbee',
    'could not refresh origin',
    '/srv/wt/alpha-full',
    '/srv/alpha-shared',
    'own worktree',
    'shared checkout',
    'Directory',
    'Branch',
    'Orchestrator',
  ]) {
    expect({ forbidden, found: text.includes(forbidden) }).toEqual({ forbidden, found: false })
  }
})

test('the title links to the session page', async () => {
  sessions = [session({ id: 'abc-123', title: 'Linked' })]
  await mount()
  const link = bodyRows()[0]?.querySelector('td a')
  expect(link?.textContent).toBe('Linked')
  expect(link?.getAttribute('href')).toBe('/projects/p1/sessions/abc-123')
})

test('an untitled session reads "Session <first 8 chars of id>"', async () => {
  sessions = [session({ id: '1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890', title: null })]
  await mount()
  expect(rowTitles()).toEqual(['Session 1a2b3c4d'])
  expect(bodyRows()[0]?.querySelector('td a')?.getAttribute('href')).toBe(
    '/projects/p1/sessions/1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890',
  )
})

test('the Date column carries date and time, and differs by both', async () => {
  sessions = [
    session({ id: 'a', title: 'Morning', createdAt: '2026-03-14T08:05:00.000Z' }),
    session({ id: 'b', title: 'Evening', createdAt: '2026-03-14T19:40:00.000Z' }),
    session({ id: 'c', title: 'Next year', createdAt: '2027-03-14T08:05:00.000Z' }),
  ]
  await mount()
  const dates = bodyRows().map((r) => cellTexts(r)[1] ?? '')
  // Locale-independent: each carries its year, and two instants on the same
  // day (time differs) and a year apart (date differs) never render alike.
  expect(dates[0]).toContain('2026')
  expect(dates[2]).toContain('2027')
  expect(dates[0]).not.toBe(dates[1])
  expect(dates[0]).not.toBe(dates[2])
  // The same instant through the reader's own locale's date+time parts.
  const d = new Date('2026-03-14T08:05:00.000Z')
  expect(dates[0]).toContain(String(d.getFullYear()))
  expect(dates[0]).toContain(String(d.getDate()))
  expect(dates[0]).toContain(String(d.getMinutes()).padStart(2, '0'))
})

for (const createdAt of ['', 'not-a-date']) {
  test(`createdAt ${JSON.stringify(createdAt)} never renders "Invalid Date"`, async () => {
    sessions = [session({ createdAt })]
    await mount()
    expect(main().textContent).not.toContain('Invalid Date')
    expect(cellTexts(bodyRows()[0] as HTMLElement)[1]).toBe('')
  })
}

test('the Status column shows the translated status for every status', async () => {
  const statuses = ['idle', 'queued', 'running', 'interrupted', 'completed', 'failed'] as const
  sessions = statuses.map((status, i) => session({ id: `s${i}`, title: `T${i}`, status }))
  await mount()
  expect(bodyRows().map((r) => cellTexts(r)[2])).toEqual([
    'Idle',
    'Queued',
    'Running',
    'Interrupted',
    'Completed',
    'Failed',
  ])
  expect(main().textContent).not.toContain('sessions.status')
})

test('rows keep the API order, even when createdAt disagrees with it', async () => {
  sessions = [
    session({ id: 'x', title: 'Zulu', createdAt: '2026-01-01T00:00:00.000Z' }),
    session({ id: 'y', title: 'Alpha', createdAt: '2026-06-01T00:00:00.000Z' }),
    session({ id: 'z', title: 'Mike', createdAt: '2025-01-01T00:00:00.000Z' }),
  ]
  await mount()
  expect(rowTitles()).toEqual(['Zulu', 'Alpha', 'Mike'])
})

test('the actions menu has exactly Open and Delete', async () => {
  sessions = [session()]
  await mount()
  expect(menuTriggers().length).toBe(1)
  await click(menuTriggers()[0], 'menu trigger')
  expect(menuItemLabels()).toEqual(['Open', 'Delete'])
})

test('Open navigates to the session page', async () => {
  sessions = [session({ id: 'open-me', title: 'Open me' })]
  await mount()
  await selectMenuItem(0, 'Open')
  expect(router.state.location.pathname).toBe('/projects/p1/sessions/open-me')
})

test('Delete asks first, sends nothing until confirmed, then DELETEs that session', async () => {
  sessions = [session({ id: 'keep', title: 'Keep' }), session({ id: 'drop', title: 'Drop' })]
  await mount()
  await selectMenuItem(1, 'Delete')

  expect(deleteCalls).toEqual([])
  expect(alertDialog()?.textContent).toContain('Delete session?')

  const confirm = buttonsByText(alertDialog() as HTMLElement, 'Delete')[0]
  await click(confirm, 'confirm Delete')

  expect(deleteCalls).toEqual([{ path: { id: 'drop' } }])
  expect(alertDialog()).toBeNull()
  expect(rowTitles()).toEqual(['Keep'])
})

test('cancelling the delete confirmation sends nothing', async () => {
  sessions = [session({ id: 'keep', title: 'Keep' })]
  await mount()
  await selectMenuItem(0, 'Delete')
  await click(buttonsByText(alertDialog() as HTMLElement, 'Cancel')[0], 'Cancel')
  expect(deleteCalls).toEqual([])
  expect(alertDialog()).toBeNull()
  expect(rowTitles()).toEqual(['Keep'])
})

test("a failed delete toasts the API's message and leaves the row", async () => {
  sessions = [session({ id: 'stuck', title: 'Stuck' })]
  deleteFailure = { response: { status: 409, data: { error: 'session is still running' } } }
  await mount()
  await selectMenuItem(0, 'Delete')
  await click(buttonsByText(alertDialog() as HTMLElement, 'Delete')[0], 'confirm Delete')

  expect(deleteCalls).toEqual([{ path: { id: 'stuck' } }])
  expect(document.body.textContent).toContain('session is still running')
  expect(rowTitles()).toEqual(['Stuck'])
})

test('a failed delete with no API message toasts "Could not delete the session"', async () => {
  sessions = [session({ id: 'stuck', title: 'Stuck' })]
  deleteFailure = { response: { status: 500, data: 'nope' } }
  await mount()
  expect(document.body.textContent).not.toContain('Could not delete the session')
  await selectMenuItem(0, 'Delete')
  await click(buttonsByText(alertDialog() as HTMLElement, 'Delete')[0], 'confirm Delete')
  expect(document.body.textContent).toContain('Could not delete the session')
})

// --- 3. search ------------------------------------------------------------

const THREE = () => [
  session({ id: 'a1', title: 'Refactor Auth module' }),
  session({ id: '1a2b3c4d-0000-0000-0000-000000000000', title: null }),
  session({ id: 'c3', title: 'Write docs' }),
]

test('the search input sits above the table', async () => {
  sessions = THREE()
  await mount()
  const s = searchInput()
  expect(s).not.toBeNull()
  expect(s?.getAttribute('placeholder')).toBe('Search sessions…')
  const t = table() as HTMLTableElement
  // DOCUMENT_POSITION_FOLLOWING: the table comes after the input.
  expect(Boolean((s as HTMLInputElement).compareDocumentPosition(t) & 4)).toBe(true)
})

test('typing filters rows case-insensitively by substring', async () => {
  sessions = THREE()
  await mount()
  await type(searchInput() as HTMLInputElement, 'auth')
  expect(rowTitles()).toEqual(['Refactor Auth module'])
  await type(searchInput() as HTMLInputElement, 'DOCS')
  expect(rowTitles()).toEqual(['Write docs'])
  await type(searchInput() as HTMLInputElement, 'E')
  expect(rowTitles()).toEqual(['Refactor Auth module', 'Session 1a2b3c4d', 'Write docs'])
})

test('an untitled session is found by its displayed "Session 1a2b3c4d" text', async () => {
  sessions = THREE()
  await mount()
  await type(searchInput() as HTMLInputElement, 'session 1a2b')
  expect(rowTitles()).toEqual(['Session 1a2b3c4d'])
  await type(searchInput() as HTMLInputElement, '1A2B3C4D')
  expect(rowTitles()).toEqual(['Session 1a2b3c4d'])
})

test('no match: no rows, and the "No sessions match your search." message', async () => {
  sessions = THREE()
  await mount()
  expect(main().textContent).not.toContain('No sessions match your search.')
  await type(searchInput() as HTMLInputElement, 'zzz-nothing')
  expect(rowTitles()).toEqual([])
  expect(main().textContent).toContain('No sessions match your search.')
  // Still the table's own empty row, not the page's zero-sessions empty state.
  expect(main().textContent).not.toContain('No sessions yet.')
  expect(searchInput()).not.toBeNull()
})

test('clearing the search restores every row, in order', async () => {
  sessions = THREE()
  await mount()
  await type(searchInput() as HTMLInputElement, 'zzz-nothing')
  expect(rowTitles()).toEqual([])
  await type(searchInput() as HTMLInputElement, '')
  expect(rowTitles()).toEqual(['Refactor Auth module', 'Session 1a2b3c4d', 'Write docs'])
  expect(main().textContent).not.toContain('No sessions match your search.')
})

test('zero sessions: the empty state, and neither the search input nor the table', async () => {
  sessions = []
  await mount()
  expect(listCalls).toBeGreaterThanOrEqual(1)
  expect(main().querySelector('[data-slot="empty-title"]')?.textContent).toContain(
    'No sessions yet.',
  )
  expect(searchInput()).toBeNull()
  expect(main().querySelectorAll('input').length).toBe(0)
  expect(table()).toBeNull()
  // The header button is still how you make one.
  expect(newSessionButton().disabled).toBe(false)
})

test('deleting the last session swaps the table for the empty state', async () => {
  sessions = [session({ id: 'only', title: 'Only' })]
  await mount()
  await selectMenuItem(0, 'Delete')
  await click(buttonsByText(alertDialog() as HTMLElement, 'Delete')[0], 'confirm Delete')
  expect(table()).toBeNull()
  expect(searchInput()).toBeNull()
  expect(main().textContent).toContain('No sessions yet.')
})
