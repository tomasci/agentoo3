// Adversarial checks on the Usage page (`UsagePage`, route `/usage`) — the
// inputs and timings tests/usage-page.test.tsx does not reach: out-of-range
// utilization, reset instants at and around `now`, the 30s relative-time
// tick and the 60s poll under fake timers, window focus, keys the page has
// no label for, extraUsage currency/disabled variants, the Russian bundle's
// plurals and durations, and HTTP errors on first load and on a later poll.
//
// Same isolation as tests/usage-page.test.tsx: the generated client is
// replaced through tests/mock-module.ts, and each render gets its own
// I18nextProvider (the real en / ru bundles) rather than the app singleton.
// Time-sensitive cases pin the clock with bun's fake timers (which advance
// `Date.now()` too), so nothing here depends on when it runs.

import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { focusManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import i18next, { type i18n as I18n } from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { mockModule } from './mock-module'

const USAGE_CLIENT = '@/shared/api/generated/clients/getApiSystemUsage'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const T0 = new Date('2026-09-30T06:00:00.000Z').getTime()
const iso = (ms: number) => new Date(ms).toISOString()

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

function limits(overrides: Record<string, unknown> = {}) {
  return {
    source: 'observed',
    asOf: iso(Date.now()),
    status: 'allowed',
    windows: [],
    overage: null,
    extraUsage: null,
    ...overrides,
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    fetchedAt: iso(Date.now()),
    account: {
      subscriptionType: 'max',
      email: null,
      organization: null,
      tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
      apiKeySource: null,
      apiProvider: 'firstParty',
    },
    limits: limits(),
    breakdown: { day: period(), week: period() },
    probeError: null,
    ...overrides,
  }
}

let responseData: Record<string, unknown> = response()
let failure: unknown = null
let calls = 0
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

async function makeI18n(lng: 'en' | 'ru') {
  const instance = i18next.createInstance()
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  return instance
}
const english = await makeI18n('en')
const russian = await makeI18n('ru')

let client: QueryClient
let container: HTMLDivElement
let root: Root | null = null
let fake = false

/** Flush promise continuations plus zero-delay timers (react-query's
 *  notifyManager batches through setTimeout(0)) without ever firing the 30s
 *  tick or the 60s poll by accident: under fake timers only 0ms is advanced. */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      if (fake) jest.advanceTimersByTime(0)
      else await new Promise((r) => setTimeout(r, 0))
      await Promise.resolve()
    })
  }
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
  })
  await settle()
}

function useFakeClock(at = T0) {
  jest.useFakeTimers({ now: at })
  fake = true
}

async function mount(i18n: I18n = english, extra?: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <UsagePage />
          {extra}
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

const consoleErrors: string[] = []
const realConsoleError = console.error

beforeEach(() => {
  responseData = response()
  failure = null
  calls = 0
  gate = null
  consoleErrors.length = 0
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' ').slice(0, 300))
  }
})

afterEach(async () => {
  console.error = realConsoleError
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
    container.remove()
    client.clear()
  }
  focusManager.setFocused(undefined)
  if (fake) {
    jest.useRealTimers()
    fake = false
  }
})

const text = () => container.textContent ?? ''
const meters = () => [...container.querySelectorAll('[data-slot="progress"]')] as HTMLElement[]
const indicatorWidth = (bar: Element) =>
  (bar.querySelector('[data-slot="progress-indicator"]') as HTMLElement | null)?.style.width ?? ''
