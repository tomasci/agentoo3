// The library's agent editor (Prompt) and skill editor (SKILL.md body), each
// mounted for an existing item with its generated clients mocked: the loaded
// markdown lands in `MarkdownField`'s CodeMirror editor (visual mode, the
// default), an edit there reaches the draft, and Save sends the edited
// markdown to the update mutation byte for byte — including text a
// rich-text round-trip would rewrite (intraword underscores, globs, literal
// HTML-looking tags, fenced code, blank lines, trailing spaces).
//
// Mounting follows tests/project-library-page.test.tsx: clients mocked through
// tests/mock-module.ts, a one-route TanStack router for the page's <Link> and
// useNavigate, and a private `cimode` i18n instance so `t()` returns the key.
// A fresh jotai store per test and a cleared localStorage keep the
// visual/raw mode from leaking in from another test or file.
//
// CodeMirror is driven per tests/markdown-editor.test.tsx's header:
// `view.dispatch(...)` inside `act`, never DOM input events.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { mockModule } from './mock-module'

// Markdown a rich-text editor would "helpfully" rewrite: `_` inside a word,
// a glob that looks like bold+italic, a literal tag, a fenced block holding
// markup, a list, a blank-line run and trailing double-space hard break.
// LF only — CodeMirror normalises CRLF, which is pinned elsewhere.
const TRICKY = [
  '# Role',
  '',
  'Call get_user_by_id before touching **/*.tsx files.',
  'Wrap the answer in a literal <answer> tag, not <b>bold</b>.',
  '',
  '```ts',
  'const re = /\\*\\*(.+?)\\*\\*/ // **not bold** in here',
  'type A = Array<string>',
  '```',
  '',
  '- [ ] snake_case_item',
  '- 2 * 3 * 4 = 24',
  '',
  '',
  'hard break here  ',
  'next line &amp; &lt;escaped&gt; \\_kept\\_',
].join('\n')

const EDITED = `${TRICKY}\n\n> appended in the editor: __init__.py and *.md`

// --- mocked clients -------------------------------------------------------------

const AGENT = {
  name: 'reviewer',
  role: 'subagent' as const,
  team: false,
  description: 'Reviews diffs',
  prompt: TRICKY,
  path: '/lib/agents/reviewer.md',
}
const SKILL = {
  name: 'testing',
  description: 'How tests run here',
  body: TRICKY,
  path: '/lib/skills/testing/SKILL.md',
  extraFiles: [] as string[],
}

type PutAgent = { path: { name: string }; body: Record<string, unknown> }
type PutSkill = { path: { name: string }; body: { description: string; body: string } }
let agentPuts: PutAgent[] = []
let skillPuts: PutSkill[] = []

await mockModule('@/shared/api/generated/clients/getApiLibraryAgentsName', () => ({
  getApiLibraryAgentsName: async () => ({ data: AGENT }),
}))
await mockModule('@/shared/api/generated/clients/putApiLibraryAgentsName', () => ({
  putApiLibraryAgentsName: async (opts: PutAgent) => {
    agentPuts.push({ path: opts.path, body: opts.body })
    return { data: { ...AGENT, ...opts.body } }
  },
}))
await mockModule('@/shared/api/generated/clients/getApiLibrarySkillsName', () => ({
  getApiLibrarySkillsName: async () => ({ data: SKILL }),
}))
await mockModule('@/shared/api/generated/clients/putApiLibrarySkillsName', () => ({
  putApiLibrarySkillsName: async (opts: PutSkill) => {
    skillPuts.push({ path: opts.path, body: opts.body })
    return { data: { ...SKILL, ...opts.body } }
  },
}))
// The agent editor waits on the models list before rendering the form.
await mockModule('@/shared/api/generated/clients/getApiSystemModels', () => ({
  getApiSystemModels: async () => ({ data: { models: [], source: 'live' } }),
}))
// Save's onSuccess invalidates the library lists; never let that refetch
// reach a real backend.
await mockModule('@/shared/api/generated/clients/getApiLibraryAgents', () => ({
  getApiLibraryAgents: async () => ({ data: [] }),
}))
await mockModule('@/shared/api/generated/clients/getApiLibrarySkills', () => ({
  getApiLibrarySkills: async () => ({ data: [] }),
}))

const { AgentEditorPage } = await import('../src/features/library/components/agent-editor-page')
const { SkillEditorPage } = await import('../src/features/library/components/skill-editor-page')
const { toast } = await import('../src/shared/components')

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

// --- mounting -------------------------------------------------------------------

