// The prompt editor's place in the real route tree and shell, now that it
// lives under the Library rather than as its own System sidebar item:
//
// - the System sidebar has no Prompts item any more;
// - `/library/prompts/idea-to-prompt` renders the editor (loaded body, Save,
//   Reset to default) with a "Library" back link, and the sidebar's Library
//   item is the current one there;
// - the old `/prompts/idea-to-prompt` redirects there instead of 404ing,
//   including when it arrives as a stale tab path out of localStorage;
// - a Save in the editor shows up as "Custom" in the Library table afterwards.
//
// Mounted the way tests/usage-route-verify.test.tsx mounts the shell, with
// the prompt clients faked through tests/mock-module.ts the way
// tests/prompt-editor-page.test.tsx fakes them. The fake GET reads a single
// "server-side" record that the fake PUT writes, so the Library table can only
// learn about a save by refetching it.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const NAME = 'idea-to-prompt'
const DEFAULT_BODY = 'The built-in default instruction.'
type PromptRecord = { name: string; body: string; path: string; source: 'file' | 'default' }

const defaultRecord = (): PromptRecord => ({
  name: NAME,
  body: DEFAULT_BODY,
  path: '/opt/agentoo/library/prompts/idea-to-prompt.md',
  source: 'default',
})

/** The fake backend's one stored prompt. */
let server: PromptRecord = defaultRecord()
let getCalls = 0
let putCalls: { path: { name: string }; body: { body: string } }[] = []

await mockModule('@/shared/api/generated/clients/getApiSystemPromptsName', () => ({
  getApiSystemPromptsName: async (opts: { path: { name: string } }) => {
    getCalls += 1
    if (opts.path.name !== NAME) throw new Error(`unknown prompt ${opts.path.name}`)
    return { data: { ...server } }
  },
}))
await mockModule('@/shared/api/generated/clients/putApiSystemPromptsName', () => ({
  putApiSystemPromptsName: async (opts: { path: { name: string }; body: { body: string } }) => {
    putCalls.push(opts)
    server = { ...server, body: opts.body.body, source: 'file' }
    return { data: { ...server } }
  },
}))
await mockModule('@/shared/api/generated/clients/deleteApiSystemPromptsName', () => ({
  deleteApiSystemPromptsName: async () => {
    server = defaultRecord()
    return { data: { ...server } }
  },
}))

const { i18n } = await import('../src/shared/i18n')
await i18n.changeLanguage('en')
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
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  // staleTime: Infinity, so nothing refetches on its own — a fresh value can
  // only reach the cache through an explicit invalidation.
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
  client.setQueryData([{ url: '/api/library/agents' }], [])
  client.setQueryData([{ url: '/api/library/skills' }], [])
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

