// Renaming a session in place from its own page: `SessionTitle`
// (features/sessions/components/session-title.tsx) inside SessionPage's
// header, beside the status badge.
//
//   - the `<h1>` holds a button showing the title (the "Session <id8>"
//     fallback for an untitled one); clicking it swaps in an input holding the
//     *raw* title (empty when untitled), focused and fully selected;
//   - Enter saves, blur saves, Escape cancels with no request. Enter followed
//     by the blur it causes (the input is disabled while pending) is ONE
//     request; so is a double Enter;
//   - an empty, whitespace-only or unchanged (after trimming) value leaves
//     edit mode without a request; anything else is sent trimmed;
//   - on success the heading shows the new title straight from the PATCH
//     response (the detail GET here keeps answering the old title and is
//     never refetched); on failure an error toast (the API message, fallback
//     "Could not rename the session") and the input stays, enabled, with the
//     typed value, so Enter retries;
//   - every session status can rename, `running` included;
//   - switching the page to another session while editing does not carry the
//     edit over.
//
// Rendered the way tests/session-page-header.test.tsx renders SessionPage —
// real hooks and query client, generated clients mocked per-file through
// ./mock-module, a minimal memory router, the real `<Toaster />` read back
// off `document.body` — but under a private i18n instance holding the real
// English bundle, so the copy asserted is the copy shipped.
//
// happy-dom does not blur an element when it becomes disabled (verified: a
// focused input stays `document.activeElement` after `disabled = true`), and
// its `blur()` on a disabled input fires nothing at all. A browser does blur
// it, so for a disabled input `blurInput` dispatches the `blur`/`focusout`
// pair itself — the events a real browser would deliver, and the ones
// React's `onBlur` listens to.
//
// Assertions compare primitives, never DOM nodes: bun pretty-printing a
// happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import en from '../src/shared/i18n/locales/en.json'
import { composerModeAtom } from '../src/shared/store/ui'
import { mockModule } from './mock-module'

// Never `.use(initReactI18next)` — see tests/session-page-scroll.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const T = '2026-09-04T10:00:00.000Z'

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
  automationId: null,
  title: 'A session',
  status: 'idle',
  orchestrator: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/alpha',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
  lastMessageAt: null,
  settledAt: null,
  seenAt: null,
  unchecked: false,
  ...overrides,
})

const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
const PATCH_CLIENT = '@/shared/api/generated/clients/patchApiSessionsId'

type PatchCall = { path: { id: string }; body: Record<string, unknown> }

/** What the detail GET answers, per session id. Never updated by a PATCH. */
let byId: Record<string, SessionDto> = {}
let getCalls = 0
let patchCalls: PatchCall[] = []
let patchFailure: unknown = null
let patchGate: Promise<void> | null = null

await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => {
    getCalls++
    return { data: byId[opts.path.id] ?? session({ id: opts.path.id }) }
  },
}))
await mockModule(MESSAGES_CLIENT, () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule(FILES_CLIENT, () => ({
  getApiSessionsIdFiles: async () => ({
    data: { files: [], usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 0 } },
  }),
}))
await mockModule(PATCH_CLIENT, () => ({
  patchApiSessionsId: async (opts: PatchCall) => {
    patchCalls.push({ path: { ...opts.path }, body: { ...opts.body } })
    const failure = patchFailure
    if (patchGate) await patchGate
    if (failure) throw failure
    const base = byId[opts.path.id] ?? session({ id: opts.path.id })
    return { data: { ...base, title: opts.body.title as string } }
  },
}))

/** happy-dom ships no EventSource — see tests/session-page-scroll.test.tsx. */
class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { SessionPage } = await import('../src/features/sessions/components/session-page')
const { Toaster, toast } = await import('../src/shared/ui/toast')
const { getApiSessionsIdQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiSessionsId'
)

let container: HTMLDivElement
let client: QueryClient
let root: Root
let store: ReturnType<typeof createStore>
/** Switches the mounted page to another session without remounting it, the
 *  way the router does on a session-to-session navigation. */
let showSession: (id: string) => void = () => {}
/** The session id the page mounts on. */
let initialId = 's1'

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

function Page() {
  const [id, setId] = useState(initialId)
  showSession = setId
  return <SessionPage projectId="p1" sessionId={id} />
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const rootRoute = createRootRoute({ component: Page })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <Toaster />
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  if (!titleButton()) throw new Error('session page never rendered its title button')
}

beforeEach(() => {
  byId = { s1: session() }
  initialId = 's1'
  getCalls = 0
  patchCalls = []
  patchFailure = null
  patchGate = null
  store = createStore()
  localStorage.clear()
  store.set(composerModeAtom, 'raw')
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  toast.close()
  document.body.replaceChildren()
})