const findButton = (label: string) => {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button labelled "${label}"`)
  return b as HTMLButtonElement
}
const window1 = (w: Record<string, unknown>) =>
  response({ limits: limits({ windows: [{ key: 'five_hour', label: null, resetsAt: null, ...w }] }) })

// --- Out-of-range utilization ------------------------------------------------

test('utilization 130 keeps the bar at <= 100% width and reads as critical', async () => {
  responseData = window1({ utilization: 130 })
  await mount()
  const bar = meters()[0]
  expect(bar).toBeDefined()
  const width = Number.parseFloat(indicatorWidth(bar))
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThanOrEqual(100)
  expect(bar.className).toContain('bg-destructive')
  expect(text()).toContain('130%')
})

test('a negative utilization never renders a negative bar width or a "-N%" label', async () => {
  responseData = window1({ utilization: -5 })
  await mount()
  const width = Number.parseFloat(indicatorWidth(meters()[0]))
  expect(width).toBeGreaterThanOrEqual(0)
  expect(text()).not.toMatch(/-\d+%/)
})

test('utilization null shows "—" and an empty (not indeterminate, full-width) bar', async () => {
  responseData = window1({ utilization: null })
  await mount()
  expect(text()).toContain('5-hour session—')
  expect(indicatorWidth(meters()[0])).toBe('0%')
})

test('emphasis follows the rounded figure shown: 74.4 normal, 74.6 warning, 89.5 critical', async () => {
  responseData = response({
    limits: limits({
      windows: [
        { key: 'five_hour', label: null, utilization: 74.4, resetsAt: null },
        { key: 'seven_day', label: null, utilization: 74.6, resetsAt: null },
        { key: 'seven_day_opus', label: null, utilization: 89.5, resetsAt: null },
      ],
    }),
  })
  await mount()
  const [a, b, c] = meters()
  expect(text()).toContain('74%')
  expect(text()).toContain('75%')
  expect(text()).toContain('90%')
  expect(a.className).not.toMatch(/amber|destructive/)
  expect(b.className).toContain('bg-amber-500')
  expect(c.className).toContain('bg-destructive')
})

// --- Reset instants ------------------------------------------------------------

test('resetsAt null shows the percent but neither a countdown nor the stale wording', async () => {
  responseData = window1({ utilization: 40, resetsAt: null })
  await mount()
  expect(text()).toContain('40%')
  expect(text()).not.toContain('Resets in')
  expect(text()).not.toContain('Reset since this report')
})

test('resetsAt exactly now reads as reset, not "Resets in <1m"', async () => {
  useFakeClock()
  responseData = window1({ utilization: 50, resetsAt: iso(T0) })
  await mount()
  expect(text()).toContain('Reset since this report')
  expect(text()).not.toContain('Resets in')
})

test('a stale 95% window drops its critical emphasis and mutes the bar', async () => {
  useFakeClock()
  responseData = window1({ utilization: 95, resetsAt: iso(T0 - MINUTE) })
  await mount()
  const bar = meters()[0]
  expect(bar.className).not.toContain('bg-destructive')
  expect(bar.className).toContain('bg-muted-foreground')
  expect(text()).toContain('Reset since this report')
})

test('a countdown that runs out while the page is open flips to the stale wording on the next tick, with no refetch', async () => {
  useFakeClock()
  responseData = window1({ utilization: 60, resetsAt: iso(T0 + 20_000) })
  await mount()
  expect(text()).toContain('Resets in <1m')
  await advance(30_000)
  expect(text()).toContain('Reset since this report')
  expect(calls).toBe(1)
})

// --- The 30s tick and the 60s poll ------------------------------------------

test('the 30s tick moves "Resets in 1h 0m" to "59m" across the hour boundary without refetching', async () => {
  useFakeClock()
  responseData = window1({ utilization: 10, resetsAt: iso(T0 + HOUR + 20_000) })
  await mount()
  expect(text()).toContain('Resets in 1h 0m')
  await advance(29_000)
  expect(text()).toContain('Resets in 1h 0m')
  await advance(1_000)
  expect(text()).toContain('Resets in 59m')
  expect(calls).toBe(1)
})

test('the 30s tick advances the observed source line ("45" -> "46 minutes ago") between polls', async () => {
  useFakeClock()
  // 44m40s old reads "45 minutes ago" (rounded); two ticks later it is
  // 45m40s old and must read "46 minutes ago".
  responseData = response({ limits: limits({ asOf: iso(T0 - 44 * MINUTE - 40_000) }) })
  await mount()
  expect(text()).toContain('From the last rate-limit report, 45 minutes ago')
  await advance(30_000)
  expect(text()).toContain('From the last rate-limit report, 45 minutes ago')
  await advance(30_000)
  expect(text()).toContain('From the last rate-limit report, 46 minutes ago')
  expect(calls).toBe(2) // the 60s poll has fired exactly once by now
})

test('a report just under an hour old never reads "60 minutes ago"', async () => {
  useFakeClock()
  responseData = response({ limits: limits({ asOf: iso(T0 - 59 * MINUTE - 40_000) }) })
  await mount()
  expect(text()).not.toContain('60 minutes ago')
})

test('polls every 60s: no second request at 59s, one at 60s, a third at 120s', async () => {
  useFakeClock()
  await mount()
  expect(calls).toBe(1)
  await advance(59_000)
  expect(calls).toBe(1)
  await advance(1_500)
  expect(calls).toBe(2)
  await advance(60_000)
  expect(calls).toBe(3)
})

test('the tick timer is cleared on unmount (no state update after unmount)', async () => {
  useFakeClock()
  await mount()
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  await act(async () => {
    jest.advanceTimersByTime(120_000)
  })
  expect(calls).toBe(1)
  expect(consoleErrors).toEqual([])
})

// --- Window focus ------------------------------------------------------------

/** A sibling query with react-query's default refetchOnWindowFocus — the
 *  control that proves the focus event below really does trigger refetches,
 *  so the usage query staying at one call is the page's own setting at work. */
let controlCalls = 0
function FocusControl() {
  useQuery({
    queryKey: ['focus-control'],
    queryFn: async () => {
      controlCalls += 1
      return controlCalls
    },
  })
  return null
}

test('regaining window focus refetches a default query but not the usage query', async () => {
  controlCalls = 0
  await mount(english, <FocusControl />)
  expect(calls).toBe(1)
  expect(controlCalls).toBe(1)
  await act(async () => {
    focusManager.setFocused(false)
  })
  await act(async () => {
    focusManager.setFocused(true)
  })
  await settle()
  expect(controlCalls).toBe(2)
  expect(calls).toBe(1)
})

// --- Refresh while fetching ------------------------------------------------

test('Refresh is disabled while a request is in flight, so a double click sends one request', async () => {
  await mount()
  expect(calls).toBe(1)
  let release: () => void = () => {}
  gate = new Promise<void>((r) => {
    release = r
  })
  const button = findButton('Refresh')
  await act(async () => {
    button.click()
  })
  await settle(2)
  expect(findButton('Refresh').disabled).toBe(true)
  await act(async () => {
    findButton('Refresh').click()
  })
  await settle(2)
  expect(calls).toBe(2)
  release()
  gate = null
  await settle()
  expect(findButton('Refresh').disabled).toBe(false)
})

// --- Keys the page has no label for ---------------------------------------

test('a very long model label renders in full inside "Weekly · …" without crashing', async () => {
  const long = `claude-${'x'.repeat(240)}-experimental`
  responseData = response({
    limits: limits({ windows: [{ key: 'model', label: long, utilization: 5, resetsAt: null }] }),
  })
  await mount()
  expect(text()).toContain(`Weekly · ${long}`)
})

test('a model row with a null label does not render a dangling "Weekly · "', async () => {
  responseData = response({
    limits: limits({ windows: [{ key: 'model', label: null, utilization: 5, resetsAt: null }] }),
  })
  await mount()
  expect(text()).not.toMatch(/Weekly · (5%|$)/)
})

test('an unknown window key is shown by its raw key, not blank, and the page still renders', async () => {
  responseData = response({
    limits: limits({
      windows: [{ key: 'seven_day_haiku', label: null, utilization: 12, resetsAt: null }],
    }),
  })
  await mount()
  expect(text()).toContain('seven_day_haiku')
  expect(text()).toContain('12%')
  expect(text()).toContain('Account')
})

test('an unknown behavior key is shown raw with its pct and count', async () => {
  responseData = response({
    breakdown: {
      day: period({
        requestCount: 5,
        sessionCount: 1,
        behaviors: [{ key: 'tool_storm', pct: 33.6, count: 2 }],
      }),
      week: period(),
    },
  })
  await mount()
  expect(text()).toContain('tool_storm')
  expect(text()).toContain('34% · 2')
})

test('an overage row with only a reason still says it is about extra usage', async () => {
  responseData = response({
    limits: limits({
      overage: { status: null, disabledReason: 'out_of_credits', inUse: null },
    }),
  })
  await mount()
  expect(text()).toContain('Out of credits')
  const row = [...container.querySelectorAll('p')].find((p) =>
    p.textContent?.includes('Out of credits'),
  )
  expect(row?.textContent ?? '').toContain('Extra usage')
})

test('an unknown overage reason with a null status is shown raw, not dropped', async () => {
  responseData = response({
    limits: limits({ overage: { status: null, disabledReason: 'weird_code', inUse: null } }),
  })
  await mount()
  expect(text()).toContain('weird_code')
})

// --- extraUsage variants ------------------------------------------------------

function liveWithExtra(extra: Record<string, unknown>) {
  return response({
    limits: limits({
      source: 'live',
      status: null,
      windows: [{ key: 'five_hour', label: null, utilization: 3, resetsAt: null }],
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 5000,
        usedCredits: 1234,
        utilization: 24.68,
        currency: 'USD',
        ...extra,
      },
    }),
  })
}

test('extraUsage with a null currency falls back to USD', async () => {
  responseData = liveWithExtra({ currency: null })
  await mount()
  expect(text()).toContain('$12.34 of $50.00 used')
})

test("extraUsage in 'EUR' renders euro amounts", async () => {
  responseData = liveWithExtra({ currency: 'EUR' })
  await mount()
  expect(text()).toContain('€12.34 of €50.00 used')
})

test('extraUsage in the ru locale formats money the Russian way', async () => {
  responseData = liveWithExtra({ currency: 'EUR' })
  await mount(russian)
  const expected = (n: number) =>
    new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' }).format(n)
  expect(text()).toContain(`Использовано ${expected(12.34)} из ${expected(50)}`)
})

test('extraUsage.isEnabled false reads "Disabled" with no meter and no amounts', async () => {
  responseData = liveWithExtra({ isEnabled: false })
  await mount()
  expect(text()).toContain('Extra usage spendDisabled')
  // Only the one plan-limit window's meter; none for the disabled extra usage.
  expect(meters().length).toBe(1)
  expect(text()).not.toContain('used')
})

test('extraUsage utilization over 100 still keeps its bar in bounds and critical', async () => {
  responseData = liveWithExtra({ utilization: 140, usedCredits: 7000 })
  await mount()
  const bar = meters()[1]
  expect(Number.parseFloat(indicatorWidth(bar))).toBeLessThanOrEqual(100)
  expect(bar.className).toContain('bg-destructive')
})

// --- Degenerate limit shapes ------------------------------------------------

test("source 'live' with zero windows renders the live line and nothing broken", async () => {
  responseData = response({ limits: limits({ source: 'live', status: null, windows: [] }) })
  await mount()
  expect(text()).toContain('Live from claude.ai')
  expect(text()).not.toContain('setup-token')
  expect(meters().length).toBe(0)
})

test('everything degraded at once: probeError, no limits, no account, no breakdown', async () => {
  responseData = response({
    probeError: 'accountInfo() timed out; the behaviors scan failed',
    account: null,
    breakdown: null,
    limits: limits({ source: 'none', asOf: null, status: null }),
  })
  await mount()
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'accountInfo() timed out',
  )
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(text()).toContain('No limit data yet')
  expect(text()).toContain('Account details unavailable')
  expect(text()).toContain('Breakdown unavailable')
  // No 24h/7d toggle over a breakdown that is not there.
  expect(text()).not.toContain('7 days')
})

// --- Plurals and durations: en and ru ----------------------------------------

function withCounts(requestCount: number, sessionCount: number) {
  return response({
    breakdown: { day: period({ requestCount, sessionCount }), week: period() },
  })
}

test('en: a single request in a single session is singular', async () => {
  responseData = withCounts(1, 1)
  await mount()
  expect(text()).toContain('1 request across 1 session')
  expect(text()).not.toContain('1 requests')
})

test('ru: request/session counts take the right Russian plural forms', async () => {
  const cases: [number, number, string][] = [
    [1, 1, '1 запрос в 1 сессии'],
    [3, 2, '3 запроса в 2 сессиях'],
    [12541, 23, '12541 запрос в 23 сессиях'],
    [2875, 6, '2875 запросов в 6 сессиях'],
  ]
  const seen: string[] = []
  for (const [r, s] of cases) {
    responseData = withCounts(r, s)
    await mount(russian)
    seen.push(text().match(/\d+ запрос(?:а|ов)? в \d+ сесси(?:ях|ий|и|я)/)?.[0] ?? '(missing)')
    await act(async () => {
      root?.unmount()
    })
    root = null
    container.remove()
    client.clear()
  }
  expect(seen).toEqual(cases.map((c) => c[2]))
})

test('ru: the reset countdown uses Russian units, not "h"/"m"/"d"', async () => {
  useFakeClock()
  responseData = response({
    limits: limits({
      windows: [
        { key: 'five_hour', label: null, utilization: 8, resetsAt: iso(T0 + 3 * HOUR + 16 * MINUTE) },
        { key: 'seven_day', label: null, utilization: 20, resetsAt: iso(T0 + 5 * DAY + 17 * HOUR) },
      ],
    }),
  })
  await mount(russian)
  const lines = text().match(/Сброс через [^%]*?(?=Неделя|По последнему|$)/g) ?? []
  expect(lines.length).toBe(2)
  for (const line of lines) expect(line).not.toMatch(/\d+[hmd]\b/)
})

test('ru: relative "reported" time and Updated line are Russian, and no raw usage.* key leaks', async () => {
  useFakeClock()
  responseData = response({
    limits: limits({
      asOf: iso(T0 - 4 * MINUTE),
      status: 'allowed_warning',
      windows: [{ key: 'five_hour', label: null, utilization: 80, resetsAt: iso(T0 + HOUR) }],
      overage: { status: 'rejected', disabledReason: 'out_of_credits', inUse: true },
    }),
    breakdown: {
      day: period({
        requestCount: 10,
        sessionCount: 2,
        behaviors: [{ key: 'cache_miss', pct: 10, count: 1 }],
        agents: [{ name: 'a', pct: 1 }],
        skills: [{ name: 's', pct: 1 }],
        plugins: [{ name: 'p', pct: 1 }],
        mcpServers: [{ name: 'm', pct: 1 }],
      }),
      week: period(),
    },
  })
  await mount(russian)
  expect(text()).toContain('По последнему отчёту о лимитах, 4 минуты назад')
  expect(text()).toContain('Приближение к лимиту')
  expect(text()).toContain('Дополнительное использование: недоступно — Кредиты исчерпаны (используется)')
  expect(text()).toContain('Обновлено')
  expect(text()).not.toMatch(/usage\.[a-zA-Z_.]+/)
})

// --- HTTP errors --------------------------------------------------------------

test('an HTTP 500 with a JSON error body on first load shows that message in an alert, not a blank page', async () => {
  failure = Object.assign(new Error('Request failed with status code 500'), {
    response: { status: 500, data: { error: 'usage probe exploded' } },
  })
  await mount()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('usage probe exploded')
  expect(text()).not.toContain('Loading')
  expect(findButton('Refresh').disabled).toBe(false)
})

test('an HTTP 502 with a non-JSON body falls back to the error message rather than nothing', async () => {
  failure = Object.assign(new Error('Request failed with status code 502'), {
    response: { status: 502, data: '<html>Bad Gateway</html>' },
  })
  await mount()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('status code 502')
})

test('a failed poll after a good load keeps the last data on screen and adds an alert', async () => {
  useFakeClock()
  responseData = window1({ utilization: 42 })
  await mount()
  expect(text()).toContain('42%')
  failure = Object.assign(new Error('Network Error'), {})
  await advance(60_500)
  expect(calls).toBe(2)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Network Error')
  expect(text()).toContain('42%')
})

test('no retry: a failing first load is requested exactly once', async () => {
  useFakeClock()
  failure = new Error('Network Error')
  await mount()
  await advance(10_000)
  expect(calls).toBe(1)
})
