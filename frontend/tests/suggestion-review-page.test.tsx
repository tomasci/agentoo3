// The suggestion review page (`/library/suggestions/$id`): a `modify`
// suggestion shows removed/added diff lines, Apply sends the detail's own
// `currentHash` as `expectedCurrentHash`, a 409 from Apply shows the server's
// message, and a `create` suggestion shows the structured preview instead of
// a diff.
//
// Mounted the same way tests/suggested-page.test.tsx mounts its own route.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const MODIFY_BEFORE = ['# Role', '', 'You review pull requests.', 'Be terse.'].join('\n')
const MODIFY_AFTER = ['# Role', '', 'You review pull requests for defects.', 'Be terse.'].join('\n')

const modifyDetail = (overrides: Record<string, unknown> = {}) => ({
  id: 'sug-1',
  runId: 'run-1',
  kind: 'agent',
  action: 'modify',
  name: 'reviewer',
  title: 'Tighten the review checklist',
  rationale: 'Recent sessions show the reviewer missing some defect classes.',
  status: 'pending',
  createdAt: '2026-09-20T04:00:00.000Z',
  decidedAt: null,
  appliedVersion: null,
  sourceSessions: [],
  targetExists: true,
  stale: false,
  proposed: { description: 'Reviews PRs', role: 'subagent', prompt: MODIFY_AFTER },
  proposedMarkdown: `---\nrole: subagent\n---\n${MODIFY_AFTER}`,
  baseMarkdown: `---\nrole: subagent\n---\n${MODIFY_BEFORE}`,
  currentMarkdown: MODIFY_BEFORE,
  currentHash: 'hash-abc123',
  ...overrides,
})

const createDetail = (overrides: Record<string, unknown> = {}) => ({
  id: 'sug-2',
  runId: 'run-1',
  kind: 'skill',
  action: 'create',
  name: 'release-notes',
  title: 'A release-notes skill',
  rationale: 'Several sessions hand-wrote release notes the same way.',
  status: 'pending',
  createdAt: '2026-09-20T04:00:00.000Z',
  decidedAt: null,
  appliedVersion: null,
  sourceSessions: [],
  targetExists: false,
  stale: false,
  proposed: { description: 'Writes release notes from recent commits', body: 'Summarize commits since the last tag.' },
  proposedMarkdown: '---\ndescription: Writes release notes from recent commits\n---\nSummarize commits since the last tag.',
  baseMarkdown: null,
  currentMarkdown: null,
  currentHash: null,
  ...overrides,
})

let detail: ReturnType<typeof modifyDetail> | ReturnType<typeof createDetail> = modifyDetail()
let applyCalls: { path: { id: string }; body: { expectedCurrentHash: string | null } }[] = []
/** When set, Apply rejects with it. */
let applyFailure: unknown = null
/** How many times the detail GET actually ran — the review page's own
 *  `useSuggestion(id)` fires it once on mount; a second call right after
 *  Apply/Reject would mean the fix for the "API error: canceled" warning
 *  (use-learning.ts's `refetchType: 'none'`) regressed, since that second
 *  fetch is the one the navigation that follows goes on to cancel. */
let detailFetchCount = 0

