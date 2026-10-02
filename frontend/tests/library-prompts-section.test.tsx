// The global Library page's third section, "System prompts", through the real
// route tree and shell at `/library`: its heading sits after Agents and
// Skills with no "New" button, one row per `KNOWN_PROMPTS` entry
// (`idea-to-prompt`, `session-learning`) links to the editor under /library,
// its Source cell reflects the GET's `source` (and falls back to "—" when
// that GET fails), and its actions menu offers Edit only. The fake GET below
// answers every name with the same fixture — fine here, since only
// `idea-to-prompt`'s own row (always first, `KNOWN_PROMPTS`' own order) is
// what these tests read from.
//
// Mounted the way tests/usage-route-verify.test.tsx mounts the shell (memory
// history, seeded query cache), with the prompt clients replaced through
// tests/mock-module.ts exactly as tests/prompt-editor-page.test.tsx does.
// Language is pinned to English (as tests/transcript-model-render.test.tsx
// does), because the labels themselves are part of what is being checked.
// The editor's body is a `MarkdownField`, visual (CodeMirror) by default, so
// the one test that lands there reads it from the `EditorView`.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const NAME = 'idea-to-prompt'
type PromptFixture = { name: string; body: string; path: string; source: 'file' | 'default' }

const fixture = (source: 'file' | 'default'): PromptFixture => ({
  name: NAME,
  body: source === 'file' ? 'My own saved instruction.' : 'The built-in default instruction.',
  path: '/opt/agentoo/library/prompts/idea-to-prompt.md',
  source,
})

/** What the fake GET answers with: a fixture, or `'fail'` to reject. */
let getAnswer: PromptFixture | 'fail' = fixture('default')
let getCalls: string[] = []

await mockModule('@/shared/api/generated/clients/getApiSystemPromptsName', () => ({
  getApiSystemPromptsName: async (opts: { path: { name: string } }) => {
    getCalls.push(opts.path.name)
    if (getAnswer === 'fail') throw new Error('500 from the fake backend')
    return { data: getAnswer }
  },
}))
// Not called by anything in this file — replaced only so nothing here can
// ever reach a real backend.
await mockModule('@/shared/api/generated/clients/putApiSystemPromptsName', () => ({
  putApiSystemPromptsName: async () => {
    throw new Error('PUT is not expected in library-prompts-section.test.tsx')
  },
}))
await mockModule('@/shared/api/generated/clients/deleteApiSystemPromptsName', () => ({
  deleteApiSystemPromptsName: async () => {
    throw new Error('DELETE is not expected in library-prompts-section.test.tsx')
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
  client.setQueryData([{ url: '/api/library/agents' }], [])
  client.setQueryData([{ url: '/api/library/skills' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
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
  getAnswer = fixture('default')
  getCalls = []
  problems.length = 0
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

const main = () => container.querySelector('main') ?? container
const headings = () => [...main().querySelectorAll('h2')].map((h) => h.textContent?.trim())
/** The section a heading opens: the nearest ancestor that also holds a table
 *  or the next section's content — PageHeader's own wrapper does not. */
const sectionOf = (title: string): HTMLElement => {
  const h = [...main().querySelectorAll('h2')].find((el) => el.textContent?.trim() === title)
  if (!h) throw new Error(`no h2 "${title}" among ${headings().join(', ')}`)
  let node: HTMLElement | null = h.parentElement
  while (node && !node.querySelector('table')) node = node.parentElement
  if (!node) throw new Error(`no table under the "${title}" section`)
  return node
}
const promptRows = () => [...sectionOf('System prompts').querySelectorAll('tbody tr')]
const sourceCellText = () => {
  const section = sectionOf('System prompts')
  const headers = [...section.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
  const col = headers.indexOf('Source')
  if (col < 0) throw new Error(`no Source column among ${headers.join(', ')}`)
  return promptRows()[0]?.querySelectorAll('td, th')[col]?.textContent?.trim()
}

test('the System prompts section comes after Agents and Skills and has no New button', async () => {
  await mount('/library')
  expect(router.state.location.pathname).toBe('/library')
  expect(headings()).toEqual(['Agents', 'Skills', 'System prompts'])

  const section = sectionOf('System prompts')
  // The section wraps only its own table: the Agents/Skills tables are not in it.
  expect(section.querySelectorAll('table')).toHaveLength(1)
  const buttons = [...section.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')
  expect(buttons.filter((label) => /new/i.test(label))).toEqual([])
  expect(section.querySelector('a[href$="/new"]')).toBeNull()
  // The other two sections do keep theirs, so the check above is not vacuous.
  expect(sectionOf('Agents').querySelector('a[href="/library/agents/new"]')).not.toBeNull()
  expect(problems).toEqual([])
})

test('one row per known prompt, the first linking the title to /library/prompts/idea-to-prompt', async () => {
  await mount('/library')
  const rows = promptRows()
  expect(rows).toHaveLength(2)
  const link = rows[0]?.querySelector('a') as HTMLAnchorElement | null
  expect(link?.textContent?.trim()).toBe('Idea → prompt instruction')
  expect(link?.getAttribute('href')).toBe('/library/prompts/idea-to-prompt')
  expect(rows[0]?.textContent).toContain(
    "Turns an idea's canvas into a single development prompt for an orchestrator session.",
  )
  // The second known prompt, added for session learning — same table, its own row.
  const link2 = rows[1]?.querySelector('a') as HTMLAnchorElement | null
  expect(link2?.getAttribute('href')).toBe('/library/prompts/session-learning')
  expect(link2?.textContent?.trim()).toBe('Session learning instruction')
  expect(getCalls).toEqual([NAME, 'session-learning'])
})

test('Source reads "Built-in default" when the GET says source: default', async () => {
  getAnswer = fixture('default')
  await mount('/library')
  expect(sourceCellText()).toBe('Built-in default')
})

test('Source reads "Custom" when the GET says source: file', async () => {
  getAnswer = fixture('file')
  await mount('/library')
  expect(sourceCellText()).toBe('Custom')
})

test('Source reads "—" when the GET fails, and the rest of the row still renders', async () => {
  getAnswer = 'fail'
  await mount('/library')
  expect(getCalls).toEqual([NAME, 'session-learning'])
  expect(sourceCellText()).toBe('—')
  expect(promptRows()[0]?.querySelector('a')?.getAttribute('href')).toBe(
    '/library/prompts/idea-to-prompt',
  )
})

test('the row actions menu offers only Edit, and Edit navigates to the editor', async () => {
  await mount('/library')
  const trigger = promptRows()[0]?.querySelector('button[aria-haspopup="menu"]') as HTMLElement | null
  if (!trigger) throw new Error('no actions menu trigger in the prompt row')
  await act(async () => {
    trigger.click()
  })
  await settle()
  const items = [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')] as HTMLElement[]
  expect(items.map((el) => el.textContent?.trim())).toEqual(['Edit'])

  await act(async () => {
    items[0]?.click()
  })
  await settle()
  expect(router.state.location.pathname).toBe('/library/prompts/idea-to-prompt')
  const cm = container.querySelector('.cm-editor') as HTMLElement | null
  expect(cm && EditorView.findFromDOM(cm)?.state.doc.toString()).toBe(
    'The built-in default instruction.',
  )
  expect(problems).toEqual([])
})
