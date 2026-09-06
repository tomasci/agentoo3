// `useStorageSummary`'s own polling policy: there is no job-status endpoint
// behind `/storage/check` or `/storage/cleanup` (both only ever answer 202),
// so "finished" is inferred from `lastCheckAt`/`lastCleanupAt` moving past
// the moment a job was asked for (see the hook's own comment). This drives
// that decision directly through the cache with `setQueryData` — standing in
// for "a refetch just landed with this data" — rather than waiting out the
// hook's real 1500ms interval, which `staleTime: Infinity` below also keeps
// from firing an unwanted refetch-on-mount against a backend that isn't there.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStorageSummary } from '../src/features/storage/hooks/use-storage'
import { getApiStorageSummaryQueryKey } from '../src/shared/api/generated/hooks/useGetApiStorageSummary'

const KEY = getApiStorageSummaryQueryKey()

const summary = (o: Record<string, unknown> = {}) => ({
  totalBytes: 0,
  totalFiles: 0,
  sessionCount: 0,
  maxTotalBytes: 1000,
  openAnomalies: 0,
  lastCheckAt: null,
  lastCleanupAt: null,
  ...o,
})

let client: QueryClient
let container: HTMLDivElement
let root: Root
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let api: ReturnType<typeof useStorageSummary>

function Probe() {
  api = useStorageSummary()
  return null
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
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

/** A real timer tick, not a bare microtask: react-query's `notifyManager`
 *  batches a `setQueryData` notification through its own scheduler, which a
 *  synchronous `act(async () => {...})` callback can return before flushing
 *  (same issue tests/use-session-files.test.tsx's own `flush()` works
 *  around). Every `setQueryData` below is followed by this rather than
 *  wrapped in its own `act`, so the effect it triggers has actually run by
 *  the time the next assertion reads `api.watching`. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
})

afterEach(async () => {
  await unmount()
  client.clear()
})

test('not watching until something asks for it', async () => {
  client.setQueryData(KEY, summary())
  await mount()
  expect(api.watching).toBe(false)
})

test('startWatching("check") turns polling on, and it stays on while lastCheckAt has not moved', async () => {
  client.setQueryData(KEY, summary({ lastCheckAt: null }))
  await mount()

  act(() => {
    api.startWatching('check')
  })
  await flush()
  expect(api.watching).toBe(true)

  // A refetch that reports nothing new yet — the schedule's own clock has
  // not reached the job this asked for.
  client.setQueryData(KEY, summary({ lastCheckAt: null }))
  await flush()
  expect(api.watching).toBe(true)
})

test('watching settles once lastCheckAt moves past the moment it was asked for', async () => {
  client.setQueryData(KEY, summary({ lastCheckAt: null }))
  await mount()

  act(() => {
    api.startWatching('check')
  })
  await flush()
  expect(api.watching).toBe(true)

  client.setQueryData(KEY, summary({ lastCheckAt: new Date().toISOString() }))
  await flush()
  expect(api.watching).toBe(false)
})

test('a stale lastCheckAt from before the ask does not settle it', async () => {
  const before = new Date(Date.now() - 60_000).toISOString()
  client.setQueryData(KEY, summary({ lastCheckAt: before }))
  await mount()

  act(() => {
    api.startWatching('check')
  })
  await flush()
  expect(api.watching).toBe(true)

  // A different, but still-stale, run from well before this ask.
  client.setQueryData(KEY, summary({ lastCheckAt: new Date(Date.now() - 30_000).toISOString() }))
  await flush()
  expect(api.watching).toBe(true)
})

test('watching "cleanup" settles only on lastCleanupAt, not on lastCheckAt', async () => {
  client.setQueryData(KEY, summary())
  await mount()

  act(() => {
    api.startWatching('cleanup')
  })
  await flush()

  // The hourly schedule's own check happens to land while this is watching
  // for a cleanup — must not be mistaken for the job that was actually asked
  // for.
  client.setQueryData(KEY, summary({ lastCheckAt: new Date().toISOString() }))
  await flush()
  expect(api.watching).toBe(true)

  client.setQueryData(KEY, summary({ lastCleanupAt: new Date().toISOString() }))
  await flush()
  expect(api.watching).toBe(false)
})
