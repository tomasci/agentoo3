// The project "Agents & skills" page: which library agents and skills a
// project uses, one checkbox row each, with a left-aligned Save underneath.
//
// The regression this file exists for: the shadcn redesign rendered each
// row's <Checkbox> *after* its <FieldContent>, which in a horizontal Field
// puts the box on the far right of the row — away from the left-aligned Save
// button it is used together with (worst on a phone). The guard is on DOM
// order inside each `[data-slot="field"]` rather than on computed layout:
// happy-dom does no layout, and the Field is a plain flex row, so source order
// is what decides the side.
//
// The same order is pinned for the agent editor's "restrict tools" checkbox
// and its per-tool checkboxes, which got the same fix.
//
// Rendered inside a private `cimode` `I18nextProvider` (never
// `.use(initReactI18next)`) for the reasons spelled out in the header of
// tests/settings-page.test.tsx: every text match below relies on `t()`
// returning the raw key, and the app's global i18next singleton is shared
// process-wide with every other test file.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { mockModule } from './mock-module'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

const agent = (name: string, role: 'orchestrator' | 'subagent') => ({
  name,
  role,
  team: role === 'orchestrator',
  description: `${name} description`,
  path: `/lib/agents/${name}.md`,
  promptLines: 3,
  usedByProjects: 0,
})
const skill = (name: string) => ({
  name,
  description: `${name} description`,
  body: '',
  path: `/lib/skills/${name}/SKILL.md`,
  extraFiles: [],
  usedByProjects: 0,
})

// One assigned and one unassigned of each kind, so both checked states are
// exercised in both lists.
const AGENTS = [agent('alpha', 'orchestrator'), agent('beta', 'subagent')]
const SKILLS = [skill('gamma'), skill('delta')]
const ASSIGNED = { agents: ['alpha'], skills: ['gamma'] }

let putCalls: { path: { id: string }; body: { agents: string[]; skills: string[] } }[] = []

// Through tests/mock-module.ts, not a bare `mock.module`, so these fakes do
// not leak into every file `bun test` loads after this one.
await mockModule('@/shared/api/generated/clients/getApiLibraryAgents', () => ({
  getApiLibraryAgents: async () => ({ data: AGENTS }),
}))
await mockModule('@/shared/api/generated/clients/getApiLibrarySkills', () => ({
  getApiLibrarySkills: async () => ({ data: SKILLS }),
}))
await mockModule('@/shared/api/generated/clients/getApiProjectsIdLibrary', () => ({
  getApiProjectsIdLibrary: async () => ({ data: ASSIGNED }),
}))
await mockModule('@/shared/api/generated/clients/putApiProjectsIdLibrary', () => ({
  putApiProjectsIdLibrary: async (opts: {
    path: { id: string }
    body: { agents: string[]; skills: string[] }
  }) => {
    putCalls.push({ path: opts.path, body: opts.body })
    return { data: opts.body }
  },
}))

// Only the agent editor asks for this; mocked rather than seeded so no render
// ever reaches for a real backend.
await mockModule('@/shared/api/generated/clients/getApiSystemModels', () => ({
  getApiSystemModels: async () => ({ data: { models: [], source: 'live' } }),
}))

const { ProjectLibraryPage } = await import(
  '../src/features/library/components/project-library-page'
)
const { AgentEditorPage } = await import('../src/features/library/components/agent-editor-page')
const { toast } = await import('../src/shared/components')

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

let client: QueryClient
let container: HTMLDivElement
let root: Root | undefined

async function flush() {
  // Several queries each resolve over their own microtask chain; a few real
  // timer ticks outlast all of them (same idiom as tests/storage-page.test.tsx).
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function render(node: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  const r = createRoot(container)
  root = r
  await act(async () => {
    r.render(
      <I18nextProvider i18n={testI18n}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </I18nextProvider>,
    )
  })
  await flush()
}

const mountLibrary = () => render(<ProjectLibraryPage projectId={PROJECT_ID} />)

beforeEach(() => {
  putCalls = []
})

afterEach(async () => {
  const r = root
  if (r) {
    await act(async () => {
      r.unmount()
    })
  }
  root = undefined
  container?.remove()
  client?.clear()
  // Module-level singleton; a "saved" toast must not outlive its test.
  toast.close()
})

const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** The Field row that holds the checkbox with this id. */
function fieldFor(id: string): HTMLElement {
  const label = container.querySelector(`label[for="${id}"]`)
  const field = label?.closest('[data-slot="field"]') as HTMLElement | null
  if (!field) throw new Error(`no field row for ${id}`)
  return field
}
function checkboxIn(field: HTMLElement): HTMLElement {
  const box = field.querySelector('[role="checkbox"]') as HTMLElement | null
  if (!box) throw new Error('no role="checkbox" in field')
  return box
}
function labelIn(field: HTMLElement): HTMLLabelElement {
  const label = field.querySelector('label')
  if (!label) throw new Error('no label in field')
  return label
}
const isChecked = (id: string) => checkboxIn(fieldFor(id)).getAttribute('aria-checked')
const saveButton = () => {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent === 'common.save')
  if (!b) throw new Error('no Save button')
  return b
}

