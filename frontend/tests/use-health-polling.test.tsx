// features/health/hooks/use-health.ts's poll cadence: 3s while the health
// query is in `error`, 15s otherwise, and never a retry of its own.
//
// Two angles. The exact numbers are read off the observer the hook actually
// mounted — its `refetchInterval` option evaluated against its own query,
// which is what query-core's QueryObserver does to schedule the next poll. And
// one real-time case proves the 3s figure is what actually fires: after an
// error the second request arrives within a few seconds, not 15.
//
// The generated client is mocked per-file through ./mock-module so nothing
// here reaches a real /api/health.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

type Health = { claudeCredential: boolean; version: string }
let healthImpl: () => Promise<{ data: Health }> = () => new Promise(() => {})
let healthCalls = 0

await mockModule('@/shared/api/generated/clients/getApiHealth', () => ({
  getApiHealth: async () => {
    healthCalls++
    return healthImpl()
  },
}))

const { useHealth } = await import('../src/features/health/hooks/use-health')
const { getApiHealthQueryKey } = await import('../src/shared/api/generated/hooks/useGetApiHealth')

const ok = () => Promise.resolve({ data: { claudeCredential: true, version: '1.2.3' } })
const fail = () => Promise.reject(new Error('ECONNREFUSED'))

let client: QueryClient
let container: HTMLDivElement
let root: Root | undefined
let status: string | undefined

function Probe() {
  status = useHealth().status
  return null
}

beforeEach(() => {
  healthImpl = () => new Promise(() => {})
  healthCalls = 0
  status = undefined
  // No default `retry: false` here on purpose — the hook must set it itself.
  client = new QueryClient()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  client.clear()
})

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

const healthQuery = () => {
  const q = client.getQueryCache().find({ queryKey: getApiHealthQueryKey() })
  if (!q) throw new Error('useHealth mounted no query')
  return q as unknown as Query
}

/** The observer's own interval, resolved the way QueryObserver resolves it. */
const interval = () => {
  const q = healthQuery()
  const observer = q.observers[0]
  if (!observer) throw new Error('health query has no observer')
  const opt = observer.options.refetchInterval
  return typeof opt === 'function' ? opt(q) : opt
}

const retryOption = () => healthQuery().observers[0]?.options.retry

test('while the first request is pending, the interval is 15000', async () => {
  await mount()
  expect(status).toBe('pending')
  expect(interval()).toBe(15_000)
})

test('once health answers, the interval is 15000', async () => {
  healthImpl = ok
  await mount()
  expect(status).toBe('success')
  expect(interval()).toBe(15_000)
})

test('while health is in error, the interval is 3000', async () => {
  healthImpl = fail
  await mount()
  expect(status).toBe('error')
  expect(interval()).toBe(3_000)
})

test('recovering from error puts the interval back to 15000', async () => {
  healthImpl = fail
  await mount()
  expect(interval()).toBe(3_000)
  healthImpl = ok
  await act(async () => {
    await client.refetchQueries({ queryKey: getApiHealthQueryKey() })
  })
  // query-core batches observer notifications onto a setTimeout(0).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
  expect(status).toBe('success')
  expect(interval()).toBe(15_000)
})

test('retry stays false: a failed health check is one request, not a retry burst', async () => {
  healthImpl = fail
  await mount()
  expect(retryOption()).toBe(false)
  // query-core's default would retry 3 times with a 1s+ backoff; a short wait
  // is enough to see the first retry if there were one.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1200))
  })
  expect(healthCalls).toBe(1)
})

test('after an error the next poll really fires within a few seconds, not 15', async () => {
  healthImpl = fail
  await mount()
  expect(healthCalls).toBe(1)
  const started = Date.now()
  const deadline = started + 7000
  while (Date.now() < deadline && healthCalls < 2) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
  }
  const waited = Date.now() - started
  expect(healthCalls).toBe(2)
  // Not an immediate refire either.
  expect(waited).toBeGreaterThanOrEqual(2500)
}, 15_000)