let client: QueryClient
let container: HTMLDivElement
let root: Root | undefined

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function mountPage(page: () => ReactNode) {
  const rootRoute = createRootRoute({ component: page })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  const r = createRoot(container)
  root = r
  await act(async () => {
    r.render(
      <I18nextProvider i18n={cimode}>
        <JotaiProvider store={createStore()}>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await flush()
}

beforeEach(() => {
  localStorage.clear()
  agentPuts = []
  skillPuts = []
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
  toast.close()
  localStorage.clear()
})

const cmEditor = () => container.querySelector('.cm-editor') as HTMLElement | null
const view = () => {
  const el = cmEditor()
  const v = el && EditorView.findFromDOM(el)
  if (!v) throw new Error('no CodeMirror view mounted')
  return v
}
const doc = () => view().state.doc.toString()

async function replaceDoc(text: string) {
  await act(async () => {
    view().dispatch({
      changes: { from: 0, to: view().state.doc.length, insert: text },
      userEvent: 'input.type',
    })
  })
}

async function appendToDoc(text: string) {
  await act(async () => {
    const end = view().state.doc.length
    view().dispatch({
      changes: { from: end, insert: text },
      selection: { anchor: end + text.length },
      userEvent: 'input.type',
    })
  })
}

const saveButton = () => {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent === 'common.save')
  if (!b) throw new Error('no Save button')
  return b as HTMLButtonElement
}
const clickSave = async () => {
  await act(async () => {
    saveButton().click()
  })
  await flush()
}

// --- agent editor ---------------------------------------------------------------

describe('agent editor: Prompt field', () => {
  const page = () => <AgentEditorPage name="reviewer" />

  test('the loaded prompt shows in the CodeMirror editor, not a textarea', async () => {
    await mountPage(page)
    expect(cmEditor()).not.toBeNull()
    // The page has no other textarea (description is an <Input>), so none at all.
    expect(container.querySelector('textarea')).toBeNull()
    expect(doc() === TRICKY).toBe(true)
    const content = container.querySelector('.cm-content')
    expect(content?.getAttribute('aria-label')).toBe('library.agent.prompt')
    expect(content?.getAttribute('spellcheck')).toBe('false')
  })

  test('the field label and the subagent hint are still rendered', async () => {
    await mountPage(page)
    const label = container.querySelector('label[for="agent-prompt"]')
    expect(label?.textContent).toBe('library.agent.prompt')
    const hint = container.querySelector('label[for="agent-prompt"]')
      ?.closest('[data-slot="field"]')
      ?.querySelector('[data-slot="field-description"]')
    expect(hint?.textContent).toBe('library.agent.promptHint')
  })

  test('Save without editing sends the loaded prompt verbatim', async () => {
    await mountPage(page)
    await clickSave()
    expect(agentPuts.length).toBe(1)
    expect(agentPuts[0]?.path).toEqual({ name: 'reviewer' })
    expect(agentPuts[0]?.body.prompt === TRICKY).toBe(true)
  })

  test('after an edit in the editor, Save sends the edited prompt verbatim', async () => {
    await mountPage(page)
    await appendToDoc('\n\n> appended in the editor: __init__.py and *.md')
    expect(doc() === EDITED).toBe(true)
    await clickSave()
    expect(agentPuts.length).toBe(1)
    const sent = agentPuts[0]?.body.prompt
    // Compare as a value too, so a failure prints a readable diff.
    expect(sent).toBe(EDITED)
    expect(agentPuts[0]?.body).toMatchObject({ description: 'Reviews diffs', role: 'subagent' })
    // No rename was made, so none is sent.
    expect(agentPuts[0]?.body.name).toBeUndefined()
  })

  test('clearing the prompt in the editor disables Save (the page still sees the draft)', async () => {
    await mountPage(page)
    expect(saveButton().disabled).toBe(false)
    await replaceDoc('')
    expect(saveButton().disabled).toBe(true)
  })

  test('an edit made in raw mode is what Save sends', async () => {
    await mountPage(page)
    const toggle = container.querySelector<HTMLElement>('[aria-label="markdownField.source"]')
    await act(async () => {
      toggle?.click()
    })
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.id).toBe('agent-prompt')
    expect(ta.value === TRICKY).toBe(true)
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(ta, EDITED)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickSave()
    expect(agentPuts[0]?.body.prompt).toBe(EDITED)
  })
})

// --- skill editor ---------------------------------------------------------------

describe('skill editor: SKILL.md body field', () => {
  const page = () => <SkillEditorPage name="testing" />

  test('the loaded body shows in the CodeMirror editor, not a textarea', async () => {
    await mountPage(page)
    expect(cmEditor()).not.toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(doc() === TRICKY).toBe(true)
    const content = container.querySelector('.cm-content')
    expect(content?.getAttribute('aria-label')).toBe('library.skill.body')
    expect(content?.getAttribute('spellcheck')).toBe('false')
  })

  test('the field label and the body hint are still rendered', async () => {
    await mountPage(page)
    const label = container.querySelector('label[for="skill-body"]')
    expect(label?.textContent).toBe('library.skill.body')
    const hint = label
      ?.closest('[data-slot="field"]')
      ?.querySelector('[data-slot="field-description"]')
    expect(hint?.textContent).toBe('library.skill.bodyHint')
  })

  test('Save without editing sends the loaded body verbatim', async () => {
    await mountPage(page)
    await clickSave()
    expect(skillPuts.length).toBe(1)
    expect(skillPuts[0]?.path).toEqual({ name: 'testing' })
    expect(skillPuts[0]?.body.body === TRICKY).toBe(true)
  })

  test('after an edit in the editor, Save sends the edited body verbatim', async () => {
    await mountPage(page)
    await appendToDoc('\n\n> appended in the editor: __init__.py and *.md')
    await clickSave()
    expect(skillPuts.length).toBe(1)
    expect(skillPuts[0]?.body).toEqual({ description: 'How tests run here', body: EDITED })
  })

  test('a whole-document replacement through the editor is sent verbatim', async () => {
    await mountPage(page)
    const replaced = '```\n<tag attr="x">\n```\n\nonly get_user_by_id and **/*.tsx remain'
    await replaceDoc(replaced)
    await clickSave()
    expect(skillPuts[0]?.body.body).toBe(replaced)
  })

  test('clearing the body in the editor disables Save', async () => {
    await mountPage(page)
    expect(saveButton().disabled).toBe(false)
    await replaceDoc('')
    expect(saveButton().disabled).toBe(true)
  })
})
