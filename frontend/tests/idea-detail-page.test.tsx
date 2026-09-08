// Render smoke test for the Idea Manager's detail page (T11): the canvas
// renders its blocks in `seq` order — the order the prompt generator reads
// them in (backend's `serializeIdea`) — never in whatever order the list
// endpoint happened to hand them back in.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import { routeTree } from '../src/app/router'
import type { Idea } from '../src/features/ideas/hooks/use-ideas'
import type { IdeaBlock } from '../src/features/ideas/hooks/use-idea-canvas'

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

// Deliberately out of `seq` order — the DTO order this list actually hands
// back is not what the reading order is; only `seq` is.
const BLOCKS: IdeaBlock[] = [
  { id: 'b-c', ideaId: 'idea-1', groupId: null, seq: 5, x: 0, y: 0, w: null, h: null, kind: 'note', text: 'Third: seq 5' },
  { id: 'b-a', ideaId: 'idea-1', groupId: null, seq: 1, x: 0, y: 0, w: null, h: null, kind: 'note', text: 'First: seq 1' },
  { id: 'b-b', ideaId: 'idea-1', groupId: null, seq: 3, x: 0, y: 0, w: null, h: null, kind: 'note', text: 'Second: seq 3' },
]

let currentIdea = idea()

await mockModule(IDEA_CLIENT, () => ({
  getApiIdeasId: async () => ({ data: currentIdea }),
}))
await mockModule(BLOCKS_CLIENT, () => ({
  getApiIdeasIdBlocks: async () => ({ data: BLOCKS }),
}))
await mockModule(GROUPS_CLIENT, () => ({
  getApiIdeasIdGroups: async () => ({ data: [] }),
}))
await mockModule(ASSETS_CLIENT, () => ({
  getApiIdeasIdAssets: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxIdeaBytes: 50_000_000 } },
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
})

afterEach(unmount)

test('the canvas renders its blocks in seq order, not list order', async () => {
  await mount()

  const texts = [...container.querySelectorAll('ol li p')].map((p) => p.textContent)
  expect(texts).toEqual(['First: seq 1', 'Second: seq 3', 'Third: seq 5'])
})
