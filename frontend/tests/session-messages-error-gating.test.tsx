// Which of the two transcript alerts shows, for each way a fetch can fail.
//
// `useSessionMessages` exposes two error flags and session-page.tsx renders a
// different thing for each: `isError` replaces the whole transcript with
// "could not load the messages", `isLoadOlderError` puts "could not load older
// messages" *above* a transcript that is still on screen. Picking the wrong one
// is a visible regression in both directions — a load-older hiccup blanking a
// transcript that loaded fine, or a failed initial load rendering as an empty
// session.
//
// The distinction is not free, because query-core keeps one `status` for the
// whole query: a failed `fetchPreviousPage` sets `status: 'error'` on the same
// query whose initial page succeeded. `isError` therefore gates on
// `query.data === undefined` as well. The first test below pins that premise
// directly against the real QueryClient rather than taking it on trust, so if a
// future react-query changes it, the reason this gate exists fails loudly
// instead of the gate quietly becoming wrong.
//
// The generated client is swapped for a scripted one, the same seam
// tests/use-session-messages.test.tsx uses — not the axios transport that
// tests/session-messages-envelope-validation.test.tsx reaches for. The swap
// goes through tests/mock-module.ts, which is what keeps a `mock.module`
// registration from outliving the file that made it; see that helper for why
// the obvious undo does not.
//
// Everything above the client is real: the hook, react-query, the DOM.

import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import { useSessionMessages } from '../src/features/sessions/hooks/use-sessions'
import { sessionMessagesKey } from '../src/features/sessions/lib/message-cache'

const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'

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

const page = (messages: Row[], hasOlder: boolean) => ({ messages, hasOlder })

/** A transport driven by a queue of scripted outcomes, so a test can say
 *  "first call fails, second succeeds" without knowing anything about how many
 *  requests react-query decides to make. */
type Outcome = { ok: true; data: unknown } | { ok: false; message: string }

let queue: Outcome[] = []

const scripted = () => ({
  getApiSessionsIdMessages: async () => {
    const next = queue.shift()
    if (!next) throw new Error('the client was called more times than the test scripted')
    if (!next.ok) throw new Error(next.message)
    return { data: next.data }
  },
})

await mockModule(MESSAGES_CLIENT, scripted)

afterEach(() => {
  queue = []
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

async function settle(until: () => boolean, ticks = 25) {
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

/** What session-page.tsx would put on screen, given the flags the hook
 *  exposes — the branch order is copied from its own JSX so these tests fail
 *  if the two ever disagree about precedence. */
function rendered(r: Result | undefined) {
  if (!r) return 'nothing'
  if (r.isPending) return 'spinner'
  if (r.isError) return 'transcript-load-failed'
  return r.isLoadOlderError ? 'transcript+load-older-failed' : 'transcript'
}

// --- the premise the gate is built on -----------------------------------------

test('query-core really does set the whole query to error when only loadOlder fails', async () => {
  // If this ever stops being true, the `query.data === undefined` half of the
  // gate is dead weight and the comment explaining it is wrong. Asserted
  // against the real cache, not the hook, so it is a statement about
  // react-query rather than about our wrapper.
  queue = [
    { ok: true, data: page([row(5)], true) },
    { ok: false, message: 'older page exploded' },
  ]
  await mount()
  await settle(() => latest?.isSuccess === true)

  await act(async () => {
    await latest?.loadOlder()
  })
  await settle(() => latest?.isLoadOlderError === true)

  const state = queryClient.getQueryState(sessionMessagesKey('s1'))
  expect(state?.status).toBe('error')
  expect(state?.data).toBeDefined()
  await unmount()
})

// --- the initial load failing --------------------------------------------------

test('a failed initial load shows the transcript error, not an empty transcript', async () => {
  queue = [{ ok: false, message: 'first page exploded' }]
  await mount()
  await settle(() => latest?.isError === true)

  expect(latest?.isError).toBe(true)
  expect(latest?.error).toBeInstanceOf(Error)
  expect(latest?.messages).toEqual([])
  // The one that must NOT be showing: there is no transcript to put it above.
  expect(latest?.isLoadOlderError).toBe(false)
  expect(rendered(latest)).toBe('transcript-load-failed')
  await unmount()
})

test('a failed initial load is not still reported as pending', async () => {
  // session-page.tsx checks isPending first, so a hook that stayed pending
  // would spin forever and never reach the alert branch at all.
  queue = [{ ok: false, message: 'first page exploded' }]
  await mount()
  await settle(() => latest?.isError === true)
  expect(latest?.isPending).toBe(false)
  await unmount()
})

// --- the initial load failing, then succeeding --------------------------------

test('an initial load that fails and is then retried successfully clears the error', async () => {
  queue = [
    { ok: false, message: 'first page exploded' },
    { ok: true, data: page([row(1), row(2)], false) },
  ]
  await mount()
  await settle(() => latest?.isError === true)
  expect(rendered(latest)).toBe('transcript-load-failed')

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: sessionMessagesKey('s1') })
  })
  await settle(() => latest?.isError === false && (latest?.messages.length ?? 0) > 0)

  expect(latest?.isError).toBe(false)
  expect(latest?.messages.map((m) => m.seq)).toEqual([1, 2])
  expect(rendered(latest)).toBe('transcript')
  await unmount()
})