await mockModule('@/shared/api/generated/clients/getApiLibrarySuggestionsId', () => ({
  getApiLibrarySuggestionsId: async () => {
    detailFetchCount++
    return { data: detail }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdApply', () => ({
  postApiLibrarySuggestionsIdApply: async (opts: {
    path: { id: string }
    body: { expectedCurrentHash: string | null }
  }) => {
    applyCalls.push(opts)
    if (applyFailure) throw applyFailure
    return { data: { ...detail, status: 'applied', appliedVersion: 2 } }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdReject', () => ({
  postApiLibrarySuggestionsIdReject: async () => {
    throw new Error('reject is not expected in suggestion-review-page.test.tsx')
  },
}))
await mockModule('@/shared/api/generated/clients/deleteApiLibrarySuggestionsId', () => ({
  deleteApiLibrarySuggestionsId: async () => {
    throw new Error('delete is not expected in suggestion-review-page.test.tsx')
  },
}))

const { routeTree } = await import('../src/app/router')
const { Toaster, toast } = await import('../src/shared/ui/toast')

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() }
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    { status, statusText: '', data, headers: {}, config },
  )
}

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

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount(id = 'sug-1') {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/library/suggestions/${id}`] }),
  })
  await router.load()
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
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={english}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <Toaster />
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  detail = modifyDetail()
  applyCalls = []
  applyFailure = null
  detailFetchCount = 0
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  toast.close()
  document.body.innerHTML = ''
})

const main = () => container.querySelector('main') ?? container
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const button = (label: string): HTMLButtonElement => {
  const found = [...main().querySelectorAll('button')].find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button among ${[...main().querySelectorAll('button')].map(text).join(', ')}`)
  return found as HTMLButtonElement
}
const dialogButton = (label: string): HTMLButtonElement => {
  const dialog = document.body.querySelector('[role="alertdialog"]')
  const found = dialog && [...dialog.querySelectorAll('button')].find((el) => text(el) === label)
  if (!found) throw new Error(`no open dialog button "${label}"`)
  return found as HTMLButtonElement
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))

test('a modify suggestion shows removed and added lines', async () => {
  detail = modifyDetail()
  await mount()

  const removed = [...main().querySelectorAll('div')].find(
    (el) => el.textContent?.includes('You review pull requests.') && el.className.includes('bg-destructive/10'),
  )
  const added = [...main().querySelectorAll('div')].find(
    (el) =>
      el.textContent?.includes('You review pull requests for defects.') &&
      el.className.includes('bg-primary/10'),
  )
  expect(removed).toBeDefined()
  expect(added).toBeDefined()
  // Context survives untouched, unmarked.
  expect(text(main())).toContain('Be terse.')
  expect(problems).toEqual([])
})

test('Apply sends the detail’s own currentHash as expectedCurrentHash', async () => {
  detail = modifyDetail({ currentHash: 'hash-xyz789' })
  await mount()

  await click(button('Apply'))
  await click(dialogButton('Apply'))

  expect(applyCalls).toHaveLength(1)
  expect(applyCalls[0]?.path).toEqual({ id: 'sug-1' })
  expect(applyCalls[0]?.body).toEqual({ expectedCurrentHash: 'hash-xyz789' })
  expect(toastTitles()).toContain('Applied')
})

test('a 409 from Apply shows the server message and the dialog closes', async () => {
  applyFailure = httpError(409, { error: 'The file changed since this suggestion was made.' })
  await mount()

  await click(button('Apply'))
  await click(dialogButton('Apply'))

  expect(applyCalls).toHaveLength(1)
  expect(text(main())).toContain('The file changed since this suggestion was made.')
  expect(toastTitles()).not.toContain('Applied')
  expect(problems).toEqual([])
})

test('Apply is disabled when the modify target no longer exists', async () => {
  detail = modifyDetail({ currentMarkdown: null, currentHash: null, targetExists: false })
  await mount()
  expect(button('Apply').disabled).toBe(true)
  expect(text(main())).toContain('This suggestion modifies an item that no longer exists')
})

test('a create suggestion shows the structured preview, not a diff', async () => {
  detail = createDetail()
  await mount('sug-2')

  expect(text(main())).toContain('Writes release notes from recent commits')
  expect(text(main())).toContain('Summarize commits since the last tag.')
  // No diff gutter markers from SuggestionDiff.
  expect(main().querySelector('.font-mono')).toBeNull()
})

test('a create suggestion’s Apply confirms adding the new item to the library', async () => {
  detail = createDetail()
  await mount('sug-2')

  await click(button('Apply'))
  expect(text(document.body.querySelector('[role="alertdialog"]'))).toContain(
    // Lowercase mid-sentence ("the new skill"), not the capitalized badge
    // form ("Skill") — this is running text, not a standalone label.
    'adds the new skill "release-notes" to the library',
  )
})

