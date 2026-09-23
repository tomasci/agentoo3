// The session page's one link back to where it came from.
//
// A session handed off from an idea carries that idea's id on its DTO; a
// session someone started directly carries `null` there (see the field's own
// description in shared/api/generated/types/GetApiSessionsId.ts). The header
// has to offer the way back in the first case and nothing at all in the
// second.
//
// Mounted through the real router rather than by rendering `SessionPage`
// directly the way tests/session-page-scroll.test.tsx does: the thing under
// test *is* a `<Link>`, and a Link needs a router around it to resolve to an
// `href` — which is the only part of it a click actually uses. Same harness
// shape as tests/idea-detail-page.test.tsx otherwise: a memory history, the
// generated clients mocked per-file through ./mock-module, and the
// project-shell queries seeded so nothing reaches for a backend.
//
// CSS-module class names are `undefined` under `bun test`, so everything is
// selected by text, `href` or structure. Assertions are written to fail with
// primitives (counts, strings) and never with a DOM node: bun pretty-printing
// a happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { mockModule } from './mock-module'

const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
// The one editor endpoint this file's own SessionPage calls: "Stop editor"
// (session-page.tsx's ActionsMenu). Not the GET status or start clients —
// those belong to the editor launcher (tests/editor-page.test.tsx), which
// this file never mounts.
const EDITOR_STOP_CLIENT = '@/shared/api/generated/clients/postApiProjectsIdSessionsSessionidEditorStop'

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
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

let currentSession = session()

await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async () => ({ data: currentSession }),
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))

type StopCall = { path: { id: string; sessionId: string } }
let stopCalls: StopCall[] = []
let stopReject: unknown = null
await mockModule(EDITOR_STOP_CLIENT, () => ({
  postApiProjectsIdSessionsSessionidEditorStop: async (opts: StopCall) => {
    stopCalls.push(opts)
    if (stopReject) throw stopReject
    return {
      data: {
        projectId: opts.path.id,
        sessionId: opts.path.sessionId,
        enabled: true,
        daemon: { cliInstalled: true, available: true, error: null },
        state: 'stopped',
        proxyPath: '/api/projects/p1/sessions/s1/editor/proxy/',
        worktreePath: '/srv/alpha',
        image: 'codercom/code-server:4.138.0',
        idleTimeoutSeconds: 1800,
        container: null,
        operation: null,
        fetchedAt: T,
      },
    }
  },
}))

const { Toaster, toaster } = await import('../src/shared/ui/overlay/toast')

/** happy-dom ships no EventSource, and the transcript stream is not what this
 *  file is about — see tests/use-session-stream-hook.test.tsx for the stream
 *  itself. Installed for the whole file; nothing here depends on it firing. */
class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
// Put back afterwards: `mock.module` is not the only thing that escapes a
// file — a global assigned here is every later file's EventSource otherwise
// (tests/use-session-stream.test.ts brings its own).
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

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
  createdAt: T,
  updatedAt: T,
}

let container: HTMLDivElement
let client: QueryClient
let root: Root

async function mount(path = '/projects/p1/sessions/s1') {
  container = document.createElement('div')
  document.body.append(container)

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
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
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

beforeEach(() => {
  localStorage.clear()
  currentSession = session()
  stopCalls = []
  stopReject = null
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  // The toaster is a module-level singleton (toast.tsx) — clear it so a
  // toast this test raised is not still alive for the next test's mount().
  toaster.remove()
})

/** Anchors by their visible text — a `<Link>`'s props are not what a click
 *  follows, its rendered `href` is. */
const linkByText = (text: string) =>
  [...container.querySelectorAll('a')].filter((a) => a.textContent?.trim() === text)

/** Every *single-idea* URL the page links to, whatever the label on it — the
 *  project shell's own sidebar always links to the board at
 *  `/projects/p1/ideas`, which is not a link back to an idea. */
const ideaHrefs = () =>
  [...container.querySelectorAll('a')]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => /\/ideas\/[^/]+$/.test(href))

/** Scoped to `SessionPage`'s own `<header>`, not the whole container: the
 *  project sidebar's own nav also has a "Docker" link
 *  (`nav.docker`, sidebar.tsx), to the *project*-scope dashboard rather than
 *  this session's — `linkByText` alone would count both. */
const headerLinkByText = (text: string) => {
  const header = container.querySelector('header')
  if (!header) throw new Error('no session header rendered')
  return [...header.querySelectorAll('a')].filter((a) => a.textContent?.trim() === text)
}

test('a session handed off from an idea links back to it', async () => {
  currentSession = session({ ideaId: 'idea-7' })
  await mount()

  // The page really rendered — otherwise "no link" below would pass on an
  // empty document.
  expect(container.textContent ?? '').toContain('A session')

  const links = linkByText('Back to Idea')
  expect(links.length).toBe(1)
  expect(links[0]?.getAttribute('href')).toBe('/projects/p1/ideas/idea-7')
})

// The link is the session's record of where it came from, not a status
// indicator: it is there whatever the session is doing now, including after it
// has failed or been interrupted.
for (const status of ['idle', 'queued', 'running', 'interrupted', 'completed', 'failed'] as const) {
  test(`the link back to the idea survives a ${status} session`, async () => {
    currentSession = session({ ideaId: 'idea-7', status })
    await mount()

    expect(linkByText('Back to Idea').map((a) => a.getAttribute('href'))).toEqual([
      '/projects/p1/ideas/idea-7',
    ])
  })
}

