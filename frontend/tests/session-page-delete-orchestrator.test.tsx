// The single-session page (`SessionPage`, route
// `/projects/$projectId/sessions/$sessionId`) after two changes:
//
//   A. the composer's "this session has no orchestrator" alert is gone — even
//      for a session whose `orchestrator` is null nothing like it renders,
//      and a send the API refuses for that reason surfaces the API's own
//      message in the composer's error alert instead;
//   B. the header's actions menu gained a destructive "Delete", last, behind
//      a "Delete session?" confirmation: Cancel sends nothing; Confirm sends
//      DELETE for this session and lands on the project's sessions list
//      without "Could not load the session" ever being rendered; a failure
//      toasts (API message, else "Could not delete the session"), closes the
//      confirmation and leaves the reader on the session page.
//
// Mounted through the real router and route tree, the way
// tests/project-sessions-page.test.tsx mounts its page, so that the
// post-delete navigation really lands on — and renders — the sessions list.
// The generated clients are mocked per-file through ./mock-module; everything
// above them is real. After a successful DELETE the session and messages
// clients answer 404 the way the real backend would, so any refetch of the
// deleted session that reached the screen would show up as an error.
//
// Assertions are on outcomes only (where the router ends up, what is or is
// never on screen, which requests were sent), never on the order of the
// page's internal cache calls.
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
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
const SEND_CLIENT = '@/shared/api/generated/clients/postApiSessionsIdMessages'
const DELETE_CLIENT = '@/shared/api/generated/clients/deleteApiSessionsId'
const EDITOR_STOP_CLIENT =
  '@/shared/api/generated/clients/postApiProjectsIdSessionsSessionidEditorStop'

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  title: 'Doomed session',
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

const NOT_FOUND = { response: { status: 404, data: { error: 'Session not found' } } }

let sessions: Session[] = []
let deleted = new Set<string>()
let sessionGets = 0
let sends: { id: string; body: unknown }[] = []
let sendReject: unknown = null
let deleteCalls: { path: { id: string } }[] = []
let deleteFailure: unknown = null
/** When set, the delete client awaits this before settling. */
let deleteGate: Promise<void> | null = null
let editorStops = 0

