// The skew notice as it is actually mounted — the half of the feature the pure
// `isVersionSkewed` tests cannot reach.
//
// Why this file has to mock `@/shared/config/env` at all: under `bun test`
// there is no Vite transform, so `import.meta.env.PROD` is `undefined` and
// `__APP_VERSION__` is never substituted — verified, `isProd` comes out
// `undefined` and `env.appVersion` falls back to `'dev'`. `VersionSkewAlert`
// is gated on `isProd`, so without this it returns `null` unconditionally and
// every assertion below would pass for the wrong reason: an empty document
// proves nothing about a component that is hard-wired off. Mocking the module
// is what puts it in the state a production bundle actually ships (verified
// separately: `bun run build` bakes `appVersion: "0.1.79"` and folds `isProd`
// to a literal `true`, so the `typeof __APP_VERSION__` fallback is eliminated
// entirely rather than left live).
//
// Everything else is real: the real Alert and Button, the real i18n bundle
// (so a missing translation key shows up as the raw key and fails), the real
// QueryClient with `useHealth`'s query seeded directly.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AxiosInstance } from 'axios'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const ENV_MODULE = new URL('../src/shared/config/env.ts', import.meta.url).pathname

/** Stand-in for the two values Vite bakes in at build time: the version this
 *  tab is running, and the production gate.
 *
 *  Fixed rather than per-test mutable, deliberately. The component imports
 *  `env` and `isProd` as ordinary bindings, and bun resolves those once when
 *  the module below is first imported — a mutable getter here reads as live
 *  but is not (verified: flipping it mid-file changed nothing). So the
 *  `isProd: false` half of the gate is left to tests/version-skew.test.ts,
 *  which exercises `isVersionSkewed` directly and can vary it honestly. What
 *  this file adds is everything downstream of the gate being open. */
const BUILD_VERSION = '0.1.79'

// Through tests/mock-module.ts rather than `mock.module` directly: this fake
// makes `isProd` true for the whole process, and a bare `mock.module` never
// gives that back — every file `bun test` loads afterwards would render the
// production branch of anything gated on it. Awaited here so it is in place
// before the component below is imported, which is the ordering the paragraph
// above depends on.
await mockModule(ENV_MODULE, () => ({
  env: { apiUrl: '/api', appName: 'agentoo', appVersion: BUILD_VERSION },
  isProd: true,
}))

const { VersionSkewAlert } = await import('../src/features/health/components/version-skew-alert')
const { getApiHealthQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiHealth'
)
const { client: apiClient } = await import('../src/shared/api/generated/.kubb/client')
await import('../src/shared/i18n')

/** No test here is about fetching, but `useHealth` mounts a real query: without
 *  a transport of its own this file would issue real HTTP to /api/health and
 *  pass or fail on whether a backend happens to be listening. Refusing every
 *  request is also the honest stand-in for the "backend unreachable" case
 *  below. */
const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()

const originalTransport = apiClient.getConfig().transport

let client: QueryClient
let container: HTMLDivElement
let root: Root

const realReload = window.location.reload
let reloads = 0

beforeEach(() => {
  reloads = 0
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    value: () => {
      reloads++
    },
  })
  apiClient.setConfig({ transport: offlineTransport })
  // `staleTime: Infinity` so seeding the cache below is the whole story: a
  // refetch would race every assertion and reintroduce the network.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  client.clear()
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    value: realReload,
  })
})

/** Seed `useHealth`'s cache directly rather than faking a transport: what is
 *  under test is the comparison and the render, not the fetch. `health`
 *  `undefined` stands for "the poll has not answered, or the backend is
 *  unreachable" — react-query reports both as no data. */
async function render(health: unknown) {
  if (health !== undefined) client.setQueryData(getApiHealthQueryKey(), health)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <VersionSkewAlert />
      </QueryClientProvider>,
    )
  })
}

const alert = () => container.querySelector('[role="status"], [role="alert"]')
const text = () => container.textContent ?? ''
const reloadButton = () =>
  [...container.querySelectorAll('button')].find((b) => /reload|перезагр/i.test(b.textContent ?? ''))

const ok = (version: unknown) => ({ status: 'ok', version, claudeCredential: true })

