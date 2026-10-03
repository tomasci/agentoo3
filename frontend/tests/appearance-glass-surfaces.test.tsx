// The shared glass recipe (`GLASS_CLASS_NAME`, features/appearance) on the
// three shell surfaces that carry it while a backdrop is active, and on
// nothing else:
//
//   - the page body, `main[data-slot=sidebar-inset]`;
//   - the desktop tab pill: one element wrapping the tab <ul> and the [+]
//     button, with the glass plus `rounded-xl p-1` — not the full-width nav,
//     with the header kept at `h-12`;
//   - the desktop sidebar's main nav `SidebarMenu`, for both the system tab
//     (`SystemNav`) and a project tab (`ProjectNav`), with the glass plus
//     `rounded-xl p-1`.
//
// The brand header, ProjectNav's footer menu and the sidebar container never
// carry glass. Neither does the nav menu in the phone drawer. With nothing
// chosen, none of these surfaces carries any glass class or the
// `rounded-xl`/`p-1` this change adds, and the tabs, the [+] and the nav links
// still work.
//
// "Carries glass" is detected by any of `bg-background/70`,
// `backdrop-blur-xl` or `ring-border/50`. None of them is used anywhere else
// in src/ (grepped), unlike `ring-1`, which is common and so is only checked
// as part of the full recipe on the surfaces expected to carry it.
//
// The harness is tests/shell.test.tsx's: real router, seeded queries, offline
// API transport, inert EventSource, and happy-dom's `setViewport` to drive
// `useIsMobile` for the phone cases.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import { GLASS_CLASS_NAME } from '../src/features/appearance'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { backgroundAtom, backgroundPatternAtom } from '../src/shared/store/ui'

const BG_KEY = 'agentoo:background'
const PATTERN_KEY = 'agentoo:background-pattern'

/** The recipe from the spec, spelled out rather than imported. */
const RECIPE = ['bg-background/70', 'ring-1', 'ring-border/50', 'backdrop-blur-xl'] as const
/** The tokens that mean "glass" wherever they appear (see header). */
const GLASS_MARKERS = ['bg-background/70', 'backdrop-blur-xl', 'ring-border/50'] as const
const PILL = ['rounded-xl', 'p-1'] as const

const PROJECTS = [
  {
    id: 'p1', name: 'Alpha', slug: 'alpha', source: 'clone', remoteUrl: null, sourceName: null,
    sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null,
    recoveryCommands: null, path: '/srv/alpha', createdAt: '', updatedAt: '',
  },
]

const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

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
let store: ReturnType<typeof createStore>

