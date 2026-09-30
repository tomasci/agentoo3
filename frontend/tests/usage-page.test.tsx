// The Usage page (`UsagePage`, route `/usage`): the Claude subscription's
// plan-limit meters (with 'observed' vs 'live' vs 'none' made legible, and a
// stale reading called out rather than shown as current), the account
// Claude Code is authenticated as, and the local-transcript breakdown of
// what has been consuming that usage, with its 24h/7d toggle.
//
// The same isolation as tests/ports-page.test.tsx: the generated client is
// replaced through tests/mock-module.ts, and every render goes through its
// own private I18nextProvider (loaded with the real `en` bundle, so
// assertions read the actual wording) rather than the app's global i18next
// singleton.
//
// Every timestamp fixture is built as an offset from `Date.now()` captured
// once per test, not a hardcoded date — `formatDurationShort` and
// `formatRelativeTime` are re-derived from that same captured instant for
// the expected string, so this file never depends on which day it actually
// runs (see those two helpers' own tests in usage-format.test.ts for the
// exhaustive boundary cases; this file only checks that the page wires them
// up correctly).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { formatDurationShort, formatRelativeTime } from '../src/features/system/lib/usage'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const USAGE_CLIENT = '@/shared/api/generated/clients/getApiSystemUsage'

const HOUR = 3_600_000
const MINUTE = 60_000

function period(overrides: Record<string, unknown> = {}) {
  return {
    requestCount: 0,
    sessionCount: 0,
    behaviors: [],
    agents: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    ...overrides,
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    fetchedAt: new Date().toISOString(),
    account: {
      subscriptionType: null,
      email: null,
      organization: null,
      tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
      apiKeySource: null,
      apiProvider: 'firstParty',
    },
    limits: {
      source: 'observed',
      asOf: new Date().toISOString(),
      status: 'allowed',
      windows: [],
      overage: null,
      extraUsage: null,
    },
    breakdown: { day: period(), week: period() },
    probeError: null,
    ...overrides,
  }
}

let responseData: ReturnType<typeof response> = response()
let failure: unknown = null
let calls = 0
/** When set, the mocked client awaits this before answering — a real, held
 *  Promise is what actually exercises "still loading" rather than a timing
 *  guess (see ports-page-verify.test.tsx's identical `gate` for the same
 *  reasoning). */
let gate: Promise<void> | null = null

await mockModule(USAGE_CLIENT, () => ({
  getApiSystemUsage: async () => {
    calls += 1
    if (gate) await gate
    if (failure) throw failure
    return { data: responseData }
  },
}))

const { UsagePage } = await import('../src/features/system/components/usage-page')

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

