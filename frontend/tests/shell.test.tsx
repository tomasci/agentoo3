// The shell's own composition (src/app/root-layout.tsx, sidebar.tsx,
// tab-bar.tsx, tab-switcher.tsx, status-bar.tsx): dashboard-01's
// `Sidebar variant="inset"` + `SidebarInset`, and the two bars around it.
// workspace.test.tsx already covers the tab-row/sidebar-nav *behaviour*
// (opening, closing, remembering a page); this file is about the DOM shape
// those pieces render into — one sidebar, one inset, a top bar and a status
// bar outside it with no background or border of their own, an empty tab with
// nothing in the sidebar at all, a session page that owns its whole region,
// the editor launcher with no shell at all, and the phone form showing the
// switcher and a drawer instead of the row.
//
// Where the contract is a CSS decision happy-dom cannot evaluate (it runs no
// media queries against Tailwind's output and computes no layout), the
// utility class is the only observable and is asserted as such — each one
// says which behaviour it stands for. Everything else is by slot, role,
// landmark and what a click does.
//
// Hermetic by construction: `<body>` is emptied and `localStorage` (tabs,
// sidebar-open, theme — all `atomWithStorage`) cleared before each case so no
// earlier file's markup or workspace leaks in, the shared API transport refuses every request so an
// unseeded query cannot reach whatever is listening on localhost, and the
// viewport and `<html>` class are put back after each case because both are
// process-wide.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import en from '../src/shared/i18n/locales/en.json'

const PROJECTS = [
  {
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
  },
]

/** Same defensive idiom as tests/project-layout.test.tsx: nothing here is
 *  about any endpoint, and the session and editor routes below mount pages
 *  whose queries are deliberately left unseeded — they fail fast here instead
 *  of issuing real HTTP. */
const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

/** happy-dom ships no EventSource; the session page's stream hook constructs
 *  one. Inert, and not what this file is about — see
 *  tests/use-session-stream-hook.test.tsx for the stream. */
class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource

type HappyWindow = { happyDOM: { setViewport(v: { width: number; height: number }): void } }
const setViewport = (width: number, height: number) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height })

let container: HTMLDivElement
let root: Root | undefined
let router: ReturnType<typeof createRouter>

/** The default host figures every case gets unless it asks for its own —
 *  cpu 10%, mem 20%, disk 30%, none of them worth a second look. */
const DEFAULT_SYSTEM = {
  cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
  memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
  disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
}

/** Mounted at a URL with every query this shell reads already in the cache,
 *  so nothing here ever reaches for a backend that isn't there. `system`
 *  overrides the host figures, for the case that needs one of them past 90%. */
async function mount(path: string, system: typeof DEFAULT_SYSTEM = DEFAULT_SYSTEM) {
  container = document.createElement('div')
  document.body.append(container)

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/system' }], system)
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])

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

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const click = async (el: Element | null | undefined, what: string) => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

const classesOf = (el: Element | null | undefined) =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
/** Any background or border utility, under any variant prefix
 *  (`md:bg-…`, `hover:border-…`). */
const surfaceClasses = (el: Element | null | undefined) =>
  classesOf(el).filter((c) => /(^|:)(bg|border)(-|$)/.test(c))
/** Any padding utility, under any variant prefix (`p-4`, `lg:p-6`, `px-2`…). */
const paddingClasses = (el: Element | null | undefined) =>
  classesOf(el).filter((c) => /(^|:)p[xytrbse]?-/.test(c))

const wrapper = () => container.querySelector('[data-slot="sidebar-wrapper"]')
/** Every sidebar in the document — the phone form portals into <body>, so
 *  `container` alone would miss it. */
const sidebars = () => [...document.querySelectorAll('[data-slot="sidebar"]')]
const trigger = () => container.querySelector('[data-slot="sidebar-trigger"]')
const tabNavs = () => [...container.querySelectorAll('header nav')]

