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
const tabs = () => [...container.querySelectorAll('[role="tab"]')].map(label)
const activeTab = () => {
  const el = container.querySelector('[role="tab"][aria-selected="true"]')
  return el ? label(el) : null
}
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
const tabNamed = (text: string) =>
  [...container.querySelectorAll('[role="tab"]')].find((el) => label(el) === text)
const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => { (el as HTMLElement).click() })
  await settle()
}
const clickTab = (text: string) => click(tabNamed(text), `tab ${text}`)
const newTabButton = () => container.querySelector('[aria-label="New tab"]')

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
  expect(sidebar()).toBeNull()
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

  await click(container.querySelector('[aria-label="Close Alpha"]'), 'close button')

  // The race this guards: the URL still named the closed tab while the
  // navigation away was in flight, and adoption read that as a deep link.
  expect(tabs()).toEqual(['System'])
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

  await click(container.querySelector('[aria-label="Close Alpha"]'))

  expect(tabs()).toEqual(['System', 'Beta'])
  expect(activeTab()).toBe('Beta')
  expect(at()).toBe('/projects/p2')
  expect(problems).toEqual([])
})

test('the tab row moves with the arrow keys', async () => {
  await mount('/library')
  await click(newTabButton())
  await click(byText('button', 'Alpha'))
  expect(activeTab()).toBe('Alpha')

  const press = async (key: string) => {
    const el = container.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    await settle()
  }

  await press('ArrowLeft')
  expect(activeTab()).toBe('System')
  await press('ArrowRight')
  expect(activeTab()).toBe('Alpha')
  // Nothing past the ends.
  await press('ArrowRight')
  expect(activeTab()).toBe('Alpha')

  // Only the selected tab is in the page's tab order.
  const order = [...container.querySelectorAll('[role="tab"]')].map((el) =>
    el.getAttribute('tabindex'),
  )
  expect(order).toEqual(['-1', '0'])
  expect(problems).toEqual([])
})

test('the system tab has no close button', async () => {
  await mount('/library')
  expect(container.querySelector('[aria-label="Close System"]')).toBeNull()
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
  expect(name).toBeUndefined()
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
  expect(sidebar()?.querySelector('select')).toBeNull()
  expect(container.querySelector('[aria-label="Toggle theme"]')).toBeNull()
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

  const project = await paint('/projects/p1')
  expect(project).toContain('href="/projects/p1/sessions"')
  expect(project).not.toContain('href="/settings"')

  expect(await paint('/tab/new-1')).not.toContain('<aside')
})
