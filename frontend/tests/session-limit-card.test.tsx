// SettingsPage's second card, `SessionLimitCard`, for the server-held "max
// concurrent sessions" setting: the field pre-filled from
// `GET /api/system/settings` (with its default/override status line and the
// Reset button's enabled state following `source`), client-side rejection of
// anything outside a whole number 1–64 without a PATCH ever going out, a save
// and a reset sending exactly the body the API documents and refetching the
// GET afterwards, a server-side 400 rendered through `apiErrorMessage` in a
// destructive alert, Save/Reset locked while a PATCH is in flight, and a GET
// failure that leaves the language/theme card above it untouched.
//
// Mounted through the real router/shell at `/settings`, the same way
// tests/settings-page.test.tsx does, with the two generated clients replaced
// through tests/mock-module.ts the way tests/library-prompts-section.test.tsx
// replaces its own. The fake backend below is a tiny stateful server — a PATCH
// really changes what the next GET answers — so "save, then the refetch shows
// the new value" is the round trip itself, not two unrelated fixtures.
//
// Wrapped in a private English `I18nextProvider`, built the way
// tests/ports-page.test.tsx builds its own, rather than the app's ambient
// i18next singleton — see tests/settings-page.test.tsx's header comment for
// why that singleton is not safe to rely on (or to change) from one file. The
// labels and messages are matched as English wording because the wording is
// part of what is being checked. `<Toaster />` is rendered alongside the
// router because the app mounts it in providers.tsx, outside the route tree —
// the same arrangement tests/docker-system-page.test.tsx uses.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const GET_CLIENT = '@/shared/api/generated/clients/getApiSystemSettings'
const PATCH_CLIENT = '@/shared/api/generated/clients/patchApiSystemSettings'

// Held before the module is mocked: `mock.module` swaps the namespace's
// bindings in place, but this is the real function object itself, so it stays
// the real one. Used once below to check the method/URL the hook's mutation
// would actually send — the one part the mocked client can not show.
const realPatch = (await import(PATCH_CLIENT)).patchApiSystemSettings as (opts: {
  body: unknown
  client: (config: Record<string, unknown>) => Promise<unknown>
}) => Promise<unknown>

type Setting = { value: number; source: 'override' | 'default'; defaultValue: number }

/** The fake server's own state: what the next GET answers is derived from it. */
let defaultValue = 2
let override: number | null = null
const current = (): Setting =>
  override === null
    ? { value: defaultValue, source: 'default', defaultValue }
    : { value: override, source: 'override', defaultValue }

let getCalls = 0
/** When set, the GET rejects with it instead of answering. */
let getFailure: unknown = null
/** When set, the GET waits on it before answering (see `patchGate`). */
let getGate: Promise<void> | null = null
let patchCalls: unknown[] = []
/** When set, the PATCH rejects with it (and the server state is unchanged). */
let patchFailure: unknown = null
/** When set, the PATCH waits on it before answering — a real held promise,
 *  so "the request is still in flight" is a state, not a timing guess. */
let patchGate: Promise<void> | null = null

await mockModule(GET_CLIENT, () => ({
  getApiSystemSettings: async () => {
    getCalls++
    if (getGate) await getGate
    if (getFailure) throw getFailure
    return { data: { maxConcurrentSessions: current() } }
  },
}))
await mockModule(PATCH_CLIENT, () => ({
  patchApiSystemSettings: async (opts: { body: { maxConcurrentSessions: number | null } }) => {
    patchCalls.push(opts.body)
    if (patchGate) await patchGate
    if (patchFailure) throw patchFailure
    override = opts.body.maxConcurrentSessions
    return { data: { maxConcurrentSessions: current() } }
  },
}))

const { routeTree } = await import('../src/app/router')
const { Toaster, toast } = await import('../src/shared/ui/toast')

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

/** A real axios error carrying a response body, the way the generated client
 *  throws one under `throwOnError` for a non-2xx answer. */
function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() }
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    { status, statusText: '', data, headers: {}, config },
  )
}
const VALIDATION_400 = {
  error: 'Validation failed',
  issues: [{ path: 'maxConcurrentSessions', message: 'Must be at least 1' }],
}

const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

let container: HTMLDivElement
let root: Root | null = null
let client: QueryClient

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // The shell's own queries, seeded so it never reaches for a backend. The
  // settings query is deliberately *not* seeded: it is the one under test.
  client.setQueryData([{ url: '/api/projects' }], [])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData(
    [{ url: '/api/sessions/overview' }, { window: '1d' }],
    { running: [], unchecked: [], recent: [], window: '1d' },
  )
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={english}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <Toaster />
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  defaultValue = 2
  override = null
  getCalls = 0
  getFailure = null
  getGate = null
  patchCalls = []
  patchFailure = null
  patchGate = null
})

