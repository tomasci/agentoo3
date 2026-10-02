// Requirement 1 of the Ports page, through the real route tree and shell:
// the System sidebar's Ports item navigates to `/ports`, is marked current
// there (and only there), and the page it lands on is `PortsPage`.
//
// Mounted the way tests/workspace.test.tsx mounts the shell (memory history,
// seeded query cache) with the ports client replaced through
// tests/mock-module.ts: `usePorts` pins `staleTime: 0`, so a seeded cache
// entry alone would not stop it from reaching for a backend. Links are
// matched by `href` rather than by label, because the shell reads the app's
// global i18next singleton, whose language depends on which test file
// initialised it first.

import { afterAll, afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

let portCalls: (string | undefined)[] = []

await mockModule('@/shared/api/generated/clients/getApiSystemPorts', () => ({
  getApiSystemPorts: async (opts: { query?: { scope?: string } }) => {
    portCalls.push(opts.query?.scope)
    return {
      data: {
        scope: 'listening',
        source: 'ss',
        collectedAt: '2026-09-04T10:00:00.000Z',
        user: 'agentoo',
        runningAsRoot: false,
        total: 1,
        truncated: false,
        unattributedCount: 0,
        inferredCount: 0,
        ports: [
          {
            protocol: 'tcp',
            localAddress: '127.0.0.1',
            localPort: 18123,
            peerAddress: null,
            peerPort: null,
            state: 'LISTEN',
            pid: 4242,
            processName: 'bun-route-probe',
            processKnown: true,
            attribution: 'socket',
            unit: null,
            container: null,
            owner: 'agentoo',
          },
        ],
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
  portCalls = []
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

test('clicking the System sidebar Ports item lands on /ports, marks it current, and renders the page', async () => {
  await mount('/sessions')
  const ports = sidebarLink('/ports')
  expect(ports).not.toBeNull()
  expect(ports?.getAttribute('aria-current')).toBeNull()
  expect(portCalls).toEqual([])

  await act(async () => {
    ports?.click()
  })
  await settle()

  expect(router.state.location.pathname).toBe('/ports')
  expect(sidebarLink('/ports')?.getAttribute('aria-current')).toBe('page')
  expect(sidebarLink('/ports')?.hasAttribute('data-active')).toBe(true)
  expect(sidebarLink('/storage')?.getAttribute('aria-current')).toBeNull()
  // The page itself mounted and fetched once, for the default scope.
  expect(portCalls).toEqual(['listening'])
  expect(container.textContent).toContain('bun-route-probe')
  expect(problems).toEqual([])
})

test('a direct load of /ports renders the page with the Ports item current', async () => {
  await mount('/ports')
  expect(sidebarLink('/ports')?.getAttribute('aria-current')).toBe('page')
  expect(container.querySelector('tbody tr')?.textContent).toContain('18123')
  expect(portCalls).toEqual(['listening'])
  expect(problems).toEqual([])
})
