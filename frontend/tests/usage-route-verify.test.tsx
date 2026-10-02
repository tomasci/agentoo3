// The Usage page, through the real route tree and shell: the System
// sidebar's Usage item navigates to `/usage`, is marked current there (and
// only there), and the page it lands on is `UsagePage`.
//
// Mounted the way tests/ports-route-verify.test.tsx mounts the shell (memory
// history, seeded query cache), with the usage client replaced through
// tests/mock-module.ts. Links are matched by `href` rather than by label,
// because the shell reads the app's global i18next singleton, whose
// language depends on which test file initialised it first.

import { afterAll, afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

let usageCalls = 0

await mockModule('@/shared/api/generated/clients/getApiSystemUsage', () => ({
  getApiSystemUsage: async () => {
    usageCalls += 1
    return {
      data: {
        fetchedAt: '2026-09-30T06:34:00.000Z',
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
          asOf: '2026-09-30T06:33:37.701Z',
          status: 'allowed',
          windows: [
            { key: 'five_hour', label: null, utilization: 8, resetsAt: '2026-09-30T09:50:00.000Z' },
          ],
          overage: null,
          extraUsage: null,
        },
        breakdown: null,
        probeError: null,
      },
    }
  },
}))

const { routeTree } = await import('../src/app/router')

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
let router: ReturnType<typeof createRouter>

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount(path: string) {
  usageCalls = 0
  problems.length = 0
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
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
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

const sidebarLink = (href: string) =>
  container.querySelector(`[data-slot="sidebar-content"] a[href="${href}"]`) as HTMLAnchorElement | null

test('clicking the System sidebar Usage item lands on /usage, marks it current, and renders the page', async () => {
  await mount('/sessions')
  const usage = sidebarLink('/usage')
  expect(usage).not.toBeNull()
  expect(usage?.getAttribute('aria-current')).toBeNull()
  expect(usageCalls).toBe(0)

  await act(async () => {
    usage?.click()
  })
  await settle()

  expect(router.state.location.pathname).toBe('/usage')
  expect(sidebarLink('/usage')?.getAttribute('aria-current')).toBe('page')
  expect(sidebarLink('/usage')?.hasAttribute('data-active')).toBe(true)
  expect(sidebarLink('/ports')?.getAttribute('aria-current')).toBeNull()
  expect(usageCalls).toBe(1)
  expect(container.textContent).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  expect(problems).toEqual([])
})

test('a direct load of /usage renders the page with the Usage item current', async () => {
  await mount('/usage')
  expect(sidebarLink('/usage')?.getAttribute('aria-current')).toBe('page')
  expect(container.textContent).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  expect(usageCalls).toBe(1)
  expect(problems).toEqual([])
})
