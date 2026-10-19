// Renaming a session from a project's session list: the row menu's Rename
// item opens `RenameSessionDialog` (features/sessions/components/
// rename-session-dialog.tsx), which PATCHes `/sessions/{id}` through
// `useUpdateSession()`:
//
//   - the dialog is titled "Rename session" and its "Title" input starts from
//     the session's *raw* title — empty for an untitled one, whose fallback
//     text is only the placeholder;
//   - Save is disabled for an empty, whitespace-only or unchanged (after
//     trimming) value and while a save is pending;
//   - Save (or Enter, i.e. the form's submit) sends `{ title: <trimmed> }`
//     for that row's session, closes the dialog and the row shows the new
//     title (the list was invalidated);
//   - a failure shows the API's message (fallback "Could not rename the
//     session") inside the dialog, which stays open with the typed value and
//     can retry; reopening resets value and error;
//   - a request from an attempt the reader closed cannot close or put its
//     error into a dialog opened since.
//
// Mounted through the real router exactly like
// tests/project-sessions-page.test.tsx (same fixtures, same helpers), with
// the generated clients mocked per-file through ./mock-module and the real
// English bundle.
//
// happy-dom performs no implicit form submission on Enter (verified: a
// keydown/keypress Enter on a text input fires no `submit`), so "Enter" is
// driven as `form.requestSubmit()` — the step a browser takes for it.
//
// Assertions compare primitives, never DOM nodes: bun pretty-printing a
// happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session } from '../src/features/sessions/hooks/use-sessions'
import { mockModule } from './mock-module'

const LIST_CLIENT = '@/shared/api/generated/clients/getApiProjectsIdSessions'
const PATCH_CLIENT = '@/shared/api/generated/clients/patchApiSessionsId'
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  automationId: null,
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
  lastMessageAt: null,
  settledAt: null,
  seenAt: null,
  unchecked: false,
  ...overrides,
})

type PatchCall = { path: { id: string }; body: Record<string, unknown> }

let sessions: Session[] = []
let listCalls = 0
let patchCalls: PatchCall[] = []
let patchFailure: unknown = null
/** When set, the PATCH client awaits this before settling. */
let patchGate: Promise<void> | null = null

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => {
    listCalls++
    return { data: sessions }
  },
}))
await mockModule(PATCH_CLIENT, () => ({
  patchApiSessionsId: async (opts: PatchCall) => {
    patchCalls.push({ path: { ...opts.path }, body: { ...opts.body } })
    // Read once, before the await: a test that swaps the failure while this
    // request is held must not change what *this* request answers.
    const failure = patchFailure
    if (patchGate) await patchGate
    if (failure) throw failure
    const found = sessions.find((s) => s.id === opts.path.id) ?? session({ id: opts.path.id })
    const updated = { ...found, title: opts.body.title as string }
    sessions = sessions.map((s) => (s.id === updated.id ? updated : s))
    return { data: updated }
  },
}))
await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: sessions.find((s) => s.id === opts.path.id) ?? session({ id: opts.path.id }),
  }),
}))

/** happy-dom ships no EventSource. */
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
const { getApiSessionsIdQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)

const project = {
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
}

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

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/sessions'] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/library/agents' }], [])

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
  patchCalls = []
  patchFailure = null
  patchGate = null
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

const bodyRows = () =>
  [...(main().querySelector('table')?.querySelectorAll('tbody tr') ?? [])].filter(
    (row) => row.querySelector('th') === null,
  ) as HTMLElement[]
const rowTitles = () =>
  bodyRows()
    .map((r) => r.querySelector('td a')?.textContent ?? null)
    .filter((t): t is string => t !== null)

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

/** The open Rename dialog, or null. Base UI unmounts a closed popup. */
const dialog = () =>
  ([...document.body.querySelectorAll('[role="dialog"]')].find(
    (d) => d.querySelector('h2')?.textContent === 'Rename session',
  ) ?? null) as HTMLElement | null

const openRename = async (rowIndex = 0) => {
  expect(dialog() === null).toBe(true)
  await selectMenuItem(rowIndex, 'Rename')
  const d = dialog()
  if (!d) throw new Error('Rename dialog did not open')
  return d
}