await mockModule(LIST_CLIENT, () => ({
  getApiProjectsIdSessions: async () => ({ data: sessions.filter((s) => !deleted.has(s.id)) }),
}))
await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => {
    sessionGets++
    if (deleted.has(opts.path.id)) throw NOT_FOUND
    const found = sessions.find((s) => s.id === opts.path.id)
    if (!found) throw NOT_FOUND
    return { data: found }
  },
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async (opts: { path: { id: string } }) => {
    if (deleted.has(opts.path.id)) throw NOT_FOUND
    return { data: { messages: [], hasOlder: false } }
  },
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async (opts: { path: { id: string } }) => {
    if (deleted.has(opts.path.id)) throw NOT_FOUND
    return {
      data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
    }
  },
}))
await mockModule(SEND_CLIENT, () => ({
  postApiSessionsIdMessages: async (opts: { path: { id: string }; body?: unknown }) => {
    sends.push({ id: opts.path.id, body: opts.body })
    if (sendReject) throw sendReject
    return { data: { id: 'm1', seq: 0 } }
  },
}))
await mockModule(DELETE_CLIENT, () => ({
  deleteApiSessionsId: async (opts: { path: { id: string } }) => {
    deleteCalls.push({ path: { ...opts.path } })
    if (deleteGate) await deleteGate
    if (deleteFailure) throw deleteFailure
    deleted.add(opts.path.id)
    return { data: undefined }
  },
}))
await mockModule(EDITOR_STOP_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStop: async () => {
    editorStops++
    return { data: { status: 'stopped' } }
  },
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

/** Every string that must never reach the screen, and whether it ever did —
 *  recorded off every DOM mutation, so a render that appears and is replaced
 *  a moment later still counts. */
const NEVER = ['Could not load the session', 'Session not found', 'Could not load the messages']
let seenNever = new Set<string>()
let observer: MutationObserver | null = null
const scan = (text: string | null | undefined) => {
  if (!text) return
  for (const s of NEVER) if (text.includes(s)) seenNever.add(s)
}

const settle = async (ticks = 10) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount(path = '/projects/p1/sessions/s1') {
  container = document.createElement('div')
  document.body.append(container)
  observer = new MutationObserver((records) => {
    for (const r of records) {
      scan((r.target as Node).textContent)
      for (const n of r.addedNodes) scan(n.textContent)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
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
  const title = sessions[0]?.title ?? ''
  if (!pageHeader()?.textContent?.includes(title)) throw new Error('session page never rendered')
}

beforeEach(() => {
  localStorage.clear()
  sessions = [session()]
  deleted = new Set()
  sessionGets = 0
  sends = []
  sendReject = null
  deleteCalls = []
  deleteFailure = null
  deleteGate = null
  editorStops = 0
  seenNever = new Set()
})

afterEach(async () => {
  observer?.disconnect()
  observer = null
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  toast.close()
  document.body.replaceChildren()
})

// --- helpers ---------------------------------------------------------------

const pathname = () => router.state.location.pathname
const pageHeader = () =>
  [...container.querySelectorAll('header')].find((h) => h.querySelector('h1')) as
    | HTMLElement
    | undefined
const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const buttonsByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
const alertDialog = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null

const actionsTrigger = () => {
  const found = [...(pageHeader()?.querySelectorAll('button[aria-haspopup="menu"]') ?? [])]
  if (found.length !== 1) throw new Error(`expected one header actions menu, got ${found.length}`)
  return found[0] as HTMLElement
}
const menuItems = () =>
  [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')] as HTMLElement[]
async function openMenu() {
  await click(actionsTrigger(), 'header actions trigger')
}
async function chooseDelete() {
  await openMenu()
  const item = menuItems().find((el) => el.textContent?.trim() === 'Delete')
  if (!item)
    throw new Error(
      `no Delete among ${menuItems()
        .map((i) => i.textContent)
        .join(', ')}`,
    )
  await click(item, 'Delete menu item')
}
const confirmButton = () => buttonsByText(alertDialog() as HTMLElement, 'Delete')[0]
const cancelButton = () => buttonsByText(alertDialog() as HTMLElement, 'Cancel')[0]

const composer = () => {
  const f = [...container.querySelectorAll('footer')].find((el) => el.querySelector('textarea'))
  if (!f) throw new Error('no composer footer')
  return f as HTMLElement
}
async function typeAndSend(text: string) {
  const ta = composer().querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  await act(async () => {
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(2)
  const send = [...composer().querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Send',
  )
  await click(send, 'Send button')
}

// --- A. no "no orchestrator" alert in the composer ------------------------

test('a session with orchestrator null renders no orchestrator warning anywhere on the page', async () => {
  sessions = [session({ orchestrator: null })]
  await mount()
  const text = document.body.textContent ?? ''
  expect(text).not.toContain('cannot run')
  expect(/no orchestrator/i.test(text)).toBe(false)
  expect(text).not.toContain('sessions.needsOrchestrator')
  // No alert of any kind in the composer before anything was sent.
  expect(
    composer().querySelectorAll('[data-slot="alert"], [role="alert"], [role="status"]').length,
  ).toBe(0)
})

test("a send the API refuses for having no orchestrator shows the API's message in the composer alert", async () => {
  const message = 'This session has no orchestrator. Choose one before sending a message.'
  sessions = [session({ orchestrator: null })]
  sendReject = { response: { status: 400, data: { error: message } } }
  await mount()
  await typeAndSend('please do the thing')

  expect(sends).toEqual([{ id: 's1', body: { text: 'please do the thing' } }])
  const alerts = [...composer().querySelectorAll('[data-slot="alert"]')].map(
    (a) => a.textContent?.trim() ?? '',
  )
  expect(alerts).toEqual([message])
  // The API's message, not the generic fallback.
  expect(composer().textContent).not.toContain('Could not send the message')
})

// --- B. Delete in the header's actions menu -------------------------------

test('control: the never-rendered detector does catch a load error when one reaches the screen', async () => {
  // Without this, every `seenNever` assertion below could be passing only
  // because the detector sees nothing at all.
  await mount()
  const getsBefore = sessionGets
  deleted.add('s1')
  await act(async () => {
    await client.invalidateQueries({
      queryKey: [{ url: '/api/sessions/:id', params: { id: 's1' } }],
    })
  })
  await settle()
  expect(sessionGets).toBeGreaterThan(getsBefore)
  expect(seenNever.has('Session not found')).toBe(true)
})

test('a shared-checkout session: the menu is Export JSON, then a destructive Delete', async () => {
  await mount()
  await openMenu()
  expect(menuItems().map((i) => i.textContent?.trim())).toEqual(['Export JSON', 'Delete'])
  expect(menuItems().map((i) => i.getAttribute('data-variant'))).toEqual(['default', 'destructive'])
})

test('an isolated session: Export JSON, Stop editor, then Delete last and destructive', async () => {
  sessions = [session({ isolated: true, worktreePath: '/srv/wt/s1', branch: 'agentoo/s-s1' })]
  await mount()
  await openMenu()
  expect(menuItems().map((i) => i.textContent?.trim())).toEqual([
    'Export JSON',
    'Stop editor',
    'Delete',
  ])
  expect(menuItems().at(-1)?.getAttribute('data-variant')).toBe('destructive')
  expect(
    menuItems()
      .slice(0, -1)
      .map((i) => i.getAttribute('data-variant')),
  ).toEqual(['default', 'default'])
})

test('Delete opens a "Delete session?" confirmation and sends nothing yet', async () => {
  await mount()
  await chooseDelete()
  expect(alertDialog()?.textContent).toContain('Delete session?')
  expect(deleteCalls).toEqual([])
  expect(pathname()).toBe('/projects/p1/sessions/s1')
})

test('Cancel closes the confirmation, sends nothing, and stays on the session', async () => {
  await mount()
  await chooseDelete()
  await click(cancelButton(), 'Cancel')
  expect(alertDialog()).toBeNull()
  expect(deleteCalls).toEqual([])
  expect(editorStops).toBe(0)
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(pageHeader()?.querySelector('h1')?.textContent).toBe('Doomed session')
})

test('Confirm DELETEs this session and lands on the sessions list, never showing a load error', async () => {
  sessions = [session(), session({ id: 's2', title: 'Survivor' })]
  await mount()
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')
  await settle(20)

  expect(deleteCalls).toEqual([{ path: { id: 's1' } }])
  expect(pathname()).toBe('/projects/p1/sessions')
  expect(alertDialog()).toBeNull()
  // Really on the list, and the deleted session is not in it.
  const titles = [...container.querySelectorAll('main table tbody tr td a')].map(
    (a) => a.textContent,
  )
  expect(titles).toEqual(['Survivor'])
  // Never rendered at any point during the whole flow, not just at the end.
  expect([...seenNever]).toEqual([])
  expect(document.body.textContent).not.toContain('Could not delete the session')
})

test('after a successful delete, focus/visibility events on the list do not surface the deleted session', async () => {
  // react-query refetches on window focus; the list is where the reader is,
  // and nothing about the deleted session may reach the screen from there.
  await mount()
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await settle(20)
  expect(pathname()).toBe('/projects/p1/sessions')
  expect([...seenNever]).toEqual([])
})

test('the confirm is disabled while the DELETE is in flight: a double click sends one request', async () => {
  let release: () => void = () => {}
  deleteGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await chooseDelete()
  const confirm = confirmButton()
  await click(confirm, 'confirm Delete')
  expect(confirmButton()?.disabled).toBe(true)
  await click(confirmButton(), 'confirm Delete again')
  await act(async () => {
    release()
  })
  await settle(20)
  expect(deleteCalls).toEqual([{ path: { id: 's1' } }])
  expect(pathname()).toBe('/projects/p1/sessions')
  expect([...seenNever]).toEqual([])
})

test("a failed delete toasts the API's message, closes the confirmation, and stays on the session", async () => {
  deleteFailure = {
    response: { status: 409, data: { error: 'Session is running; interrupt it before deleting' } },
  }
  await mount()
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')

  expect(deleteCalls).toEqual([{ path: { id: 's1' } }])
  expect(document.body.textContent).toContain('Session is running; interrupt it before deleting')
  expect(document.body.textContent).not.toContain('Could not delete the session')
  expect(alertDialog()).toBeNull()
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(pageHeader()?.querySelector('h1')?.textContent).toBe('Doomed session')
  expect([...seenNever]).toEqual([])
})

test('a failed delete with no API message toasts "Could not delete the session"', async () => {
  deleteFailure = { response: { status: 500, data: 'upstream exploded' } }
  await mount()
  expect(document.body.textContent).not.toContain('Could not delete the session')
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')

  expect(deleteCalls.length).toBe(1)
  expect(document.body.textContent).toContain('Could not delete the session')
  expect(alertDialog()).toBeNull()
  expect(pathname()).toBe('/projects/p1/sessions/s1')
  expect(pageHeader()?.querySelector('h1')?.textContent).toBe('Doomed session')
})

test('after a failed delete the reader can try again, and the retry goes through', async () => {
  deleteFailure = { response: { status: 409, data: { error: 'busy' } } }
  await mount()
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')
  expect(pathname()).toBe('/projects/p1/sessions/s1')

  deleteFailure = null
  await chooseDelete()
  await click(confirmButton(), 'confirm Delete')
  await settle(20)
  expect(deleteCalls).toEqual([{ path: { id: 's1' } }, { path: { id: 's1' } }])
  expect(pathname()).toBe('/projects/p1/sessions')
  expect([...seenNever]).toEqual([])
})