beforeEach(() => {
  // Counts below are document-wide (the phone drawer portals into <body>), so
  // the document has to start empty: another file's leftover markup would be
  // counted as this shell's. That happened under `--randomize` before
  // tests/workspace.test.tsx unmounted its roots.
  document.body.replaceChildren()
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(async () => {
  // Unmounted before anything else: an open Sheet stamps aria-hidden on its
  // siblings, and that would outlive this case otherwise.
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  setViewport(1024, 768)
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  localStorage.clear()
  document.documentElement.className = ''
})

// --- desktop ----------------------------------------------------------------------

test('the desktop shell mounts exactly one inset sidebar, with the two bars outside it and unstyled', async () => {
  await mount('/library')

  // One sidebar of any kind, and it is the inset one.
  expect(sidebars()).toHaveLength(1)
  expect(sidebars()[0]?.getAttribute('data-variant')).toBe('inset')
  expect(container.querySelectorAll('[data-slot="sidebar"][data-variant="inset"]').length).toBe(1)

  const insets = container.querySelectorAll('[data-slot="sidebar-inset"]')
  expect(insets.length).toBe(1)
  const inset = insets[0] as HTMLElement

  // The wrapper's own children, in order: the top bar, the sidebar/inset row,
  // the status bar. Found structurally rather than by `querySelector('header')`,
  // which would happily match a page's own <header> somewhere inside the inset.
  const shell = wrapper()
  expect(shell).not.toBeNull()
  const [header, row, footer, ...rest] = [...(shell?.children ?? [])] as HTMLElement[]
  expect(rest).toHaveLength(0)
  expect(header?.tagName).toBe('HEADER')
  expect(row?.tagName).toBe('DIV')
  expect(footer?.tagName).toBe('FOOTER')

  // The row holds the sidebar and the inset; the bars are its siblings.
  expect(row?.contains(sidebars()[0] ?? null)).toBe(true)
  expect(row?.contains(inset)).toBe(true)
  expect(inset.contains(header ?? null)).toBe(false)
  expect(inset.contains(footer ?? null)).toBe(false)
  expect(header?.closest('[data-slot="sidebar-inset"]') == null).toBe(true)
  expect(footer?.closest('[data-slot="sidebar-inset"]') == null).toBe(true)

  // Only the inset is an elevated surface — the bars sit on the same
  // `bg-sidebar` wrapper the sidebar does, so they carry no background (and
  // no border separating them from it) of their own.
  expect(surfaceClasses(header)).toEqual([])
  expect(surfaceClasses(footer)).toEqual([])
  // And that wrapper is the one that turns `bg-sidebar` — only because an
  // inset-variant sidebar is inside it.
  expect(classesOf(shell)).toContain('has-data-[variant=inset]:bg-sidebar')

  // The SSH-key count used to live in the status bar too; it was dropped as a
  // duplicate of the link the system sidebar already carries (asserted below,
  // in the drawer test), so the footer must never grow one back.
  expect(footer?.querySelector('a[href="/ssh-keys"]')).toBeNull()
})

test('the sidebar sits in the row between the bars — absolute, not pinned to the viewport', async () => {
  await mount('/library')

  // The generated Sidebar's container is `fixed inset-y-0 … h-svh`: pinned to
  // the whole browser viewport, over both bars. ShellSidebar overrides that to
  // `absolute h-auto`, which resolves against the row's `relative` and
  // stretches to the row's height instead.
  const sidebarContainer = container.querySelector('[data-slot="sidebar-container"]')
  expect(sidebarContainer).not.toBeNull()
  const classes = classesOf(sidebarContainer)
  expect(classes).toContain('absolute')
  expect(classes).toContain('h-auto')
  expect(classes).not.toContain('fixed')
  expect(classes).not.toContain('h-svh')

  const row = sidebarContainer?.closest('[data-slot="sidebar-wrapper"] > div')
  expect(classesOf(row)).toContain('relative')
})

test('an ordinary page gets the padded, scrolling body inside the inset', async () => {
  // The control for the full-bleed case below: proves `paddingClasses` sees
  // the padding an ordinary page does get, so its empty result there means
  // something.
  await mount('/library')
  const body = container.querySelector('[data-slot="sidebar-inset"]')?.firstElementChild
  expect(paddingClasses(body).length).toBeGreaterThan(0)
  expect(classesOf(body)).toContain('overflow-y-auto')
})

test('a session page is full-bleed: the inset child carries no padding and does not scroll itself', async () => {
  await mount('/projects/p1/sessions/s1')

  expect(router.state.location.pathname).toBe('/projects/p1/sessions/s1')
  const insets = container.querySelectorAll('[data-slot="sidebar-inset"]')
  expect(insets.length).toBe(1)
  const body = insets[0]?.firstElementChild
  expect(body?.tagName).toBe('DIV')
  expect(paddingClasses(body)).toEqual([])
  // The page scrolls its own transcript; the body only clips.
  expect(classesOf(body)).not.toContain('overflow-y-auto')
  expect(classesOf(body)).toContain('overflow-hidden')
  // Still inside the shell: it is the body that bleeds, not the chrome that goes.
  expect(wrapper()).not.toBeNull()
  expect(sidebars()).toHaveLength(1)
})

test('the session list is not full-bleed — only the session detail route is', async () => {
  await mount('/projects/p1/sessions')
  const body = container.querySelector('[data-slot="sidebar-inset"]')?.firstElementChild
  expect(paddingClasses(body).length).toBeGreaterThan(0)
})

test('the bare editor path renders no shell at all — no wrapper, sidebar, bars or trigger', async () => {
  await mount('/projects/p1/sessions/s1/editor')

  expect(router.state.location.pathname).toBe('/projects/p1/sessions/s1/editor')
  expect(wrapper() == null).toBe(true)
  expect(document.querySelectorAll('[data-slot="sidebar-wrapper"]').length).toBe(0)
  expect(sidebars()).toHaveLength(0)
  expect(container.querySelectorAll('[data-slot="sidebar-inset"]').length).toBe(0)
  expect(container.querySelectorAll('header, footer').length).toBe(0)
  expect(trigger() == null).toBe(true)
  // …but something did render: the launcher itself, not an empty page.
  expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0)
})

test('a system page has a sidebar trigger on desktop, open by default', async () => {
  // The control for the empty-tab case below: the trigger's absence there is
  // the mode's doing, not something this viewport never renders.
  await mount('/library')
  expect(trigger() == null).toBe(false)
  expect(sidebars()[0]?.getAttribute('data-state')).toBe('expanded')
  expect(sidebars()[0]?.querySelectorAll('a').length ?? 0).toBeGreaterThan(0)
})

test('an empty tab shows an empty, closed sidebar and no trigger to open it', async () => {
  await mount('/tab/new-1')

  expect(sidebars()).toHaveLength(1)
  const sidebar = sidebars()[0]
  expect(sidebar?.querySelectorAll('a').length).toBe(0)
  expect(sidebar?.querySelectorAll('[data-slot="sidebar-menu-button"]').length).toBe(0)
  // Forced closed — even though the persisted preference (cleared to its
  // default) says open.
  expect(sidebar?.getAttribute('data-state')).toBe('collapsed')
  expect(trigger() == null).toBe(true)
})

test('an empty tab forces the sidebar closed without overwriting the stored preference', async () => {
  localStorage.setItem('agentoo:sidebar-open', 'true')
  await mount('/tab/new-1')
  expect(sidebars()[0]?.getAttribute('data-state')).toBe('collapsed')
  expect(localStorage.getItem('agentoo:sidebar-open')).toBe('true')
})

// --- host metrics --------------------------------------------------------------------

test('the desktop footer shows the three host figures as Progress bars, each with its own accessible name', async () => {
  await mount('/library')

  const footer = container.querySelector('footer')
  const groups = [...(footer?.children ?? [])] as HTMLElement[]
  const desktopGroup = groups.find((el) => classesOf(el).includes('md:flex'))
  expect(desktopGroup).not.toBeUndefined()
  expect(classesOf(desktopGroup)).toEqual(expect.arrayContaining(['hidden', 'md:flex']))

  const bars = [...(desktopGroup?.querySelectorAll('[data-slot="progress"]') ?? [])] as HTMLElement[]
  expect(bars).toHaveLength(3)

  const accessibleName = (bar: HTMLElement): string => {
    const labelId = bar.getAttribute('aria-labelledby')
    return (labelId && document.getElementById(labelId)?.textContent) || ''
  }
  const byName = Object.fromEntries(bars.map((bar) => [accessibleName(bar), bar]))

  // Rounded percents from the mocked /api/system: cpu 10%, mem 20%, disk 30%.
  for (const [label, percent] of [
    [en.status.cpuLabel, 10],
    [en.status.memLabel, 20],
    [en.status.diskLabel, 30],
  ] as const) {
    const bar = byName[label]
    expect(bar).not.toBeUndefined()
    expect(bar?.getAttribute('role')).toBe('progressbar')
    expect(bar?.getAttribute('aria-valuenow')).toBe(String(percent))
  }
})

test('on a phone the status bar collapses to one Progress bar naming the worst metric', async () => {
  setViewport(375, 800)
  await mount('/library')

  const footer = container.querySelector('footer')
  const groups = [...(footer?.children ?? [])] as HTMLElement[]
  const phoneGroup = groups.find((el) => classesOf(el).includes('md:hidden'))
  expect(phoneGroup).not.toBeUndefined()

  const bars = [...(phoneGroup?.querySelectorAll('[data-slot="progress"]') ?? [])] as HTMLElement[]
  expect(bars).toHaveLength(1)
  const bar = bars[0]
  expect(bar?.getAttribute('role')).toBe('progressbar')

  // Disk is the worst of cpu 10% / mem 20% / disk 30% in the mocked data.
  expect(bar?.getAttribute('aria-valuenow')).toBe('30')
  const labelId = bar?.getAttribute('aria-labelledby')
  expect(labelId ? document.getElementById(labelId)?.textContent : null).toBe(en.status.diskLabel)
})

// Mirrors i18next's own `{{var}}` interpolation, done directly here rather
// than pulling the real i18next instance into a file that otherwise checks
// DOM shape by role and slot, not by rendering through it.
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''))

