// A render smoke test: PromptEditorPage fetches the operator's saved (or
// default) instruction and puts it in the body editor a save button sits next
// to — the one thing worth pinning here is that the loaded body actually
// reaches the editor, since everything else (mutation wiring, invalidation) is
// the generated client's own contract, not this page's. The body is a
// `MarkdownField`, whose default (visual) mode is a CodeMirror editor rather
// than a textarea, so it is read from the `EditorView`'s own document — see
// tests/library-editor-markdown.test.tsx, which covers editing and saving.
// A fresh jotai store and a cleared localStorage per test keep the field's
// visual/raw mode from leaking in from another test or file.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'

const NAME = 'idea-to-prompt'
const GET_CLIENT = '@/shared/api/generated/clients/getApiSystemPromptsName'
const PUT_CLIENT = '@/shared/api/generated/clients/putApiSystemPromptsName'
const DELETE_CLIENT = '@/shared/api/generated/clients/deleteApiSystemPromptsName'

type PromptFixture = { name: string; body: string; path: string; source: 'file' | 'default' }

const DEFAULT_FIXTURE: PromptFixture = {
  name: NAME,
  body: 'The default fallback instruction, several sentences long.',
  path: '/opt/agentoo/library/prompts/idea-to-prompt.md',
  source: 'default',
}

let getResult: PromptFixture = DEFAULT_FIXTURE

// Registered through tests/mock-module.ts rather than `mock.module` directly
// — see that helper's own comment for why a bare `mock.module` here would
// leak these fakes into every file `bun test` loads afterwards.
await mockModule(GET_CLIENT, () => ({
  getApiSystemPromptsName: async () => ({ data: getResult }),
}))

let putCalls: { path: { name: string }; body: { body: string } }[] = []
await mockModule(PUT_CLIENT, () => ({
  putApiSystemPromptsName: async (opts: {
    path: { name: string }
    body: { body: string }
  }) => {
    putCalls.push(opts)
    return { data: { ...getResult, body: opts.body.body, source: 'file' as const } }
  },
}))

let deleteCalls: { path: { name: string } }[] = []
await mockModule(DELETE_CLIENT, () => ({
  deleteApiSystemPromptsName: async (opts: { path: { name: string } }) => {
    deleteCalls.push(opts)
    return { data: getResult }
  },
}))

// Dynamic, so the CSS-module loader above is registered before the barrel
// resolves.
const { PromptEditorPage } = await import('../src/features/library/components/prompt-editor-page')

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // A one-route router is enough for the page's back-to-library <Link> — same
  // idiom as tests/project-library-page.test.tsx's agent editor case.
  const rootRoute = createRootRoute({ component: () => <PromptEditorPage name={NAME} /> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  await act(async () => {
    root.render(
      <JotaiProvider store={createStore()}>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  // The query resolves over its own chain of microtasks; several real timer
  // ticks reliably outlasts it — same idiom as tests/storage-page.test.tsx's
  // own `mount()`.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  localStorage.clear()
}

/** The body editor's current document, read from CodeMirror itself. */
const editorDoc = () => {
  const el = container.querySelector('.cm-editor') as HTMLElement | null
  const view = el && EditorView.findFromDOM(el)
  if (!view) throw new Error('no CodeMirror view mounted')
  return view.state.doc.toString()
}

beforeEach(() => {
  localStorage.clear()
  getResult = DEFAULT_FIXTURE
  putCalls = []
  deleteCalls = []
})

afterEach(unmount)

test('renders the loaded body in the editor', async () => {
  await mount()
  expect(editorDoc()).toBe(getResult.body)
})

test('a saved custom instruction round-trips into the editor too', async () => {
  getResult = { ...getResult, body: 'Be terse. Always name the file you mean.', source: 'file' }
  await mount()
  expect(editorDoc()).toBe('Be terse. Always name the file you mean.')
})
