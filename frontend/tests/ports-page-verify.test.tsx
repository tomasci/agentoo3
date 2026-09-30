// Independent verification of the Ports page (`PortsPage`, route `/ports`),
// covering what tests/ports-page.test.tsx leaves out: numeric (not
// lexicographic) Port and PID sorting, unresolved PIDs staying last in both
// directions, recovery from a first-load 503 via Refresh, a failed refetch
// that keeps the previous rows, the interpolated wording of the truncated
// notice and the unattributed/inferred notice (a named user, no user, and
// `runningAsRoot` suppressing only the inferred half), the filter's count and
// no-match state, the already-pressed scope toggle, Refresh issuing exactly
// one request per click and being disabled while in flight, and the absence
// of polling or focus refetches.
//
// The same isolation as tests/ports-page.test.tsx: the generated client is
// replaced through tests/mock-module.ts, and every render goes through a
// private I18nextProvider rather than the app's global i18next singleton.
// Two private instances are used: a `cimode` one (t() returns the raw key)
// for structural assertions, and one loaded with the real en/ru bundles for
// assertions on the interpolated wording, which cimode cannot show.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next, { type i18n as I18n } from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { mockModule } from './mock-module'

const PORTS_CLIENT = '@/shared/api/generated/clients/getApiSystemPorts'

const T = '2026-09-04T10:00:00.000Z'

type Port = {
  protocol: 'tcp' | 'udp'
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  state: string
  pid: number | null
  processName: string
  processKnown: boolean
  attribution: 'socket' | 'docker' | 'service' | 'none'
  unit: string | null
  container: string | null
  owner: string | null
}

const port = (o: Partial<Port> & { localPort: number }): Port => ({
  protocol: 'tcp',
  localAddress: '127.0.0.1',
  peerAddress: null,
  peerPort: null,
  state: 'LISTEN',
  pid: null,
  processName: 'unknown',
  processKnown: false,
  attribution: 'none',
  unit: null,
  container: null,
  owner: null,
  ...o,
})

const known = (localPort: number, pid: number, processName: string, o: Partial<Port> = {}) =>
  port({ localPort, pid, processName, processKnown: true, attribution: 'socket', ...o })

const DEFAULT_PORTS: Port[] = [
  known(8080, 1234, 'node'),
  port({ localPort: 22, localAddress: '0.0.0.0' }),
  known(53, 999, 'systemd-resolved', { protocol: 'udp', state: 'UNCONN' }),
]

function response(overrides: Record<string, unknown> = {}) {
  const ports = (overrides.ports as Port[] | undefined) ?? DEFAULT_PORTS
  return {
    scope: 'listening',
    source: 'ss',
    collectedAt: T,
    user: 'agentoo',
    runningAsRoot: false,
    total: ports.length,
    truncated: false,
    unattributedCount: ports.filter((p) => !p.processKnown).length,
    inferredCount: ports.filter((p) => p.attribution === 'docker' || p.attribution === 'service')
      .length,
    ports,
    ...overrides,
  }
}

/** An axios-shaped rejection, the way the generated client throws a 503. */
const httpError = (status: number, error: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error } },
  })

let responseData: ReturnType<typeof response> = response()
let scopeResponses: Partial<Record<string, ReturnType<typeof response>>> = {}
let failure: unknown = null
let calls: (string | undefined)[] = []
let gate: Promise<void> | null = null

await mockModule(PORTS_CLIENT, () => ({
  getApiSystemPorts: async (opts: { query?: { scope?: string } }) => {
    const scope = opts.query?.scope
    calls.push(scope)
    if (gate) await gate
    if (failure) throw failure
    return { data: (scope && scopeResponses[scope]) ?? responseData }
  },
}))

const { PortsPage } = await import('../src/features/system/components/ports-page')

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

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

/** The app's own QueryClient defaults (app/providers.tsx), so the focus and
 *  polling tests below see the configuration the real page runs under. */
const APP_QUERY_DEFAULTS = { refetchOnWindowFocus: false, retry: 1, staleTime: 60_000 } as const

let client: QueryClient
let container: HTMLDivElement
let root: Root | null = null