const titleInput = () => {
  const d = dialog()
  if (!d) throw new Error('dialog not open')
  const label = [...d.querySelectorAll('label')].find((l) => l.textContent === 'Title')
  if (!label) throw new Error('no "Title" label in the dialog')
  const control = document.getElementById(label.getAttribute('for') ?? '')
  if (!control) throw new Error('no control for the "Title" label')
  return control as HTMLInputElement
}

const saveButton = () => {
  const d = dialog()
  if (!d) throw new Error('dialog not open')
  const found = [...d.querySelectorAll('button')].filter((b) => b.getAttribute('type') === 'submit')
  if (found.length !== 1) throw new Error(`expected one submit button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}

/** Enter in the field: the browser's implicit submission of its form. */
const pressEnter = async () => {
  const form = titleInput().form
  if (!form) throw new Error('the Title input is not in a form')
  await act(async () => {
    form.requestSubmit()
  })
  await settle()
}

const cancel = async () => {
  await click(buttonsByText(dialog() as HTMLElement, 'Cancel')[0], 'Cancel')
}

const gate = () => {
  let release: () => void = () => {}
  patchGate = new Promise<void>((r) => {
    release = r
  })
  return async () => {
    await act(async () => {
      release()
    })
    await settle()
  }
}

// --- opening -----------------------------------------------------------------

test('Rename opens a "Rename session" dialog with the Title input prefilled with the raw title', async () => {
  sessions = [session({ id: 's1', title: 'Fix login' })]
  await mount()
  await openRename()
  expect(dialog()?.querySelector('h2')?.textContent).toBe('Rename session')
  expect(titleInput().value).toBe('Fix login')
  expect(saveButton().textContent?.trim()).toBe('Save')
  expect(patchCalls).toEqual([])
})

test('an untitled session opens with an empty input and the fallback only as the placeholder', async () => {
  sessions = [session({ id: '1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890', title: null })]
  await mount()
  expect(rowTitles()).toEqual(['Session 1a2b3c4d'])
  await openRename()
  expect(titleInput().value).toBe('')
  expect(titleInput().getAttribute('placeholder')).toBe('Session 1a2b3c4d')
  // Nothing typed: Save cannot "rename" it to the fallback text.
  expect(saveButton().disabled).toBe(true)
})

test('the input stops at 200 characters, the backend limit', async () => {
  sessions = [session()]
  await mount()
  await openRename()
  expect(titleInput().getAttribute('maxlength')).toBe('200')
})

// --- Save gating ---------------------------------------------------------------

test('Save is disabled for the unchanged, empty, whitespace-only and trim-equal values', async () => {
  sessions = [session({ title: 'Fix login' })]
  await mount()
  await openRename()
  const states: [string, boolean][] = []
  for (const value of ['Fix login', '', '   ', '\t ', '  Fix login  ', 'Fix login 2']) {
    await type(titleInput(), value)
    states.push([value, saveButton().disabled])
  }
  expect(states).toEqual([
    ['Fix login', true],
    ['', true],
    ['   ', true],
    ['\t ', true],
    ['  Fix login  ', true],
    ['Fix login 2', false],
  ])
})

test('Enter on a disabled-Save value (whitespace) sends nothing and keeps the dialog open', async () => {
  sessions = [session({ title: 'Fix login' })]
  await mount()
  await openRename()
  await type(titleInput(), '   ')
  await pressEnter()
  await type(titleInput(), 'Fix login')
  await pressEnter()
  expect(patchCalls).toEqual([])
  expect(dialog() === null).toBe(false)
})

// --- success -------------------------------------------------------------------

test("Save PATCHes that row's session with the trimmed title, closes the dialog and the row shows it", async () => {
  sessions = [
    session({ id: 'keep', title: 'Keep', lastMessageAt: '2026-09-05T00:00:00.000Z' }),
    session({ id: 'target', title: 'Old name' }),
  ]
  await mount()
  expect(rowTitles()).toEqual(['Keep', 'Old name'])
  const listCallsBefore = listCalls
  await openRename(1)
  expect(titleInput().value).toBe('Old name')
  await type(titleInput(), '  New name  ')
  expect(saveButton().disabled).toBe(false)
  await click(saveButton(), 'Save')

  expect(patchCalls).toEqual([{ path: { id: 'target' }, body: { title: 'New name' } }])
  expect(dialog() === null).toBe(true)
  // staleTime is infinite, so only an invalidation refetches the list.
  expect(listCalls).toBeGreaterThan(listCallsBefore)
  expect(rowTitles()).toEqual(['Keep', 'New name'])
})

test('Enter (the form submit) saves the same way as the Save button', async () => {
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Via Enter')
  await pressEnter()
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'Via Enter' } }])
  expect(dialog() === null).toBe(true)
  expect(rowTitles()).toEqual(['Via Enter'])
})

test('an untitled session can be given a title', async () => {
  sessions = [session({ id: '1a2b3c4d-0000', title: null })]
  await mount()
  await openRename()
  await type(titleInput(), 'First title')
  await click(saveButton(), 'Save')
  expect(patchCalls).toEqual([{ path: { id: '1a2b3c4d-0000' }, body: { title: 'First title' } }])
  expect(rowTitles()).toEqual(['First title'])
})

test('a 200-character title is sent whole', async () => {
  sessions = [session({ id: 's1', title: 'Short' })]
  await mount()
  await openRename()
  const long = 'x'.repeat(200)
  await type(titleInput(), long)
  await click(saveButton(), 'Save')
  expect(patchCalls.length).toBe(1)
  expect((patchCalls[0]?.body.title as string).length).toBe(200)
  expect(dialog() === null).toBe(true)
})

test('a running session can be renamed from the list', async () => {
  sessions = [session({ id: 'busy', title: 'Busy one', status: 'running' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Still busy')
  await click(saveButton(), 'Save')
  expect(patchCalls).toEqual([{ path: { id: 'busy' }, body: { title: 'Still busy' } }])
  expect(rowTitles()).toEqual(['Still busy'])
})

test("a rename from the list writes the response into that session's detail cache", async () => {
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Cached name')
  await click(saveButton(), 'Save')
  const cached = client.getQueryData(getApiSessionsIdQueryKey({ path: { id: 's1' } })) as
    | Session
    | undefined
  expect(cached?.title).toBe('Cached name')
})

test('Cancel sends nothing and leaves the title as it was', async () => {
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Discarded')
  await cancel()
  expect(dialog() === null).toBe(true)
  expect(patchCalls).toEqual([])
  expect(rowTitles()).toEqual(['Old name'])
})

// --- pending -------------------------------------------------------------------

test('while the save is in flight Save is disabled, and a second click or Enter sends nothing more', async () => {
  const release = gate()
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'New name')
  await click(saveButton(), 'Save')
  expect(saveButton().disabled).toBe(true)
  await click(saveButton(), 'Save again')
  await pressEnter()
  expect(patchCalls.length).toBe(1)
  await release()
  expect(dialog() === null).toBe(true)
  expect(patchCalls.length).toBe(1)
})

// --- failure -------------------------------------------------------------------

test("a failure shows the API's message inside the dialog, which stays open with the typed value", async () => {
  patchFailure = { response: { status: 400, data: { error: 'Title is not allowed' } } }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Rejected name')
  await click(saveButton(), 'Save')

  expect(patchCalls.length).toBe(1)
  expect(dialog() === null).toBe(false)
  expect(dialog()?.textContent).toContain('Title is not allowed')
  expect(main().textContent).not.toContain('Title is not allowed')
  expect(titleInput().value).toBe('Rejected name')
  expect(saveButton().disabled).toBe(false)
  expect(rowTitles()).toEqual(['Old name'])
})

test('a validation failure shows its issues', async () => {
  patchFailure = {
    response: {
      status: 400,
      data: { error: 'Invalid', issues: [{ path: 'title', message: 'Too big' }] },
    },
  }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Something')
  await click(saveButton(), 'Save')
  expect(dialog()?.textContent).toContain('title: Too big')
})

test('a failure with no API message falls back to "Could not rename the session"', async () => {
  patchFailure = { response: { status: 500, data: 'upstream exploded' } }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  expect(document.body.textContent).not.toContain('Could not rename the session')
  await type(titleInput(), 'Something')
  await click(saveButton(), 'Save')
  expect(dialog()?.textContent).toContain('Could not rename the session')
  expect(dialog() === null).toBe(false)
})

test('after a failure, Save again retries and a success closes the dialog', async () => {
  patchFailure = { response: { status: 503, data: { error: 'try again later' } } }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Second try')
  await click(saveButton(), 'Save')
  expect(dialog()?.textContent).toContain('try again later')

  patchFailure = null
  await click(saveButton(), 'Save (retry)')
  expect(patchCalls).toEqual([
    { path: { id: 's1' }, body: { title: 'Second try' } },
    { path: { id: 's1' }, body: { title: 'Second try' } },
  ])
  expect(dialog() === null).toBe(true)
  expect(rowTitles()).toEqual(['Second try'])
})

test('a retry clears the previous error while it is in flight', async () => {
  patchFailure = { response: { status: 503, data: { error: 'first failure' } } }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'Second try')
  await click(saveButton(), 'Save')
  expect(dialog()?.textContent).toContain('first failure')

  patchFailure = null
  const release = gate()
  await click(saveButton(), 'Save (retry)')
  expect(dialog()?.textContent).not.toContain('first failure')
  await release()
})

for (const how of ['Cancel', 'Escape'] as const) {
  test(`${how} after a failure, then reopening, resets the value and shows no stale error`, async () => {
    patchFailure = { response: { status: 400, data: { error: 'boom from the API' } } }
    sessions = [session({ id: 's1', title: 'Old name' })]
    await mount()
    await openRename()
    await type(titleInput(), 'Typed then abandoned')
    await click(saveButton(), 'Save')
    expect(dialog()?.textContent).toContain('boom from the API')

    if (how === 'Cancel') {
      await cancel()
    } else {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      })
      await settle()
    }
    expect(dialog() === null).toBe(true)

    await openRename()
    expect(dialog()?.textContent).not.toContain('boom from the API')
    expect(titleInput().value).toBe('Old name')
    expect(patchCalls.length).toBe(1)
  })
}

test("reopening on another row starts from that row's title", async () => {
  sessions = [
    session({ id: 'a', title: 'Alpha', lastMessageAt: '2026-09-05T00:00:00.000Z' }),
    session({ id: 'b', title: 'Bravo' }),
  ]
  await mount()
  await openRename(0)
  await type(titleInput(), 'half typed')
  await cancel()
  await openRename(1)
  expect(titleInput().value).toBe('Bravo')
})

// --- a request outliving the attempt that sent it -----------------------------

test('a save that fails after the dialog was closed and reopened puts no error into the new one', async () => {
  const release = gate()
  patchFailure = { response: { status: 400, data: { error: 'late failure' } } }
  sessions = [session({ id: 's1', title: 'Old name' })]
  await mount()
  await openRename()
  await type(titleInput(), 'First attempt')
  await click(saveButton(), 'Save')
  await cancel()
  expect(dialog() === null).toBe(true)

  await openRename()
  await release()
  expect(dialog() === null).toBe(false)
  expect(dialog()?.textContent).not.toContain('late failure')
  expect(titleInput().value).toBe('Old name')
})

test('a save that succeeds after the dialog was closed and reopened does not close the new one', async () => {
  const release = gate()
  sessions = [
    session({ id: 'a', title: 'Alpha', lastMessageAt: '2026-09-05T00:00:00.000Z' }),
    session({ id: 'b', title: 'Bravo' }),
  ]
  await mount()
  await openRename(0)
  await type(titleInput(), 'Alpha renamed')
  await click(saveButton(), 'Save')
  await cancel()

  await openRename(1)
  await type(titleInput(), 'Bravo half typed')
  await release()

  expect(dialog() === null).toBe(false)
  expect(titleInput().value).toBe('Bravo half typed')
  // The first rename still happened server-side, and the list says so.
  expect(rowTitles()).toEqual(['Alpha renamed', 'Bravo'])
})