// --- helpers ---------------------------------------------------------------

const heading = () => {
  const found = [...container.querySelectorAll('header h1')]
  if (found.length !== 1) throw new Error(`expected one header h1, got ${found.length}`)
  return found[0] as HTMLHeadingElement
}
const headingText = () => heading().textContent?.trim() ?? ''
const titleButton = () => heading().querySelector('button') as HTMLButtonElement | null
const titleInput = () => heading().querySelector('input') as HTMLInputElement | null
const editing = () => titleInput() !== null

const requireInput = () => {
  const input = titleInput()
  if (!input) throw new Error('not in edit mode')
  return input
}

async function startEditing() {
  const button = titleButton()
  if (!button) throw new Error('no title button')
  await act(async () => {
    button.click()
  })
  await settle(3)
  return requireInput()
}

const type = async (value: string) => {
  const el = requireInput()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(2)
}

const keyDown = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

async function press(key: string) {
  const el = requireInput()
  await act(async () => {
    keyDown(el, key)
  })
  await settle()
}

async function blurInput() {
  const el = requireInput()
  await act(async () => {
    if (el.disabled) {
      el.dispatchEvent(new FocusEvent('blur'))
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    } else {
      el.blur()
    }
  })
  await settle()
}

const gate = () => {
  let release: () => void = () => {}
  patchGate = new Promise<void>((r) => {
    release = r
  })
  return async () => {
    await act(async () => {
      release()
    })
    await settle()
  }
}

const bodyText = () => document.body.textContent ?? ''
const occurrences = (needle: string) => bodyText().split(needle).length - 1
const cachedTitle = (id = 's1') =>
  (client.getQueryData(getApiSessionsIdQueryKey({ path: { id } })) as SessionDto | undefined)?.title

// --- at rest -------------------------------------------------------------------

test('the heading is one <h1> holding a button with the title, and no input', async () => {
  byId = { s1: session({ title: 'Fix login' }) }
  await mount()
  expect(headingText()).toBe('Fix login')
  expect(titleButton()?.getAttribute('type')).toBe('button')
  expect(titleButton()?.textContent?.trim()).toBe('Fix login')
  expect(editing()).toBe(false)
})

const UUID = '1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890'

test('an untitled session shows "Session <first 8 chars of id>" on the button', async () => {
  initialId = UUID
  byId = { [UUID]: session({ id: UUID, title: null }) }
  await mount()
  expect(headingText()).toBe('Session 1a2b3c4d')
})

// --- entering edit mode ------------------------------------------------------

test('clicking the title swaps in an input holding the raw title, focused and fully selected', async () => {
  byId = { s1: session({ title: 'Fix login' }) }
  await mount()
  const input = await startEditing()
  expect(input.value).toBe('Fix login')
  expect(document.activeElement === input).toBe(true)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Fix login'.length])
  expect(input.getAttribute('aria-label')).toBe('Title')
  expect(input.getAttribute('maxlength')).toBe('200')
  expect(input.disabled).toBe(false)
  // Still inside the one heading.
  expect(titleButton()).toBeNull()
  expect(patchCalls).toEqual([])
})

test("an untitled session's input starts empty, with the fallback only as its placeholder", async () => {
  initialId = UUID
  byId = { [UUID]: session({ id: UUID, title: null }) }
  await mount()
  const input = await startEditing()
  expect(input.value).toBe('')
  expect(input.getAttribute('placeholder')).toBe('Session 1a2b3c4d')
  // Leaving it untouched renames nothing — neither Enter nor blur.
  await press('Enter')
  expect(patchCalls).toEqual([])
  expect(editing()).toBe(false)
  expect(headingText()).toBe('Session 1a2b3c4d')
  await startEditing()
  await blurInput()
  expect(patchCalls).toEqual([])
})

test('an untitled session can be given a title in place', async () => {
  initialId = UUID
  byId = { [UUID]: session({ id: UUID, title: null }) }
  await mount()
  await startEditing()
  await type('First title')
  await press('Enter')
  expect(patchCalls).toEqual([{ path: { id: UUID }, body: { title: 'First title' } }])
  expect(headingText()).toBe('First title')
})

// --- saving ----------------------------------------------------------------------

test('Enter sends one PATCH with the trimmed value and the heading shows it from the response', async () => {
  byId = { s1: session({ title: 'Old name' }) }
  await mount()
  const getsBefore = getCalls
  await startEditing()
  await type('  New name  ')
  await press('Enter')
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'New name' } }])
  expect(editing()).toBe(false)
  expect(headingText()).toBe('New name')
  expect(cachedTitle()).toBe('New name')
  // Not a refetch: the GET still answers "Old name" and was not asked again.
  expect(getCalls).toBe(getsBefore)
})

