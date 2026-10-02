// SettingsPage's "Session learning" card: Save sends a PATCH carrying the
// edited `learningSchedule`, and Reset to default sends `null` — the same
// "send exactly this body, then refetch" contract tests/session-
// limit-card.test.tsx covers for its sibling card.
//
// Mounted through the real router/shell at `/settings`, with the two system-
// settings clients replaced through tests/mock-module.ts, the same stateful-
// fake-server idiom tests/session-limit-card.test.tsx uses (a PATCH really
// changes what the next GET answers).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { formatDateTime } from '../src/features/settings/lib/format'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

type Schedule = { enabled: boolean; time: string; timezone: string }

const DEFAULT_SCHEDULE: Schedule = { enabled: false, time: '04:00', timezone: 'UTC' }
let override: Schedule | null = null
let nextRunAt: string | null = null
let patchCalls: Record<string, unknown>[] = []

const current = () =>
  override === null
    ? { value: DEFAULT_SCHEDULE, source: 'default', defaultValue: DEFAULT_SCHEDULE, nextRunAt }
    : { value: override, source: 'override', defaultValue: DEFAULT_SCHEDULE, nextRunAt }

await mockModule('@/shared/api/generated/clients/getApiSystemSettings', () => ({
  getApiSystemSettings: async () => ({
    data: {
      maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
      learningSchedule: current(),
    },
  }),
}))
await mockModule('@/shared/api/generated/clients/patchApiSystemSettings', () => ({
  patchApiSystemSettings: async (opts: { body: { learningSchedule?: Schedule | null } }) => {
    patchCalls.push(opts.body)
    if ('learningSchedule' in opts.body) override = opts.body.learningSchedule ?? null
    return {
      data: {
        maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
        learningSchedule: current(),
      },
    }
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  // The status bar's version button and the "what's new" screen
  // (app/root-layout.tsx's Shell) query this on every mount — seeded for the
  // same reason as every other query here, not because this file has
  // anything of its own to say about that screen.
  client.setQueryData(
    [{ url: '/api/whats-new' }],
    { installedVersion: null, installedAt: null, pending: false },
  )
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

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  override = null
  nextRunAt = null
  patchCalls = []
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  toast.close()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const card = (): HTMLElement => {
  const title = [...container.querySelectorAll('[data-slot="card-title"]')].find(
    (el) => text(el) === 'Session learning',
  )
  const found = title?.closest('[data-slot="card"]') as HTMLElement | null | undefined
  if (!found) throw new Error('no "Session learning" card on the page')
  return found
}
const button = (label: string): HTMLButtonElement => {
  const found = [...card().querySelectorAll('button')].find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button in the card`)
  return found as HTMLButtonElement
}
const switchControl = (): HTMLElement => {
  const label = [...card().querySelectorAll('label')].find((el) => text(el) === 'Run automatically')
  const id = label?.getAttribute('for')
  const el = id ? card().querySelector(`#${id}`) : null
  if (!el) throw new Error('no "Run automatically" switch')
  return el as HTMLElement
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))

test('Save sends a PATCH carrying the edited learningSchedule', async () => {
  await mount()
  await click(switchControl())
  await click(button('Save'))

  expect(patchCalls).toHaveLength(1)
  expect(patchCalls[0]).toEqual({ learningSchedule: { enabled: true, time: '04:00', timezone: 'UTC' } })
  expect(toastTitles()).toContain('Saved')
  expect(problems).toEqual([])
})

test('Reset to default sends { learningSchedule: null }', async () => {
  override = { enabled: true, time: '06:30', timezone: 'Europe/Moscow' }
  await mount()
  expect(text(card())).toContain('Overriding')

  await click(button('Reset to default'))
  expect(patchCalls).toEqual([{ learningSchedule: null }])
  expect(toastTitles()).toContain('Reset to the default')
  expect(problems).toEqual([])
})

test('a default schedule shows "Scheduled runs are off" and disables Reset', async () => {
  await mount()
  expect(text(card())).toContain('Scheduled runs are off')
  expect(button('Reset to default').disabled).toBe(true)
})

// The next-run line once rendered `Date#toLocaleString()` directly — no
// shared formatting, no "your local time" label, unlike every other date
// this app shows (see src/features/library/lib/format.ts's own comment on
// the identical bug the Library panel already had). It now goes through the
// same formatter the rest of the app uses and carries the same label.
test('the next run is shown with the shared date formatter and "your local time"', async () => {
  override = { enabled: true, time: '06:30', timezone: 'Europe/Moscow' }
  nextRunAt = '2026-10-02T10:00:00.000Z'
  await mount()

  const expected = `Next run: ${formatDateTime(nextRunAt)} (your local time).`
  expect(text(card())).toContain(expected)
  // Never the raw, unlabelled `Date#toLocaleString()` output this replaced.
  expect(text(card())).not.toContain(new Date(nextRunAt).toLocaleString())
})

// UTC is the schedule's own default (DEFAULT_SCHEDULE above) — the Select
// pins it first and labels it bare "UTC" rather than "UTC (UTC+0)" (see
// src/features/settings/lib/timezones.ts's own comment on why that
// parenthetical would just repeat the zone's name back at the reader), and
// the schedule line below reads "Daily at 04:00 (UTC)." for the same reason.
test('UTC is offered in the timezone Select, labelled bare, and the schedule line reads cleanly', async () => {
  override = { enabled: true, time: '04:00', timezone: 'UTC' }
  await mount()
  expect(text(card())).toContain('Daily at 04:00 (UTC).')
  expect(text(card())).not.toContain('UTC+0')

  const trigger = card().querySelector('#settings-learning-timezone') as HTMLElement
  // Base UI renders the trigger's chevron as part of the same text node set
  // in jsdom, so this checks containment rather than exact equality.
  expect(text(trigger)).toContain('UTC')
  expect(text(trigger)).not.toContain('(UTC+0)')

  await click(trigger)
  const options = [...document.body.querySelectorAll('[role="option"]')]
  const utc = options.find((el) => text(el) === 'UTC')
  if (!utc) throw new Error('no "UTC" option in the timezone Select')
  // Not a second, "UTC (UTC+0)"-style row alongside the bare one.
  expect(options.some((el) => text(el).startsWith('UTC ('))).toBe(false)
})