async function mount(path: string) {
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
  client.setQueryData([{ url: '/api/system' }], {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
  client.setQueryData(
    [{ url: '/api/system/prompts/:name', params: { name: 'session-learning' } }],
    { name: 'session-learning', body: 'x', path: '/x.md', source: 'default' },
  )

  store = createStore()
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <JotaiProvider store={store}>
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
const has = (el: Element | null | undefined, tokens: readonly string[]) =>
  tokens.filter((t) => classesOf(el).includes(t))

// --- the surfaces --------------------------------------------------------------------

const header = () => container.querySelector('[data-slot="sidebar-wrapper"] > header')
/** The desktop tab row: the `nav` inside the header that holds the tab <ul>
 *  (the phone switcher is a second, list-less nav). */
const desktopNav = () =>
  [...(header()?.querySelectorAll('nav') ?? [])].find((n) => n.querySelector('ul') !== null)
const tabList = () => desktopNav()?.querySelector('ul')
const addButton = () => desktopNav()?.querySelector('button[aria-label="New tab"]')
/** The tab pill: the nearest element holding both the tab <ul> and the [+]. */
function tabPill(): Element | null {
  let el: Element | null | undefined = tabList()?.parentElement
  const plus = addButton()
  while (el && plus && !el.contains(plus)) el = el.parentElement
  return el ?? null
}
const inset = () => container.querySelector('main[data-slot="sidebar-inset"]')
/** Every sidebar in the document — the phone drawer portals into <body>. */
const sidebars = () => [...document.querySelectorAll('[data-slot="sidebar"]')]
const mainNavMenu = (sidebar: Element | undefined = sidebars()[0]) =>
  sidebar?.querySelector('[data-slot="sidebar-content"] [data-slot="sidebar-menu"]') ?? null
const footerMenu = () =>
  sidebars()[0]?.querySelector('[data-slot="sidebar-footer"] [data-slot="sidebar-menu"]') ?? null
const brandHeader = () => sidebars()[0]?.querySelector('[data-slot="sidebar-header"]') ?? null

/** Names every element in the document that carries any glass marker, so a
 *  failure says which surface went glassy rather than printing elements. */
function glassySurfaces(): string[] {
  const named = new Map<Element | null, string>([
    [inset(), 'inset'],
    [tabPill(), 'tab-pill'],
    [mainNavMenu(), 'nav-menu'],
  ])
  return [...document.querySelectorAll('[class]')]
    .filter((el) => has(el, GLASS_MARKERS).length > 0)
    .map(
      (el) =>
        named.get(el) ??
        `${el.tagName.toLowerCase()}[data-slot=${el.getAttribute('data-slot') ?? '-'}]`,
    )
    .sort()
}

/** Everything the spec says about the surfaces, as one printable object. */
function surfaces() {
  return {
    glassy: glassySurfaces(),
    insetRecipe: has(inset(), RECIPE),
    pillRecipe: has(tabPill(), RECIPE),
    pillShape: has(tabPill(), PILL),
    navRecipe: has(mainNavMenu(), RECIPE),
    navShape: has(mainNavMenu(), PILL),
  }
}

const ON = {
  glassy: ['inset', 'nav-menu', 'tab-pill'],
  insetRecipe: [...RECIPE],
  pillRecipe: [...RECIPE],
  pillShape: [...PILL],
  navRecipe: [...RECIPE],
  navShape: [...PILL],
}
const OFF = {
  glassy: [],
  insetRecipe: [],
  pillRecipe: [],
  pillShape: [],
  navRecipe: [],
  navShape: [],
}

beforeEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
  setViewport(1024, 768)
})

afterEach(async () => {
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

// --- the recipe ------------------------------------------------------------------------

test('GLASS_CLASS_NAME is exactly the spec recipe', () => {
  expect(GLASS_CLASS_NAME).toBe('bg-background/70 ring-1 ring-border/50 backdrop-blur-xl')
})

// --- structure that holds either way -------------------------------------------------------

describe('the tab pill', () => {
  for (const [state, stored] of [
    ['off', null],
    ['on', '"blue"'],
  ] as const) {
    test(`(${state}) is one element holding the tab list and the [+], inside but not the nav`, async () => {
      if (stored) localStorage.setItem(BG_KEY, stored)
      await mount('/library')
      const pill = tabPill()
      const nav = desktopNav()
      expect(pill !== null && nav !== undefined).toBe(true)
      expect(pill === nav).toBe(false)
      expect(!!nav?.contains(pill)).toBe(true)
      expect(!!pill?.contains(tabList() ?? null)).toBe(true)
      expect(!!pill?.contains(addButton() ?? null)).toBe(true)
      // The header keeps its 48px height and the nav carries no glass itself.
      expect(classesOf(header())).toContain('h-12')
      expect(has(nav, [...GLASS_MARKERS, ...PILL])).toEqual([])
    })
  }
})

// --- off ---------------------------------------------------------------------------------

describe('with nothing chosen no surface carries glass or the pill shape', () => {
  test('system tab: nothing stored', async () => {
    await mount('/library')
    expect(mainNavMenu() !== null).toBe(true)
    expect(surfaces()).toEqual(OFF)
  })

  test('project tab: nothing stored', async () => {
    await mount('/projects/p1/sessions')
    expect(mainNavMenu() !== null).toBe(true)
    expect(surfaces()).toEqual(OFF)
  })

  test('garbage in storage counts as nothing chosen', async () => {
    localStorage.setItem(BG_KEY, '{not json')
    localStorage.setItem(PATTERN_KEY, '"stripes"')
    await mount('/library')
    expect(surfaces()).toEqual(OFF)
  })
})

describe('with nothing chosen the tabs, the [+] and the nav links still work', () => {
  const tabButtons = () =>
    [...(tabList()?.querySelectorAll(':scope > li') ?? [])].map(
      (li) => li.querySelector('button') as HTMLButtonElement,
    )
  const current = () =>
    tabButtons()
      .filter((b) => b.getAttribute('aria-current') === 'page')
      .map((b) => b.textContent?.trim())
  const at = () => router.state.location.pathname

  for (const [state, stored] of [
    ['off', null],
    ['on', '"ocean"'],
  ] as const) {
    test(`(${state}) add a tab, open a project, select, navigate, close`, async () => {
      if (stored) localStorage.setItem(BG_KEY, stored)
      await mount('/library')
      expect(tabButtons()).toHaveLength(1)

      // [+] opens an empty tab and makes it current.
      await click(addButton(), '[+] button')
      expect(tabButtons()).toHaveLength(2)
      expect(at().startsWith('/tab/')).toBe(true)

      // The empty tab's picker opens the project into it.
      const alpha = [...(inset()?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent?.trim() === 'Alpha',
      )
      await click(alpha, 'Alpha in the project picker')
      expect(at()).toBe('/projects/p1/sessions')
      expect(current()).toEqual(['Alpha'])

      // A project nav link navigates.
      const library = sidebars()[0]?.querySelector('a[href="/projects/p1/library"]')
      await click(library, 'project library link')
      expect(at()).toBe('/projects/p1/library')

      // Selecting the system tab goes back to it.
      const system = tabButtons().find((b) => b.textContent?.includes('System'))
      await click(system, 'System tab')
      expect(current().length).toBe(1)
      expect(at()).toBe('/library')

      // A system nav link navigates.
      await click(sidebars()[0]?.querySelector('a[href="/ssh-keys"]'), 'SSH keys link')
      expect(at()).toBe('/ssh-keys')

      // Closing the project tab removes it.
      await click(desktopNav()?.querySelector('button[aria-label="Close Alpha"]'), 'close Alpha')
      expect(tabButtons()).toHaveLength(1)
    })
  }
})

// --- on ----------------------------------------------------------------------------------

describe('while a backdrop is active exactly the three surfaces carry the glass', () => {
  test('system tab, a colour', async () => {
    localStorage.setItem(BG_KEY, '"blue"')
    await mount('/library')
    expect(surfaces()).toEqual(ON)
  })

  test('system tab, a pattern alone', async () => {
    localStorage.setItem(PATTERN_KEY, '"code"')
    await mount('/library')
    expect(surfaces()).toEqual(ON)
  })

  test('project tab, a gradient and a pattern', async () => {
    localStorage.setItem(BG_KEY, '"sunset"')
    localStorage.setItem(PATTERN_KEY, '"space"')
    await mount('/projects/p1/sessions')
    // It is ProjectNav's menu being checked: it links into the project.
    expect(!!mainNavMenu()?.querySelector('a[href="/projects/p1/sessions"]')).toBe(true)
    expect(surfaces()).toEqual(ON)
  })

  test('the brand header, the footer menu and the sidebar container carry none of it', async () => {
    localStorage.setItem(BG_KEY, '"green"')
    await mount('/projects/p1/sessions')
    const brand = brandHeader()
    const footer = footerMenu()
    const sidebarContainer = sidebars()[0]?.querySelector('[data-slot="sidebar-container"]')
    const sidebarInner = sidebars()[0]?.querySelector('[data-slot="sidebar-inner"]')
    expect([brand, footer, sidebarContainer, sidebarInner].every((el) => !!el)).toBe(true)
    const touched = (el: Element | null | undefined) => [
      ...has(el, GLASS_MARKERS),
      // and nothing inside them either
      ...[...(el?.querySelectorAll('[class]') ?? [])].flatMap((d) =>
        // The container/inner hold the nav menu, which is allowed glass.
        d === mainNavMenu() ? [] : has(d, GLASS_MARKERS),
      ),
    ]
    expect({
      brand: touched(brand),
      footer: touched(footer),
      container: has(sidebarContainer, GLASS_MARKERS),
      inner: has(sidebarInner, GLASS_MARKERS),
    }).toEqual({ brand: [], footer: [], container: [], inner: [] })
  })

  test('switching the backdrop on and off live adds and removes all three', async () => {
    await mount('/library')
    expect(surfaces()).toEqual(OFF)
    await act(async () => {
      store.set(backgroundAtom, 'mint')
    })
    await settle()
    expect(surfaces()).toEqual(ON)
    await act(async () => {
      store.set(backgroundAtom, 'none')
      store.set(backgroundPatternAtom, 'geometric')
    })
    await settle()
    expect(surfaces()).toEqual(ON)
    await act(async () => {
      store.set(backgroundPatternAtom, 'none')
    })
    await settle()
    expect(surfaces()).toEqual(OFF)
  })
})

// --- phone -----------------------------------------------------------------------------------

describe('in the phone drawer the nav menu stays opaque', () => {
  for (const [what, path, href] of [
    ['system tab', '/library', '/ssh-keys'],
    ['project tab', '/projects/p1/sessions', '/projects/p1/library'],
  ] as const) {
    test(`${what}: backdrop active, drawer open, no glass on its nav menu`, async () => {
      setViewport(375, 800)
      localStorage.setItem(BG_KEY, '"purple"')
      localStorage.setItem(PATTERN_KEY, '"weather"')
      await mount(path)
      await click(container.querySelector('[data-slot="sidebar-trigger"]'), 'sidebar trigger')
      const drawer = sidebars()[0]
      expect(drawer?.getAttribute('data-mobile')).toBe('true')
      const menu = mainNavMenu(drawer)
      // The right menu, and it is populated.
      expect(!!menu?.querySelector(`a[href="${href}"]`)).toBe(true)
      expect(has(menu, [...GLASS_MARKERS, ...PILL])).toEqual([])
      // Nothing else in the drawer went glassy either.
      const glassyInDrawer = [...(drawer?.querySelectorAll('[class]') ?? [])].filter(
        (el) => has(el, GLASS_MARKERS).length > 0,
      )
      expect(glassyInDrawer.length).toBe(0)
    })
  }
})
