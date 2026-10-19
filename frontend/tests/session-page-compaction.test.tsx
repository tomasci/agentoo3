// The "Compact session" entry points on the session page (session-page.tsx):
//
//   - the header always carries a Compact session button, before the details
//     trigger, inside the action group the title is followed by;
//   - a cost banner sits between the header and the transcript only once the
//     session's totalCostUsd is STRICTLY above COMPACT_SUGGEST_COST_USD
//     (lib/compaction.ts) — absent at exactly 1000, present at 1000.01;
//   - both buttons are one control: disabled together while the session is
//     queued/running or a compaction is in flight, with the reason in a
//     tooltip, and either one starts the same single POST;
//   - the in-flight state is the *session's*: it does not follow the reader
//     to another session.
//
// Rendered the way tests/session-page-header.test.tsx renders it — the real
// `SessionPage`, real hooks, real query client, the generated clients mocked
// per-file through ./mock-module, a private `cimode` i18n instance so every
// label is its bare key, inside a minimal memory router (the header renders
// `<Link>`s and the hook calls `useNavigate`). The compaction clients are
// mocked here only far enough to count calls and hold the POST open; the full
// start → poll → navigate flow is tests/session-page-compaction-flow.test.tsx.
//
// Assertions compare primitives (strings, counts, booleans), never DOM nodes:
// bun pretty-printing a happy-dom element on failure takes minutes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from '@tanstack/react-router'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { composerModeAtom } from '../src/shared/store/ui'
import { mockModule } from './mock-module'

// Never `.use(initReactI18next)` — see tests/session-page-scroll.test.tsx.
const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-10-18T10:00:00.000Z'

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  projectId: 'p1',
  ideaId: null,
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
  ...overrides,
})

let sessionsById: Record<string, SessionDto> = {}

const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const MESSAGES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdMessages'
const FILES_CLIENT = '@/shared/api/generated/clients/getApiSessionsIdFiles'
const CREATE_COMPACTION_CLIENT = '@/shared/api/generated/clients/createSessionCompaction'
const GET_COMPACTION_CLIENT = '@/shared/api/generated/clients/getSessionCompaction'

let compactionPosts: { path: { id: string } }[] = []
/** The POST stays open until this resolves, so the page can be seen in flight. */
let postGate: Promise<void> = new Promise(() => {})

