// The Ports page (`PortsPage`, route `/ports`): a live `ss -tulpn` — loading,
// an unresolved row's own "unknown" marker, the client-side global filter
// (by process name and by port), the Port column's sort toggle, Refresh
// issuing a new request, a 503 rendered as a readable alert rather than a
// blank page, and the informational "process details are hidden" notice
// that appears whenever the response says some sockets went unattributed,
// switching scope: the previous rows (and the scope toggle itself) stay on
// screen, dimmed, rather than the whole page flickering away while the new
// scope loads — see `usePorts`' own comment on `placeholderData:
// keepPreviousData` — and that same "manual refresh only" contract holding
// even without the app's own `refetchOnWindowFocus: false` default (neither
// a focus nor a reconnect event refetches), the "Last refreshed" time
// following the active i18next language rather than the browser's own
// locale, and the global filter matching what an unresolved row actually
// shows (the translated "unknown" label) rather than its raw `processName`.
//
// Rendered with no router at all: unlike storage-page.tsx's anomalies table,
// this page never renders a `Link` (there is nothing here to navigate to),
// so a bare `QueryClientProvider` + `I18nextProvider` is enough.
//
// Wrapped in its own private, isolated `I18nextProvider` (a `cimode`
// instance — i18next's own always-return-the-key mode) rather than the app's
// ambient global i18next singleton — see tests/storage-page.test.tsx's own
// header comment for why: that singleton is a `bun test`-process-wide,
// unawaited side effect that whichever test file's render reaches first
// initialises for every other file afterwards too. Every `t()` match below
// depends on getting the raw key back, so this file brings its own answer
// rather than racing the rest of the suite for it. The locale and filter
// cases below need real wording instead, so they mount against private
// en/ru instances built the same way tests/ports-page-verify.test.tsx's own
// russian cases do.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next, { type i18n as I18n } from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { mockModule } from './mock-module'

const PORTS_CLIENT = '@/shared/api/generated/clients/getApiSystemPorts'

const T = '2026-09-04T10:00:00.000Z'

const PORTS = [
  {
    protocol: 'tcp',
    localAddress: '127.0.0.1',
    localPort: 8080,
    peerAddress: null,
    peerPort: null,
    state: 'LISTEN',
    pid: 1234,
    processName: 'node',
    processKnown: true,
  },
  {
    protocol: 'tcp',
    localAddress: '0.0.0.0',
    localPort: 22,
    peerAddress: null,
    peerPort: null,
    state: 'LISTEN',
    pid: null,
    processName: 'unknown',
    processKnown: false,
  },
  {
    protocol: 'udp',
    localAddress: '0.0.0.0',
    localPort: 53,
    peerAddress: null,
    peerPort: null,
    state: 'UNCONN',
    pid: 999,
    processName: 'systemd-resolved',
    processKnown: true,
  },
]

function response(overrides: Record<string, unknown> = {}) {
  const ports = (overrides.ports as typeof PORTS | undefined) ?? PORTS
  return {
    scope: 'listening',
    source: 'ss',
    collectedAt: T,
    user: 'agentoo',
    runningAsRoot: false,
    total: ports.length,
    truncated: false,
    unattributedCount: ports.filter((p) => !p.processKnown).length,
    ports,
    ...overrides,
  }
}

let responseData: ReturnType<typeof response> = response()
/** Per-scope override for `responseData`, for tests where Listening and All
 *  must answer with visibly different rows (the scope-switch tests below) —
 *  every other test only ever requests one scope, so `responseData` alone
 *  still covers it. */
let scopeResponses: Partial<Record<string, ReturnType<typeof response>>> = {}
let failure: unknown = null
let scopeCalls: (string | undefined)[] = []
/** When set for a scope, that scope's request waits on it before answering —
 *  see tests/sessions-dashboard-page.test.tsx's identical `gates` for why: a
 *  real, held Promise is what actually exercises "the second request is
 *  still pending" rather than a timing guess. */
let gates: Partial<Record<string, Promise<void>>> = {}

// Registered through tests/mock-module.ts rather than a bare `mock.module` —
// see storage-page.test.tsx's own header comment for why that call needs to
// be scoped back to this file.
await mockModule(PORTS_CLIENT, () => ({
  getApiSystemPorts: async (opts: { query?: { scope?: string } }) => {
    const scope = opts.query?.scope
    scopeCalls.push(scope)
    if (failure) throw failure
    const gate = scope ? gates[scope] : undefined
    if (gate) await gate
    return { data: (scope && scopeResponses[scope]) ?? responseData }
  },
}))

