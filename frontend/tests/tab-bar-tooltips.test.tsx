// The tab bar's Tooltip-wrapped controls (app/tab-bar.tsx): the [+], each
// tab's close button, and the sidebar toggle.
//
//   T1  focusing or hovering each opens its tooltip — tabs.addTooltip,
//       tabs.close (with the tab's name), shell.hideSidebar/showSidebar by
//       sidebar state;
//   T2  each still works: [+] adds a tab, close closes *that* tab, the toggle
//       toggles and its aria-label flips between hide and show;
//   T3  the [+] and close keep `data-slot="button"`, the toggle keeps
//       `data-slot="sidebar-trigger"` (tests/shell.test.tsx finds it by that).
//
// Mounted as the whole shell at a URL, with every query seeded, the way
// tests/workspace.test.tsx does — the tab row and the sidebar are only real
// inside it. The shell renders under the app's own English i18n (installed
// by src/app/router's import graph), so expected strings are read from
// en.json rather than retyped. Focus opens a Base UI tooltip at once; hover
// only after the Root's default delay without the app's `TooltipProvider`
// (app/providers.tsx, delay 0), so the hover case mounts one — see
// tests/composer-tooltips.test.tsx.
//
// Anything React reports through console.error (an act warning included)
// fails the test that caused it, as in workspace.test.tsx.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import en from '../src/shared/i18n/locales/en.json'
import { TooltipProvider } from '../src/shared/ui/tooltip'

const project = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  source: 'clone',
  remoteUrl: null,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`,
  createdAt: '',
  updatedAt: '',
})
const PROJECTS = [project('p1', 'Alpha'), project('p2', 'Beta')]

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

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root | undefined

async function mount(path: string, { provider = false } = {}) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
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
  client.setQueryData([{ url: '/api/system' }], {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
  })
  for (const p of PROJECTS) {
    client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: p.id } }], [])
  }
  // The Suggested/Rejected tab counts (features/library/components/
  // library-tabs.tsx) and the System prompts table's new row — seeded for
  // the same reason as every other query here, not because this file has
  // anything of its own to say about the learning feature.
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
  client.setQueryData(
    [{ url: '/api/system/prompts/:name', params: { name: 'session-learning' } }],
    {
      name: 'session-learning',
      body: 'Built-in default instruction.',
      path: '/opt/agentoo/library/prompts/session-learning.md',
      source: 'default',
    },
  )
  root = createRoot(container)
  const app = <RouterProvider router={router} />
  await act(async () => {
    root?.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          {provider ? <TooltipProvider>{app}</TooltipProvider> : app}
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

beforeEach(() => {
  localStorage.clear()
  problems.length = 0
  document.body.replaceChildren()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
  client?.clear()
})

const tabBar = () => container.querySelector(`nav[aria-label="${en.tabs.label}"]`)
const tabLabels = () =>
  [...(tabBar()?.querySelectorAll('ul > li') ?? [])].map((li) =>
    li.querySelector('button')?.textContent?.replace('⚙', '').trim(),
  )
const addButton = () => {
  const b = tabBar()?.querySelector<HTMLButtonElement>(`[aria-label="${en.tabs.add}"]`)
  if (!b) throw new Error('no [+] button')
  return b
}
const closeLabel = (name: string) => en.tabs.close.replace('{{name}}', name)
const closeButton = (name: string) => {
  const b = tabBar()?.querySelector<HTMLButtonElement>(`ul button[aria-label="${closeLabel(name)}"]`)
  if (!b) throw new Error(`no close button for ${name}`)
  return b
}
const trigger = () => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('header button')].filter(
    (b) => b.getAttribute('data-sidebar') === 'trigger',
  )
  if (found.length !== 1) throw new Error(`expected one sidebar trigger, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
const sidebarState = () =>
  container.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null
/** Open tooltips' text (portalled into <body>). */
const openTooltips = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"][data-open]')].map(
    (el) => el.textContent ?? '',
  )

async function focus(el: HTMLElement) {
  await act(async () => {
    el.focus()
  })
  await settle(1)
}
async function blur(el: HTMLElement) {
  await act(async () => {
    el.blur()
  })
  await settle(2)
}
async function hover(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerenter'))
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseenter'))
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  })
  await settle(2)
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

/** Two project tabs, Alpha and Beta, Beta active. */
async function withTwoProjects(opts: { provider?: boolean } = {}) {
  await mount('/library', opts)
  for (const name of ['Alpha', 'Beta']) {
    await click(addButton())
    const pick = [...container.querySelectorAll<HTMLButtonElement>('main button')].find(
      (b) => b.textContent?.trim() === name,
    )
    if (!pick) throw new Error(`no ${name} in the picker`)
    await click(pick)
  }
  expect(tabLabels()).toEqual(['System', 'Alpha', 'Beta'])
}

// --- T1 ----------------------------------------------------------------------