test('Enter followed by the blur it causes is exactly one request', async () => {
  const release = gate()
  await mount()
  await startEditing()
  await type('Once')
  await press('Enter')
  expect(requireInput().disabled).toBe(true)
  // What a browser does to an input that just became disabled.
  await blurInput()
  expect(patchCalls.length).toBe(1)
  await release()
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'Once' } }])
  expect(headingText()).toBe('Once')
})

test('a double Enter in the same tick is exactly one request', async () => {
  await mount()
  await startEditing()
  await type('Twice pressed')
  const el = requireInput()
  await act(async () => {
    keyDown(el, 'Enter')
    keyDown(el, 'Enter')
  })
  await settle()
  expect(patchCalls.length).toBe(1)
  expect(headingText()).toBe('Twice pressed')
})

test('blur saves', async () => {
  await mount()
  await startEditing()
  await type('Saved on blur')
  await blurInput()
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'Saved on blur' } }])
  expect(editing()).toBe(false)
  expect(headingText()).toBe('Saved on blur')
})

test('while the save is pending the input is disabled and keeps the typed value', async () => {
  const release = gate()
  await mount()
  await startEditing()
  await type('Pending name')
  await press('Enter')
  expect(editing()).toBe(true)
  expect(requireInput().disabled).toBe(true)
  expect(requireInput().value).toBe('Pending name')
  await release()
  expect(editing()).toBe(false)
})

test('Escape arriving while the save is pending neither cancels it nor sends anything else', async () => {
  const release = gate()
  byId = { s1: session({ title: 'Old name' }) }
  await mount()
  await startEditing()
  await type('Committed')
  await press('Enter')
  await press('Escape')
  await blurInput()
  expect(patchCalls.length).toBe(1)
  await release()
  expect(patchCalls.length).toBe(1)
  expect(headingText()).toBe('Committed')
})

test('a 200-character title is sent whole', async () => {
  await mount()
  await startEditing()
  await type('y'.repeat(200))
  await press('Enter')
  expect(patchCalls.length).toBe(1)
  expect((patchCalls[0]?.body.title as string).length).toBe(200)
  expect(headingText()).toBe('y'.repeat(200))
})

test('an Enter or Escape that belongs to an IME composition neither saves nor cancels', async () => {
  byId = { s1: session({ title: 'Original' }) }
  await mount()
  await startEditing()
  await type('かな')
  const el = requireInput()
  await act(async () => {
    for (const key of ['Enter', 'Escape']) {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }),
      )
    }
  })
  await settle()
  expect(patchCalls).toEqual([])
  expect(editing()).toBe(true)
  expect(requireInput().value).toBe('かな')
  // The composition over, Enter is the field's again.
  await press('Enter')
  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'かな' } }])
})

// --- leaving without a request ----------------------------------------------------

test('Escape cancels: no request, the original title is back, the typed value gone', async () => {
  byId = { s1: session({ title: 'Original' }) }
  await mount()
  await startEditing()
  await type('Abandoned')
  await press('Escape')
  expect(patchCalls).toEqual([])
  expect(editing()).toBe(false)
  expect(headingText()).toBe('Original')
  // Reopening starts from the title again, not from what was abandoned.
  const input = await startEditing()
  expect(input.value).toBe('Original')
})

for (const [label, value] of [
  ['empty', ''],
  ['whitespace-only', '   \t '],
  ['unchanged', 'Original'],
  ['unchanged once trimmed', '  Original  '],
] as const) {
  for (const how of ['Enter', 'blur'] as const) {
    test(`${how} on an ${label} value leaves edit mode with no request`, async () => {
      byId = { s1: session({ title: 'Original' }) }
      await mount()
      await startEditing()
      await type(value)
      if (how === 'Enter') await press('Enter')
      else await blurInput()
      expect(patchCalls).toEqual([])
      expect(editing()).toBe(false)
      expect(headingText()).toBe('Original')
    })
  }
}

// --- failure ----------------------------------------------------------------------

test("a failure toasts the API's message and the input stays, enabled, with the typed value", async () => {
  patchFailure = { response: { status: 400, data: { error: 'Title is not allowed' } } }
  byId = { s1: session({ title: 'Old name' }) }
  await mount()
  await startEditing()
  await type('Rejected')
  await press('Enter')
  expect(patchCalls.length).toBe(1)
  expect(occurrences('Title is not allowed')).toBe(1)
  expect(bodyText()).not.toContain('Could not rename the session')
  expect(editing()).toBe(true)
  expect(requireInput().disabled).toBe(false)
  expect(requireInput().value).toBe('Rejected')
  expect(cachedTitle()).toBe('Old name')
})

