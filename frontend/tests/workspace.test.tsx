import { afterAll, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { routeTree } from '../src/app/router'

const project = (id: string, name: string, status = 'ready') => ({
  id, name, slug: name.toLowerCase(), source: 'clone', remoteUrl: null, sourceName: null,
  sshKeyId: null, defaultBranch: 'main', status, lastError: null, recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`, createdAt: '', updatedAt: '',
})

const PROJECTS = [project('p1', 'Alpha'), project('p2', 'Beta')]

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient

/**
 * Anything React reports — a render loop, an `act` warning, an error thrown in
 * a component — fails the test that caused it rather than scrolling past in the
 * output. The infinite loop this suite was written to catch announced itself
 * only this way.
 */
const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

/**
 * The shell, mounted at a URL with the server's answers already in the cache.
 *
 * Effects are what keep the tab row and the URL in step, so these tests mount
 * for real and click; a string render would exercise none of it.
 */

async function mount(path: string, projects = PROJECTS) {
  container = document.createElement('div')
  document.body.append(container)

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded, so the shell never reaches for a backend.
  client.setQueryData([{ url: '/api/projects' }], projects)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  for (const p of projects) {
    client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: p.id } }], [])
  }

  await act(async () => {
    createRoot(container).render(
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
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
}

const label = (el: Element) => el.textContent?.replace('⚙', '').trim()

/**
 * The tab row is a `nav` holding a list of plain buttons, not an ARIA tablist:
 * nothing in the app is a `role="tabpanel"`, so there is no tab/panel
 * relationship to declare. The tab you are on is marked `aria-current="page"`.
 * These helpers therefore match on the accessible markup — the nav's name, the
 * list, `aria-current` — rather than on roles that no longer exist or on class
 * names, which are styling and prove nothing to a screen reader.
 */
const tabBar = () => container.querySelector('nav[aria-label="Workspace tabs"]')
const tabItems = () => [...(tabBar()?.querySelectorAll('ul > li') ?? [])]
/** A tab's own button: the first button in its item, ahead of the close button. */
const tabButtons = () => tabItems().map((li) => li.querySelector('button') as HTMLButtonElement)
const tabs = () => tabButtons().map(label)
/** Every tab claiming to be the page you are on. More than one would be a bug. */
const currentTabs = () => tabButtons().filter((el) => el.getAttribute('aria-current') === 'page')
const activeTab = () => {
  const current = currentTabs()
  // Enforced on every call, so no test can pass while two tabs both say `page`.
  if (current.length > 1) {
    throw new Error(`${current.length} tabs claim aria-current="page": ${current.map(label)}`)
  }
  return current[0] ? label(current[0]) : null
}
/**
 * A printable stand-in for an element: unique per node, stable for the run, and
 * `null`/`undefined` passed straight through so an absence assertion still
 * claims exactly what it claimed before.
 *
 * Wrapped around every element that would otherwise be the operand of a matcher
 * that *prints its operands* — `toBe`, `toEqual`, `toBeNull`, `toBeUndefined`.
 * A happy-dom element serialises its symbol-keyed internals plus its whole
 * ancestor chain, so on failure those print the document. Measured on a
 * nine-element fixture: a failed `toBeNull` on an element emits 12 MB, a failed
 * `toBe` between two elements 25 MB, and `toEqual([])` against an array of them
 * aborts the process outright. Against a mounted workspace that is an OOM kill
 * — exit 137, no message, and the rest of `bun test tests/` goes with it, which
 * is exactly what a failing assertion in tests/transcript-row.test.tsx did.
 *
 * `toHaveLength` is deliberately *not* wrapped anywhere: it prints the two
 * lengths and nothing else, so it is already safe on a live `children` or
 * `NodeList`. Converting those would be churn.
 *
 * The `#n` is what keeps this an identity comparison rather than a comparison
 * of names: two distinct buttons labelled the same still differ.
 */
const tokens = new WeakMap<Node, string>()
let tokenCount = 0
function ref(node: Node): string
function ref(node: Node | null): string | null
function ref(node: Node | null | undefined): string | null | undefined
function ref(node: Node | null | undefined): string | null | undefined {
  if (node === null || node === undefined) return node
  const seen = tokens.get(node)
  if (seen) return seen
  const el = node as Element
  const named = el.getAttribute?.('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
  const token = `<${node.nodeName.toLowerCase()} #${++tokenCount}${named ? ` ${JSON.stringify(named)}` : ''}>`
  tokens.set(node, token)
  return token
}

const closeButtons = () =>
  [...(tabBar()?.querySelectorAll('ul button[aria-label^="Close "]') ?? [])] as HTMLElement[]
const closeButtonFor = (name: string) =>
  (tabBar()?.querySelector(`ul button[aria-label="Close ${name}"]`) ?? null) as HTMLElement | null
const at = () => router.state.location.pathname
const sidebar = () => container.querySelector('aside')
const navLinks = () =>
  [...(sidebar()?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))
const main = () => container.querySelector('main') as HTMLElement
const byText = (selector: string, text: string) =>
  [...main().querySelectorAll(selector)].find((el) => el.textContent?.trim() === text)
// Sidebar navigation, which is outside <main>.
const navTo = (text: string) =>
  [...(sidebar()?.querySelectorAll('a') ?? [])].find((el) => el.textContent?.trim() === text)
// Tabs are matched on their own label, past the system tab's icon.
const tabNamed = (text: string) => tabButtons().find((el) => label(el) === text)
const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => { (el as HTMLElement).click() })
  await settle()
}
const clickTab = (text: string) => click(tabNamed(text), `tab ${text}`)
// The [+] at the end of the row; the empty tab it creates is labelled, not
// aria-labelled, so this stays unambiguous however many are open.
const newTabButton = () => tabBar()?.querySelector('[aria-label="New tab"]')

beforeEach(() => {
  localStorage.clear()
  problems.length = 0
  document.body.innerHTML = ''
})

test('the workspace opens as one system tab, showing system navigation only', async () => {
  await mount('/library')

  expect(tabs()).toEqual(['System'])
  expect(activeTab()).toBe('System')
  // Library, ssh keys, configuration — and nothing about any project.
  expect(navLinks()).toEqual(['/library', '/library', '/ssh-keys', '/settings'])
  expect(navLinks().some((href) => href?.startsWith('/projects'))).toBe(false)
  expect(problems).toEqual([])
})

test('[+] opens an empty tab that asks for a project, and has no sidebar', async () => {
  await mount('/library')
  await click(newTabButton(), 'new-tab button')

  expect(tabs()).toEqual(['System', 'New tab'])
  expect(activeTab()).toBe('New tab')
  expect(at()).toBe('/tab/new-1')
  expect(ref(sidebar())).toBeNull()
  expect(container.textContent).toContain('Choose a project for this tab')
  // All three ways in, on the one page.
  expect(container.textContent).toContain('Clone a repository')
  expect(container.textContent).toContain('Existing folder')
  expect(container.textContent).toContain('New empty project')
  expect(problems).toEqual([])
})

test('picking a project fills in that same tab, and turns on project navigation', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'), 'project Alpha')

  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(activeTab()).toBe('Alpha')
  expect(at()).toBe('/projects/p1')
  expect(navLinks()).toEqual(['/projects/p1', '/projects/p1/sessions', '/projects/p1/library'])
  // No system pages in a project tab.
  expect(navLinks().includes('/settings')).toBe(false)
  expect(problems).toEqual([])
})

test('as many tabs as you like, each holding its own project', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  await click(newTabButton())
  await click(byText('button', 'Beta'))

  expect(tabs()).toEqual(['System', 'Alpha', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(at()).toBe('/projects/p2')
  expect(problems).toEqual([])
})

test('a tab remembers the page it was on', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  await click(navTo('Sessions'), 'Sessions link')
  expect(at()).toBe('/projects/p1/sessions')

  await clickTab('System')
  expect(at()).toBe('/library')

  await clickTab('Alpha')
  expect(at()).toBe('/projects/p1/sessions')
  expect(problems).toEqual([])
})

test('the system tab remembers its page too', async () => {
  await mount('/library')
  await click(navTo('Configuration'), 'Configuration link')
  expect(at()).toBe('/settings')

  await click(newTabButton())
  expect(at()).toBe('/tab/new-1')

  await clickTab('System')
  expect(at()).toBe('/settings')
  expect(problems).toEqual([])
})

test('closing the tab you are in moves you on, and it stays closed', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))

  await click(closeButtonFor('Alpha'), 'close button')

  // The race this guards: the URL still named the closed tab while the
  // navigation away was in flight, and adoption read that as a deep link.
  expect(tabs()).toEqual(['System'])
  // And the neighbour it moved you to is the tab now marked as your page.
  expect(activeTab()).toBe('System')
  expect(at()).toBe('/library')
  expect(problems).toEqual([])
})

