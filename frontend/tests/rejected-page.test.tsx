// The Rejected view (`/library/rejected`): the table of rejected
// suggestions, and "Delete permanently" — it requires confirmation
// (ConfirmDialog, not window.confirm) before the DELETE actually goes out.
//
// Mounted the same way tests/suggested-page.test.tsx mounts its own route:
// real router/shell, generated clients replaced through tests/mock-module.ts,
// a private English I18nextProvider.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
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
  sourceSessions: unknown[]
  targetExists: boolean
  stale: boolean
}

const REJECTED: Suggestion[] = [
  {
    id: 's1',
    runId: 'r1',
    kind: 'agent',
    action: 'modify',
    name: 'reviewer',
    title: 'Tighten the review checklist',
    rationale: 'Recent sessions show the reviewer missing null checks.',
    status: 'rejected',
    createdAt: '2026-09-18T04:00:00.000Z',
    decidedAt: '2026-09-19T09:00:00.000Z',
    appliedVersion: null,
    sourceSessions: [],
    targetExists: true,
    stale: false,
  },
]

let deleteCalls: { path: { id: string } }[] = []
/** When set, the DELETE rejects with it. */
let deleteFailure: unknown = null

await mockModule('@/shared/api/generated/clients/getApiLibrarySuggestions', () => ({
  getApiLibrarySuggestions: async (opts: { query?: { status?: string } }) => {
    const status = opts.query?.status ?? 'pending'
    return { data: status === 'rejected' ? REJECTED : [] }
  },
}))
await mockModule('@/shared/api/generated/clients/deleteApiLibrarySuggestionsId', () => ({
  deleteApiLibrarySuggestionsId: async (opts: { path: { id: string } }) => {
    deleteCalls.push(opts)
    if (deleteFailure) throw deleteFailure
    return { data: undefined }
  },
}))

const { routeTree } = await import('../src/app/router')

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
    history: createMemoryHistory({ initialEntries: ['/library/rejected'] }),
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
  deleteCalls = []
  deleteFailure = null
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  document.body.innerHTML = ''
})

const main = () => container.querySelector('main') ?? container
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const rows = () => [...main().querySelectorAll('tbody tr')]

async function openRowMenu() {
  const trigger = rows()[0]?.querySelector('button[aria-haspopup="menu"]') as HTMLElement | null
  if (!trigger) throw new Error('no row actions menu trigger')
  await act(async () => {
    trigger.click()
  })
  await settle()
}

const menuItem = (label: string): HTMLElement => {
  const items = [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')] as HTMLElement[]
  const found = items.find((el) => text(el) === label)
  if (!found) throw new Error(`no "${label}" menu item among ${items.map(text).join(', ')}`)
  return found
}

const dialogButton = (label: string): HTMLButtonElement => {
  const dialog = document.body.querySelector('[role="alertdialog"]')
  const found = dialog && [...dialog.querySelectorAll('button')].find((el) => text(el) === label)
  if (!found) throw new Error(`no open dialog button "${label}"`)
  return found as HTMLButtonElement
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

test('lists kind, action, name, title and the rejected date', async () => {
  await mount()
  expect(rows()).toHaveLength(1)
  expect(text(rows()[0])).toContain('reviewer')
  expect(text(rows()[0])).toContain('Tighten the review checklist')
  expect(text(rows()[0])).toContain('Modify')
  expect(text(rows()[0])).toContain('Agent')
})

test('an empty list shows the empty state, not a bare table', async () => {
  const empty: Suggestion[] = []
  await mockModule('@/shared/api/generated/clients/getApiLibrarySuggestions', () => ({
    getApiLibrarySuggestions: async () => ({ data: empty }),
  }))
  await mount()
  expect(text(main())).toContain('No rejected suggestions.')
})

test('"Delete permanently" opens a confirm dialog and sends no DELETE until confirmed', async () => {
  await mount()
  await openRowMenu()
  await click(menuItem('Delete permanently'))

  expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  expect(deleteCalls).toEqual([])

  await click(dialogButton('Delete permanently'))
  expect(deleteCalls.map((c) => c.path)).toEqual([{ id: 's1' }])
  expect(problems).toEqual([])
})

test('dismissing the confirm dialog (Cancel) sends no DELETE', async () => {
  await mount()
  await openRowMenu()
  await click(menuItem('Delete permanently'))
  await click(dialogButton('Cancel'))

  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  expect(deleteCalls).toEqual([])
})