const { PortsPage } = await import('../src/features/system/components/ports-page')

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const russian = i18next.createInstance()
await russian.init({
  lng: 'ru',
  fallbackLng: 'ru',
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
})

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount(i18n: I18n = testI18n) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <PortsPage />
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
}

const settle = async (ticks = 5) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  // Reset the two global singletons the focus/reconnect case below flips —
  // same reason tests/ports-page-verify.test.tsx's own afterEach resets
  // `focusManager`: both outlive this file's individual tests otherwise.
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
}

beforeEach(() => {
  responseData = response()
  scopeResponses = {}
  failure = null
  scopeCalls = []
  gates = {}
})

afterEach(unmount)

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (text: string) => buttons().find((b) => b.textContent?.trim() === text)
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const filterInput = () =>
  container.querySelector('input[aria-label="ports.filter.placeholder"]') as HTMLInputElement

/** The same input, found by tag alone — for the real-instance tests below,
 *  where the aria-label is translated wording rather than the raw key the
 *  selector above depends on. */
const anyFilterInput = () => container.querySelector('input') as HTMLInputElement

/** Types into a controlled input the way a browser does — see
 *  tests/idea-detail-page.test.tsx's identical helper. */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Every body row's own Port cell (column index 2: Protocol, Local Address,
 *  Port, PID, Process Name, State), in row order. */
const portCells = () =>
  [...container.querySelectorAll('tbody tr')].map((row) => row.children[2]?.textContent)

test('shows a loading state before the first response resolves', async () => {
  await mount()
  expect(container.textContent).toContain('common.loading')
})

test('renders every row, marking an unresolved one with the unknown-process marker', async () => {
  await mount()
  await settle()

  expect(container.textContent).toContain('node')
  expect(container.textContent).toContain('systemd-resolved')
  expect(container.textContent).toContain('ports.unknownProcess')
  expect(container.querySelectorAll('tbody tr').length).toBe(3)
})

test('filtering by process name narrows the rows to just that process', async () => {
  await mount()
  await settle()

  await type(filterInput(), 'node')
  await settle(1)

  const rows = container.querySelectorAll('tbody tr')
  expect(rows.length).toBe(1)
  expect(rows[0]?.textContent).toContain('node')
})

test('filtering by port number narrows the rows to just that socket', async () => {
  await mount()
  await settle()

  await type(filterInput(), '53')
  await settle(1)

  const rows = container.querySelectorAll('tbody tr')
  expect(rows.length).toBe(1)
  expect(rows[0]?.textContent).toContain('systemd-resolved')
})

test('the filter shows no match instead of silently emptying the table', async () => {
  await mount()
  await settle()

  await type(filterInput(), 'nothing-matches-this')
  await settle(1)

  // `DataTable`'s own `empty` slot renders as one row (a single, full-width
  // cell), not as zero rows — see shared/components/data-table.tsx.
  const rows = container.querySelectorAll('tbody tr')
  expect(rows.length).toBe(1)
  expect(rows[0]?.textContent).toContain('ports.noMatch')
})

test('under ru, the filter matches an unresolved row by its translated label, not the raw "unknown" behind it', async () => {
  await mount(russian)
  await settle()

  // The port-22 row's raw `processName` is the literal 'unknown', but what
  // ru actually shows for it is «неизвестно» — see `createMatchesQuery`'s
  // own comment for why the filter has to match that rendered label rather
  // than the English string underneath it.
  await type(anyFilterInput(), 'неизвестно')
  await settle(1)
  const matched = container.querySelectorAll('tbody tr')
  expect(matched.length).toBe(1)
  expect(matched[0]?.textContent).toContain('22')

  await type(anyFilterInput(), 'unknown')
  await settle(1)
  expect(container.querySelectorAll('tbody tr')[0]?.textContent).toBe(
    'Под этот фильтр не подходит ни один порт.',
  )
})

test('clicking the Port header reverses the row order', async () => {
  await mount()
  await settle()

  // Default sort is Port ascending.
  expect(portCells()).toEqual(['22', '53', '8080'])

  const header = buttons().find((b) => b.textContent?.trim() === 'ports.table.port')
  if (!header) throw new Error('no Port column header button')
  await click(header)

  expect(portCells()).toEqual(['8080', '53', '22'])
})