test('closing a tab you are not in leaves you where you are', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  await click(newTabButton())
  await click(byText('button', 'Beta'))
  expect(at()).toBe('/projects/p2')

  await click(closeButtonFor('Alpha'), 'close Alpha')

  expect(tabs()).toEqual(['System', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(at()).toBe('/projects/p2')
  expect(problems).toEqual([])
})

test('every tab and every close button is reachable with the keyboard', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  await click(newTabButton())
  await click(byText('button', 'Beta'))
  expect(activeTab()).toBe('Beta')

  // This replaces an arrow-key/roving-tabIndex test. That behaviour belonged to
  // the ARIA tablist pattern the row no longer claims, so what has to be proved
  // now is the thing the arrow keys were standing in for: every control in the
  // row is a real button in the browser's own tab order, one stop each, with
  // nothing parked at tabindex="-1" where a keyboard cannot reach it.
  const buttons = [...(tabBar()?.querySelectorAll('button') ?? [])] as HTMLElement[]
  // Three tabs, two close buttons (the system tab has none), and the [+].
  expect(buttons.length).toBe(6)
  for (const el of buttons) {
    expect(el.tagName).toBe('BUTTON')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.getAttribute('tabindex')).toBeNull()
    el.focus()
    expect(ref(document.activeElement)).toBe(ref(el))
  }

  // A focused tab still switches when it is activated, which is what Enter or
  // Space does to a focused <button>. (happy-dom does not synthesise the click
  // a real browser fires for those keys, so the activation itself is clicked.)
  const system = tabNamed('System') as HTMLElement
  system.focus()
  expect(ref(document.activeElement)).toBe(ref(system))
  await click(system, 'tab System')
  expect(activeTab()).toBe('System')
  expect(at()).toBe('/library')

  // And closing from the keyboard reaches the same close button.
  const close = closeButtonFor('Beta')
  close?.focus()
  expect(ref(document.activeElement)).toBe(ref(close))
  await click(close, 'close Beta')
  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(activeTab()).toBe('System')
  expect(problems).toEqual([])
})

