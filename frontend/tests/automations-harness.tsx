// Shared fake server + mount helpers for the automations component tests
// (tests/automations-*.test.tsx). Not a test file itself — `bun test` only
// picks up `*.test.*` — the same role tests/mock-module.ts plays.
//
// `installAutomationsServer()` must be awaited at module scope by each test
// file, *before* that file imports the router: it calls `mockModule` for every
// automations client (plus the library's agent list the form's orchestrator
// Select reads), so each file gets its own fakes, scoped and undone by
// `mockModule`'s own `afterAll`. The fakes are stateful — a PATCH really
// changes what the next GET answers — the same idiom
// tests/learning-schedule-card.test.tsx uses.

import { afterAll } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  type AnyRoute,
  type AnyRouter,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { AgentSummary } from '../src/features/library'
import type { Automation } from '../src/shared/api/generated/types/Automation'
import type { AutomationRun } from '../src/shared/api/generated/types/AutomationRun'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

export type { Automation, AutomationRun }

const T = '2026-10-01T09:00:00.000Z'

export const automation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  projectId: 'p1',
  name: 'Nightly deps',
  prompt: 'Check the dependencies',
  cron: '0 9 * * *',
  timezone: 'UTC',
  paused: false,
  orchestrator: 'lead',
  baseBranch: null,
  maxBudgetUsd: null,
  nextRunAt: '2026-10-06T09:00:00.000Z',
  lastRunAt: null,
  runCount: 0,
  createdAt: T,
  updatedAt: T,
  ...overrides,
})

export const run = (overrides: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'r1',
  automationId: 'a1',
  sessionId: null,
  scheduledFor: T,
  startedAt: T,
  status: 'dispatched',
  error: null,
  prompt: 'Check the dependencies',
  session: null,
  ...overrides,
})

export const agent = (name: string, role: AgentSummary['role']): AgentSummary => ({
  name,
  role,
  team: false,
  description: `${name} description`,
  path: `/agents/${name}.md`,
  promptLines: 4,
  usedByProjects: 0,
})

type PreviewBody = { cron: string; timezone: string; count?: number }
type PreviewResult = { valid: boolean; error: string | null; nextRuns: string[] }

export interface FakeServer {
  automations: Automation[]
  runs: Record<string, AutomationRun[]>
  agents: AgentSummary[]
  calls: {
    list: string[]
    get: string[]
    runs: string[]
    create: { projectId: string; body: Record<string, unknown> }[]
    patch: { id: string; body: Record<string, unknown> }[]
    delete: string[]
    preview: PreviewBody[]
  }
  /** Thrown (axios-shaped) by the next create/patch, when set. */
  createFailure: unknown
  patchFailure: unknown
  /** What the preview endpoint answers for a body (a promise to hold the
   *  answer back, simulating a request still in flight). */
  preview: (body: PreviewBody) => PreviewResult | Promise<PreviewResult>
  reset: () => void
}

const validPreview = (): PreviewResult => ({
  valid: true,
  error: null,
  nextRuns: ['2026-10-06T09:00:00.000Z', '2026-10-07T09:00:00.000Z'],
})