const ROW_IDS = [
  'assign-agent-alpha',
  'assign-agent-beta',
  'assign-skill-gamma',
  'assign-skill-delta',
]

/** Asserts the checkbox leads its row: first element child of the Field, and
 *  before the label in document order. Returns nothing; each expect names the
 *  row so a failure says which one. */
function expectCheckboxFirst(field: HTMLElement, id: string) {
  const box = checkboxIn(field)
  const label = labelIn(field)
  expect({ id, firstIsCheckbox: field.firstElementChild === box }).toEqual({
    id,
    firstIsCheckbox: true,
  })
  expect({
    id,
    labelFollowsCheckbox: Boolean(
      box.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  }).toEqual({ id, labelFollowsCheckbox: true })
}

test('every agent and skill row renders its checkbox before its label', async () => {
  await mountLibrary()
  const fields = [...container.querySelectorAll('[data-slot="field"]')] as HTMLElement[]
  // One row per fixture, so the loop below cannot pass by finding nothing.
  expect(fields.length).toBe(AGENTS.length + SKILLS.length)
  for (const id of ROW_IDS) expectCheckboxFirst(fieldFor(id), id)
})

test('checkboxes start out reflecting what the project already uses', async () => {
  await mountLibrary()
  expect(ROW_IDS.map((id) => [id, isChecked(id)])).toEqual([
    ['assign-agent-alpha', 'true'],
    ['assign-agent-beta', 'false'],
    ['assign-skill-gamma', 'true'],
    ['assign-skill-delta', 'false'],
  ])
})

test('Save starts disabled when nothing has changed', async () => {
  await mountLibrary()
  expect(saveButton().disabled).toBe(true)
})

test('clicking an unchecked checkbox checks it and enables Save', async () => {
  await mountLibrary()
  await click(checkboxIn(fieldFor('assign-agent-beta')))
  expect(isChecked('assign-agent-beta')).toBe('true')
  expect(saveButton().disabled).toBe(false)
})

test("clicking an unchecked row's label checks it and enables Save", async () => {
  await mountLibrary()
  await click(labelIn(fieldFor('assign-skill-delta')))
  expect(isChecked('assign-skill-delta')).toBe('true')
  expect(saveButton().disabled).toBe(false)
})

test('toggling a row back to its saved state disables Save again', async () => {
  await mountLibrary()
  const box = checkboxIn(fieldFor('assign-agent-alpha'))
  await click(box)
  expect(isChecked('assign-agent-alpha')).toBe('false')
  expect(saveButton().disabled).toBe(false)
  await click(box)
  expect(isChecked('assign-agent-alpha')).toBe('true')
  expect(saveButton().disabled).toBe(true)
})

test('Save sends the full new selection for this project', async () => {
  await mountLibrary()
  await click(checkboxIn(fieldFor('assign-agent-beta')))
  await click(checkboxIn(fieldFor('assign-skill-gamma')))
  await click(saveButton())
  await flush()
  expect(putCalls).toEqual([
    { path: { id: PROJECT_ID }, body: { agents: ['alpha', 'beta'], skills: [] } },
  ])
})

// --- agent editor -------------------------------------------------------------

test('agent editor: restrict-tools and per-tool checkboxes render before their labels', async () => {
  // A one-route router is enough for the page's <Link> and useNavigate; the
  // real route tree would also need the whole shell's data seeded.
  const rootRoute = createRootRoute({ component: () => <AgentEditorPage /> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  await render(<RouterProvider router={router} />)

  const restrict = fieldFor('agent-restrict-tools')
  expectCheckboxFirst(restrict, 'agent-restrict-tools')

  // The per-tool rows only exist once restriction is on.
  await click(checkboxIn(restrict))
  const toolLabels = [...container.querySelectorAll('label[for^="agent-tool-"]')]
  expect(toolLabels.length).toBeGreaterThan(0)
  for (const label of toolLabels) {
    const id = label.getAttribute('for') as string
    expectCheckboxFirst(fieldFor(id), id)
  }
})
