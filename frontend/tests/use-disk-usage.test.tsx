// The disk-usage hooks' own policy (features/projects/hooks/use-disk-usage.ts
// and the invalidation in use-projects.ts): poll every 2 s while — and only
// while — the backend says a measurement is running; a refresh writes its
// answer into the single-project cache entry, which is what starts that poll;
// creating, retrying or deleting a project asks for the list of sizes again.
//
// Two kinds of check on polling. `refetchInterval` is read straight off the
// live `Query` in the cache and called, the way tests/use-ideas.test.tsx does,
// so every state is covered without waiting; and one test waits out two real
// intervals against the fake backend in ./disk-usage-api.ts to see the polling
// actually happen, and actually stop, rather than trusting the number.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  useProjectDiskUsage,
  useProjectsDiskUsage,
  useRefreshProjectDiskUsage,
} from '../src/features/projects/hooks/use-disk-usage'
import {
  useCreateProject,
  useDeleteProject,
  useRetryProject,
} from '../src/features/projects/hooks/use-projects'
import { getProjectDiskUsageQueryKey } from '../src/shared/api/generated/hooks/useGetProjectDiskUsage'
import { getProjectsDiskUsageQueryKey } from '../src/shared/api/generated/hooks/useGetProjectsDiskUsage'
import { fake, GB, installFakeDiskUsageApi, LIST_URL, SINGLE_URL, usage } from './disk-usage-api'

installFakeDiskUsageApi()

type Handles = {
  refresh?: ReturnType<typeof useRefreshProjectDiskUsage>
  create?: ReturnType<typeof useCreateProject>
  retry?: ReturnType<typeof useRetryProject>
  remove?: ReturnType<typeof useDeleteProject>
}
let handles: Handles = {}

/** Mounts the list and the single-project queries and every mutation that
 *  should touch them, handing the mutations back through `handles`. */
function Probe() {
  useProjectsDiskUsage()
  useProjectDiskUsage('p1')
  handles.refresh = useRefreshProjectDiskUsage('p1')
  handles.create = useCreateProject()
  handles.retry = useRetryProject()
  handles.remove = useDeleteProject()
  return null
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
const settle = () => sleep(20)

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  await settle()
}

beforeEach(() => {
  fake.reset()
  handles = {}
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
})

/** What `refetchInterval` answers for the cache entry under `queryKey`, by
 *  calling the function the hook handed to react-query on the live `Query`. */
function intervalOf(queryKey: readonly unknown[]): number | false {
  const query = client.getQueryCache().find({ queryKey })
  if (!query) throw new Error('no such query in the cache')
  const { refetchInterval } = query.options
  if (typeof refetchInterval !== 'function') throw new Error('refetchInterval is not a function')
  return refetchInterval(query as never) as number | false
}

const LIST = getProjectsDiskUsageQueryKey()
const ONE = getProjectDiskUsageQueryKey({ path: { id: 'p1' } })

test('the list polls every 2 s while any project is being measured', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB }))
  fake.rows.set('p2', usage('p2', { measuring: true }))
  await mount()

  expect(intervalOf(LIST)).toBe(2000)
})

test('the list stops polling when no project is being measured, and when there are none', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB }))
  fake.rows.set('p2', usage('p2', { error: 'Project folder not found' }))
  await mount()
  expect(intervalOf(LIST)).toBe(false)

  await act(async () => {
    client.setQueryData(LIST, [])
  })
  expect(intervalOf(LIST)).toBe(false)
})

test('the single-project query polls while it is being measured and stops when it is not', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB, measuring: true }))
  await mount()
  expect(intervalOf(ONE)).toBe(2000)

  await act(async () => {
    client.setQueryData(ONE, usage('p1', { totalBytes: 2 * GB }))
  })
  expect(intervalOf(ONE)).toBe(false)
})

test('a measurement is polled until it finishes, then left alone', async () => {
  fake.rows.set('p1', usage('p1', { measuring: true }))
  await mount()
  expect(fake.count('GET', SINGLE_URL)).toBe(1)
  expect(fake.count('GET', LIST_URL)).toBe(1)

  // The backend finishes before the first poll comes round.
  fake.rows.set('p1', usage('p1', { totalBytes: 3 * GB }))
  await sleep(2300)
  expect(fake.count('GET', SINGLE_URL)).toBe(2)
  expect(fake.count('GET', LIST_URL)).toBe(2)
  expect(client.getQueryData<{ totalBytes: number }>(ONE)?.totalBytes).toBe(3 * GB)

  // It said "not measuring", so another interval passes with nothing sent.
  await sleep(2300)
  expect(fake.count('GET', SINGLE_URL)).toBe(2)
  expect(fake.count('GET', LIST_URL)).toBe(2)
}, 15_000)

test('refreshing writes the answer into the single-project entry, which starts the poll, and refreshes the list', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB, measuredAt: '2026-09-28T14:32:00.000Z' }))
  await mount()
  expect(intervalOf(ONE)).toBe(false)
  expect(fake.count('GET', LIST_URL)).toBe(1)
  const singleBefore = fake.count('GET', SINGLE_URL)

  await act(async () => {
    handles.refresh?.mutate({ path: { id: 'p1' } })
  })
  await settle()

  // Straight from the POST's own answer, not from a refetch of the entry.
  expect(client.getQueryData<{ measuring: boolean }>(ONE)?.measuring).toBe(true)
  expect(intervalOf(ONE)).toBe(2000)
  expect(fake.count('GET', SINGLE_URL)).toBe(singleBefore)
  // The list is invalidated; it is mounted, so it is fetched again.
  expect(fake.count('GET', LIST_URL)).toBe(2)
})

for (const [name, run] of [
  ['creating', () => handles.create?.mutate({ body: { name: 'New', source: 'empty' } as never })],
  ['retrying', () => handles.retry?.mutate({ path: { id: 'p1' } })],
  [
    'deleting',
    () => handles.remove?.mutate({ path: { id: 'p1' }, query: { removeFiles: 'false' } }),
  ],
] as const) {
  test(`${name} a project asks for the list of sizes again`, async () => {
    fake.rows.set('p1', usage('p1', { totalBytes: GB }))
    await mount()
    expect(fake.count('GET', LIST_URL)).toBe(1)

    await act(async () => {
      run()
    })
    await settle()

    expect(fake.count('GET', LIST_URL)).toBe(2)
  })
}
