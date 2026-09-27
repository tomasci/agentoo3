// The New session dialog (new-session-dialog.tsx, opened from the "New
// session" button on ProjectSessions) now that a session cannot be created
// without an orchestrator:
//
//   - the orchestrator Select offers only the library's orchestrator agents —
//     no "None" item, no subagents — and reads "Choose an orchestrator" until
//     one is picked;
//   - a submit with none picked (button or Enter) sends nothing and raises an
//     inline error under the field, the field and its trigger marked invalid;
//     picking one clears it, and the body then always carries `orchestrator`;
//   - with zero orchestrator agents the submit is disabled and the "No
//     orchestrator agents in the library yet…" hint shows;
//   - the error, and the pick, do not survive a close and reopen;
//   - a project that is not ready still disables the submit even when an
//     orchestrator exists (project-sessions-page.test.tsx's status tests run
//     with no agents at all, so since the zero-orchestrator gate landed they
//     no longer prove the status gate on their own).
//
// Same harness as tests/project-sessions-page.test.tsx: the real router and
// page, the real English bundle, the generated clients mocked per-file
// through ./mock-module.
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

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'A session',
  status: 'idle',
  orchestrator: 'lead',
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
let createCalls: CreateCall[] = []

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({ data: [] as Session[] }),
}))
await mockModule(CREATE_CLIENT, () => ({
  postApiProjectsIdSessions: async (opts: CreateCall) => {
    createCalls.push({ path: { ...opts.path }, body: { ...opts.body } })
    return { data: session({ id: 'new-1', orchestrator: String(opts.body.orchestrator) }) }
  },
}))

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
let client: QueryClient
let root: Root

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/sessions'] }),
  })
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
  if (!container.querySelector('main')?.textContent?.includes('Sessions')) {
    throw new Error('sessions page never rendered')
  }
}

beforeEach(() => {
  localStorage.clear()
  createCalls = []
  currentProject = project()
  currentAgents = [
    agent('lead', 'orchestrator'),
    agent('helper', 'subagent'),
    agent('second', 'orchestrator'),
  ]
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

const REQUIRED = 'Choose an orchestrator'
const PLACEHOLDER = 'Choose an orchestrator'
const HINT = 'The agent that drives this session and delegates to subagents.'
const EMPTY_HINT = 'No orchestrator agents in the library yet. Add one with role: orchestrator.'

const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const buttonsByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)

const dialog = () =>
  ([...document.body.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes('New session'),
  ) ?? null) as HTMLElement | null

const openDialog = async () => {
  expect(dialog()).toBeNull()
  const [btn] = buttonsByText(container.querySelector('main') as HTMLElement, 'New session')
  await click(btn, 'New session button')
  if (!dialog()) throw new Error('New session dialog did not open')
}

/** The orchestrator Select's trigger, found through its <label for>. */
const trigger = (): HTMLElement => {
  const d = dialog()
  if (!d) throw new Error('dialog not open')
  const label = [...d.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith('Orchestrator'),
  )
  const el = document.getElementById(label?.getAttribute('for') ?? '')
  if (!el) throw new Error('no orchestrator trigger')
  return el
}
/** The orchestrator's own <Field> wrapper. */
const field = () => trigger().closest('[data-slot="field"]') as HTMLElement
/** What the trigger displays: the chosen name or the placeholder, minus its icon. */
const shown = () => trigger().querySelector('[data-slot="select-value"]')?.textContent?.trim() ?? ''
const fieldError = () => field().querySelector('[data-slot="field-error"]') as HTMLElement | null
const fieldDescription = () =>
  field().querySelector('[data-slot="field-description"]') as HTMLElement | null

const submitButton = () => {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => b.getAttribute('type') === 'submit',
  )
  if (!found) throw new Error('no submit button in the dialog')
  return found as HTMLButtonElement
}