beforeEach(() => {
  localStorage.clear()
  server = defaultRecord()
  getCalls = 0
  putCalls = []
  problems.length = 0
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

const sidebarHrefs = () =>
  [...container.querySelectorAll('[data-slot="sidebar"] a')].map((a) => a.getAttribute('href'))
const sidebarLink = (href: string) =>
  container.querySelector(`[data-slot="sidebar-content"] a[href="${href}"]`) as HTMLAnchorElement | null
const main = () => container.querySelector('main') ?? container
const textarea = () => main().querySelector('textarea') as HTMLTextAreaElement | null
const buttonLabels = () => [...main().querySelectorAll('button')].map((b) => b.textContent?.trim())
const button = (label: string) => {
  const b = [...main().querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}" among ${buttonLabels().join(', ')}`)
  return b as HTMLButtonElement
}
const backLink = () =>
  [...main().querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Library') as
    | HTMLAnchorElement
    | undefined
const notFoundShown = () => /not found/i.test(main().textContent ?? '')
const librarySourceCell = () => {
  const h = [...main().querySelectorAll('h2')].find((el) => el.textContent?.trim() === 'System prompts')
  let node: HTMLElement | null = h?.parentElement ?? null
  while (node && !node.querySelector('table')) node = node.parentElement
  if (!node) throw new Error('no System prompts table on the page')
  const headers = [...node.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
  return node.querySelectorAll('tbody tr')[0]?.querySelectorAll('td, th')[headers.indexOf('Source')]
    ?.textContent?.trim()
}

/** Types into a React-controlled textarea: the native value setter, then an
 *  `input` event, which is what React's onChange listens for. */
async function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('the System sidebar has no Prompts item: exactly the expected hrefs, in order', async () => {
  await mount('/sessions')
  expect(sidebarHrefs()).toEqual([
    '/sessions',
    '/sessions',
    '/docker',
    '/library',
    '/ssh-keys',
    '/storage',
    '/ports',
    '/usage',
    '/settings',
  ])
  expect(sidebarHrefs().some((href) => href?.includes('prompts'))).toBe(false)
})

test('/library/prompts/idea-to-prompt renders the editor with a back link, and Library is current', async () => {
  await mount('/library/prompts/idea-to-prompt')
  expect(router.state.location.pathname).toBe('/library/prompts/idea-to-prompt')
  expect(notFoundShown()).toBe(false)
  expect(textarea()?.value).toBe(DEFAULT_BODY)
  expect(buttonLabels()).toContain('Save')
  expect(buttonLabels()).toContain('Reset to default')

  const back = backLink()
  expect(back?.getAttribute('href')).toBe('/library')
  // The back link sits above the editor's own heading, at the top of the page.
  const h1 = main().querySelector('h1')
  expect(h1 && back ? Boolean(back.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING) : null).toBe(true)

  expect(sidebarLink('/library')?.getAttribute('aria-current')).toBe('page')
  const othersCurrent = [...container.querySelectorAll('[data-slot="sidebar"] a[aria-current="page"]')]
    .map((a) => a.getAttribute('href'))
  expect(othersCurrent).toEqual(['/library'])
  expect(problems).toEqual([])
})

test('the back link returns to /library', async () => {
  await mount('/library/prompts/idea-to-prompt')
  await act(async () => {
    backLink()?.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/library')
  expect([...main().querySelectorAll('h2')].map((h) => h.textContent?.trim())).toContain('System prompts')
})

test('the old /prompts/idea-to-prompt redirects to /library/prompts/idea-to-prompt and shows the editor', async () => {
  await mount('/prompts/idea-to-prompt')
  expect(router.state.location.pathname).toBe('/library/prompts/idea-to-prompt')
  expect(notFoundShown()).toBe(false)
  expect(textarea()?.value).toBe(DEFAULT_BODY)
  expect(sidebarLink('/library')?.getAttribute('aria-current')).toBe('page')
  expect(problems).toEqual([])
})

test('a system tab persisted at the old /prompts path lands on the editor when reopened', async () => {
  localStorage.setItem(
    'agentoo:tabs',
    JSON.stringify([
      { id: 'system', kind: 'system', path: '/prompts/idea-to-prompt' },
      { id: 'tab-1', kind: 'empty', path: '/tab/tab-1' },
    ]),
  )
  await mount('/tab/tab-1')
  const systemTabButton = [
    ...container.querySelectorAll('nav[aria-label="Workspace tabs"] ul > li button'),
  ].find((b) => b.textContent?.trim() === 'System') as HTMLButtonElement | undefined
  if (!systemTabButton) throw new Error('no System tab button')
  await act(async () => {
    systemTabButton.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/library/prompts/idea-to-prompt')
  expect(textarea()?.value).toBe(DEFAULT_BODY)
  expect(notFoundShown()).toBe(false)
})

test('control: a server-side change alone does not reach the cached Library row', async () => {
  // Proves the next test's "Custom" can only come from the editor's
  // invalidation, not from the table refetching on its own.
  await mount('/library')
  expect(librarySourceCell()).toBe('Built-in default')
  server = { ...server, source: 'file' }
  await act(async () => {
    router.navigate({ to: '/library/agents/new' })
  })
  await settle()
  await act(async () => {
    router.navigate({ to: '/library' })
  })
  await settle()
  expect(librarySourceCell()).toBe('Built-in default')
})

test('saving in the editor makes the Library table show "Custom" afterwards', async () => {
  await mount('/library')
  expect(librarySourceCell()).toBe('Built-in default')
  const getsBefore = getCalls

  const title = main().querySelector('a[href="/library/prompts/idea-to-prompt"]') as HTMLAnchorElement | null
  await act(async () => {
    title?.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/library/prompts/idea-to-prompt')
  const ta = textarea()
  if (!ta) throw new Error('no editor textarea')
  await typeInto(ta, 'Be terse. Always name the file you mean.')
  await act(async () => {
    button('Save').click()
  })
  await settle()
  expect(putCalls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: { name: NAME }, body: { body: 'Be terse. Always name the file you mean.' } },
  ])
  expect(getCalls).toBeGreaterThan(getsBefore)

  await act(async () => {
    backLink()?.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/library')
  expect(librarySourceCell()).toBe('Custom')
  expect(problems).toEqual([])
})