test('Refresh issues a second request for the current scope', async () => {
  await mount()
  await settle()
  expect(scopeCalls).toEqual(['listening'])

  const refresh = findButton('ports.refresh')
  if (!refresh) throw new Error('no Refresh button')
  await click(refresh)
  await settle()

  expect(scopeCalls).toEqual(['listening', 'listening'])
})

test('neither a window focus nor a reconnect refetches — only Refresh does', async () => {
  await mount()
  await settle()
  expect(scopeCalls).toEqual(['listening'])

  // This file's own QueryClient (unlike app/providers.tsx) carries none of
  // the app-wide `refetchOnWindowFocus: false` default, so this only stays
  // quiet if `usePorts` sets both of these itself.
  await act(async () => {
    focusManager.setFocused(false)
  })
  await act(async () => {
    focusManager.setFocused(true)
  })
  await settle()
  expect(scopeCalls).toEqual(['listening'])

  await act(async () => {
    onlineManager.setOnline(false)
  })
  await act(async () => {
    onlineManager.setOnline(true)
  })
  await settle()
  expect(scopeCalls).toEqual(['listening'])
})

test('a 503 renders the backend\'s own message in an alert, not a blank page', async () => {
  failure = { response: { data: { error: 'neither ss nor /proc could be read' } } }
  await mount()
  await settle()

  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('neither ss nor /proc could be read')
  // Refresh must still be there to retry.
  expect(findButton('ports.refresh')).toBeDefined()
})

test('the permissions notice appears when some sockets went unattributed', async () => {
  await mount()
  await settle()

  expect(container.textContent).toContain('ports.unattributed.withUser')
})

test('no permissions notice when every socket resolved to a known process', async () => {
  responseData = response({
    ports: PORTS.filter((p) => p.processKnown),
  })
  await mount()
  await settle()

  expect(container.textContent).not.toContain('ports.unattributed')
})

test('the truncated banner appears when the backend capped the row count', async () => {
  responseData = response({ truncated: true, total: 9000 })
  await mount()
  await settle()

  expect(container.textContent).toContain('ports.truncated')
})

test('an empty port table renders the empty state, not a table with no rows', async () => {
  responseData = response({ ports: [] })
  await mount()
  await settle()

  expect(container.textContent).toContain('ports.empty')
  expect(container.querySelectorAll('tbody tr').length).toBe(0)
})

test('the "Last refreshed" time follows the active i18next language, not the browser default', async () => {
  await mount(russian)
  await settle()

  // en/US formats a 12-hour clock with an AM/PM marker; ru's 24-hour clock
  // never does — a difference this environment's own default locale (en)
  // would erase if the page fell back to it instead of `i18n.language`.
  expect(container.textContent).not.toContain('AM')
  expect(container.textContent).not.toContain('PM')
})

test('and under en, the same time still reads with an AM/PM marker', async () => {
  await mount(english)
  await settle()

  expect(container.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}\s?(AM|PM)/)
})

test('switching scope keeps the previous rows and the toggle on screen while the new scope loads, then swaps once it resolves', async () => {
  scopeResponses.listening = response({ ports: [PORTS[0]] })
  scopeResponses.all = response({ scope: 'all', ports: PORTS })
  let release: () => void = () => {}
  gates.all = new Promise<void>((r) => {
    release = r
  })

  await mount()
  await settle()
  expect(portCells()).toEqual(['8080'])

  const allToggle = findButton('ports.scope.all')
  if (!allToggle) throw new Error('no All toggle button')
  await click(allToggle)

  // The `all` request is in flight and held: the Listening rows and the
  // scope toggle itself both stay exactly where they were, dimmed
  // (`aria-busy`) rather than replaced by a spinner or vanishing.
  expect(scopeCalls).toEqual(['listening', 'all'])
  expect(portCells()).toEqual(['8080'])
  expect(findButton('ports.scope.listening')).toBeDefined()
  expect(findButton('ports.scope.all')).toBeDefined()
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()

  await act(async () => {
    release()
  })
  await settle()

  expect(portCells()).toEqual(['22', '53', '8080'])
  expect(container.querySelector('[aria-busy="true"]')).toBeNull()
})

test('when the very first request fails, the error alert is shown and the scope toggle is still present', async () => {
  failure = { response: { data: { error: 'neither ss nor /proc could be read' } } }
  await mount()
  await settle()

  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('neither ss nor /proc could be read')
  expect(findButton('ports.scope.listening')).toBeDefined()
  expect(findButton('ports.scope.all')).toBeDefined()
})
