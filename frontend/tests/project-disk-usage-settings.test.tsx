// The "Size on disk" fact in the Details card of a project's Settings page
// (project-disk-usage-fact.tsx, rendered by project-overview.tsx): where it
// sits in the list, the total and its breakdown, when it was measured, the
// states with no figure yet (measuring, failed, still being set up, failed to
// load), and the Recalculate button — that it POSTs to the refresh endpoint,
// is disabled while a measurement runs or its own request is in flight, and
// says so when the request fails.
//
// Mounted through the real router at `/projects/p1/settings`, with the
// shell's ambient queries seeded the way tests/git-identity-card.test.tsx
// seeds them for this same route, and the fact's own requests answered by the
// fake backend in ./disk-usage-api.ts — the real generated clients, with only
// the transport replaced, so a click is asserted as the request the browser
// would actually send. Wording is checked through private i18next instances
// (English, and Russian for the one test about the locale), because the
// wording is part of the point.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { routeTree } from '../src/app/router'
import { getProjectGitIdentityQueryKey } from '../src/shared/api/generated/hooks/useGetProjectGitIdentity'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { formatDateTime } from '../src/shared/lib/date'
import {
  fake,
  GB,
  installFakeDiskUsageApi,
  LIST_URL,
  MB,
  REFRESH_URL,
  SINGLE_URL,
  usage,
} from './disk-usage-api'

installFakeDiskUsageApi()

const instance = async (lng: 'en' | 'ru') => {
  const i18n = i18next.createInstance()
  await i18n.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  return i18n
}
const english = await instance('en')
const russian = await instance('ru')

const project = (status = 'ready') => ({
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  source: 'clone',
  remoteUrl: 'https://example.com/acme/alpha.git',
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status,
  lastError: null,
  recoveryCommands: null,
  path: '/srv/alpha',
  createdAt: '',
  updatedAt: '',
})

const MEASURED_AT = '2026-09-28T14:32:00.000Z'

let container: HTMLDivElement
let root: Root | null = null
let client: QueryClient

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount(
  status = 'ready',
  i18n: typeof english = english,
) {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/settings'] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project(status)])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/whats-new' }], {
    installedVersion: null,
    installedAt: null,
    pending: false,
  })
  client.setQueryData([{ url: '/api/notifications' }], {
    items: [],
    hasUnread: false,
    truncated: false,
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/sessions/overview' }, { window: '1d' }], {
    running: [],
    unchecked: [],
    recent: [],
    window: '1d',
  })
  client.setQueryData(getProjectGitIdentityQueryKey({ path: { id: 'p1' } }), {
    available: false,
    configPath: null,
    local: { name: null, email: null },
    effective: { name: null, email: null },
  })
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
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
  fake.reset()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** The description (`dd`) of the Details fact whose term (`dt`) is `term`. */
const fact = (term = 'Size on disk'): HTMLElement => {
  const dt = [...container.querySelectorAll('dt')].find((el) => text(el) === term)
  const dd = dt?.nextElementSibling as HTMLElement | null | undefined
  if (!dd) throw new Error(`no "${term}" fact on the page`)
  return dd
}
const recalculate = (label = 'Recalculate'): HTMLButtonElement => {
  const found = [...fact(label === 'Recalculate' ? 'Size on disk' : 'Размер на диске').querySelectorAll('button')].find(
    (b) => text(b).includes(label),
  )
  if (!found) throw new Error(`no "${label}" button in the fact`)
  return found as HTMLButtonElement
}
const measuringSpinners = (scope: Element, label = 'Measuring…') =>
  [...scope.querySelectorAll('[role="status"]')].filter(
    (el) => el.getAttribute('aria-label') === label,
  )
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

const MEASURED = usage('p1', {
  totalBytes: 2.1 * GB,
  repoBytes: 1.5 * GB,
  worktreesBytes: 600 * MB,
  measuredAt: MEASURED_AT,
})

test('the fact sits right after Path in the Details list', async () => {
  fake.rows.set('p1', MEASURED)
  await mount()

  const terms = [...container.querySelectorAll('dt')].map((el) => text(el))
  expect(terms.slice(0, 3)).toEqual(['Path', 'Size on disk', 'Source'])
})

test('shows the total, the repository / worktrees split, and when it was measured', async () => {
  fake.rows.set('p1', MEASURED)
  await mount()

  const dd = fact()
  expect(text(dd)).toContain('2.1 GB')
  expect(text(dd)).toContain('Repository 1.5 GB · Session worktrees 600 MB')
  expect(text(dd)).toContain(`Measured ${formatDateTime(MEASURED_AT, 'en')}`)
  expect(recalculate().disabled).toBe(false)
  expect(measuringSpinners(dd)).toHaveLength(0)
})

test('asks the single-project endpoint, not the list', async () => {
  fake.rows.set('p1', MEASURED)
  await mount()

  expect(fake.count('GET', SINGLE_URL)).toBe(1)
  expect(fake.count('GET', LIST_URL)).toBe(0)
})

