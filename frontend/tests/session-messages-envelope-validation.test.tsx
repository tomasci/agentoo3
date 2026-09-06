// The boundary check itself (use-sessions.ts's `validator: { response:
// getApiSessionsIdMessagesStatus200Schema }`), exercised through the real
// kubb pipeline: the generated `getApiSessionsIdMessages`, its
// `resolveRequest`/`settleResponse`, and the validator wired onto that one
// call — with only the HTTP transport faked, via kubb's own seam for that
// (`client.setConfig({ transport })`, the shared axios instance every
// generated call defaults to), not the generated function itself.
//
// Deliberately NOT tests/use-session-messages.test.tsx's own harness: that
// file replaces `getApiSessionsIdMessages` wholesale via `mock.module`, which
// is the right tool for testing what the *hook* asks the backend for and how
// pages flatten — but a mock swapped in at that level never runs the real
// validator at all, so a malformed envelope handed to it would just flow
// straight through. What actually failed in production (commit 76113a8's
// shape change reaching a stale tab) failed inside the real client's response
// handling, three layers before it ever reached a cache updater — so that is
// the path this proves is now closed.

import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AxiosInstance, AxiosResponse } from 'axios'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionMessages } from '../src/features/sessions/hooks/use-sessions'
import { client } from '../src/shared/api/generated/.kubb/client'
import { ParseError } from '../src/shared/api/generated/.kubb/standardSchema'

type Row = {
  id: string
  sessionId: string
  seq: number
  type: string
  parentToolUseId: string | null
  title: string | null
  pending: boolean
  payload: unknown
  files: unknown[]
  createdAt: string
}

const row = (seq: number): Row => ({
  id: `00000000-0000-4000-8000-00000000000${seq}`,
  sessionId: '00000000-0000-4000-8000-000000000001',
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: {},
  files: [],
  createdAt: '2026-09-04T10:00:00.000Z',
})

/** Stands in for the HTTP transport only — everything above it (building the
 *  request, decoding and validating the response) is the real production
 *  code path. */
const fakeTransport = (data: unknown): AxiosInstance =>
  ({
    request: async () =>
      ({
        status: 200,
        data,
        headers: { 'content-type': 'application/json' },
        config: {},
      }) as AxiosResponse,
  }) as unknown as AxiosInstance

const originalTransport = client.getConfig().transport
afterEach(() => {
  client.setConfig({ transport: originalTransport })
})

type Result = ReturnType<typeof useSessionMessages>
let latest: Result | undefined
let queryClient: QueryClient
let container: HTMLDivElement
let root: Root

function Probe({ id }: { id: string }) {
  latest = useSessionMessages(id)
  return null
}

async function mount(id = 's1') {
  latest = undefined
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe id={id} />
      </QueryClientProvider>,
    )
  })
}

async function settle(until: () => boolean, ticks = 20) {
  for (let i = 0; i < ticks && !until(); i++) {
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
}

test('a bare array 200 body (the pre-76113a8 shape) fails with a named ParseError, not a TypeError three layers deeper', async () => {
  client.setConfig({ transport: fakeTransport([row(0), row(1)]) })
  await mount()

  await settle(() => latest?.isError === true || latest?.isSuccess === true)

  expect(latest?.isSuccess).toBe(false)
  expect(latest?.isError).toBe(true)
  expect(latest?.error).toBeInstanceOf(ParseError)
  // Not `n.findIndex is not a function` in a cache updater: nothing ever
  // reached message-cache.ts, because the shape never got past the client.
  expect(latest?.error?.message).not.toMatch(/findIndex/)
  // No messages silently rendered as though the session simply had none.
  expect(latest?.messages).toEqual([])

  await unmount()
})

test('an envelope missing hasOlder fails the same way, named', async () => {
  client.setConfig({ transport: fakeTransport({ messages: [row(0)] }) })
  await mount()

  await settle(() => latest?.isError === true)

  expect(latest?.isError).toBe(true)
  expect(latest?.error).toBeInstanceOf(ParseError)

  await unmount()
})

test('a well-formed envelope still succeeds through the same validator', async () => {
  client.setConfig({
    transport: fakeTransport({ messages: [row(0), row(1)], hasOlder: false }),
  })
  await mount()

  await settle(() => latest?.isSuccess === true)

  expect(latest?.isSuccess).toBe(true)
  expect(latest?.isError).toBe(false)
  expect(latest?.messages.map((m) => m.seq)).toEqual([0, 1])

  await unmount()
})
