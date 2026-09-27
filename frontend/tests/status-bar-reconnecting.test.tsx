// app/status-bar.tsx's backend label — the first `<span>` of the status
// footer — and how the reconnecting-streams set folds into it:
//
//   health pending                         -> health.checking, dot
//   health ok, credential, set empty       -> health.ok, dot
//   health ok, no credential, set empty    -> health.noCredential, dot
//   health errored                         -> health.reconnecting, spinner, no dot
//   health ok (either credential), set > 0 -> health.reconnecting, spinner, no dot
//   set emptied again                      -> back to ok / noCredential
//
// The real StatusBar, real `useHealth`/`useSystem`, a real QueryClient; the two
// generated clients those reach are mocked per-file through ./mock-module so
// each case decides what /api/health answers (and /api/system never does, so
// the host-metrics half stays out of the way). A private `cimode` i18n instance
// makes every label its bare key, and a private Jotai store behind a Provider
// is the one both the component reads and this file writes.
//
// Assertions compare primitives, never DOM nodes (see
// tests/session-page-header.test.tsx on why).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { mockModule } from './mock-module'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

type Health = { claudeCredential: boolean; version: string }
/** What the next /api/health request does. */
let healthImpl: () => Promise<{ data: Health }> = () => new Promise(() => {})
let healthCalls = 0

await mockModule('@/shared/api/generated/clients/getApiHealth', () => ({
  getApiHealth: async () => {
    healthCalls++
    return healthImpl()
  },
}))
await mockModule('@/shared/api/generated/clients/getApiSystem', () => ({
  // Never settles: `system` stays undefined, so no metrics or tooltips render.
  getApiSystem: () => new Promise(() => {}),
}))

const { StatusBar } = await import('../src/app/status-bar')
const { addReconnectingStreamAtom, removeReconnectingStreamAtom } = await import(
  '../src/shared/store/connection'
)

const ok = (claudeCredential: boolean) => () =>
  Promise.resolve({ data: { claudeCredential, version: '1.2.3' } })
const fail = () => Promise.reject(new Error('ECONNREFUSED'))

let client: QueryClient
let store: ReturnType<typeof createStore>
let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  healthImpl = () => new Promise(() => {})
  healthCalls = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  store = createStore()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  client.clear()
})

async function settle(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <StatusBar />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

/** The backend-label span: the footer's first child. */
const labelSpan = () => {
  const footers = container.querySelectorAll('footer')
  if (footers.length !== 1) throw new Error(`expected one footer, got ${footers.length}`)
  const first = footers[0]?.firstElementChild
  if (!first || first.tagName !== 'SPAN') throw new Error('footer has no leading span')
  return first
}

/** A primitive snapshot of the label: its text, and which indicator it shows. */
const backend = () => {
  const span = labelSpan()
  return {
    text: span.querySelector('.truncate')?.textContent ?? null,
    // StatusDot: the round `span[aria-hidden]` (shared/components/status-dot.tsx).
    dots: span.querySelectorAll('span.rounded-full[aria-hidden="true"]').length,
    // Spinner: lucide's Loader2Icon with data-slot="spinner" (shared/ui/spinner.tsx).
    spinners: span.querySelectorAll('svg[data-slot="spinner"]').length,
  }
}

const dotClass = () =>
  labelSpan().querySelector('span.rounded-full[aria-hidden="true"]')?.getAttribute('class') ?? ''

const CHECKING = { text: 'health.checking', dots: 1, spinners: 0 }
const OK = { text: 'health.ok', dots: 1, spinners: 0 }
const NO_CRED = { text: 'health.noCredential', dots: 1, spinners: 0 }
const RECONNECTING = { text: 'health.reconnecting', dots: 0, spinners: 1 }

const add = async (key: string) => {
  await act(async () => {
    store.set(addReconnectingStreamAtom, key)
  })
}
const remove = async (key: string) => {
  await act(async () => {
    store.set(removeReconnectingStreamAtom, key)
  })
}

// --- health alone --------------------------------------------------------------

test('health pending -> checking, with a (neutral) dot and no spinner', async () => {
  await mount()
  expect(healthCalls).toBe(1)
  expect(backend()).toEqual(CHECKING)
  expect(dotClass()).toContain('bg-muted-foreground')
})

test('health pending wins over a non-empty reconnecting set', async () => {
  store.set(addReconnectingStreamAtom, 's1')
  await mount()
  expect(backend()).toEqual(CHECKING)
})

test('health ok with a credential and an empty set -> ok, success dot', async () => {
  healthImpl = ok(true)
  await mount()
  expect(backend()).toEqual(OK)
  expect(dotClass()).toContain('bg-green-500')
})

test('health ok without a credential and an empty set -> noCredential, warning dot', async () => {
  healthImpl = ok(false)
  await mount()
  expect(backend()).toEqual(NO_CRED)
  expect(dotClass()).toContain('bg-amber-500')
})

test('health request errored -> reconnecting, spinner, no dot', async () => {
  healthImpl = fail
  await mount()
  expect(backend()).toEqual(RECONNECTING)
})

test('the old "down" label is gone: an errored health check never renders that key', async () => {
  healthImpl = fail
  await mount()
  expect(container.textContent ?? '').not.toContain('health.down')
})

test('health recovering from error goes back to ok', async () => {
  healthImpl = fail
  await mount()
  expect(backend()).toEqual(RECONNECTING)
  healthImpl = ok(true)
  await act(async () => {
    await client.refetchQueries({ queryKey: [{ url: '/api/health' }] })
  })
  await settle()
  expect(backend()).toEqual(OK)
})

// --- the reconnecting-streams set ----------------------------------------------

test('health ok + credential, but a stream reconnecting -> reconnecting wins over ok', async () => {
  healthImpl = ok(true)
  await mount()
  expect(backend()).toEqual(OK)
  await add('s1')
  expect(backend()).toEqual(RECONNECTING)
})

test('health ok without credential, but a stream reconnecting -> reconnecting wins over noCredential', async () => {
  healthImpl = ok(false)
  await mount()
  expect(backend()).toEqual(NO_CRED)
  await add('s1')
  expect(backend()).toEqual(RECONNECTING)
})

test('a set that is non-empty at mount shows reconnecting as soon as health answers', async () => {
  store.set(addReconnectingStreamAtom, 's1')
  healthImpl = ok(true)
  await mount()
  expect(backend()).toEqual(RECONNECTING)
})

test('emptying the set goes back to ok', async () => {
  healthImpl = ok(true)
  await mount()
  await add('s1')
  expect(backend()).toEqual(RECONNECTING)
  await remove('s1')
  expect(backend()).toEqual(OK)
})

test('emptying the set goes back to noCredential', async () => {
  healthImpl = ok(false)
  await mount()
  await add('s1')
  expect(backend()).toEqual(RECONNECTING)
  await remove('s1')
  expect(backend()).toEqual(NO_CRED)
})

test('with two streams reconnecting, it stays reconnecting until BOTH have recovered', async () => {
  healthImpl = ok(true)
  await mount()
  await add('s1')
  await add('s2')
  await remove('s1')
  expect(backend()).toEqual(RECONNECTING)
  await remove('s2')
  expect(backend()).toEqual(OK)
})

test('health errored and the set emptied: still reconnecting (health alone is enough)', async () => {
  healthImpl = fail
  await mount()
  await add('s1')
  await remove('s1')
  expect(backend()).toEqual(RECONNECTING)
})
