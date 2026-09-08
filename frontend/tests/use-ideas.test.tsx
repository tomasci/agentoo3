// `useIdeas`' own `refetchInterval`: a function of the query's state, not a
// fixed number — polls while `isIdeaBusy` (lib/status.ts) is true for at
// least one card in the list, and stops the moment none are. The generated
// client function is mocked (through `mockModule`, so the fake does not leak
// into any file `bun test` loads afterwards) so a test can control exactly
// what the list answers, the same technique tests/use-session-files.test.tsx
// and tests/use-session-stream-hook.test.tsx use for their own generated
// clients — and, since `refetchInterval` is read straight off the live
// `Query` object in the cache rather than re-implemented here, this exercises
// the actual function `useIdeas` hands react-query, not a copy of it.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import type { Idea } from '../src/features/ideas/hooks/use-ideas'
import { useIdeas } from '../src/features/ideas/hooks/use-ideas'
import { getApiProjectsIdIdeasQueryKey } from '../src/shared/api/generated/hooks/useGetApiProjectsIdIdeas'

const CLIENT_SPEC = '@/shared/api/generated/clients/getApiProjectsIdIdeas'

/** Reassigned per test so each one controls what the "server" answers. */
let respond: () => Promise<{ data: Idea[] }>

await mockModule(CLIENT_SPEC, () => ({
  getApiProjectsIdIdeas: () => respond(),
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

let client: QueryClient
let container: HTMLDivElement
let root: Root

function Probe({ projectId }: { projectId: string }) {
  useIdeas(projectId)
  return null
}

async function mount(projectId = 'p1') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe projectId={projectId} />
      </QueryClientProvider>,
    )
  })
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** Drains whatever microtask chain the mocked fetch just queued up — same
 * idiom as tests/use-session-files.test.tsx's own `flush`. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(async () => {
  await unmount()
  client.clear()
})

/** The live `Query` for this project's list, straight from the cache — not a
 * hand-rolled stand-in — so calling its own `options.refetchInterval` on it
 * asks the exact question react-query itself would ask on its next tick. */
function refetchIntervalFor(projectId: string): number | false {
  const query = client
    .getQueryCache()
    .find({ queryKey: getApiProjectsIdIdeasQueryKey({ path: { id: projectId } }) })
  if (!query) throw new Error('no query found in the cache for this project')
  const { refetchInterval } = query.options
  if (typeof refetchInterval !== 'function') {
    throw new Error('refetchInterval is not a function')
  }
  return refetchInterval(query as never) as number | false
}

test('polls while a prompt is still generating', async () => {
  respond = () =>
    Promise.resolve({
      data: [idea({ latestPrompt: { id: 'pr-1', kind: 'initial', status: 'pending' } })],
    })
  await mount()
  await flush()

  expect(refetchIntervalFor('p1')).toBe(1500)
})

test('polls while a handoff run is open', async () => {
  respond = () =>
    Promise.resolve({ data: [idea({ openRun: { id: 'run-1', status: 'dispatching' } })] })
  await mount()
  await flush()

  expect(refetchIntervalFor('p1')).toBe(1500)
})

test('polls while the bound session itself is queued or running', async () => {
  respond = () => Promise.resolve({ data: [idea({ sessionId: 's1', sessionStatus: 'running' })] })
  await mount()
  await flush()

  expect(refetchIntervalFor('p1')).toBe(1500)
})

test('stops once nothing on the board is busy', async () => {
  respond = () =>
    Promise.resolve({
      data: [
        idea({ id: 'idea-1', status: 'done' }),
        idea({ id: 'idea-2', status: 'backlog', latestPrompt: { id: 'pr-2', kind: 'initial', status: 'ready' } }),
      ],
    })
  await mount()
  await flush()

  expect(refetchIntervalFor('p1')).toBe(false)
})

test('an empty board is not busy either', async () => {
  respond = () => Promise.resolve({ data: [] })
  await mount()
  await flush()

  expect(refetchIntervalFor('p1')).toBe(false)
})
