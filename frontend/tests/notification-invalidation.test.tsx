// The notification bell's feed (`GET /notifications`) is refreshed by the
// mutations that can take an item out of it:
//
//   - `useMarkSessionSeen` (features/sessions/hooks/use-sessions.ts): a
//     session marked seen leaves the feed's unchecked results;
//   - apply, reject and delete of a suggestion (features/library/hooks/
//     use-learning.ts, all through its shared list invalidation): the
//     suggestion leaves the feed's pending ones.
//
// Each hook is driven on its own with a real QueryClient and the generated
// client mocked per-file through ./mock-module. The feed is seeded and left
// unobserved, so `isInvalidated` on its query state is the whole observable —
// nothing refetches it behind the assertion's back. A failed call must leave
// it alone.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const T = '2026-09-04T10:00:00.000Z'

let failure: unknown = null
const calls: Record<string, unknown[]> = { seen: [], apply: [], reject: [], delete: [] }

await mockModule('@/shared/api/generated/clients/postApiSessionsIdSeen', () => ({
  postApiSessionsIdSeen: async (opts: { path: { id: string } }) => {
    calls.seen?.push(opts)
    if (failure) throw failure
    return {
      data: {
        id: opts.path.id,
        projectId: 'p1',
        ideaId: null,
        title: 'A session',
        status: 'completed',
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
        settledAt: T,
        seenAt: T,
        unchecked: false,
        createdAt: T,
        updatedAt: T,
      },
    }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdApply', () => ({
  postApiLibrarySuggestionsIdApply: async (opts: { path: { id: string } }) => {
    calls.apply?.push(opts)
    if (failure) throw failure
    return { data: { id: opts.path.id, kind: 'agent', name: 'reviewer', status: 'applied' } }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdReject', () => ({
  postApiLibrarySuggestionsIdReject: async (opts: { path: { id: string } }) => {
    calls.reject?.push(opts)
    if (failure) throw failure
    return { data: { id: opts.path.id, kind: 'skill', name: 'deploy', status: 'rejected' } }
  },
}))
await mockModule('@/shared/api/generated/clients/deleteApiLibrarySuggestionsId', () => ({
  deleteApiLibrarySuggestionsId: async (opts: { path: { id: string } }) => {
    calls.delete?.push(opts)
    if (failure) throw failure
    return { data: undefined }
  },
}))

const { useMarkSessionSeen } = await import('../src/features/sessions/hooks/use-sessions')
const { useApplySuggestion, useRejectSuggestion, useDeleteSuggestion } = await import(
  '../src/features/library/hooks/use-learning'
)
const { getApiNotificationsQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiNotifications'
)

const FEED_KEY = getApiNotificationsQueryKey()

let container: HTMLDivElement
let client: QueryClient
let root: Root | undefined

type Mutate = (vars: never) => Promise<unknown>

/** Mounts `useHook()` and hands back its `mutateAsync`. */
async function mountHook(useHook: () => { mutateAsync: Mutate }): Promise<Mutate> {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(FEED_KEY, { items: [], hasUnread: true, truncated: false })
  let mutate: Mutate | null = null
  function Probe() {
    mutate = useHook().mutateAsync
    return null
  }
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  if (!mutate) throw new Error('hook never rendered')
  return mutate
}

const feedInvalidated = () => client.getQueryState(FEED_KEY)?.isInvalidated

async function run(mutate: Mutate, vars: unknown) {
  await act(async () => {
    await (mutate as (v: unknown) => Promise<unknown>)(vars).catch(() => {})
  })
}

beforeEach(() => {
  failure = null
  for (const k of Object.keys(calls)) calls[k] = []
  document.body.replaceChildren()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  client?.clear()
  document.body.replaceChildren()
})

const CASES = [
  ['useMarkSessionSeen', 'seen', () => useMarkSessionSeen(), { path: { id: 's1' } }],
  [
    'useApplySuggestion',
    'apply',
    () => useApplySuggestion('sug-1'),
    { path: { id: 'sug-1' }, body: { expectedCurrentHash: null } },
  ],
  [
    'useRejectSuggestion (with id)',
    'reject',
    () => useRejectSuggestion('sug-1'),
    { path: { id: 'sug-1' } },
  ],
  ['useRejectSuggestion (no id)', 'reject', () => useRejectSuggestion(), { path: { id: 'sug-1' } }],
  ['useDeleteSuggestion', 'delete', () => useDeleteSuggestion(), { path: { id: 'sug-1' } }],
] as const

for (const [name, call, useHook, vars] of CASES) {
  test(`${name} invalidates the notifications feed on success`, async () => {
    const mutate = await mountHook(useHook as unknown as () => { mutateAsync: Mutate })
    expect(feedInvalidated()).toBe(false)
    await run(mutate, vars)
    expect(calls[call]).toHaveLength(1)
    expect(feedInvalidated()).toBe(true)
  })

  test(`${name} leaves the notifications feed alone when the call fails`, async () => {
    failure = new Error('500')
    const mutate = await mountHook(useHook as unknown as () => { mutateAsync: Mutate })
    await run(mutate, vars)
    expect(calls[call]).toHaveLength(1)
    expect(feedInvalidated()).toBe(false)
  })
}