test('the worst metric on a phone is a button that opens a popover with all three host figures', async () => {
  setViewport(375, 800)
  await mount('/library')

  const footer = container.querySelector('footer')
  const groups = [...(footer?.children ?? [])] as HTMLElement[]
  const phoneGroup = groups.find((el) => classesOf(el).includes('md:hidden'))

  // The collapsed bar lives inside a real button — not the plain, unfocusable
  // trigger the desktop tooltips use — because tapping it is the only way to
  // see the other two figures on a screen with no room for tooltips.
  const trigger = phoneGroup?.querySelector('[data-slot="popover-trigger"]')
  expect(trigger).not.toBeNull()
  expect(trigger?.tagName).toBe('BUTTON')
  expect(trigger?.getAttribute('aria-label')).toBe(en.status.hostDetails)
  expect(trigger?.querySelectorAll('[data-slot="progress"]').length).toBe(1)

  // Closed until tapped — Base UI popups unmount rather than hide.
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()

  await click(trigger, 'host details trigger')

  const popover = document.querySelector('[data-slot="popover-content"]')
  expect(popover).not.toBeNull()
  expect(popover?.querySelector('[data-slot="popover-title"]')?.textContent).toBe(en.status.hostDetails)

  const bars = [...(popover?.querySelectorAll('[role="progressbar"]') ?? [])] as HTMLElement[]
  expect(bars).toHaveLength(3)

  const accessibleName = (bar: HTMLElement): string => {
    const labelId = bar.getAttribute('aria-labelledby')
    return (labelId && document.getElementById(labelId)?.textContent) || ''
  }
  const byName = Object.fromEntries(bars.map((bar) => [accessibleName(bar), bar]))
  for (const [label, percent] of [
    [en.status.cpuLabel, 10],
    [en.status.memLabel, 20],
    [en.status.diskLabel, 30],
  ] as const) {
    const bar = byName[label]
    expect(bar).not.toBeUndefined()
    expect(bar?.getAttribute('aria-valuenow')).toBe(String(percent))
  }

  // The same three detail lines the desktop tooltips carry, now written out
  // under each bar instead of hidden behind a hover that touch cannot reach.
  const popoverText = popover?.textContent ?? ''
  expect(popoverText).toContain(fill(en.status.cpuTitle, { cores: 4, load: 0.5 }))
  expect(popoverText).toContain(fill(en.status.memTitle, { used: '1 B', total: '2 B' }))
  expect(popoverText).toContain(fill(en.status.diskTitle, { free: '1 B', path: '/' }))

  // Tapping the trigger again closes it, the same as tapping anywhere else outside it would.
  await click(trigger, 'host details trigger (closing)')
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
})