// --- loadOlder failing on a transcript that loaded fine ------------------------

test('a failed loadOlder keeps the transcript on screen and shows only the older-page error', async () => {
  queue = [
    { ok: true, data: page([row(5), row(6)], true) },
    { ok: false, message: 'older page exploded' },
  ]
  await mount()
  await settle(() => latest?.isSuccess === true)
  expect(latest?.messages.map((m) => m.seq)).toEqual([5, 6])

  await act(async () => {
    await latest?.loadOlder()
  })
  await settle(() => latest?.isLoadOlderError === true)

  // The whole point of the `data === undefined` half of the gate.
  expect(latest?.isError).toBe(false)
  expect(latest?.isLoadOlderError).toBe(true)
  // The transcript is still there — this is the regression that gate prevents.
  expect(latest?.messages.map((m) => m.seq)).toEqual([5, 6])
  expect(rendered(latest)).toBe('transcript+load-older-failed')
  await unmount()
})

test('a failed loadOlder that is then retried successfully prepends and clears', async () => {
  queue = [
    { ok: true, data: page([row(5)], true) },
    { ok: false, message: 'older page exploded' },
    { ok: true, data: page([row(3), row(4)], false) },
  ]
  await mount()
  await settle(() => latest?.isSuccess === true)

  await act(async () => {
    await latest?.loadOlder()
  })
  await settle(() => latest?.isLoadOlderError === true)

  await act(async () => {
    await latest?.loadOlder()
  })
  await settle(() => latest?.isLoadOlderError === false)

  expect(latest?.isError).toBe(false)
  expect(latest?.isLoadOlderError).toBe(false)
  expect(latest?.messages.map((m) => m.seq)).toEqual([3, 4, 5])
  expect(rendered(latest)).toBe('transcript')
  await unmount()
})

test('a transcript that legitimately has no messages is not reported as an error', async () => {
  // The other half of the distinction the gate exists for: empty must stay
  // empty, not become "could not load".
  queue = [{ ok: true, data: page([], false) }]
  await mount()
  await settle(() => latest?.isSuccess === true)

  expect(latest?.isError).toBe(false)
  expect(latest?.messages).toEqual([])
  expect(rendered(latest)).toBe('transcript')
  await unmount()
})

// --- a note on why this file mocks where it does --------------------------------
//
// It used to register in `beforeEach` and restore the live namespace in
// `afterAll`, to survive tests/session-page-scroll.test.tsx leaking its own
// fake for this same specifier into every file loaded after it. That leak is
// fixed at the source now — see tests/mock-module.ts — so this file registers
// once at module scope like the others.