test('a pending stale modify suggestion shows the stale banner', async () => {
  detail = modifyDetail({ stale: true })
  await mount()
  expect(text(main())).toContain('This item changed after the suggestion was made')
})

test('an applied modify suggestion never shows the stale banner, even if stale is (wrongly) still true', async () => {
  // The backend is only meant to report `stale: true` for a pending modify —
  // this pins the UI's own guard in case that ever slips (see use-learning's
  // own comment), rather than trusting the server never to send it.
  detail = modifyDetail({
    status: 'applied',
    stale: true,
    appliedVersion: 2,
    decidedAt: '2026-09-21T04:00:00.000Z',
  })
  await mount()
  expect(text(main())).not.toContain('This item changed after the suggestion was made')
})

test('a rejected modify suggestion never shows the stale banner', async () => {
  detail = modifyDetail({ status: 'rejected', stale: true, decidedAt: '2026-09-21T04:00:00.000Z' })
  await mount()
  expect(text(main())).not.toContain('This item changed after the suggestion was made')
})

test('an applied modify suggestion compares the pre-apply version to what was applied, honestly captioned', async () => {
  detail = modifyDetail({
    status: 'applied',
    appliedVersion: 2,
    decidedAt: '2026-09-21T04:00:00.000Z',
  })
  await mount()
  expect(text(main())).toContain(
    "Comparing the version this replaced to what was applied — not the item's current content.",
  )
  // Still a real diff, from baseMarkdown to proposedMarkdown.
  expect(main().querySelector('.font-mono')).not.toBeNull()
  expect(text(main())).not.toContain('applying replaces it')
})

test('a rejected modify suggestion compares what was proposed, with no apply-related wording', async () => {
  detail = modifyDetail({ status: 'rejected', decidedAt: '2026-09-21T04:00:00.000Z' })
  await mount()
  expect(text(main())).toContain('Comparing the version this was based on to what it proposed.')
  expect(text(main())).not.toContain('applying replaces it')
  expect(text(main())).not.toContain('Apply')
})

test('a pending create suggestion whose name is now taken disables Apply and warns', async () => {
  detail = createDetail({ targetExists: true })
  await mount('sug-2')
  expect(button('Apply').disabled).toBe(true)
  // Lowercase mid-sentence ("this skill"), for the same reason as the Apply
  // confirmation above.
  expect(text(main())).toContain(
    'A library item named "release-notes" already exists, so this skill can\'t be created',
  )
})

test('a long unchanged run is collapsed behind the correct plural count', async () => {
  // 89 identical lines after one changed line folds to a hidden run of
  // 89 - 2*CONTEXT_RADIUS(3) = 83 — the same number the bug report's "Show
  // 83 unchanged line" came from.
  const context = Array.from({ length: 89 }, (_, i) => `line ${i}`)
  const before = ['OLD', ...context].join('\n')
  const after = ['NEW', ...context].join('\n')
  detail = modifyDetail({
    baseMarkdown: `---\nrole: subagent\n---\n${before}`,
    currentMarkdown: before,
    proposedMarkdown: `---\nrole: subagent\n---\n${after}`,
  })
  await mount()

  const collapseButton = [...main().querySelectorAll('button')].find((b) =>
    text(b).includes('unchanged'),
  )
  expect(collapseButton && text(collapseButton)).toBe('Show 83 unchanged lines')
})

test('Apply does not start a redundant refetch of the detail query it is about to navigate away from', async () => {
  detail = modifyDetail()
  await mount()
  expect(detailFetchCount).toBe(1)

  await click(button('Apply'))
  await click(dialogButton('Apply'))

  // Apply's own onSuccess invalidates this same detail query (so a reader
  // who lands back on this id later gets a fresh fetch) — it must do that
  // without actively refetching it here, since the page is about to unmount
  // on the navigate() right below it in the same callback.
  expect(detailFetchCount).toBe(1)
})