test('the tab row is a named nav, not a tablist that promises panels it has none of', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))

  // The row used to declare role="tablist"/role="tab" with aria-selected while
  // nothing in the app was ever a role="tabpanel" and no tab carried
  // aria-controls: a relationship announced to assistive tech that did not
  // exist. Nothing in the shell may claim it again.
  expect(container.querySelectorAll('[role="tablist"]').length).toBe(0)
  expect(container.querySelectorAll('[role="tab"]').length).toBe(0)
  expect(container.querySelectorAll('[role="tabpanel"]').length).toBe(0)
  expect(container.querySelectorAll('[aria-selected]').length).toBe(0)
  // `aria-controls` is scoped to the row: it is legitimate elsewhere (a
  // disclosure controls its panel), and dangling only on a tab that controls
  // nothing.
  expect(tabBar()?.querySelectorAll('[aria-controls]').length).toBe(0)

  // What is there instead: a nav with an accessible name, holding a list with
  // one item per tab.
  const bar = tabBar()
  expect(bar).not.toBeNull()
  expect(bar?.tagName).toBe('NAV')
  expect(bar?.getAttribute('aria-label')).toBe('Workspace tabs')
  expect(bar?.querySelector('ul')).not.toBeNull()
  expect(tabItems().length).toBe(2)

  // Exactly one tab says "this is the page you are on", and it moves with you.
  expect(currentTabs().map(label)).toEqual(['Alpha'])
  await clickTab('System')
  expect(currentTabs().map(label)).toEqual(['System'])
  await clickTab('Alpha')
  expect(currentTabs().map(label)).toEqual(['Alpha'])
  expect(problems).toEqual([])
})

test('the system tab has no close button, and every other close button is named', async () => {
  await mount('/library')
  expect(ref(closeButtonFor('System'))).toBeNull()
  expect(closeButtons().map(ref)).toEqual([])

  await click(newTabButton(), 'new-tab button')
  await click(byText('button', 'Alpha'), 'project Alpha')

  // One close button, and it says out loud which tab it closes — an unnamed
  // ✕ is what a screen reader reads as "button".
  expect(closeButtons().map((el) => el.getAttribute('aria-label'))).toEqual(['Close Alpha'])
  expect(ref(closeButtonFor('System'))).toBeNull()
})

test('a project already open is focused, not opened twice', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  await click(newTabButton())
  await click(byText('button', 'Alpha'))

  // Focused the tab holding it, and retired the picker that asked.
  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(activeTab()).toBe('Alpha')
  expect(at()).toBe('/projects/p1')
  expect(problems).toEqual([])
})