// --- the case it exists for ----------------------------------------------------

test('a genuine mismatch renders a visible notice with a Reload button', async () => {
  await render(ok('0.1.80'))

  expect(alert()).not.toBeNull()
  expect(reloadButton()).toBeDefined()
  // The real translations, not the keys — a key missing from en.json would
  // render as `health.outdatedTitle` and fail here.
  expect(text()).toContain('Update available')
  expect(text()).not.toContain('health.outdated')
})

test('the notice does not reload on its own — only the button does', async () => {
  await render(ok('0.1.80'))
  expect(reloads).toBe(0)

  await act(async () => {
    reloadButton()?.click()
  })
  expect(reloads).toBe(1)
})

test('the notice is polite, not an assertive interrupt', async () => {
  // tone="warning" — Alert only announces `danger` assertively. A build being
  // stale is not an emergency and must not talk over a screen reader.
  await render(ok('0.1.80'))
  expect(alert()?.getAttribute('role')).toBe('status')
  expect(alert()?.getAttribute('aria-live')).toBe('polite')
})

// --- the false-nag failure modes ----------------------------------------------

test('matching versions render nothing at all', async () => {
  await render(ok('0.1.79'))
  expect(alert()).toBeNull()
  expect(text()).toBe('')
})

test('an unreachable backend (no health data) does not nag and does not throw', async () => {
  // Nothing seeded and every request refused — react-query reports "no data",
  // which must read as "nothing to compare against", never as skew.
  await render(undefined)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
  expect(alert()).toBeNull()
})

test('a health response with no version field does not nag', async () => {
  await render({ status: 'ok', claudeCredential: true })
  expect(alert()).toBeNull()
})

for (const version of [null, '', undefined]) {
  test(`a health response with a falsy version (${JSON.stringify(version)}) does not nag`, async () => {
    await render(ok(version))
    expect(alert()).toBeNull()
  })
}

test('a health response that is not an object at all does not throw', async () => {
  await render('totally not a health payload')
  expect(alert()).toBeNull()
})

// --- direction ------------------------------------------------------------------

test('a tab AHEAD of the backend stays silent — the wrong-direction case a bare !== used to trip', async () => {
  // Previously indistinguishable from "tab behind": a bare `!==` fired on
  // deploy order this way round too, even though the notice's copy ("running
  // an older build than the server") is untrue here and reloading cannot fix
  // it — the backend catching up is what clears it. version-skew.ts's
  // numeric, direction-aware comparison is what keeps this silent now; this
  // replaces the test that used to pin the bug (BUILD_VERSION is "0.1.79",
  // so "0.1.78" is a backend that is one build behind this tab, not ahead).
  await render(ok('0.1.78'))

  expect(alert()).toBeNull()
})

test('a backend version that does not parse as major.minor.build stays silent, not thrown', async () => {
  await render(ok('not-a-version'))
  expect(alert()).toBeNull()
})

// --- dismissal --------------------------------------------------------------

const dismissButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')

test('the notice has a dismiss control, and dismissing it hides the notice', async () => {
  await render(ok('0.1.80'))
  expect(alert()).not.toBeNull()
  expect(dismissButton()).not.toBeNull()

  await act(async () => {
    dismissButton()?.click()
  })
  expect(alert()).toBeNull()
})

test('a dismissal holds across the poll re-fetching the exact same mismatch', async () => {
  await render(ok('0.1.80'))
  await act(async () => {
    dismissButton()?.click()
  })
  expect(alert()).toBeNull()

  // Same version pair, a new response object — exactly what the 15s poll
  // delivers on its next tick. Without per-pair state this resurrects the
  // notice seconds after the button was clicked, which is the defect this
  // pins shut.
  await act(async () => {
    client.setQueryData(getApiHealthQueryKey(), ok('0.1.80'))
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(alert()).toBeNull()
})

test('a dismissal does not survive the backend moving on to a different version', async () => {
  await render(ok('0.1.80'))
  await act(async () => {
    dismissButton()?.click()
  })
  expect(alert()).toBeNull()

  await act(async () => {
    client.setQueryData(getApiHealthQueryKey(), ok('0.1.81'))
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(alert()).not.toBeNull()
})