test('a host figure at 90% or more keeps its label and value text muted, not destructive', async () => {
  // Only disk crosses the line; cpu and mem stay put as the control.
  const highDisk = {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 95, totalBytes: 100, usedPercent: 95, path: '/' },
  }
  await mount('/library', highDisk)

  const footer = container.querySelector('footer')
  const groups = [...(footer?.children ?? [])] as HTMLElement[]
  const desktopGroup = groups.find((el) => classesOf(el).includes('md:flex'))
  const desktopText = [
    ...(desktopGroup?.querySelectorAll('[data-slot="progress-label"], [data-slot="progress-value"]') ?? []),
  ] as HTMLElement[]
  // Three bars, a label and a value each.
  expect(desktopText).toHaveLength(6)
  for (const el of desktopText) {
    expect(classesOf(el)).not.toContain('text-destructive')
  }
})

test('a host figure at 90% or more stays muted in the phone trigger and its popover too', async () => {
  setViewport(375, 800)
  const highDisk = {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 95, totalBytes: 100, usedPercent: 95, path: '/' },
  }
  await mount('/library', highDisk)

  const footer = container.querySelector('footer')
  const groups = [...(footer?.children ?? [])] as HTMLElement[]
  const phoneGroup = groups.find((el) => classesOf(el).includes('md:hidden'))
  const trigger = phoneGroup?.querySelector('[data-slot="popover-trigger"]')

  // Disk is the worst metric, so it is what the collapsed trigger names.
  const triggerText = [
    ...(trigger?.querySelectorAll('[data-slot="progress-label"], [data-slot="progress-value"]') ?? []),
  ] as HTMLElement[]
  expect(triggerText).toHaveLength(2)

  await click(trigger, 'host details trigger')
  const popover = document.querySelector('[data-slot="popover-content"]')
  const popoverRowText = [
    ...(popover?.querySelectorAll('[data-slot="progress-label"], [data-slot="progress-value"]') ?? []),
  ] as HTMLElement[]
  expect(popoverRowText).toHaveLength(6)

  for (const el of [...triggerText, ...popoverRowText]) {
    expect(classesOf(el)).not.toContain('text-destructive')
  }
})