test('focusing [+] opens tabs.addTooltip, and blurring closes it', async () => {
  await mount('/library')
  expect(openTooltips()).toEqual([])
  await focus(addButton())
  expect(openTooltips()).toEqual([en.tabs.addTooltip])
  await blur(addButton())
  expect(openTooltips()).toEqual([])
  expect(problems).toEqual([])
})

test("focusing a tab's close button opens a tooltip naming that tab", async () => {
  await withTwoProjects()
  await focus(closeButton('Alpha'))
  expect(openTooltips()).toEqual([closeLabel('Alpha')])
  await blur(closeButton('Alpha'))
  await focus(closeButton('Beta'))
  expect(openTooltips()).toEqual([closeLabel('Beta')])
  expect(problems).toEqual([])
})

test('focusing the sidebar toggle says "Hide sidebar" while the sidebar is open', async () => {
  await mount('/library')
  expect(sidebarState()).toBe('expanded')
  await focus(trigger())
  expect(openTooltips()).toEqual([en.shell.hideSidebar])
  expect(problems).toEqual([])
})

test('with the sidebar closed, the toggle\'s tooltip says "Show sidebar"', async () => {
  localStorage.setItem('agentoo:sidebar-open', 'false')
  await mount('/library')
  expect(sidebarState()).toBe('collapsed')
  await focus(trigger())
  expect(openTooltips()).toEqual([en.shell.showSidebar])
})

test("hovering each control under the app's TooltipProvider opens its tooltip", async () => {
  await withTwoProjects({ provider: true })
  const cases: [HTMLElement, string][] = [
    [addButton(), en.tabs.addTooltip],
    [closeButton('Alpha'), closeLabel('Alpha')],
    [trigger(), en.shell.hideSidebar],
  ]
  for (const [el, tip] of cases) {
    await hover(el)
    expect(openTooltips()).toContain(tip)
  }
})

// --- T2 ----------------------------------------------------------------------

test('[+] still opens a new tab', async () => {
  await mount('/library')
  await click(addButton())
  expect(tabLabels()).toEqual(['System', en.tabs.add])
  expect(router.state.location.pathname).toBe('/tab/new-1')
  expect(problems).toEqual([])
})

test('close still closes that tab and no other', async () => {
  await withTwoProjects()
  await click(closeButton('Alpha'))
  expect(tabLabels()).toEqual(['System', 'Beta'])
  expect(problems).toEqual([])
})

test('the sidebar toggle still toggles on click, and its aria-label flips with it', async () => {
  await mount('/library')
  expect(sidebarState()).toBe('expanded')
  expect(trigger().getAttribute('aria-label')).toBe(en.shell.hideSidebar)

  await click(trigger())
  expect(sidebarState()).toBe('collapsed')
  expect(trigger().getAttribute('aria-label')).toBe(en.shell.showSidebar)
  expect(localStorage.getItem('agentoo:sidebar-open')).toBe('false')

  await click(trigger())
  expect(sidebarState()).toBe('expanded')
  expect(trigger().getAttribute('aria-label')).toBe(en.shell.hideSidebar)
  expect(problems).toEqual([])
})

test('on one mounted shell, the toggle tooltip follows the sidebar state as it changes', async () => {
  // Toggled with the Ctrl+B shortcut rather than a click on the trigger:
  // Base UI deliberately keeps a trigger's tooltip from reopening on focus
  // right after that trigger was clicked, which would make a click-then-focus
  // sequence test Base UI's suppression, not this label.
  const toggle = async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
    })
    await settle()
  }
  await mount('/library')
  await focus(trigger())
  expect(openTooltips()).toEqual([en.shell.hideSidebar])
  await blur(trigger())

  await toggle()
  expect(sidebarState()).toBe('collapsed')
  await focus(trigger())
  expect(openTooltips()).toEqual([en.shell.showSidebar])
  expect(trigger().getAttribute('aria-label')).toBe(en.shell.showSidebar)
  await blur(trigger())

  await toggle()
  expect(sidebarState()).toBe('expanded')
  await focus(trigger())
  expect(openTooltips()).toEqual([en.shell.hideSidebar])
  expect(problems).toEqual([])
})

test('the old static "Toggle sidebar" label is gone from the trigger', async () => {
  await mount('/library')
  expect(trigger().getAttribute('aria-label')).not.toBe('Toggle sidebar')
  expect(container.querySelectorAll('[aria-label="Toggle sidebar"]').length).toBe(0)
})

// --- T3 ----------------------------------------------------------------------

test('[+] and every close keep data-slot="button"; the toggle keeps data-slot="sidebar-trigger"', async () => {
  await withTwoProjects()
  expect(addButton().getAttribute('data-slot')).toBe('button')
  expect(closeButton('Alpha').getAttribute('data-slot')).toBe('button')
  expect(closeButton('Beta').getAttribute('data-slot')).toBe('button')
  expect(trigger().getAttribute('data-slot')).toBe('sidebar-trigger')
  expect(container.querySelectorAll('[data-slot="sidebar-trigger"]').length).toBe(1)
  expect(container.querySelectorAll('header [data-slot="tooltip-trigger"]').length).toBe(0)
})
