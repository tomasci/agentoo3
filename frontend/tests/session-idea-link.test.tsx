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
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
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