// --- theme --------------------------------------------------------------------------

test('the stored theme is what <html> gets on first render: .dark only for dark', async () => {
  localStorage.setItem('agentoo:theme', JSON.stringify('light'))
  await mount('/library')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(document.documentElement.style.colorScheme).toBe('light')
  await act(async () => {
    root?.unmount()
  })
  container.remove()

  localStorage.setItem('agentoo:theme', JSON.stringify('dark'))
  await mount('/library')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(document.documentElement.style.colorScheme).toBe('dark')
})

test('the theme is applied on the bare editor path too, which has no shell of its own', async () => {
  // RootLayout applies it before choosing between the shell and the bare
  // route — the launcher opens in its own browser tab, and would otherwise
  // flash the wrong palette.
  localStorage.setItem('agentoo:theme', JSON.stringify('dark'))
  await mount('/projects/p1/sessions/s1/editor')
  expect(wrapper() == null).toBe(true)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
})

test('the theme selector on the configuration page flips .dark on <html>, both ways', async () => {
  // tests/settings-page.test.tsx drives dark → light under its own cimode
  // instance; this is the same control through the shell, and back again.
  await mount('/settings')
  expect(document.documentElement.classList.contains('dark')).toBe(true)

  const choose = async (value: 'light' | 'dark') => {
    await click(container.querySelector('#settings-theme'), 'theme select trigger')
    const options = [...document.body.querySelectorAll('[role="option"]')]
    expect(options).toHaveLength(2)
    // By label, read from en.json rather than typed out: importing the real
    // router installs the app's English i18n singleton for this file (see
    // tests/session-page-scroll.test.tsx), the same thing the phone case's
    // 'System' relies on.
    const label = value === 'light' ? en.settings.themeLight : en.settings.themeDark
    await click(
      options.find((o) => o.textContent === label),
      `${value} option`,
    )
  }

  await choose('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(JSON.parse(localStorage.getItem('agentoo:theme') ?? 'null')).toBe('light')

  await choose('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(JSON.parse(localStorage.getItem('agentoo:theme') ?? 'null')).toBe('dark')
})

// --- phone ----------------------------------------------------------------------------

test('the phone layout shows the tab switcher and a trigger, not the tab row', async () => {
  setViewport(375, 800)

  await mount('/library')

  expect(trigger() == null).toBe(false)
  // The switcher is a DropdownMenu; the desktop tab row has no such trigger.
  const switcherTrigger = container.querySelector('[data-slot="dropdown-menu-trigger"]')
  expect(switcherTrigger == null).toBe(false)
  expect(switcherTrigger?.textContent).toContain('System')

  // Both shapes are always in the DOM (tab-bar.tsx) and which one shows is
  // Tailwind's `md:` alone — happy-dom evaluates no media query against it, so
  // the classes are the contract: the row is hidden until md, the switcher's
  // nav from md on.
  const navs = tabNavs()
  expect(navs).toHaveLength(2)
  const [rowNav, switcherNav] = navs
  expect(classesOf(rowNav)).toEqual(expect.arrayContaining(['hidden', 'md:flex']))
  expect(classesOf(switcherNav)).toContain('md:hidden')
  expect(classesOf(switcherNav)).not.toContain('hidden')
  expect(switcherNav?.contains(switcherTrigger)).toBe(true)
  expect(rowNav?.contains(switcherTrigger)).toBe(false)
  // The same accessible name on both, since only one is ever visible.
  expect(rowNav?.getAttribute('aria-label')).toBe(switcherNav?.getAttribute('aria-label') ?? '')

  // The switcher's menu lists the open tabs.
  await click(switcherTrigger, 'tab switcher')
  const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
  expect(items.map((i) => i.textContent?.trim())).toContain('System')
})

test('on a phone the sidebar is a drawer: closed until the trigger opens it, and it closes on navigation', async () => {
  setViewport(375, 800)
  await mount('/library')

  // No inline sidebar below md — it is a Sheet, and a closed one unmounts.
  expect(sidebars()).toHaveLength(0)

  await click(trigger(), 'sidebar trigger')
  expect(sidebars()).toHaveLength(1)
  const drawer = sidebars()[0]
  expect(drawer?.getAttribute('data-mobile')).toBe('true')
  // Portalled out of the shell, not inline in the row.
  expect(container.contains(drawer ?? null)).toBe(false)

  const sshKeys = [...(drawer?.querySelectorAll('a') ?? [])].find(
    (a) => a.getAttribute('href') === '/ssh-keys',
  )
  await click(sshKeys, 'SSH keys link in the drawer')

  expect(router.state.location.pathname).toBe('/ssh-keys')
  expect(sidebars()).toHaveLength(0)
})

test('an empty tab on a phone has no trigger either', async () => {
  // On a phone the trigger is the only way into the drawer, so this is where
  // its absence matters most.
  setViewport(375, 800)
  await mount('/tab/new-1')
  expect(trigger() == null).toBe(true)
  expect(sidebars()).toHaveLength(0)
  // The switcher is still there — it is how you leave an empty tab.
  expect(container.querySelector('[data-slot="dropdown-menu-trigger"]') == null).toBe(false)
})

const pressToggleShortcut = async () => {
  // shadcn's SidebarProvider binds Ctrl/Cmd+B on `window` — the one way to
  // toggle the sidebar that does not go through the (absent) trigger.
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
  })
  await settle()
}