let client: QueryClient
let container: HTMLDivElement
let root: Root | null = null

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={english}>
        <QueryClientProvider client={client}>
          <UsagePage />
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
  failure = null
  calls = 0
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
})

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (label: string) => {
  const b = buttons().find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button labelled "${label}"`)
  return b
}
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null
const statusTexts = () =>
  [...container.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? '')

// --- Loading and error -------------------------------------------------------

test('shows a loading state before the first response resolves', async () => {
  gate = new Promise<void>(() => {})
  await mount()
  await settle()
  expect(container.textContent).toContain('Loading')
  expect(container.querySelector('[data-slot="card"]')).toBeNull()
})

test('a network failure renders a readable alert, not a blank page', async () => {
  failure = new Error('Network Error')
  await mount()
  await settle()
  expect(alertText()).toContain('Network Error')
  expect(findButton('Refresh')).toBeDefined()
})

// --- Plan limits: 'observed' source, both meters, reset countdown ----------

test('observed data renders both meters with their own percent, a reset countdown, and the observed source line', async () => {
  const now = Date.now()
  const fiveHourResets = new Date(now + 3 * HOUR + 16 * MINUTE + 30_000).toISOString()
  // 4m15s rather than a boundary-adjacent offset: the component captures
  // its own, slightly later `now` at render time, and a value right at a
  // rounding edge (e.g. 4m30s) can tip into the next minute's bucket by the
  // time it actually renders.
  const asOf = new Date(now - 4 * MINUTE - 15_000).toISOString()
  responseData = response({
    limits: {
      source: 'observed',
      asOf,
      status: 'allowed',
      windows: [
        { key: 'five_hour', label: null, utilization: 8, resetsAt: fiveHourResets },
        {
          key: 'seven_day',
          label: null,
          utilization: 23,
          resetsAt: new Date(now + 5 * 86_400_000).toISOString(),
        },
      ],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('5-hour session')
  expect(container.textContent).toContain('8%')
  expect(container.textContent).toContain('Weekly · all models')
  expect(container.textContent).toContain('23%')
  expect(container.textContent).toContain(
    `Resets in ${formatDurationShort(new Date(fiveHourResets).getTime() - now, english.t)}`,
  )
  expect(container.textContent).toContain(
    `From the last rate-limit report, ${formatRelativeTime(asOf, now, 'en')}`,
  )
  // The setup-token limitation note is there, short of quoting its exact
  // wording (that belongs to the i18n parity test).
  expect(container.textContent).toContain('setup-token')
})

test('a resetsAt already in the past shows the stale reset wording, not a live countdown', async () => {
  const now = Date.now()
  responseData = response({
    limits: {
      source: 'observed',
      asOf: new Date(now - 10 * MINUTE).toISOString(),
      status: 'allowed',
      windows: [
        {
          key: 'five_hour',
          label: null,
          utilization: 40,
          resetsAt: new Date(now - 5 * MINUTE).toISOString(),
        },
      ],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('Reset since this report')
  expect(container.textContent).not.toMatch(/Resets in/)
})

test('a utilization at or above 90% renders the meter at its critical level', async () => {
  responseData = response({
    limits: {
      source: 'live',
      asOf: new Date().toISOString(),
      status: null,
      windows: [{ key: 'five_hour', label: null, utilization: 95, resetsAt: null }],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()

  const bar = container.querySelector('[data-slot="progress"]')
  expect(bar?.className ?? '').toContain('bg-destructive')
})

test('status "rejected" shows the "Limit reached" badge', async () => {
  responseData = response({
    limits: {
      source: 'observed',
      asOf: new Date().toISOString(),
      status: 'rejected',
      windows: [{ key: 'five_hour', label: null, utilization: 100, resetsAt: null }],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Limit reached')
})

test('status "allowed_warning" shows the "Approaching limit" badge', async () => {
  responseData = response({
    limits: {
      source: 'observed',
      asOf: new Date().toISOString(),
      status: 'allowed_warning',
      windows: [{ key: 'five_hour', label: null, utilization: 80, resetsAt: null }],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Approaching limit')
})

test('source "none" renders the empty state instead of any meter', async () => {
  responseData = response({
    limits: {
      source: 'none',
      asOf: null,
      status: null,
      windows: [],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain(
    'No limit data yet — it appears after a session runs its first turn on this box.',
  )
})

// --- Live data: a per-model window and extraUsage ---------------------------

test('live data with a model row and extraUsage renders both', async () => {
  responseData = response({
    limits: {
      source: 'live',
      asOf: new Date().toISOString(),
      status: null,
      windows: [{ key: 'model', label: 'Fable', utilization: 12, resetsAt: null }],
      overage: null,
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 5000,
        usedCredits: 1234,
        utilization: 24.68,
        currency: 'USD',
      },
    },
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('Weekly · Fable')
  expect(container.textContent).toContain('Live from claude.ai')
  expect(container.textContent).toContain('$12.34 of $50.00 used')
})

// --- Long labels truncate rather than push the percent off-screen ----------

test('a window label truncates instead of pushing its percent out of view, with the full text in a title', async () => {
  const long = `claude-${'x'.repeat(240)}-experimental`
  responseData = response({
    limits: {
      source: 'live',
      asOf: new Date().toISOString(),
      status: null,
      windows: [{ key: 'model', label: long, utilization: 12, resetsAt: null }],
      overage: null,
      extraUsage: null,
    },
  })
  await mount()
  await settle()

  const labelText = `Weekly · ${long}`
  const label = [...container.querySelectorAll('span')].find(
    (el) => el.textContent === labelText,
  )
  expect(label).toBeDefined()
  expect(label?.className).toContain('min-w-0')
  expect(label?.className).toContain('truncate')
  expect(label?.getAttribute('title')).toBe(labelText)
  // The percent alongside it never shrinks away, whatever the label's length.
  expect(container.textContent).toContain('12%')
})

// --- Overage --------------------------------------------------------------

test('overage renders the humanised reason and "not available" for a rejected status', async () => {
  responseData = response({
    limits: {
      source: 'observed',
      asOf: new Date().toISOString(),
      status: 'allowed',
      windows: [],
      overage: { status: 'rejected', disabledReason: 'org_level_disabled_until', inUse: false },
      extraUsage: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Extra usage: not available')
  expect(container.textContent).toContain('Disabled for your organization until further notice')
  expect(container.textContent).not.toContain('in use')
})

test('an unrecognised overage reason code is shown raw, not dropped', async () => {
  responseData = response({
    limits: {
      source: 'observed',
      asOf: new Date().toISOString(),
      status: 'allowed',
      windows: [],
      overage: { status: 'allowed', disabledReason: 'some_new_reason_code', inUse: true },
      extraUsage: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Extra usage: allowed')
  expect(container.textContent).toContain('some_new_reason_code')
  expect(container.textContent).toContain('in use')
})

// --- Account ---------------------------------------------------------------

test('account null renders the unavailable fallback without breaking the rest of the page', async () => {
  responseData = response({ account: null })
  await mount()
  await settle()
  expect(container.textContent).toContain('Account details unavailable')
  expect(container.textContent).toContain('Plan limits')
})

test('a full account renders plan, authentication, provider, email and organization', async () => {
  responseData = response({
    account: {
      subscriptionType: 'max',
      email: 'operator@example.com',
      organization: 'Acme',
      tokenSource: null,
      apiKeySource: 'ANTHROPIC_API_KEY',
      apiProvider: 'firstParty',
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Max')
  expect(container.textContent).toContain('API key')
  expect(container.textContent).toContain('Anthropic')
  expect(container.textContent).toContain('operator@example.com')
  expect(container.textContent).toContain('Acme')
})

test('a null subscriptionType reads as Unknown, and an absent provider omits its row entirely', async () => {
  responseData = response({
    account: {
      subscriptionType: null,
      email: null,
      organization: null,
      tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
      apiKeySource: null,
      apiProvider: null,
    },
  })
  await mount()
  await settle()
  expect(container.textContent).toContain('Unknown')
  expect(container.textContent).not.toContain('Provider')
})

// --- Breakdown ---------------------------------------------------------

test('breakdown null renders the unavailable fallback without breaking the rest of the page', async () => {
  responseData = response({ breakdown: null })
  await mount()
  await settle()
  expect(container.textContent).toContain('Breakdown unavailable')
  expect(container.textContent).toContain('Account')
})

test('the 24h/7d toggle switches the breakdown numbers shown', async () => {
  responseData = response({
    breakdown: {
      day: period({ requestCount: 2695, sessionCount: 6 }),
      week: period({ requestCount: 9000, sessionCount: 40 }),
    },
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('2695 requests across 6 sessions')
  expect(container.textContent).not.toContain('9000 requests across 40 sessions')

  await click(findButton('7 days'))
  await settle()

  expect(container.textContent).toContain('9000 requests across 40 sessions')
  expect(container.textContent).not.toContain('2695 requests across 6 sessions')
})

test('behaviors, agents and plugins each render when present, and an empty list hides its own heading', async () => {
  responseData = response({
    breakdown: {
      day: period({
        requestCount: 10,
        sessionCount: 2,
        behaviors: [{ key: 'subagent_heavy', pct: 100, count: 6 }],
        agents: [{ name: 'agentoo:docker', pct: 39 }],
        skills: [],
        plugins: [{ name: 'agentoo', pct: 93 }],
        mcpServers: [],
      }),
      week: period(),
    },
  })
  await mount()
  await settle()

  expect(container.textContent).toContain('Subagent-heavy')
  expect(container.textContent).toContain('agentoo:docker')
  expect(container.textContent).toContain('agentoo')
  expect(container.textContent).not.toContain('Skills')
  expect(container.textContent).not.toContain('MCP servers')
  expect(container.textContent).toContain("don't add up to 100%")
})

// --- probeError --------------------------------------------------------

test('a non-null probeError shows a non-blocking warning, and the rest of the page still renders', async () => {
  responseData = response({ probeError: 'The rate-limit probe timed out after 5s.' })
  await mount()
  await settle()
  expect(
    statusTexts().some((s) => s.includes('The rate-limit probe timed out after 5s.')),
  ).toBe(true)
  expect(container.textContent).toContain('Plan limits')
  expect(container.textContent).toContain('Account')
})

// --- Refresh -------------------------------------------------------------

test('Refresh issues a second request', async () => {
  await mount()
  await settle()
  expect(calls).toBe(1)
  await click(findButton('Refresh'))
  await settle()
  expect(calls).toBe(2)
})

// --- Updated time --------------------------------------------------------

test('shows the "Updated" line from fetchedAt', async () => {
  responseData = response({ fetchedAt: new Date().toISOString() })
  await mount()
  await settle()
  expect(container.textContent).toMatch(/Updated \d{1,2}:\d{2}:\d{2}/)
})