test('a failure with no API message toasts "Could not rename the session"', async () => {
  patchFailure = { response: { status: 500, data: 'upstream exploded' } }
  await mount()
  expect(bodyText()).not.toContain('Could not rename the session')
  await startEditing()
  await type('Anything')
  await press('Enter')
  expect(occurrences('Could not rename the session')).toBe(1)
  expect(editing()).toBe(true)
})

test('after a failure, Enter retries and a success ends edit mode with the new title', async () => {
  patchFailure = { response: { status: 503, data: { error: 'try again later' } } }
  await mount()
  await startEditing()
  await type('Second try')
  await press('Enter')
  expect(editing()).toBe(true)

  patchFailure = null
  await press('Enter')
  expect(patchCalls).toEqual([
    { path: { id: 's1' }, body: { title: 'Second try' } },
    { path: { id: 's1' }, body: { title: 'Second try' } },
  ])
  expect(editing()).toBe(false)
  expect(headingText()).toBe('Second try')
})

test('after a failure, the value can be fixed and blur retries with the new one', async () => {
  patchFailure = { response: { status: 400, data: { error: 'bad title' } } }
  await mount()
  await startEditing()
  await type('Bad')
  await press('Enter')
  patchFailure = null
  await type('Good')
  await blurInput()
  expect(patchCalls.map((c) => c.body.title)).toEqual(['Bad', 'Good'])
  expect(headingText()).toBe('Good')
})

test('after a failure, Escape still cancels with no further request', async () => {
  patchFailure = { response: { status: 400, data: { error: 'bad title' } } }
  byId = { s1: session({ title: 'Original' }) }
  await mount()
  await startEditing()
  await type('Bad')
  await press('Enter')
  expect(editing()).toBe(true)
  await press('Escape')
  expect(patchCalls.length).toBe(1)
  expect(editing()).toBe(false)
  expect(headingText()).toBe('Original')
})

test('a failed Enter followed by its blur toasts once and sends once', async () => {
  const release = gate()
  patchFailure = { response: { status: 400, data: { error: 'only once please' } } }
  await mount()
  await startEditing()
  await type('Bad')
  await press('Enter')
  await blurInput()
  await release()
  expect(patchCalls.length).toBe(1)
  expect(occurrences('only once please')).toBe(1)
})

// --- every status ------------------------------------------------------------------

for (const status of ['idle', 'queued', 'running', 'interrupted', 'completed', 'failed'] as const) {
  test(`a ${status} session renames in place`, async () => {
    byId = { s1: session({ status, title: 'Before' }) }
    await mount()
    await startEditing()
    await type(`After (${status})`)
    await press('Enter')
    expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: `After (${status})` } }])
    expect(headingText()).toBe(`After (${status})`)
  })
}

// --- switching sessions ------------------------------------------------------------

/** Puts s2 in the detail cache, as a session visited earlier would be: the
 *  page then switches without a loading state that unmounts the header, so
 *  only `SessionTitle`'s own key stands between s1's edit and s2. */
const seedSecondSession = async () => {
  await act(async () => {
    client.setQueryData(getApiSessionsIdQueryKey({ path: { id: 's2' } }), byId.s2)
  })
}

test('switching to another session while editing does not carry the edit over', async () => {
  byId = {
    s1: session({ id: 's1', title: 'First session' }),
    s2: session({ id: 's2', title: 'Second session' }),
  }
  await mount()
  await seedSecondSession()
  await startEditing()
  await type('Half-typed for s1')

  await act(async () => {
    showSession('s2')
  })
  await settle()

  expect(headingText()).toBe('Second session')
  expect(editing()).toBe(false)
  expect(patchCalls).toEqual([])
  const input = await startEditing()
  expect(input.value).toBe('Second session')
})

test("a save still in flight when the page switches lands on its own session, not the new one's heading", async () => {
  const release = gate()
  byId = {
    s1: session({ id: 's1', title: 'First session' }),
    s2: session({ id: 's2', title: 'Second session' }),
  }
  await mount()
  await seedSecondSession()
  await startEditing()
  await type('First renamed')
  await press('Enter')

  await act(async () => {
    showSession('s2')
  })
  await settle()
  await release()

  expect(patchCalls).toEqual([{ path: { id: 's1' }, body: { title: 'First renamed' } }])
  expect(headingText()).toBe('Second session')
  expect(editing()).toBe(false)
  expect(cachedTitle('s1')).toBe('First renamed')
  expect(cachedTitle('s2')).toBe('Second session')
})