afterEach(async () => {
  await unmount()
  toast.close()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** The card whose title is "Session limit". */
const card = (): HTMLElement => {
  const title = [...container.querySelectorAll('[data-slot="card-title"]')].find(
    (el) => text(el) === 'Session limit',
  )
  const found = title?.closest('[data-slot="card"]') as HTMLElement | null | undefined
  if (!found) throw new Error('no "Session limit" card on the page')
  return found
}
/** The input the "Max concurrent sessions" label points at. */
const field = (): HTMLInputElement => {
  const label = [...card().querySelectorAll('label')].find(
    (el) => text(el) === 'Max concurrent sessions',
  )
  const id = label?.getAttribute('for')
  const input = id ? (card().querySelector(`#${id}`) as HTMLInputElement | null) : null
  if (!input) throw new Error('no input labelled "Max concurrent sessions"')
  return input
}
const button = (label: string): HTMLButtonElement => {
  const found = [...card().querySelectorAll('button')].find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button in the card`)
  return found as HTMLButtonElement
}
const fieldError = () => card().querySelector('[data-slot="field-error"]')
const destructiveAlerts = (scope: Element) =>
  [...scope.querySelectorAll('[data-slot="alert"]')].filter((el) =>
    el.className.includes('text-destructive'),
  )
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))

/** Types into a controlled input the way a browser does — see
 *  tests/ports-page.test.tsx's identical helper. */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

// 1. Pre-filled field -------------------------------------------------------

test('a default setting pre-fills the field, says it is the default, and disables Reset', async () => {
  await mount()
  expect(getCalls).toBe(1)
  expect(field().value).toBe('2')
  expect(text(card())).toContain('Using the default of 2.')
  expect(text(card())).not.toContain('Overriding')
  expect(button('Reset to default').disabled).toBe(true)
  expect(button('Save').disabled).toBe(false)
  expect(field().getAttribute('aria-invalid')).toBe('false')
  expect(problems).toEqual([])
})

test('an override pre-fills the field with its value, names the default, and enables Reset', async () => {
  override = 3
  await mount()
  expect(field().value).toBe('3')
  expect(text(card())).toContain('Overriding the default of 2.')
  expect(text(card())).not.toContain('Using the default')
  expect(button('Reset to default').disabled).toBe(false)
  expect(problems).toEqual([])
})

// 2. Client-side rejection --------------------------------------------------

const REJECTED: [input: string, message: string][] = [
  ['0', 'Enter a whole number of 1 or more'],
  ['-1', 'Enter a whole number of 1 or more'],
  ['1.5', 'Enter a whole number of 1 or more'],
  ['', 'Enter a whole number of 1 or more'],
  ['65', 'Limit is too high'],
]

for (const [input, message] of REJECTED) {
  test(`Save with ${JSON.stringify(input)} shows "${message}", marks the field invalid, and sends no PATCH`, async () => {
    await mount()
    await type(field(), input)
    await click(button('Save'))

    expect(text(fieldError())).toBe(message)
    expect(fieldError()?.getAttribute('role')).toBe('alert')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    // The message is what the field announces as its description.
    expect(field().getAttribute('aria-describedby')).toBe(fieldError()?.id ?? '<no id>')
    expect(patchCalls).toEqual([])
    expect(toastTitles()).toEqual([])
    expect(problems).toEqual([])
  })
}

test('the bounds themselves, 1 and 64, are accepted', async () => {
  await mount()
  await type(field(), '1')
  await click(button('Save'))
  await type(field(), '64')
  await click(button('Save'))
  expect(patchCalls).toEqual([{ maxConcurrentSessions: 1 }, { maxConcurrentSessions: 64 }])
  expect(fieldError()).toBeNull()
})

test('correcting a rejected value clears the error and the next Save goes through', async () => {
  await mount()
  await type(field(), '0')
  await click(button('Save'))
  expect(text(fieldError())).toBe('Enter a whole number of 1 or more')

  await type(field(), '4')
  await settle()
  expect(fieldError()).toBeNull()
  expect(field().getAttribute('aria-invalid')).toBe('false')
  await click(button('Save'))
  expect(patchCalls).toEqual([{ maxConcurrentSessions: 4 }])
})

// 3. Save -------------------------------------------------------------------

test('Save sends exactly { maxConcurrentSessions: 3 }, toasts, refetches, and the field follows the refetch', async () => {
  await mount()
  expect(getCalls).toBe(1)
  await type(field(), '3')
  await click(button('Save'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: 3 }])
  expect(toastTitles()).toContain('Saved')
  // The mutation invalidated the query, so the GET ran again.
  expect(getCalls).toBe(2)
  expect(field().value).toBe('3')
  expect(text(card())).toContain('Overriding the default of 2.')
  expect(button('Reset to default').disabled).toBe(false)
  expect(destructiveAlerts(card())).toHaveLength(0)
  expect(problems).toEqual([])
})

test('after a save, a fresh mount (a reload) shows the saved value from GET', async () => {
  await mount()
  await type(field(), '3')
  await click(button('Save'))
  await unmount()

  await mount()
  expect(field().value).toBe('3')
  expect(text(card())).toContain('Overriding the default of 2.')
  expect(button('Reset to default').disabled).toBe(false)
})

test('the real generated PATCH client sends PATCH /api/system/settings with the body unchanged', async () => {
  const seen: Record<string, unknown>[] = []
  await realPatch({
    body: { maxConcurrentSessions: 3 },
    client: async (config) => {
      seen.push(config)
      return { data: null }
    },
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.method).toBe('PATCH')
  expect(seen[0]?.url).toBe('/api/system/settings')
  expect(seen[0]?.body).toEqual({ maxConcurrentSessions: 3 })
})

test('while a save is in flight, Save and Reset are disabled and a second click sends nothing', async () => {
  override = 3
  let release = () => {}
  patchGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await type(field(), '5')
  await click(button('Save'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: 5 }])
  expect(button('Save').disabled).toBe(true)
  expect(button('Reset to default').disabled).toBe(true)
  await click(button('Save'))
  await click(button('Reset to default'))
  expect(patchCalls).toEqual([{ maxConcurrentSessions: 5 }])

  await act(async () => {
    release()
  })
  await settle()
  expect(button('Save').disabled).toBe(false)
  expect(field().value).toBe('5')
  expect(patchCalls).toHaveLength(1)
})

// 4. Server rejection -------------------------------------------------------

test("a 400 from PATCH shows the server's validation message in a destructive alert", async () => {
  patchFailure = httpError(400, VALIDATION_400)
  await mount()
  await type(field(), '3')
  await click(button('Save'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: 3 }])
  const alerts = destructiveAlerts(card())
  expect(alerts.map((a) => text(a))).toEqual(['maxConcurrentSessions: Must be at least 1'])
  expect(toastTitles()).not.toContain('Saved')
  // The typed value is kept for the reader to fix, and nothing was saved.
  expect(field().value).toBe('3')
  expect(text(card())).toContain('Using the default of 2.')
  expect(problems).toEqual([])
})

test('the server alert clears once a later save succeeds', async () => {
  patchFailure = httpError(400, VALIDATION_400)
  await mount()
  await type(field(), '3')
  await click(button('Save'))
  expect(destructiveAlerts(card())).toHaveLength(1)

  patchFailure = null
  await click(button('Save'))
  expect(destructiveAlerts(card())).toHaveLength(0)
  expect(toastTitles()).toContain('Saved')
})

// 5. Reset ------------------------------------------------------------------

test('Reset to default sends { maxConcurrentSessions: null }, toasts, and the refetch shows the default', async () => {
  override = 3
  await mount()
  await click(button('Reset to default'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: null }])
  expect(toastTitles()).toContain('Reset to the default')
  expect(getCalls).toBe(2)
  expect(field().value).toBe('2')
  expect(text(card())).toContain('Using the default of 2.')
  expect(button('Reset to default').disabled).toBe(true)
  expect(problems).toEqual([])
})

test('Reset discards an unsaved edit when the override was pinned at the default value', async () => {
  // An override that happens to equal the default (the API documents this as
  // a real, distinct state). Resetting it leaves the effective value at 2, so
  // the field must show 2 afterwards — not whatever was typed and never saved.
  override = 2
  await mount()
  expect(text(card())).toContain('Overriding the default of 2.')
  await type(field(), '7')
  await click(button('Reset to default'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: null }])
  expect(text(card())).toContain('Using the default of 2.')
  expect(field().value).toBe('2')
})

test('a failed reset shows the server message in a destructive alert', async () => {
  override = 3
  patchFailure = httpError(500, { error: 'settings store is read-only' })
  await mount()
  await click(button('Reset to default'))

  expect(patchCalls).toEqual([{ maxConcurrentSessions: null }])
  expect(destructiveAlerts(card()).map((a) => text(a))).toEqual(['settings store is read-only'])
  expect(field().value).toBe('3')
  expect(button('Reset to default').disabled).toBe(false)
})

// 6. Load failure -----------------------------------------------------------

test('a failed GET shows the load-failed alert in the card, and the language/theme card still renders', async () => {
  getFailure = httpError(500, { error: 'database is locked' })
  await mount()

  expect(getCalls).toBe(1)
  const alerts = destructiveAlerts(card())
  expect(alerts.map((a) => text(a))).toEqual(['database is locked'])
  // No form to edit against a value that never loaded.
  expect(card().querySelector('input')).toBeNull()
  expect(card().querySelector('form')).toBeNull()
  // The page is not gated on this query.
  expect(container.querySelector('#settings-language')).not.toBeNull()
  expect(container.querySelector('#settings-theme')).not.toBeNull()
})

test('while the GET is still pending, the card shows loading and the language/theme card is already usable', async () => {
  let release = () => {}
  getGate = new Promise<void>((r) => {
    release = r
  })
  await mount()

  expect(text(card())).toContain('Loading…')
  expect(card().querySelector('input')).toBeNull()
  expect(container.querySelector('#settings-language')).not.toBeNull()
  expect(container.querySelector('#settings-theme')).not.toBeNull()

  await act(async () => {
    release()
  })
  await settle()
  expect(field().value).toBe('2')
})