test("the sidebar shortcut toggles an ordinary page's sidebar and remembers it", async () => {
  // The control for the empty-tab shortcut case below: the shortcut does
  // reach the provider in this harness.
  await mount('/library')
  expect(sidebars()[0]?.getAttribute('data-state')).toBe('expanded')
  await pressToggleShortcut()
  expect(sidebars()[0]?.getAttribute('data-state')).toBe('collapsed')
  expect(localStorage.getItem('agentoo:sidebar-open')).toBe('false')
})

test("the sidebar shortcut cannot open an empty tab's sidebar, nor rewrite the stored preference", async () => {
  localStorage.setItem('agentoo:sidebar-open', 'false')
  await mount('/tab/new-1')
  await pressToggleShortcut()
  expect(sidebars()[0]?.getAttribute('data-state')).toBe('collapsed')
  // Still the reader's own choice, for when they next open a real page.
  expect(localStorage.getItem('agentoo:sidebar-open')).toBe('false')
})

// root-layout.tsx forces an empty tab's sidebar closed through
// SidebarProvider's `open` prop, but below md the sidebar is a Sheet driven by
// `openMobile`, which that prop does not govern — and the provider's Ctrl/Cmd+B
// handler toggles `openMobile` there regardless of mode. What stops the
// shortcut from opening a modal drawer with nothing in it, in a window under
// 768px wide (a phone with a keyboard, or just a narrow desktop window), is
// ShellSidebar in sidebar.tsx not mounting a `Sidebar` at all for an empty tab
// on mobile, so there is no Sheet for `openMobile` to open. This guards that:
// forcing `open` closed alone would pass the desktop test above and still
// regress here.
test('the sidebar shortcut cannot open an empty drawer on an empty tab on a phone', async () => {
  setViewport(375, 800)
  await mount('/tab/new-1')
  await pressToggleShortcut()
  expect(sidebars()).toHaveLength(0)
})
