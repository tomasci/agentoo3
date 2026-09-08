// A render smoke test: PromptEditorPage fetches the operator's saved (or
// default) instruction and puts it in the textarea a save button sits next
// to — the one thing worth pinning here is that the loaded body actually
// reaches the DOM, since everything else (mutation wiring, invalidation) is
// the generated client's own contract, not this page's.

import { plugin } from 'bun'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx and
// tests/storage-page.test.tsx: this page pulls in the whole `@/shared/ui`
// barrel (PageHeader, Badge, Alert among them), which means importing it here
// also loads the ten `.module.scss` files ui-core.test.tsx owns. `bun test`
// does not evaluate files in a documented order, so whichever file runs first
// decides how those modules are cached for the whole run — registering the
// identical loader here makes the outcome the same either way. (Keep the
// allowlist in step with the one in tests/ui-core.test.tsx.)
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'prompt-editor-page-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
const { PromptEditorPage } = await import('../src/features/system/components/prompt-editor-page')

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PromptEditorPage name={NAME} />
      </QueryClientProvider>,
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
}

beforeEach(() => {
  getResult = DEFAULT_FIXTURE
  putCalls = []
  deleteCalls = []
})

afterEach(unmount)

test('renders the loaded body in the textarea', async () => {
  await mount()
  const textarea = container.querySelector('textarea')
  expect(textarea).not.toBeNull()
  expect(textarea?.value).toBe(getResult.body)
})

test('a saved custom instruction round-trips into the textarea too', async () => {
  getResult = { ...getResult, body: 'Be terse. Always name the file you mean.', source: 'file' }
  await mount()
  const textarea = container.querySelector('textarea')
  expect(textarea?.value).toBe('Be terse. Always name the file you mean.')
})
