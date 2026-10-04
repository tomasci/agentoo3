// The Env files page through the real router: `/projects/<id>/env` renders
// `EnvFilesPage` inside the project shell, the sidebar's "Env files" item
// (right after Docker — the order itself is pinned by
// tests/project-settings-nav.test.tsx and tests/workspace.test.tsx, not
// repeated here) navigates there and is the current item once there.
//
// Every request is answered by an in-process transport swapped into the
// shared generated client (the seam tests/editor-page.test.tsx uses): the
// project's env-files list answers from a fixture, everything else the shell
// might ask for that is not seeded below is refused, so nothing leaves the
// process.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'

const project = {
  id: 'p1', name: 'Alpha', slug: 'alpha', source: 'clone', remoteUrl: 'git@github.com:acme/alpha.git',
  sourceName: null, sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null,
  recoveryCommands: null, path: '/srv/alpha', createdAt: '', updatedAt: '',
}

let requested: string[] = []
const transport = axios.create({
  adapter: async (config: InternalAxiosRequestConfig) => {
    const url = axios.getUri(config)
    requested.push(`${(config.method ?? 'get').toUpperCase()} ${url}`)
    if (url === '/api/projects/p1/env-files') {
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        config,
        data: { files: [{ path: 'server/.env', content: 'PORT=3000', size: 9, updatedAt: '2026-10-01T00:00:00.000Z' }] },
      }
    }
    throw new AxiosError('ECONNREFUSED (no backend in a unit test)', 'ERR_NETWORK', config)
  },
})
const originalTransport = apiClient.getConfig().transport
beforeAll(() => apiClient.setConfig({ transport }))
afterAll(() => apiClient.setConfig({ transport: originalTransport }))

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { routeTree } = await import('../src/app/router')

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root | null = null

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [project])
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
  // The notification bell (app/tab-bar.tsx) polls this on every shell
  // mount too — seeded for the same reason as every other query here.
  client.setQueryData(
    [{ url: '/api/notifications' }],
    { items: [], hasUnread: false, truncated: false },
  )
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])
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

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const main = () => container.querySelector('main') as HTMLElement
const sidebar = () => container.querySelector('[data-slot="sidebar"]')
const envLink = () =>
  [...(sidebar()?.querySelectorAll('a') ?? [])].find((a) => a.getAttribute('href') === '/projects/p1/env')

beforeEach(() => {
  localStorage.clear()
  requested = []
  document.body.innerHTML = ''
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  document.body.innerHTML = ''
  client?.clear()
})

test('/projects/p1/env renders the env files page for that project, with its nav item current', async () => {
  await mount('/projects/p1/env')
  expect(router.state.location.pathname).toBe('/projects/p1/env')
  expect(text(main().querySelector('h1'))).toBe('Env files')
  expect(main().querySelector('textarea')?.value).toBe('PORT=3000')
  expect(requested).toContain('GET /api/projects/p1/env-files')
  expect(envLink()?.getAttribute('aria-current')).toBe('page')
  expect(text(envLink())).toBe('Env files')
})

test('the sidebar item navigates there from another project page', async () => {
  await mount('/projects/p1/sessions')
  expect(envLink()?.getAttribute('aria-current')).toBeNull()
  await act(async () => {
    envLink()?.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/projects/p1/env')
  expect(text(main().querySelector('h1'))).toBe('Env files')
  expect(envLink()?.getAttribute('aria-current')).toBe('page')
})
