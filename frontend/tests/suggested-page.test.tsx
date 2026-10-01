// The Suggested view (`/library/suggested`): the learning panel's "Run
// learning now" button POSTs, is disabled while a run is queued/running, and
// surfaces a 409's message as a toast; pending suggestions split into the
// "Changes to existing agents & skills" (modify) and "New agents & skills"
// (create) lists rather than one mixed one.
//
// Mounted through the real router/shell at `/library/suggested`, the same
// way tests/session-limit-card.test.tsx mounts `/settings` — generated
// clients replaced through tests/mock-module.ts, a private English
// `I18nextProvider`, `<Toaster />` alongside the router the way the app's
// own providers.tsx mounts it.

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

type Suggestion = {
  id: string
  runId: string | null
  kind: 'agent' | 'skill'
  action: 'create' | 'modify'
  name: string
  title: string
  rationale: string
  status: 'pending' | 'applied' | 'rejected'
  createdAt: string
  decidedAt: string | null
  appliedVersion: number | null
  sourceSessions: { id: string; title: string | null; projectId: string; projectName: string }[]
  targetExists: boolean
  stale: boolean
}

const suggestion = (overrides: Partial<Suggestion>): Suggestion => ({
  id: 's1',
  runId: 'r1',
  kind: 'agent',
  action: 'modify',
  name: 'reviewer',
  title: 'Tighten the review checklist',
  rationale: 'Recent sessions show the reviewer missing null checks.',
  status: 'pending',
  createdAt: '2026-09-20T04:00:00.000Z',
  decidedAt: null,
  appliedVersion: null,
  sourceSessions: [],
  targetExists: true,
  stale: false,
  ...overrides,
})

type ActiveRun = {
  id: string
  trigger: 'scheduled' | 'manual'
  status: 'queued' | 'running'
  windowStart: string
  windowEnd: string
  sessionsAnalyzed: number
  suggestionsCreated: number
  duplicatesSkipped: number
  costUsd: number
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

let suggestions: Suggestion[] = []
let activeRun: ActiveRun | null = null
let runNowCalls = 0
/** When set, the POST rejects with it instead of starting a run. */
let runNowFailure: unknown = null

const OVERVIEW = () => ({
  schedule: { value: { enabled: true, time: '04:00', timezone: 'Europe/Moscow' }, nextRunAt: null },
  activeRun,
  lastRun: null,
  recentRuns: [],
})

await mockModule('@/shared/api/generated/clients/getApiLibraryLearning', () => ({
  getApiLibraryLearning: async () => ({ data: OVERVIEW() }),
}))
await mockModule('@/shared/api/generated/clients/postApiLibraryLearningRuns', () => ({
  postApiLibraryLearningRuns: async () => {
    runNowCalls++
    if (runNowFailure) throw runNowFailure
    activeRun = {
      id: 'r2',
      trigger: 'manual',
      status: 'queued',
      windowStart: '2026-09-19T04:00:00.000Z',
      windowEnd: '2026-09-20T04:00:00.000Z',
      sessionsAnalyzed: 0,
      suggestionsCreated: 0,
      duplicatesSkipped: 0,
      costUsd: 0,
      error: null,
      createdAt: '2026-09-20T04:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    }
    return { data: activeRun }
  },
}))
await mockModule('@/shared/api/generated/clients/getApiLibrarySuggestions', () => ({
  getApiLibrarySuggestions: async (opts: { query?: { status?: string } }) => {
    const status = opts.query?.status ?? 'pending'
    return { data: suggestions.filter((s) => s.status === status) }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdReject', () => ({
  postApiLibrarySuggestionsIdReject: async () => {
    throw new Error('reject is not expected in suggested-page.test.tsx')
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
    history: createMemoryHistory({ initialEntries: ['/library/suggested'] }),
  })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
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

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  suggestions = []
  activeRun = null
  runNowCalls = 0
  runNowFailure = null
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

const main = () => container.querySelector('main') ?? container
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const headings = () => [...main().querySelectorAll('h2')].map((h) => text(h))
/** The section a heading opens — climbs past `PageHeader`'s own wrapper
 *  (which holds only the heading and its actions, not the content below it)
 *  until an ancestor's text differs from the bare heading, the same idiom
 *  tests/library-prompts-section.test.tsx uses to find a table's section. */
const sectionOf = (title: string): HTMLElement => {
  const h = [...main().querySelectorAll('h2')].find((el) => text(el) === title)
  if (!h) throw new Error(`no h2 "${title}" among ${headings().join(', ')}`)
  let node: HTMLElement | null = h.parentElement
  while (node && text(node) === title) node = node.parentElement
  if (!node) throw new Error(`no section content for "${title}"`)
  return node
}
const button = (label: string): HTMLButtonElement => {
  const found = [...main().querySelectorAll('button')].find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button among ${[...main().querySelectorAll('button')].map(text).join(', ')}`)
  return found as HTMLButtonElement
}
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

test('pending suggestions split into the modify and create lists', async () => {
  suggestions = [
    suggestion({ id: 'm1', action: 'modify', name: 'reviewer', title: 'Tighten the checklist' }),
    suggestion({ id: 'c1', action: 'create', name: 'release-notes', title: 'A release-notes skill', kind: 'skill' }),
  ]
  await mount()

  const modifySection = sectionOf('Changes to existing agents & skills')
  const createSection = sectionOf('New agents & skills')
  expect(text(modifySection)).toContain('reviewer')
  expect(text(modifySection)).toContain('Tighten the checklist')
  expect(text(modifySection)).not.toContain('release-notes')
  expect(text(createSection)).toContain('release-notes')
  expect(text(createSection)).not.toContain('Tighten the checklist')
  expect(problems).toEqual([])
})

test('an empty pending list shows both empty states', async () => {
  await mount()
  expect(text(sectionOf('Changes to existing agents & skills'))).toContain(
    'No suggested changes right now.',
  )
  expect(text(sectionOf('New agents & skills'))).toContain('No suggested additions right now.')
})

test('clicking "Run learning now" POSTs to the learning run endpoint', async () => {
  await mount()
  expect(runNowCalls).toBe(0)
  await click(button('Run learning now'))
  expect(runNowCalls).toBe(1)
})

test('"Run learning now" is disabled while a run is queued or running', async () => {
  activeRun = {
    id: 'r1',
    trigger: 'scheduled',
    status: 'running',
    windowStart: '2026-09-19T04:00:00.000Z',
    windowEnd: '2026-09-20T04:00:00.000Z',
    sessionsAnalyzed: 3,
    suggestionsCreated: 0,
    duplicatesSkipped: 0,
    costUsd: 0.01,
    error: null,
    createdAt: '2026-09-20T04:00:00.000Z',
    startedAt: '2026-09-20T04:00:01.000Z',
    finishedAt: null,
  }
  await mount()
  expect(button('Run learning now').disabled).toBe(true)
  await click(button('Run learning now'))
  expect(runNowCalls).toBe(0)
})

test('a 409 from Run learning now shows the server message as a toast', async () => {
  runNowFailure = httpError(409, { error: 'A learning run is already queued.' })
  await mount()
  await click(button('Run learning now'))
  expect(toastTitles()).toContain('A learning run is already queued.')
  expect(runNowCalls).toBe(1)
  expect(problems).toEqual([])
})