test('the date follows the app language, and the labels are Russian', async () => {
  fake.rows.set('p1', MEASURED)
  await mount('ready', russian)

  const dd = fact('Размер на диске')
  expect(text(dd)).toContain('Репозиторий 1.5 GB · Рабочие каталоги сессий 600 MB')
  expect(text(dd)).toContain(`Измерено ${formatDateTime(MEASURED_AT, 'ru')}`)
  expect(formatDateTime(MEASURED_AT, 'ru')).not.toBe(formatDateTime(MEASURED_AT, 'en'))
  expect(recalculate('Пересчитать')).toBeDefined()
})

test('Recalculate sends POST /api/projects/p1/disk-usage/refresh once, and the old figures stay up while it measures', async () => {
  fake.rows.set('p1', MEASURED)
  await mount()

  await click(recalculate())

  expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([
    { method: 'POST', url: '/api/projects/p1/disk-usage/refresh' },
  ])
  const dd = fact()
  expect(text(dd)).toContain('2.1 GB')
  expect(text(dd)).toContain('Repository 1.5 GB · Session worktrees 600 MB')
  expect(recalculate().disabled).toBe(true)
  expect(measuringSpinners(dd)).toHaveLength(1)
})

test('Recalculate is disabled, with a spinner, while its own request is in flight', async () => {
  fake.rows.set('p1', MEASURED)
  let release: () => void = () => {}
  fake.refreshGate = new Promise<void>((resolve) => {
    release = resolve
  })
  await mount()

  await click(recalculate())
  expect(recalculate().disabled).toBe(true)
  expect(measuringSpinners(fact())).toHaveLength(1)
  expect(fake.count('POST', REFRESH_URL)).toBe(1)

  // A second click on a disabled button asks for nothing more.
  await click(recalculate())
  expect(fake.count('POST', REFRESH_URL)).toBe(1)

  release()
  await settle()
  // The answer says measuring, so it stays disabled for the measurement itself.
  expect(recalculate().disabled).toBe(true)
})

test('a measurement already running disables Recalculate, and clicking it sends nothing', async () => {
  fake.rows.set('p1', { ...MEASURED, measuring: true })
  await mount()

  expect(recalculate().disabled).toBe(true)
  expect(measuringSpinners(fact())).toHaveLength(1)
  await click(recalculate())
  expect(fake.count('POST', REFRESH_URL)).toBe(0)
  // The figures it had are still there.
  expect(text(fact())).toContain('2.1 GB')
})

test('with no figures yet and a measurement running, says "Measuring…" and shows no breakdown or date', async () => {
  fake.rows.set('p1', usage('p1', { measuring: true }))
  await mount()

  const dd = fact()
  expect(text(dd)).toContain('Measuring…')
  expect(text(dd)).not.toContain('Repository')
  expect(text(dd)).not.toContain('Measured')
  expect(recalculate().disabled).toBe(true)
})

test('a failed measurement is reported, and the figures from before it are still shown', async () => {
  fake.rows.set('p1', { ...MEASURED, error: 'Measuring was stopped before it finished (limit: 120s)' })
  await mount()

  const dd = fact()
  expect(text(dd)).toContain('2.1 GB')
  expect(text(dd)).toContain(
    'The last measurement failed: Measuring was stopped before it finished (limit: 120s)',
  )
  expect(recalculate().disabled).toBe(false)
})

test('a failed first measurement shows a dash and the reason, and Recalculate is available to try again', async () => {
  fake.rows.set('p1', usage('p1', { error: 'Could not read the folder size: Permission denied' }))
  await mount()

  const dd = fact()
  expect(text(dd)).toContain('—')
  expect(text(dd)).toContain(
    'The last measurement failed: Could not read the folder size: Permission denied',
  )
  expect(recalculate().disabled).toBe(false)
})

test('a refused Recalculate says why, keeps the figures, and lets the reader try again', async () => {
  fake.rows.set('p1', MEASURED)
  fake.refreshFails = 500
  await mount()

  await click(recalculate())

  const dd = fact()
  expect(text(dd)).toContain('Refresh refused')
  expect(text(dd)).toContain('2.1 GB')
  expect(recalculate().disabled).toBe(false)
})

test('a project still being set up shows a dash and offers nothing to recalculate', async () => {
  fake.rows.set('p1', usage('p1', { error: 'Project folder not found' }))
  await mount('cloning')

  const dd = fact()
  expect(text(dd)).toBe('—')
  expect(dd.querySelector('button')).toBeNull()
})

test('a size that cannot be loaded says so instead of loading for good', async () => {
  // No row: the fake answers 404, as the real endpoint does for an unknown project.
  await mount()

  expect(text(fact())).toBe('Could not load the size')
  expect(measuringSpinners(fact(), 'Loading')).toHaveLength(0)
})

test('the size is asked for again when the project finishes setting up', async () => {
  fake.rows.set('p1', usage('p1', { error: 'Project folder not found' }))
  await mount('cloning')
  expect(fake.count('GET', SINGLE_URL)).toBe(1)

  fake.rows.set('p1', MEASURED)
  await act(async () => {
    client.setQueryData([{ url: '/api/projects' }], [project('ready')])
  })
  await settle()

  expect(fake.count('GET', SINGLE_URL)).toBe(2)
  expect(text(fact())).toContain('2.1 GB')
})