await mockModule(SESSION_CLIENT, () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => {
    const found = sessionsById[opts.path.id]
    if (!found) throw new Error(`no session ${opts.path.id}`)
    return { data: found }
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
await mockModule(CREATE_COMPACTION_CLIENT, () => ({
  createSessionCompaction: async (opts: { path: { id: string } }) => {
    compactionPosts.push({ path: { ...opts.path } })
    await postGate
    return {
      data: {
        id: 'c1',
        sourceSessionId: opts.path.id,
        status: 'pending',
        method: null,
        resultSessionId: null,
        error: null,
        costUsd: 0,
        createdAt: T,
        startedAt: null,
        finishedAt: null,
      },
    }
  },
}))
await mockModule(GET_COMPACTION_CLIENT, () => ({
  getSessionCompaction: async () => new Promise(() => {}),
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

let container: HTMLDivElement
let client: QueryClient
let root: Root
let router: ReturnType<typeof createRouter>
let store: ReturnType<typeof createStore>

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** Renders whichever session the memory router's `/s/$id` currently names,
 *  with no `key` — exactly how `SessionRoute` renders it, so a session switch
 *  reuses this instance. */
function Routed() {
  const { id } = useParams({ strict: false }) as { id?: string }
  return <SessionPage projectId="p1" sessionId={id ?? 's1'} />
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const rootRoute = createRootRoute()
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$id',
    component: Routed,
  })
  router = createRouter({
    routeTree: rootRoute.addChildren([sessionRoute]),
    history: createMemoryHistory({ initialEntries: ['/s/s1'] }),
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
  if (!container.querySelector('h1')) throw new Error('session page never rendered its title')
}

beforeEach(() => {
  sessionsById = { s1: session(), s2: session({ id: 's2', title: 'Another session' }) }
  compactionPosts = []
  postGate = new Promise(() => {})
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

const ACTION = 'sessions.compact.action'
const BANNER_ACTION = 'sessions.compact.bannerAction'
const BANNER_TITLE = 'sessions.compact.bannerTitle'
const IN_PROGRESS = 'sessions.compact.inProgress'
const BUSY_TOOLTIP = 'sessions.compact.busyTooltip'
const IN_PROGRESS_TOOLTIP = 'sessions.compact.inProgressTooltip'
const ACTION_TOOLTIP = 'sessions.compact.actionTooltip'

const header = () => {
  const headers = [...container.querySelectorAll('header')]
  if (headers.length !== 1) throw new Error(`expected one header, got ${headers.length}`)
  return headers[0] as HTMLElement
}
const composer = () => {
  const f = [...container.querySelectorAll('footer')].find((el) => el.querySelector('textarea'))
  if (!f) throw new Error('no composer footer')
  return f as HTMLElement
}
const scroller = () => {
  const prev = composer().previousElementSibling
  if (!prev) throw new Error('no scroll container before the composer')
  return prev as HTMLElement
}
/** The banner: the status-role Alert that carries its title. */
const banners = () =>
  [...container.querySelectorAll<HTMLElement>('[data-slot="alert"]')].filter((a) =>
    a.textContent?.includes(BANNER_TITLE),
  )
const buttonsIn = (scope: ParentNode, texts: string[]) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
    texts.includes(b.textContent?.trim() ?? ''),
  )
const headerButton = () => {
  const found = buttonsIn(header(), [ACTION, IN_PROGRESS])
  if (found.length !== 1) throw new Error(`expected one header compact button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
const bannerButton = () => {
  const [banner] = banners()
  if (!banner) throw new Error('no banner')
  const found = buttonsIn(banner, [BANNER_ACTION, IN_PROGRESS])
  if (found.length !== 1) throw new Error(`expected one banner button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
const openTooltips = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"][data-open]')].map(
    (el) => el.textContent ?? '',
  )
async function focusIn(el: HTMLElement) {
  await act(async () => {
    el.focus()
  })
  await settle(2)
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
  await settle(3)
}

// --- the banner's threshold ------------------------------------------------------

test('at exactly 1000 there is no banner, and the header button is there', async () => {
  sessionsById.s1 = session({ totalCostUsd: 1000 })
  await mount()
  expect(banners().length).toBe(0)
  expect(buttonsIn(container, [BANNER_ACTION]).length).toBe(0)
  expect(headerButton().disabled).toBe(false)
})

test('at 1000.01 the banner appears, and the header button is still there', async () => {
  sessionsById.s1 = session({ totalCostUsd: 1000.01 })
  await mount()
  expect(banners().length).toBe(1)
  expect(bannerButton().textContent?.trim()).toBe(BANNER_ACTION)
  expect(headerButton().textContent?.trim()).toBe(ACTION)
  // The cost the suggestion is about is quoted in it.
  expect(banners()[0]?.textContent).toContain('sessions.compact.bannerBody')
})

for (const cost of [0, 0.5, 999.99]) {
  test(`at ${cost} there is no banner but the header button is present`, async () => {
    sessionsById.s1 = session({ totalCostUsd: cost })
    await mount()
    expect(banners().length).toBe(0)
    expect(headerButton().textContent?.trim()).toBe(ACTION)
  })
}

test('far above the threshold the banner shows', async () => {
  sessionsById.s1 = session({ totalCostUsd: 5000 })
  await mount()
  expect(banners().length).toBe(1)
})

test('the banner appears while the page is open, the moment a refetch takes the cost past 1000', async () => {
  // The cost grows turn by turn with the page open; the gate has to follow the
  // session query, not just the value it mounted with.
  sessionsById.s1 = session({ totalCostUsd: 1000 })
  await mount()
  expect(banners().length).toBe(0)

  sessionsById.s1 = session({ totalCostUsd: 1000.01 })
  await act(async () => {
    await client.invalidateQueries()
  })
  await settle()
  expect(banners().length).toBe(1)
  expect(bannerButton().textContent?.trim()).toBe(BANNER_ACTION)
  expect(headerButton().textContent?.trim()).toBe(ACTION)
})

test('the banner is a status region, not an alert, so it does not interrupt a screen reader', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  await mount()
  expect(banners()[0]?.getAttribute('role')).toBe('status')
})

test('the banner sits between the header and the transcript, below a last-error alert', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000, lastError: 'boom' })
  await mount()
  const [banner] = banners()
  expect(banner?.nextElementSibling === scroller()).toBe(true)
  const before = banner?.previousElementSibling
  expect(before?.getAttribute('data-slot')).toBe('alert')
  expect(before?.textContent).toContain('boom')
  expect(banner?.classList.contains('shrink-0')).toBe(true)
})

// --- the header button ---------------------------------------------------------------

test('the header button sits in the action group that directly follows the title, before the details trigger', async () => {
  await mount()
  const group = header().querySelector('h1')?.nextElementSibling
  expect(group?.contains(headerButton())).toBe(true)
  const details = [...(group?.querySelectorAll('button') ?? [])].find(
    (b) => b.getAttribute('aria-label') === 'sessions.details',
  )
  expect(
    (headerButton().compareDocumentPosition(details as Node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  ).toBe(true)
})

test('an idle session: both buttons are enabled', async () => {
  sessionsById.s1 = session({ status: 'idle', totalCostUsd: 2000 })
  await mount()
  expect(headerButton().disabled).toBe(false)
  expect(bannerButton().disabled).toBe(false)
})

for (const status of ['queued', 'running'] as const) {
  test(`a ${status} session: both buttons are disabled, the banner still shows, and clicking sends nothing`, async () => {
    sessionsById.s1 = session({ status, totalCostUsd: 2000 })
    await mount()
    expect(banners().length).toBe(1)
    expect(headerButton().disabled).toBe(true)
    expect(bannerButton().disabled).toBe(true)
    await click(headerButton())
    await click(bannerButton())
    expect(compactionPosts).toEqual([])
  })
}

for (const status of ['completed', 'interrupted', 'failed'] as const) {
  test(`a ${status} session can be compacted`, async () => {
    sessionsById.s1 = session({ status })
    await mount()
    expect(headerButton().disabled).toBe(false)
  })
}

test('a busy session says why through a focusable wrapper, since a disabled button never gets focus', async () => {
  sessionsById.s1 = session({ status: 'running' })
  await mount()
  const wrapper = headerButton().parentElement as HTMLElement
  expect(wrapper.tagName).toBe('SPAN')
  expect(wrapper.getAttribute('tabindex')).toBe('0')
  expect(openTooltips()).toEqual([])
  await focusIn(wrapper)
  expect(openTooltips()).toEqual([BUSY_TOOLTIP])
})

test('an enabled button describes what it does on focus, and its wrapper is not a tab stop', async () => {
  await mount()
  const button = headerButton()
  expect(button.parentElement?.hasAttribute('tabindex')).toBe(false)
  await focusIn(button)
  expect(openTooltips()).toEqual([ACTION_TOOLTIP])
})

test('the banner button has no what-it-does tooltip while enabled, but gives the reason once disabled', async () => {
  sessionsById.s1 = session({ status: 'running', totalCostUsd: 2000 })
  await mount()
  await focusIn(bannerButton().parentElement as HTMLElement)
  expect(openTooltips()).toEqual([BUSY_TOOLTIP])
})

// --- one start, one in-flight state ---------------------------------------------------

test('the header button starts one compaction for this session, and both buttons show it in flight', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  await mount()
  await click(headerButton())
  expect(compactionPosts).toEqual([{ path: { id: 's1' } }])
  expect(headerButton().textContent?.trim()).toBe(IN_PROGRESS)
  expect(bannerButton().textContent?.trim()).toBe(IN_PROGRESS)
  expect(headerButton().disabled).toBe(true)
  expect(bannerButton().disabled).toBe(true)
  // A spinner, hidden from assistive tech (the text says it).
  expect(headerButton().querySelector('[data-slot="spinner"]')?.getAttribute('aria-hidden')).toBe('true')
  // And the reason is the in-flight one.
  await focusIn(headerButton().parentElement as HTMLElement)
  expect(openTooltips()).toEqual([IN_PROGRESS_TOOLTIP])
})

test('the banner button does exactly what the header button does', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  await mount()
  await click(bannerButton())
  expect(compactionPosts).toEqual([{ path: { id: 's1' } }])
  expect(headerButton().textContent?.trim()).toBe(IN_PROGRESS)
  expect(bannerButton().textContent?.trim()).toBe(IN_PROGRESS)
})

test('a second click while one is in flight does not start a second compaction', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  await mount()
  await click(headerButton())
  await click(headerButton())
  await click(bannerButton())
  expect(compactionPosts.length).toBe(1)
})

test('the click does not remount the button, so keyboard focus stays on it', async () => {
  await mount()
  const before = headerButton()
  await act(async () => {
    before.focus()
    before.click()
  })
  await settle(3)
  expect(headerButton() === before).toBe(true)
})

// --- keyed on the session ---------------------------------------------------------------

test('a compaction started on one session is not shown on another, nor when coming back to the first', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  sessionsById.s2 = session({ id: 's2', title: 'Another session', totalCostUsd: 2000 })
  await mount()
  await click(headerButton())
  expect(headerButton().textContent?.trim()).toBe(IN_PROGRESS)

  await act(async () => {
    await router.navigate({ to: '/s/$id', params: { id: 's2' } })
  })
  await settle()
  expect(container.querySelector('h1')?.textContent).toBe('Another session')
  expect(headerButton().textContent?.trim()).toBe(ACTION)
  expect(headerButton().disabled).toBe(false)
  expect(bannerButton().textContent?.trim()).toBe(BANNER_ACTION)
  expect(bannerButton().disabled).toBe(false)

  await act(async () => {
    await router.navigate({ to: '/s/$id', params: { id: 's1' } })
  })
  await settle()
  expect(container.querySelector('h1')?.textContent).toBe('A session')
  // Left alone, not resumed: the reader can click again, which the backend
  // answers with the compaction already running.
  expect(headerButton().textContent?.trim()).toBe(ACTION)
  expect(headerButton().disabled).toBe(false)
})

test('a POST answered after the reader moved on does not start polling on the session they are now on', async () => {
  sessionsById.s1 = session({ totalCostUsd: 2000 })
  sessionsById.s2 = session({ id: 's2', title: 'Another session', totalCostUsd: 2000 })
  let release: () => void = () => {}
  postGate = new Promise<void>((r) => {
    release = r
  })
  await mount()
  await click(headerButton())
  await act(async () => {
    await router.navigate({ to: '/s/$id', params: { id: 's2' } })
  })
  await settle()
  await act(async () => {
    release()
  })
  await settle()
  expect(headerButton().textContent?.trim()).toBe(ACTION)
  expect(headerButton().disabled).toBe(false)
  expect(compactionPosts).toEqual([{ path: { id: 's1' } }])
})