test('the idea id, not the session id, is what the link points at', async () => {
  // Different ids for the session and the idea, so a link built from the wrong
  // one is a different URL rather than the same string by accident.
  currentSession = session({ id: 's1', ideaId: 'idea-7' })
  await mount()

  expect(ideaHrefs()).toEqual(['/projects/p1/ideas/idea-7'])
  expect(ideaHrefs()[0]).not.toContain('s1')
})

test('a session started directly offers no way back to an idea', async () => {
  currentSession = session({ ideaId: null })
  await mount()

  expect(container.textContent ?? '').toContain('A session')
  expect(linkByText('Back to Idea').length).toBe(0)
  expect(container.textContent ?? '').not.toContain('Back to Idea')
  // Not merely unlabelled: no link into the idea manager at all.
  expect(ideaHrefs()).toEqual([])
})

// The header's Docker and Editor links share one gate (session-page.tsx's own
// comment on both): only an isolated session has a worktree of its own for
// either a compose stack or a code-server container to run against — a
// shared-checkout session has neither, and the backend 400s on both
// (features/docker/scope.ts and, the same way, features/editor/service.ts).
// Lives here rather than in tests/editor-page.test.tsx or a Docker-owned
// file: it is a fact about `SessionPage`'s own header, not about either
// feature page those links lead to.
test("an isolated session's header links to its own Docker dashboard and its own editor", async () => {
  currentSession = session({ isolated: true })
  await mount()

  const docker = headerLinkByText('Docker')
  expect(docker.length).toBe(1)
  expect(docker[0]?.getAttribute('href')).toBe('/projects/p1/sessions/s1/docker')

  const editor = headerLinkByText('Editor')
  expect(editor.length).toBe(1)
  expect(editor[0]?.getAttribute('href')).toBe('/projects/p1/sessions/s1/editor')
  // The editor launcher renders with no app shell at all (root-layout.tsx's
  // `isBareShellPath`) and must never be adopted into this tab's own
  // workspace — both of which are exactly why it has to open as its own
  // browser tab rather than an in-app navigation. `target`/`rel` on the
  // rendered anchor (not just the `<Link>`'s own props) is what a real click,
  // middle-click or cmd-click actually reads.
  expect(editor[0]?.getAttribute('target')).toBe('_blank')
  expect(editor[0]?.getAttribute('rel')).toBe('noopener noreferrer')
})

test('a shared-checkout session offers neither the Docker nor the Editor link', async () => {
  currentSession = session({ isolated: false })
  await mount()

  expect(headerLinkByText('Docker').length).toBe(0)
  expect(headerLinkByText('Editor').length).toBe(0)
})

// ── stopping the editor from the session page ────────────────────────────────

/** The header's own overflow trigger — there is exactly one `ActionsMenu` on
 *  this page. */
const actionsMenuTrigger = () => {
  const header = container.querySelector('header')
  if (!header) throw new Error('no session header rendered')
  const trigger = header.querySelector('button[aria-haspopup="menu"]')
  if (!trigger) throw new Error('no actions menu trigger in the header')
  return trigger as HTMLElement
}

/** Opens the header's menu and returns the labels of whatever it offers. */
async function openActionsMenu(): Promise<string[]> {
  await act(async () => {
    actionsMenuTrigger().click()
  })
  return [
    ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
  ].map((el) => el.textContent ?? '')
}

/**
 * Opens the header's menu and selects the item whose label is `label`.
 *
 * Two events, each its own `act`, matching tests/storage-page.test.tsx's own
 * `selectRowMenuItem`: Zag's menu machine sets `highlightedValue` off
 * `ITEM_POINTERDOWN` and reads it back synchronously handling `ITEM_CLICK` —
 * a `pointerdown` and a `click` dispatched inside the same `act` land before
 * that transition has applied, and the click fires against a
 * `highlightedValue` that is still unset.
 */
async function selectActionsMenuItem(label: string) {
  await openActionsMenu()
  const items = [
    ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
  ] as HTMLElement[]
  const item = items.find((el) => el.textContent === label)
  if (!item) {
    throw new Error(`no open menu item "${label}" among ${items.map((i) => i.textContent).join(', ')}`)
  }
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
  })
  await act(async () => {
    item.click()
  })
}

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

test('"Stop editor" is offered only for an isolated session, same gate as the link', async () => {
  currentSession = session({ isolated: true })
  await mount()

  expect(await openActionsMenu()).toContain('Stop editor')
})

test('a shared-checkout session has no "Stop editor" action', async () => {
  currentSession = session({ isolated: false })
  await mount()

  expect(await openActionsMenu()).not.toContain('Stop editor')
})

test('"Stop editor" calls stop with the session\'s own project and session ids', async () => {
  currentSession = session({ id: 's1', projectId: 'p1', isolated: true })
  await mount()

  await selectActionsMenuItem('Stop editor')
  await settle()

  expect(stopCalls).toHaveLength(1)
  expect(stopCalls[0]?.path).toEqual({ id: 'p1', sessionId: 's1' })
  expect(document.body.textContent).toContain('Editor stopped')
})

test('a failed stop toasts the API\'s own message', async () => {
  stopReject = { response: { status: 409, data: { error: 'a start is in progress' } } }
  currentSession = session({ isolated: true })
  await mount()

  await selectActionsMenuItem('Stop editor')
  await settle()

  expect(stopCalls).toHaveLength(1)
  expect(document.body.textContent).toContain('a start is in progress')
})