/** Submits the form the way Enter in a text field does, bypassing the button. */
const submitForm = async () => {
  const form = dialog()?.querySelector('form')
  if (!form) throw new Error('no form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

const openOptions = async () => {
  await click(trigger(), 'orchestrator trigger')
  return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
}
const optionNames = (options: HTMLElement[]) =>
  options.map((o) => o.querySelector('span')?.textContent?.trim() ?? '')

const chooseOrchestrator = async (name: string) => {
  const option = (await openOptions()).find((el) => el.textContent?.startsWith(name))
  if (!option) throw new Error(`no option starting with ${JSON.stringify(name)}`)
  await click(option, 'orchestrator option')
}

// --- the Select ------------------------------------------------------------

test('the trigger reads "Choose an orchestrator" until one is picked', async () => {
  await mount()
  await openDialog()
  expect(shown()).toBe(PLACEHOLDER)
  await chooseOrchestrator('second')
  expect(shown()).toBe('second')
  expect(trigger().textContent).not.toContain(PLACEHOLDER)
})

test('the options are exactly the library orchestrators: no None, no subagents', async () => {
  await mount()
  await openDialog()
  const options = await openOptions()
  expect(optionNames(options)).toEqual(['lead', 'second'])
  expect(options.some((o) => /\bnone\b/i.test(o.textContent ?? ''))).toBe(false)
})

// --- submitting without one ------------------------------------------------

test('submit with nothing picked sends no request and shows the inline error under the field', async () => {
  await mount()
  await openDialog()
  expect(fieldError()).toBeNull()
  await click(submitButton(), 'submit')

  expect(createCalls).toEqual([])
  expect(dialog()).not.toBeNull()
  expect(fieldError()?.textContent?.trim()).toBe(REQUIRED)
  // Under the trigger, inside the same field, replacing the hint.
  expect(Boolean(trigger().compareDocumentPosition(fieldError() as Node) & 4)).toBe(true)
  expect(fieldDescription()).toBeNull()
})

test('...and marks the field and its trigger invalid, the trigger described by the error', async () => {
  await mount()
  await openDialog()
  expect(field().hasAttribute('data-invalid')).toBe(false)
  expect(trigger().getAttribute('aria-invalid')).not.toBe('true')
  await click(submitButton(), 'submit')

  expect(field().hasAttribute('data-invalid')).toBe(true)
  expect(trigger().getAttribute('aria-invalid')).toBe('true')
  const errorId = fieldError()?.id ?? ''
  expect(errorId).not.toBe('')
  expect(trigger().getAttribute('aria-describedby')).toBe(errorId)
})

test('Enter-style form submission with nothing picked also sends nothing and shows the error', async () => {
  await mount()
  await openDialog()
  await submitForm()
  expect(createCalls).toEqual([])
  expect(fieldError()?.textContent?.trim()).toBe(REQUIRED)
})

test('submitting twice with nothing picked still sends nothing', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  await click(submitButton(), 'submit again')
  expect(createCalls).toEqual([])
  expect(fieldError()?.textContent?.trim()).toBe(REQUIRED)
})

test('picking an orchestrator clears the error and the invalid marks, and the hint returns', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(fieldError()).not.toBeNull()

  await chooseOrchestrator('lead')
  expect(fieldError()).toBeNull()
  expect(field().hasAttribute('data-invalid')).toBe(false)
  expect(trigger().getAttribute('aria-invalid')).not.toBe('true')
  expect(fieldDescription()?.textContent?.trim()).toBe(HINT)
  // Still nothing sent until the reader submits again.
  expect(createCalls).toEqual([])
})

test('after the error, picking one and submitting sends a body carrying that orchestrator', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  await chooseOrchestrator('second')
  await click(submitButton(), 'submit')
  expect(createCalls).toEqual([{ path: { id: 'p1' }, body: { orchestrator: 'second' } }])
})

test('switching from one orchestrator to another sends the last one picked', async () => {
  await mount()
  await openDialog()
  await chooseOrchestrator('lead')
  await chooseOrchestrator('second')
  await click(submitButton(), 'submit')
  expect(createCalls.map((c) => c.body.orchestrator)).toEqual(['second'])
})

// --- no orchestrators in the library ---------------------------------------

test('zero orchestrator agents: the submit is disabled and the empty-library hint shows', async () => {
  currentAgents = [agent('helper', 'subagent')]
  await mount()
  await openDialog()
  expect(submitButton().disabled).toBe(true)
  expect(fieldDescription()?.textContent?.trim()).toBe(EMPTY_HINT)
  expect(dialog()?.textContent).not.toContain(HINT)
  await click(submitButton(), 'disabled submit')
  expect(createCalls).toEqual([])
  expect(optionNames(await openOptions())).toEqual([])
})

test('zero orchestrator agents: Enter-style form submission sends nothing either', async () => {
  currentAgents = []
  await mount()
  await openDialog()
  await submitForm()
  expect(createCalls).toEqual([])
})

// --- close and reopen ------------------------------------------------------

test('the error does not survive Cancel and reopen', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(fieldError()).not.toBeNull()

  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')
  expect(dialog()).toBeNull()
  await openDialog()
  expect(fieldError()).toBeNull()
  expect(field().hasAttribute('data-invalid')).toBe(false)
  expect(trigger().getAttribute('aria-invalid')).not.toBe('true')
  expect(fieldDescription()?.textContent?.trim()).toBe(HINT)
})

test('the error does not survive Escape and reopen', async () => {
  await mount()
  await openDialog()
  await click(submitButton(), 'submit')
  expect(fieldError()).not.toBeNull()

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await settle()
  expect(dialog()).toBeNull()
  await openDialog()
  expect(fieldError()).toBeNull()
  expect(trigger().getAttribute('aria-invalid')).not.toBe('true')
})

test('a pick does not survive Cancel and reopen either: the placeholder is back and a bare submit errors again', async () => {
  await mount()
  await openDialog()
  await chooseOrchestrator('lead')
  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')
  await openDialog()
  expect(shown()).toBe(PLACEHOLDER)
  await click(submitButton(), 'submit')
  expect(createCalls).toEqual([])
  expect(fieldError()?.textContent?.trim()).toBe(REQUIRED)
})

// --- the project-status gate, with an orchestrator available ---------------

for (const status of ['pending', 'cloning', 'failed'] as const) {
  test(`a "${status}" project disables the submit even with an orchestrator picked`, async () => {
    currentProject = project({ status })
    await mount()
    await openDialog()
    await chooseOrchestrator('lead')
    expect(submitButton().disabled).toBe(true)
    await click(submitButton(), 'disabled submit')
    expect(createCalls).toEqual([])
  })
}