async function mount(i18n: I18n = cimode, queries: Record<string, unknown> = { retry: false }) {
  client = new QueryClient({ defaultOptions: { queries } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
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

beforeEach(() => {
  responseData = response()
  scopeResponses = {}
  failure = null
  calls = []
  gate = null
})

afterEach(async () => {
  if (!root) return
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  client.clear()
  focusManager.setFocused(undefined)
})

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (label: string) => {
  const b = buttons().find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button labelled ${label}`)
  return b
}
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}
const filterInput = () => {
  const el = container.querySelector('input')
  if (!el) throw new Error('no filter input')
  return el as HTMLInputElement
}
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const bodyRows = () => [...container.querySelectorAll('tbody tr')]
const column = (index: number) => bodyRows().map((row) => row.children[index]?.textContent ?? '')
const portCells = () => column(2)
const pidCells = () => column(3)
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null
const statusTexts = () =>
  [...container.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? '')

// --- Requirement 2: columns and their order --------------------------------

test('the header row is Protocol, Local Address, Port, PID, Process Name, State, in that order (en)', async () => {
  await mount(english)
  await settle()
  const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
  expect(headers).toEqual(['Protocol', 'Local Address', 'Port', 'PID', 'Process Name', 'State'])
})

test('the same header row renders in Russian under the ru bundle', async () => {
  await mount(russian)
  await settle()
  const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
  expect(headers).toEqual([
    'Протокол',
    'Локальный адрес',
    'Порт',
    'PID',
    'Имя процесса',
    'Состояние',
  ])
})

// --- Requirement 3: sorting ------------------------------------------------

const NUMERIC_PORTS = [8000, 9, 65535, 443, 22].map((p, i) => known(p, 100 + i, `proc${p}`))

test('Port sorts numerically ascending by default (9 < 22 < 443 < 8000 < 65535, not lexicographically)', async () => {
  responseData = response({ ports: NUMERIC_PORTS })
  await mount()
  await settle()
  expect(portCells()).toEqual(['9', '22', '443', '8000', '65535'])
})

test('one click on Port reverses to numeric descending', async () => {
  responseData = response({ ports: NUMERIC_PORTS })
  await mount()
  await settle()
  await click(findButton('ports.table.port'))
  expect(portCells()).toEqual(['65535', '8000', '443', '22', '9'])
})

const PID_PORTS = [
  known(1001, 300, 'a'),
  port({ localPort: 1002 }),
  known(1003, 20, 'b'),
  port({ localPort: 1004 }),
  known(1005, 1000, 'c'),
]

test('PID sorts numerically ascending on first click, with unresolved PIDs last', async () => {
  responseData = response({ ports: PID_PORTS })
  await mount()
  await settle()
  await click(findButton('ports.table.pid'))
  expect(pidCells()).toEqual(['20', '300', '1000', '—', '—'])
})

test('PID descending on second click still keeps unresolved PIDs last', async () => {
  responseData = response({ ports: PID_PORTS })
  await mount()
  await settle()
  await click(findButton('ports.table.pid'))
  await click(findButton('ports.table.pid'))
  expect(pidCells()).toEqual(['1000', '300', '20', '—', '—'])
})

// --- Requirement 4: filter -------------------------------------------------

test('the filter is case-insensitive on process name and updates the shown-of-total count', async () => {
  await mount(english)
  await settle()
  expect(container.textContent).toContain('Showing 3 of 3')
  await type(filterInput(), 'NODE')
  expect(column(4)).toEqual(['node'])
  expect(container.textContent).toContain('Showing 1 of 3')
})

test('the filter matches a port number', async () => {
  await mount()
  await settle()
  await type(filterInput(), '8080')
  expect(portCells()).toEqual(['8080'])
})

test('a filter matching nothing shows the no-match message and "Showing 0 of 3"', async () => {
  await mount(english)
  await settle()
  await type(filterInput(), 'zzz-no-such-process')
  const rows = bodyRows()
  expect(rows.length).toBe(1)
  expect(rows[0]?.textContent).toBe('No ports match this filter.')
  expect(container.textContent).toContain('Showing 0 of 3')
})

test('clearing the filter brings every row back', async () => {
  await mount()
  await settle()
  await type(filterInput(), 'zzz')
  await type(filterInput(), '')
  expect(portCells()).toEqual(['22', '53', '8080'])
})

// --- Requirement 5: fetching -----------------------------------------------

test('exactly one request per Refresh click', async () => {
  await mount()
  await settle()
  expect(calls).toEqual(['listening'])
  await click(findButton('ports.refresh'))
  await settle()
  expect(calls).toEqual(['listening', 'listening'])
  await click(findButton('ports.refresh'))
  await settle()
  expect(calls).toEqual(['listening', 'listening', 'listening'])
})

test('Refresh is disabled and its icon spins while the request is in flight, then re-enables', async () => {
  await mount()
  await settle()
  let release: () => void = () => {}
  gate = new Promise<void>((r) => {
    release = r
  })
  await click(findButton('ports.refresh'))
  await settle()
  const refresh = findButton('ports.refresh')
  expect(refresh.disabled).toBe(true)
  expect(refresh.querySelector('svg')?.getAttribute('class') ?? '').toContain('animate-spin')

  // A click on the disabled button issues nothing further.
  await click(refresh)
  await settle()
  expect(calls).toEqual(['listening', 'listening'])

  await act(async () => {
    release()
  })
  await settle()
  expect(findButton('ports.refresh').disabled).toBe(false)
  expect(findButton('ports.refresh').querySelector('svg')?.getAttribute('class') ?? '').not.toContain(
    'animate-spin',
  )
})

test('under the app QueryClient defaults, a window blur/focus cycle does not refetch', async () => {
  await mount(cimode, { ...APP_QUERY_DEFAULTS })
  await settle()
  expect(calls).toEqual(['listening'])
  await act(async () => {
    focusManager.setFocused(false)
  })
  await act(async () => {
    focusManager.setFocused(true)
  })
  await settle()
  expect(calls).toEqual(['listening'])
})

test('no polling: the query has no refetchInterval, and nothing refetches over a wait', async () => {
  await mount(cimode, { ...APP_QUERY_DEFAULTS })
  await settle()
  const observers = client.getQueryCache().getAll()[0]?.observers ?? []
  expect(observers.length).toBe(1)
  expect(observers[0]?.options.refetchInterval).toBeUndefined()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250))
  })
  expect(calls).toEqual(['listening'])
})

// --- Requirement 6: loading and error --------------------------------------

test('a 503 on first load, then a successful Refresh, replaces the alert with the table', async () => {
  failure = httpError(503, 'neither ss nor /proc could be read')
  await mount()
  await settle()
  expect(alertText()).toContain('neither ss nor /proc could be read')
  expect(bodyRows().length).toBe(0)
  expect(findButton('ports.scope.listening')).toBeDefined()

  failure = null
  await click(findButton('ports.refresh'))
  await settle()
  expect(calls).toEqual(['listening', 'listening'])
  expect(alertText()).toBeNull()
  expect(portCells()).toEqual(['22', '53', '8080'])
})

test('a failed refetch shows the error alert while keeping the previous rows on screen', async () => {
  await mount()
  await settle()
  expect(portCells()).toEqual(['22', '53', '8080'])

  failure = httpError(503, 'port table unreadable')
  await click(findButton('ports.refresh'))
  await settle()
  expect(alertText()).toContain('port table unreadable')
  expect(portCells()).toEqual(['22', '53', '8080'])
  expect(findButton('ports.refresh').disabled).toBe(false)
})

test('a non-HTTP failure (no response body) still renders an alert, not a blank page', async () => {
  failure = new Error('Network Error')
  await mount()
  await settle()
  expect(alertText()).toContain('Network Error')
  expect(findButton('ports.refresh')).toBeDefined()
})

test('from a first-load error, the scope toggle still works and loads the other scope', async () => {
  failure = httpError(503, 'nope')
  await mount()
  await settle()
  failure = null
  scopeResponses.all = response({ scope: 'all', ports: [known(443, 7, 'curl')] })
  await click(findButton('ports.scope.all'))
  await settle()
  expect(calls).toEqual(['listening', 'all'])
  expect(alertText()).toBeNull()
  expect(portCells()).toEqual(['443'])
})

test('the loading state is a status region with the loading label, and no table yet', async () => {
  gate = new Promise<void>(() => {})
  await mount()
  await settle()
  expect(statusTexts()).toContain('common.loading')
  expect(container.querySelector('table')).toBeNull()
})

// --- Requirement 7: unresolved rows and the unattributed/inferred notices --

test('an unresolved row shows "—" for PID and a muted "unknown" process', async () => {
  await mount(english)
  await settle()
  const row22 = bodyRows().find((r) => r.children[2]?.textContent === '22')
  expect(row22?.children[3]?.textContent).toBe('—')
  const processCell = row22?.children[4]
  expect(processCell?.textContent).toBe('unknown')
  expect(processCell?.querySelector('span')?.className ?? '').toContain('text-muted-foreground')
})

// The contract behind this notice changed: `unattributedCount` now only ever
// counts `attribution: 'none'` rows (a kernel that truly reported no owning
// process — a TIME-WAIT connection, say), not "hidden because the backend
// can't read another uid's fd table" — DEFAULT_PORTS' own port-22 row is
// still one of those regardless, so the count below (1 of 3) is unchanged,
// but the sentence naming it no longer mentions the backend's user at all.
test('the unattributed notice states how many sockets have no identifiable process', async () => {
  await mount(english)
  await settle()
  const notice = statusTexts().find((s) => s.includes('no identifiable process'))
  expect(notice).toBe(
    '1 of 3 sockets have no identifiable process (for example connections in TIME-WAIT, which no process holds any more).',
  )
})

test('runningAsRoot leaves the unattributed sentence exactly as it reads for a non-root backend', async () => {
  responseData = response({ runningAsRoot: true, user: 'root' })
  await mount(english)
  await settle()
  const notice = statusTexts().find((s) => s.includes('no identifiable process'))
  expect(notice).toBe(
    '1 of 3 sockets have no identifiable process (for example connections in TIME-WAIT, which no process holds any more).',
  )
})

// `user: null` no longer touches the unattributed sentence (above) — the
// only sentence it still varies is the *inferred* one, which needs at least
// one `service`/`docker` row to say anything at all.
test('user: null falls back to the inferred sentence\'s no-user wording', async () => {
  responseData = response({
    user: null,
    ports: [...DEFAULT_PORTS, known(443, 50, 'nginx', { attribution: 'service', unit: 'nginx.service', owner: 'root' })],
  })
  await mount(english)
  await settle()
  const notice = statusTexts().find((s) => s.includes('systemd unit or Docker'))
  // DEFAULT_PORTS' own unattributed port-22 row means `unattributedCount` is
  // also non-zero here, so this same status region carries that sentence
  // too (see ports-page.tsx's own "both sentences in one Alert" comment) —
  // `toContain`, not `toBe`, is what leaves that second sentence out of
  // this assertion's business.
  expect(notice).toContain(
    '1 processes were identified from their systemd unit or Docker, because the backend runs as a non-root account and can\'t read other users\' sockets directly — they\'re marked with ⓘ.',
  )
})

test('running as root suppresses the inferred sentence even when a row was in fact inferred', async () => {
  responseData = response({
    runningAsRoot: true,
    user: 'root',
    ports: [...DEFAULT_PORTS, known(443, 50, 'nginx', { attribution: 'service', unit: 'nginx.service', owner: 'root' })],
  })
  await mount(english)
  await settle()
  expect(statusTexts().find((s) => s.includes('systemd unit or Docker'))).toBeUndefined()
})

test('the unattributed notice renders in Russian under the ru bundle', async () => {
  await mount(russian)
  await settle()
  const notice = statusTexts().find((s) => s.includes('не имеют определяемого процесса'))
  expect(notice).toContain('1 из 3')
})

// --- Requirement 8: scope toggle -------------------------------------------

test('clicking the already-pressed Listening toggle leaves the scope unchanged and issues no request', async () => {
  await mount()
  await settle()
  const listening = findButton('ports.scope.listening')
  expect(listening.getAttribute('aria-pressed')).toBe('true')
  await click(listening)
  await settle()
  expect(calls).toEqual(['listening'])
  expect(findButton('ports.scope.listening').getAttribute('aria-pressed')).toBe('true')
  expect(findButton('ports.scope.all').getAttribute('aria-pressed')).toBe('false')
  expect(portCells()).toEqual(['22', '53', '8080'])
})

test('in All scope a peer line shows under the local address, and not for listening rows', async () => {
  scopeResponses.all = response({
    scope: 'all',
    ports: [
      known(40000, 55, 'curl', {
        localAddress: '10.0.0.5',
        peerAddress: '93.184.216.34',
        peerPort: 443,
        state: 'ESTABLISHED',
      }),
      known(8080, 1234, 'node'),
    ],
  })
  await mount(english)
  await settle()
  expect(container.textContent).not.toContain('Remote ')

  await click(findButton('All connections'))
  await settle()
  const rows = bodyRows()
  const established = rows.find((r) => r.children[5]?.textContent === 'ESTABLISHED')
  expect(established?.children[1]?.textContent).toBe('10.0.0.5Remote 93.184.216.34:443')
  const listen = rows.find((r) => r.children[5]?.textContent === 'LISTEN')
  expect(listen?.children[1]?.textContent).toBe('127.0.0.1')
})

// --- Requirement 9: truncated and empty ------------------------------------

test('the truncated notice states how many rows are shown out of the backend total', async () => {
  responseData = response({ truncated: true, total: 9000 })
  await mount(english)
  await settle()
  expect(statusTexts()).toContain('Showing the first 3 of 9000 sockets.')
})

test('no truncated notice when truncated is false', async () => {
  await mount(english)
  await settle()
  expect(container.textContent).not.toContain('Showing the first')
})

test('an empty port table shows the empty state and no unattributed/inferred notice', async () => {
  responseData = response({ ports: [] })
  await mount(english)
  await settle()
  expect(container.textContent).toContain('No sockets found.')
  expect(container.querySelector('table')).toBeNull()
  expect(container.textContent).not.toContain('no identifiable process')
  expect(container.textContent).not.toContain('systemd unit or Docker')
  expect(container.textContent).toContain('Showing 0 of 0')
})

test('a 502 with an empty body (what the dev proxy answers when the backend is down) still renders a readable alert', async () => {
  failure = Object.assign(new Error('Request failed with status code 502'), {
    response: { status: 502, data: '' },
  })
  await mount(english)
  await settle()
  expect(alertText()).toBe('Request failed with status code 502')
  expect(findButton('Refresh').disabled).toBe(false)
  expect(findButton('Listening')).toBeDefined()
})