export async function installAutomationsServer(): Promise<FakeServer> {
  const server: FakeServer = {
    automations: [],
    runs: {},
    agents: [],
    calls: { list: [], get: [], runs: [], create: [], patch: [], delete: [], preview: [] },
    createFailure: null,
    patchFailure: null,
    preview: validPreview,
    reset() {
      server.automations = []
      server.runs = {}
      server.agents = [agent('lead', 'orchestrator'), agent('helper', 'subagent')]
      server.calls = { list: [], get: [], runs: [], create: [], patch: [], delete: [], preview: [] }
      server.createFailure = null
      server.patchFailure = null
      server.preview = validPreview
    },
  }
  server.reset()

  const notFound = () => ({ response: { status: 404, data: { error: 'Automation not found' } } })

  await mockModule('@/shared/api/generated/clients/getApiProjectsIdAutomations', () => ({
    getApiProjectsIdAutomations: async (o: { path: { id: string } }) => {
      server.calls.list.push(o.path.id)
      return { data: server.automations.filter((a) => a.projectId === o.path.id) }
    },
  }))
  await mockModule('@/shared/api/generated/clients/getApiAutomationsId', () => ({
    getApiAutomationsId: async (o: { path: { id: string } }) => {
      server.calls.get.push(o.path.id)
      const found = server.automations.find((a) => a.id === o.path.id)
      if (!found) throw notFound()
      return { data: found }
    },
  }))
  await mockModule('@/shared/api/generated/clients/getApiAutomationsIdRuns', () => ({
    getApiAutomationsIdRuns: async (o: { path: { id: string } }) => {
      server.calls.runs.push(o.path.id)
      return { data: server.runs[o.path.id] ?? [] }
    },
  }))
  await mockModule('@/shared/api/generated/clients/postApiProjectsIdAutomations', () => ({
    postApiProjectsIdAutomations: async (o: {
      path: { id: string }
      body: Record<string, unknown>
    }) => {
      server.calls.create.push({ projectId: o.path.id, body: o.body })
      if (server.createFailure) throw server.createFailure
      const created = automation({
        ...(o.body as Partial<Automation>),
        id: `a${server.automations.length + 100}`,
        projectId: o.path.id,
      })
      server.automations = [...server.automations, created]
      return { data: created }
    },
  }))
  await mockModule('@/shared/api/generated/clients/patchApiAutomationsId', () => ({
    patchApiAutomationsId: async (o: { path: { id: string }; body: Record<string, unknown> }) => {
      server.calls.patch.push({ id: o.path.id, body: o.body })
      if (server.patchFailure) throw server.patchFailure
      const found = server.automations.find((a) => a.id === o.path.id)
      if (!found) throw notFound()
      const next = { ...found, ...(o.body as Partial<Automation>) }
      server.automations = server.automations.map((a) => (a.id === o.path.id ? next : a))
      return { data: next }
    },
  }))
  await mockModule('@/shared/api/generated/clients/deleteApiAutomationsId', () => ({
    deleteApiAutomationsId: async (o: { path: { id: string } }) => {
      server.calls.delete.push(o.path.id)
      server.automations = server.automations.filter((a) => a.id !== o.path.id)
      return { data: { ok: true } }
    },
  }))
  await mockModule('@/shared/api/generated/clients/postApiAutomationsSchedulePreview', () => ({
    postApiAutomationsSchedulePreview: async (o: { body: PreviewBody }) => {
      server.calls.preview.push(o.body)
      return { data: await server.preview(o.body) }
    },
  }))
  await mockModule('@/shared/api/generated/clients/getApiLibraryAgents', () => ({
    getApiLibraryAgents: async () => ({ data: server.agents }),
  }))

  // The shell's own 15s pollers (the health check and the notification
  // bell) — answered locally so a test that fires every 15s interval never
  // reaches for the network.
  await mockModule('@/shared/api/generated/clients/getApiHealth', () => ({
    getApiHealth: async () => ({ data: { claudeCredential: true, version: '0.1.41' } }),
  }))
  await mockModule('@/shared/api/generated/clients/getApiNotifications', () => ({
    getApiNotifications: async () => ({ data: { items: [], hasUnread: false, truncated: false } }),
  }))

  return server
}

// ── mounting ────────────────────────────────────────────────────────────────

export const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

/** Collects console.error output so a test can assert none happened. */
export function captureConsoleErrors(): string[] {
  const problems: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    problems.push(
      args
        .map((a) => String(a))
        .join(' ')
        .slice(0, 300),
    )
    realError(...args)
  }
  afterAll(() => {
    console.error = realError
  })
  return problems
}

export const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** Waits out real time (the schedule builder's 400ms debounce) inside act. */
export const wait = async (ms: number) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
  await settle(4)
}

const shellProject = {
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  source: 'clone',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: '/srv/alpha',
  createdAt: '',
  updatedAt: '',
}

export interface Mounted {
  container: HTMLDivElement
  router: AnyRouter
  client: QueryClient
  unmount: () => Promise<void>
}

export async function mountAt(
  routeTree: AnyRoute,
  path: string,
  Toaster?: () => React.ReactNode,
): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.append(container)
  const router: AnyRouter = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [shellProject])
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
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])
  client.setQueryData([{ url: '/api/sessions/overview' }, { window: '1d' }], {
    running: [],
    unchecked: [],
    recent: [],
    window: '1d',
  })
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={english}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            {Toaster ? <Toaster /> : null}
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  return {
    container,
    router,
    client,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      client.clear()
      document.body.innerHTML = ''
    },
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

export const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

export const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

export const buttonByText = (scope: ParentNode, label: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll('button')].find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button`)
  return found as HTMLButtonElement
}

/** Types into a controlled input/textarea through the native setter, so
 *  React's value tracker sees a real change and fires onChange. */
export const typeInto = async (el: Element, value: string) => {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The control a label's `for` points at, for the label whose text is exactly
 *  `label`, searched inside `scope`. */
export const control = (scope: ParentNode, label: string): HTMLElement => {
  const found = [...scope.querySelectorAll('label')].find((l) => text(l) === label)
  if (!found) throw new Error(`no label "${label}"`)
  const el = document.getElementById(found.getAttribute('for') ?? '')
  if (!el) throw new Error(`no control for "${label}"`)
  return el
}

/** Opens a Base UI Select by its trigger and clicks the option whose text is
 *  exactly `option`. */
export const choose = async (trigger: HTMLElement, option: string) => {
  await click(trigger, 'select trigger')
  const found = [...document.body.querySelectorAll('[role="option"]')].find(
    (el) => text(el) === option,
  )
  if (!found) {
    const seen = [...document.body.querySelectorAll('[role="option"]')].map(text).slice(0, 20)
    throw new Error(`no option "${option}" (saw ${JSON.stringify(seen)})`)
  }
  await click(found, `option ${option}`)
}