test('a pasted project link opens a real tab at that page', async () => {
  await mount('/projects/p2/sessions')

  expect(tabs()).toEqual(['System', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(at()).toBe('/projects/p2/sessions')
  expect(problems).toEqual([])
})

test('a link to a project the server does not have opens no tab', async () => {
  await mount('/projects/ghost')

  expect(tabs()).toEqual(['System'])
  expect(problems).toEqual([])
})

test('the workspace comes back after a reload', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  expect(localStorage.getItem('agentoo:tabs')).toContain('project-p1')

  // Remount without clearing storage, the way a refresh does.
  document.body.innerHTML = ''
  await mount('/projects/p1')

  expect(tabs()).toEqual(['System', 'Alpha'])
  expect(activeTab()).toBe('Alpha')
  expect(problems).toEqual([])
})

test('a project deleted elsewhere loses its tab, and takes you off its page', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  expect(at()).toBe('/projects/p1')

  // The server no longer has it — deleted from another tab, or another browser.
  await act(async () => {
    client.setQueryData([{ url: '/api/projects' }], [project('p2', 'Beta')])
  })
  await settle()

  expect(tabs()).toEqual(['System'])
  expect(at()).toBe('/library')
  expect(problems).toEqual([])
})

test('a project still cloning cannot be picked', async () => {
  await mount('/library', [project('p3', 'Cloning', 'cloning')])
  await click(newTabButton())

  const name = byText('button', 'Cloning')
  // Listed with its progress, but not an offer: there is no checkout yet.
  expect(ref(name)).toBeUndefined()
  expect(container.textContent).toContain('Cloning')
  expect(tabs()).toEqual(['System', 'New tab'])
})

test('configuration holds the language and the theme, and only the system tab has it', async () => {
  await mount('/settings')
  expect(container.querySelector('#settings-language')).not.toBeNull()
  expect(container.querySelector('#settings-theme')).not.toBeNull()

  // The old shell kept these as a select and an icon button in every sidebar.
  document.body.innerHTML = ''
  await mount('/projects/p1')
  expect(ref(sidebar()?.querySelector('select') ?? null)).toBeNull()
  expect(ref(container.querySelector('[aria-label="Toggle theme"]'))).toBeNull()
  expect(problems).toEqual([])
})

test('the theme selector actually changes the theme', async () => {
  await mount('/settings')
  const select = container.querySelector('#settings-theme') as HTMLSelectElement

  expect(document.documentElement.dataset.theme).toBe('dark')
  await act(async () => {
    select.value = 'light'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()

  expect(document.documentElement.dataset.theme).toBe('light')
  expect(localStorage.getItem('agentoo:theme')).toContain('light')
})

test('two empty tabs are two separate tabs', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(newTabButton())

  expect(tabs()).toEqual(['System', 'New tab', 'New tab'])
  expect(at()).toBe('/tab/new-2')

  // Filling one in leaves the other alone.
  await click(byText('button', 'Alpha'))
  expect(tabs()).toEqual(['System', 'New tab', 'Alpha'])
  expect(problems).toEqual([])
})

test('the shell is right on the first paint, before any effect runs', async () => {
  // Which sidebar to draw is read from the path rather than from the stored tab
  // row, so the first frame is already correct — no flash of the wrong shell
  // while the tab is being adopted. Rendered to a string, where effects never
  // run, because that is the only way to observe that first frame.
  const paint = async (path: string) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
    await router.load()
    const q = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderToStaticMarkup(
      <JotaiProvider>
        <QueryClientProvider client={q}>
          {/* biome-ignore lint/suspicious/noExplicitAny: not the app's registered router */}
          <RouterProvider router={router as any} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  }

  const system = await paint('/library')
  expect(system).toContain('href="/settings"')
  expect(system).not.toContain('href="/projects/')
  // The honest markup is there on the first frame too, not patched in by an
  // effect: a named nav with the current tab marked, and no tab roles.
  expect(system).toContain('aria-label="Workspace tabs"')
  expect(system).toContain('aria-current="page"')
  expect(system).not.toContain('role="tab')
  expect(system).not.toContain('aria-selected')

  const project = await paint('/projects/p1')
  expect(project).toContain('href="/projects/p1/sessions"')
  expect(project).not.toContain('href="/settings"')

  expect(await paint('/tab/new-1')).not.toContain('<aside')
})
