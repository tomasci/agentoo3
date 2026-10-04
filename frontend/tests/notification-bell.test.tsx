// The topbar notification bell (features/notifications): its feed, the red
// dot, the mark-read POST and the highlighted-while-open snapshot.
//
// Rendered the way tests/session-page-mark-seen.test.tsx renders a page: the
// real `NotificationBell`, real hooks and a real QueryClient, the generated
// clients mocked per-file through ./mock-module, a small memory router with
// just the routes the bell links to, and a private `cimode` i18n instance so
// keys render as-is. One case renders under the real English bundle instead,
// because `cimode` drops interpolation and would hide a count passed as an
// option.
//
// Polling is not waited out in real time: a poll is simulated with
// `refetchQueries` on the feed's own key, and the 15s/background settings are
// read off the mounted observer.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import i18next, { type i18n as I18n } from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { NotificationFeed } from '../src/shared/api/generated/types/NotificationFeed'
import type { NotificationItem } from '../src/shared/api/generated/types/NotificationItem'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })
const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

// ── fixtures ────────────────────────────────────────────────────────────────

// Ids are letters only so the untitled fallback (`Session {{id}}` in en) can
// never put a digit on screen by itself.
const S1: NotificationItem = {
  source: 'session',
  id: 'aaaabbbb-sess-one',
  at: '2026-09-04T12:00:00.000Z',
  unread: true,
  projectId: 'proj-alpha',
  projectName: 'Alpha',
  title: 'Fix the login bug',
  status: 'completed',
}
const G1: NotificationItem = {
  source: 'suggestion',
  id: 'sug-one',
  at: '2026-09-04T11:00:00.000Z',
  unread: true,
  kind: 'agent',
  action: 'create',
  name: 'reviewer',
  title: 'Add a reviewer agent',
}
const S2: NotificationItem = {
  source: 'session',
  id: 'ccccdddd-sess-two',
  at: '2026-09-04T10:00:00.000Z',
  unread: false,
  projectId: 'proj-beta',
  projectName: 'Beta',
  title: null,
  status: 'failed',
}
/** A genuinely newer unread item a later poll brings. */
const N0: NotificationItem = {
  source: 'suggestion',
  id: 'sug-new',
  at: '2026-09-04T13:00:00.000Z',
  unread: true,
  kind: 'skill',
  action: 'modify',
  name: 'deploy',
  title: 'Tighten the deploy skill',
}

const read = (item: NotificationItem): NotificationItem => ({ ...item, unread: false })
const feedOf = (items: NotificationItem[], truncated = false): NotificationFeed => ({
  items,
  hasUnread: items.some((i) => i.unread),
  truncated,
})

// ── mocked clients ──────────────────────────────────────────────────────────

/** What GET /notifications answers right now (snapshotted at call time). */
let feed: NotificationFeed = feedOf([S1, G1, S2])
let getGate: Promise<void> | null = null
let getFailure: unknown = null
let getCalls = 0

/** Every POST /notifications/read body, in order. */
let postBodies: unknown[] = []
let postGate: Promise<void> | null = null
let postFailure: unknown = null
/** What POST /notifications/read answers; defaults to `feed` with everything read. */
let postAnswer: (() => NotificationFeed) | null = null

let seenCalls: unknown[] = []
let applyCalls: unknown[] = []
let rejectCalls: unknown[] = []

await mockModule('@/shared/api/generated/clients/getApiNotifications', () => ({
  getApiNotifications: async () => {
    getCalls++
    const snapshot = feed
    const failure = getFailure
    if (getGate) await getGate
    if (failure) throw failure
    return { data: snapshot }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiNotificationsRead', () => ({
  postApiNotificationsRead: async (opts: { body: unknown }) => {
    postBodies.push(opts.body)
    if (postGate) await postGate
    if (postFailure) throw postFailure
    if (postAnswer) return { data: postAnswer() }
    const items = feed.items.map(read)
    return { data: { items, hasUnread: false, truncated: feed.truncated } }
  },
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdSeen', () => ({
  postApiSessionsIdSeen: async (opts: unknown) => {
    seenCalls.push(opts)
    throw new Error('the bell must never mark a session seen')
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdApply', () => ({
  postApiLibrarySuggestionsIdApply: async (opts: unknown) => {
    applyCalls.push(opts)
    throw new Error('the bell must never apply a suggestion')
  },
}))
await mockModule('@/shared/api/generated/clients/postApiLibrarySuggestionsIdReject', () => ({
  postApiLibrarySuggestionsIdReject: async (opts: unknown) => {
    rejectCalls.push(opts)
    throw new Error('the bell must never reject a suggestion')
  },
}))

const { NotificationBell } = await import('../src/features/notifications')
const { getApiNotificationsQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiNotifications'
)
const { Toaster, toast } = await import('../src/shared/ui/toast')

const FEED_KEY = getApiNotificationsQueryKey()

// ── harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let client: QueryClient
let root: Root | undefined
let router: ReturnType<typeof createRouter>
let toastAdds = 0
const realToastAdd = toast.add

const gate = () => {
  let open: () => void = () => {}
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <header>
          <NotificationBell />
        </header>
        <main>
          <Outlet />
        </main>
      </>
    ),
  })
  const page = (path: string, label: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{label}</p> })
  const routeTree = rootRoute.addChildren([
    page('/', 'home'),
    page('/sessions', 'all sessions'),
    page('/library/suggested', 'suggested'),
    page('/library/suggestions/$id', 'suggestion page'),
    page('/projects/$projectId/sessions/$sessionId', 'session page'),
  ])
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
}

async function mount(i18n: I18n = cimode, { waitForData = true } = {}) {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  router = buildRouter()
  await router.load()
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
          <Toaster />
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  if (waitForData && !client.getQueryData(FEED_KEY) && !getFailure) {
    throw new Error('the bell never loaded its feed')
  }
}

const LABELS = [
  'notifications.bell',
  'notifications.bellUnread',
  en.notifications.bell,
  en.notifications.bellUnread,
]
const bell = () => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
    LABELS.includes(b.getAttribute('aria-label') ?? ''),
  )
  if (found.length !== 1) throw new Error(`expected one bell, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
/** The red dot on the trigger: a danger-toned StatusDot (`bg-destructive`). */
const dot = () => bell().querySelector('[data-fixed-tone].bg-destructive')
/** Booleans, not elements, in assertions: a failing `toBeNull()` on a
 *  happy-dom node pretty-prints the whole tree and takes ~10s doing it. */
const dotShown = () => dot() !== null
const panel = () => document.querySelector('[data-slot="popover-content"]')
const panelOpen = () => panel() !== null
const rows = () => [...(panel()?.querySelectorAll<HTMLElement>('li > [data-slot="item"]') ?? [])]
const rowTitles = () =>
  rows().map((r) => r.querySelector('[data-slot="item-title"]')?.textContent ?? '')
const isHighlighted = (row: HTMLElement) => {
  const title = row.querySelector('[data-slot="item-title"]')
  const first = title?.firstElementChild
  return {
    muted: row.getAttribute('data-variant') === 'muted',
    leadingDot: Boolean(first?.matches('[data-fixed-tone].bg-destructive')),
    srLabel: [...(title?.querySelectorAll('.sr-only') ?? [])].some(
      (el) => el.textContent === 'notifications.unread',
    ),
  }
}
const NOT_HIGHLIGHTED = { muted: false, leadingDot: false, srLabel: false }
const HIGHLIGHTED = { muted: true, leadingDot: true, srLabel: true }

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const openPanel = async () => {
  if (panel()) throw new Error('panel already open')
  await click(bell())
  if (!panel()) throw new Error('panel did not open')
}
const closePanel = async () => {
  await click(bell())
  if (panel()) throw new Error('panel did not close')
}
/** A poll tick: the same refetch the 15s interval would run. */
const poll = async () => {
  await act(async () => {
    void client.refetchQueries({ queryKey: FEED_KEY })
  })
}

beforeEach(() => {
  feed = feedOf([S1, G1, S2])
  getGate = null
  getFailure = null
  getCalls = 0
  postBodies = []
  postGate = null
  postFailure = null
  postAnswer = null
  seenCalls = []
  applyCalls = []
  rejectCalls = []
  toastAdds = 0
  toast.add = ((...args: Parameters<typeof realToastAdd>) => {
    toastAdds++
    return realToastAdd(...args)
  }) as typeof realToastAdd
  document.body.replaceChildren()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  toast.add = realToastAdd
  toast.close()
  client?.clear()
  document.body.replaceChildren()
})

// ── data and refresh ────────────────────────────────────────────────────────

test('the feed is polled every 15s and not while the tab is in the background', async () => {
  await mount()
  const query = client.getQueryCache().find({ queryKey: FEED_KEY })
  const options = query?.observers.map((o) => o.options) ?? []
  expect(options.length).toBeGreaterThan(0)
  for (const o of options) {
    expect(o.refetchInterval).toBe(15_000)
    expect(o.refetchIntervalInBackground).toBe(false)
  }
})

// ── 2. the dot ──────────────────────────────────────────────────────────────

test('the red dot shows while hasUnread is true', async () => {
  await mount()
  expect(dotShown()).toBe(true)
})

test('no dot while hasUnread is false', async () => {
  feed = feedOf([read(S1), read(G1)])
  await mount()
  expect(dotShown()).toBe(false)
})

test('the dot follows hasUnread as polls change it, both ways', async () => {
  feed = feedOf([read(S1)])
  await mount()
  expect(dotShown()).toBe(false)
  feed = feedOf([S1])
  await poll()
  await settle()
  expect(dotShown()).toBe(true)
  feed = feedOf([read(S1)])
  await poll()
  await settle()
  expect(dotShown()).toBe(false)
})

// ── 3. no count ─────────────────────────────────────────────────────────────

/** Every text node under `el`, except row descriptions (they carry a timestamp). */
const textOutsideDescriptions = (el: Element | null) => {
  if (!el) return ''
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const out: string[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('[data-slot="item-description"]')) continue
    out.push(n.textContent ?? '')
  }
  return out.join('|')
}
const allAriaLabels = () =>
  [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '')

for (const [name, i18n] of [
  ['cimode', cimode],
  ['English', english],
] as const) {
  test(`no number appears on the bell, in any aria-label or in the panel (${name})`, async () => {
    // Five unread plus a truncated feed: the count a regression would show.
    const five = [N0, S1, G1, { ...S2, unread: true }, { ...G1, id: 'sug-two', title: 'Another' }]
    feed = feedOf(five, true)
    await mount(i18n)
    expect(dotShown()).toBe(true)
    expect(bell().textContent ?? '').not.toMatch(/\d/)
    await openPanel()
    // Labels anywhere in the document, the panel included.
    expect(allAriaLabels().filter((l) => /\d/.test(l))).toEqual([])
    // Positive controls: the walk does see the panel's text, and the rows'
    // own descriptions (excluded above, they hold a timestamp) do carry digits.
    expect(textOutsideDescriptions(panel())).toContain('Fix the login bug')
    expect(panel()?.querySelector('[data-slot="item-description"]')?.textContent).toMatch(/\d/)
    expect(textOutsideDescriptions(panel())).not.toMatch(/\d/)
    expect(bell().textContent ?? '').not.toMatch(/\d/)
  })
}

// ── 4. aria-label ───────────────────────────────────────────────────────────

test('the trigger is labelled notifications.bellUnread while something is unread', async () => {
  await mount()
  expect(bell().getAttribute('aria-label')).toBe('notifications.bellUnread')
})

test('the trigger is labelled notifications.bell when nothing is unread', async () => {
  feed = feedOf([read(S1)])
  await mount()
  expect(bell().getAttribute('aria-label')).toBe('notifications.bell')
})

// ── 5. the list ─────────────────────────────────────────────────────────────

test('clicking the bell opens a popover listing the items in server order', async () => {
  // Deliberately not sorted by source or by title, so a client-side re-sort shows.
  feed = feedOf([S1, G1, S2, read(N0)])
  await mount()
  expect(panelOpen()).toBe(false)
  await openPanel()
  expect(rowTitles().map((t) => t.replace('notifications.unread', ''))).toEqual([
    'Fix the login bug',
    'Add a reviewer agent',
    'sessions.untitled',
    'Tighten the deploy skill',
  ])
})

// ── 6 / 7. mark-read POST ───────────────────────────────────────────────────

test('opening with hasUnread: true sends exactly one POST with upTo = items[0].at', async () => {
  await mount()
  expect(postBodies).toEqual([])
  await openPanel()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }])
})

test('the POST response replaces the feed cache, so the dot goes once it says hasUnread: false', async () => {
  const answer = feedOf([read(S1), read(G1), read(S2)])
  postAnswer = () => answer
  await mount()
  const before = getCalls
  await openPanel()
  await settle()
  expect(client.getQueryData(FEED_KEY)).toEqual(answer)
  expect(dotShown()).toBe(false)
  expect(bell().getAttribute('aria-label')).toBe('notifications.bell')
  // Written, not refetched.
  expect(getCalls).toBe(before)
})

test('while the POST is pending the dot is still lit', async () => {
  const held = gate()
  postGate = held.promise
  await mount()
  await openPanel()
  expect(postBodies).toHaveLength(1)
  expect(dotShown()).toBe(true)
  await act(async () => {
    held.open()
  })
  await settle()
  expect(dotShown()).toBe(false)
})

// ── 8. highlight snapshot ───────────────────────────────────────────────────

test('rows unread at open stay highlighted while the panel is open, even after the POST succeeds', async () => {
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toHaveLength(1)
  // The cache now says everything is read…
  expect((client.getQueryData(FEED_KEY) as NotificationFeed).items.every((i) => !i.unread)).toBe(
    true,
  )
  // …but the rows that were unread still look it.
  const [s1, g1, s2] = rows()
  expect(s1 && isHighlighted(s1)).toEqual(HIGHLIGHTED)
  expect(g1 && isHighlighted(g1)).toEqual(HIGHLIGHTED)
  // S2 was already read when the panel opened.
  expect(s2 && isHighlighted(s2)).toEqual(NOT_HIGHLIGHTED)
})

// ── 9 / 10. reopen and nothing unread ───────────────────────────────────────

test('closing and reopening shows no highlight and sends no POST', async () => {
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toHaveLength(1)
  await closePanel()
  await openPanel()
  await settle()
  expect(rows().map(isHighlighted)).toEqual([NOT_HIGHLIGHTED, NOT_HIGHLIGHTED, NOT_HIGHLIGHTED])
  expect(postBodies).toHaveLength(1)
})

test('opening with hasUnread: false sends no POST and highlights nothing', async () => {
  feed = feedOf([read(S1), read(G1)])
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toEqual([])
  expect(rows().map(isHighlighted)).toEqual([NOT_HIGHLIGHTED, NOT_HIGHLIGHTED])
})

// ── 11. a refetch while open ────────────────────────────────────────────────

test('a refetch while open bringing a newer unread item sends exactly one more POST, for the new upTo', async () => {
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }])

  // The server now has N0 on top; the earlier ones are read.
  feed = feedOf([N0, read(S1), read(G1), S2])
  const held = gate()
  postGate = held.promise // keep the second POST pending across more polls
  await poll()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }, { upTo: N0.at }])

  // Same newest item again, twice, while that POST is still in flight — each
  // time with an older row changed, so the feed is a new object (structural
  // sharing would otherwise hand back the same reference and nothing re-runs).
  feed = feedOf([N0, read(S1), { ...read(G1), title: 'Retitled once' }, S2])
  await poll()
  await settle()
  feed = feedOf([N0, read(S1), { ...read(G1), title: 'Retitled twice' }, S2])
  await poll()
  await settle()
  expect(rowTitles()[2]).toContain('Retitled twice')
  expect(postBodies).toEqual([{ upTo: S1.at }, { upTo: N0.at }])

  // The new row joins the highlight; the earlier ones keep theirs.
  const [n0, s1, g1, s2] = rows()
  expect(n0 && isHighlighted(n0)).toEqual(HIGHLIGHTED)
  expect(s1 && isHighlighted(s1)).toEqual(HIGHLIGHTED)
  expect(g1 && isHighlighted(g1)).toEqual(HIGHLIGHTED)
  expect(s2 && isHighlighted(s2)).toEqual(NOT_HIGHLIGHTED)

  await act(async () => {
    held.open()
  })
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }, { upTo: N0.at }])
  expect(dotShown()).toBe(false)
})

test('a refetch while the first POST is pending, with the same newest item, sends no second POST', async () => {
  const held = gate()
  postGate = held.promise
  await mount()
  await openPanel()
  expect(postBodies).toHaveLength(1)
  // Still unread on the server (the POST has not landed), same newest item,
  // but an older row changed each time so the feed really is new data.
  feed = feedOf([S1, { ...G1, title: 'Retitled once' }, S2])
  await poll()
  await settle()
  feed = feedOf([S1, { ...G1, title: 'Retitled twice' }, S2])
  await poll()
  await settle()
  expect(rowTitles()[1]).toContain('Retitled twice')
  expect(postBodies).toEqual([{ upTo: S1.at }])
  await act(async () => {
    held.open()
  })
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }])
})

// ── 12. failed POST ─────────────────────────────────────────────────────────

test('a failed POST leaves the dot lit and raises no toast', async () => {
  postFailure = new Error('500 from /notifications/read')
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toHaveLength(1)
  expect(dotShown()).toBe(true)
  expect(bell().getAttribute('aria-label')).toBe('notifications.bellUnread')
  expect(toastAdds).toBe(0)
  expect(document.querySelectorAll('[data-slot="toast"]').length).toBe(0)
})

test('after a failed POST, the next open retries it', async () => {
  postFailure = new Error('500 from /notifications/read')
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }])
  await closePanel()
  postFailure = null
  await openPanel()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }, { upTo: S1.at }])
  expect(dotShown()).toBe(false)
})

// ── 13. no side effects on sessions or suggestions ──────────────────────────

test('opening the panel never marks a session seen, nor applies or rejects a suggestion', async () => {
  await mount()
  await openPanel()
  await settle()
  expect(postBodies).toHaveLength(1)
  await closePanel()
  await openPanel()
  await settle()
  expect({ seenCalls, applyCalls, rejectCalls }).toEqual({
    seenCalls: [],
    applyCalls: [],
    rejectCalls: [],
  })
})

// ── 14. links ───────────────────────────────────────────────────────────────

test('a session row links to its session page; clicking it navigates and closes the popover', async () => {
  await mount()
  await openPanel()
  const [s1] = rows()
  expect(s1?.tagName).toBe('A')
  expect(s1?.getAttribute('href')).toBe(`/projects/${S1.projectId}/sessions/${S1.id}`)
  await click(s1)
  expect(router.state.location.pathname).toBe(`/projects/${S1.projectId}/sessions/${S1.id}`)
  expect(container.textContent).toContain('session page')
  expect(panelOpen()).toBe(false)
})

test('a suggestion row links to its review page; clicking it navigates and closes the popover', async () => {
  await mount()
  await openPanel()
  const g1 = rows()[1]
  expect(g1?.tagName).toBe('A')
  expect(g1?.getAttribute('href')).toBe(`/library/suggestions/${G1.id}`)
  await click(g1)
  expect(router.state.location.pathname).toBe(`/library/suggestions/${G1.id}`)
  expect(container.textContent).toContain('suggestion page')
  expect(panelOpen()).toBe(false)
})

test('after navigating from a row, reopening shows no highlight and sends no POST', async () => {
  await mount()
  await openPanel()
  await settle()
  await click(rows()[0])
  expect(panelOpen()).toBe(false)
  await openPanel()
  await settle()
  expect(rows().map(isHighlighted)).toEqual([NOT_HIGHLIGHTED, NOT_HIGHLIGHTED, NOT_HIGHLIGHTED])
  expect(postBodies).toHaveLength(1)
})

// ── 15. untitled ────────────────────────────────────────────────────────────

test("a session with a null title shows the app's untitled-session fallback", async () => {
  await mount()
  await openPanel()
  const s2 = rows()[2]
  expect(s2?.querySelector('[data-slot="item-title"]')?.textContent).toBe('sessions.untitled')
})

test('under English the untitled fallback reads as the sessions page writes it', async () => {
  await mount(english)
  await openPanel()
  const s2 = rows()[2]
  expect(s2?.querySelector('[data-slot="item-title"]')?.textContent).toBe(
    en.sessions.untitled.replace('{{id}}', S2.id.slice(0, 8)),
  )
})

// ── 16. empty, loading, error ───────────────────────────────────────────────

test('an empty feed shows the empty state', async () => {
  feed = feedOf([])
  await mount()
  expect(dotShown()).toBe(false)
  await openPanel()
  const text = panel()?.textContent ?? ''
  expect(text).toContain('notifications.empty.title')
  expect(text).toContain('notifications.empty.description')
  expect(rows()).toHaveLength(0)
  expect(postBodies).toEqual([])
})

test('while the feed is loading the panel shows a loader', async () => {
  const held = gate()
  getGate = held.promise
  await mount(cimode, { waitForData: false })
  await openPanel()
  const status = panel()?.querySelector('[role="status"]')
  expect(status !== null).toBe(true)
  expect(status?.textContent).toContain('common.loading')
  expect(rows()).toHaveLength(0)
  await act(async () => {
    held.open()
  })
  await settle()
  expect(panel()?.querySelector('[role="status"]') == null).toBe(true)
  expect(rows()).toHaveLength(3)
})

test('a failed feed shows notifications.loadFailed and no dot', async () => {
  getFailure = new Error('500 from /notifications')
  await mount(cimode, { waitForData: false })
  expect(dotShown()).toBe(false)
  await openPanel()
  expect(panel()?.textContent).toContain('notifications.loadFailed')
  expect(rows()).toHaveLength(0)
  expect(postBodies).toEqual([])
})

// ── 17. truncated ───────────────────────────────────────────────────────────

test('truncated: true shows the footer with links to /sessions and /library/suggested, and no number', async () => {
  feed = feedOf([S1, G1, S2], true)
  await mount()
  await openPanel()
  const text = panel()?.textContent ?? ''
  expect(text).toContain('notifications.truncated')
  const hrefs = [...(panel()?.querySelectorAll('a') ?? [])]
    .filter((a) => a.closest('li') === null)
    .map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual(['/sessions', '/library/suggested'])
  const footer = [...(panel()?.querySelectorAll('p') ?? [])].find((p) =>
    p.textContent?.includes('notifications.truncated'),
  )?.parentElement
  expect(footer?.textContent ?? '').not.toMatch(/\d/)
})

test('a truncated footer link navigates and closes the popover', async () => {
  feed = feedOf([S1, G1, S2], true)
  await mount()
  await openPanel()
  const link = [...(panel()?.querySelectorAll('a') ?? [])].find(
    (a) => a.getAttribute('href') === '/library/suggested',
  )
  await click(link)
  expect(router.state.location.pathname).toBe('/library/suggested')
  expect(panelOpen()).toBe(false)
})

test('truncated: false shows no footer', async () => {
  await mount()
  await openPanel()
  expect(panel()?.textContent).not.toContain('notifications.truncated')
  expect(
    [...(panel()?.querySelectorAll('a') ?? [])].filter((a) => a.closest('li') === null),
  ).toEqual([])
})

// ── 19. stale poll racing the mark-read POST ────────────────────────────────

test('a poll already in flight when the POST is sent, landing after it with stale hasUnread: true, does not bring the dot back', async () => {
  await mount()
  expect(dotShown()).toBe(true)

  // A poll is dispatched and held: its snapshot still says hasUnread: true.
  const staleGet = gate()
  getGate = staleGet.promise
  const before = getCalls
  await poll()
  await settle(2)
  expect(getCalls).toBe(before + 1)

  // The panel opens; the POST succeeds and writes hasUnread: false.
  getGate = null
  await openPanel()
  await settle()
  expect(postBodies).toEqual([{ upTo: S1.at }])
  expect((client.getQueryData(FEED_KEY) as NotificationFeed).hasUnread).toBe(false)
  expect(dotShown()).toBe(false)

  // The stale poll lands.
  await act(async () => {
    staleGet.open()
  })
  await settle()
  // The observable first; the cache line below says why if it fails.
  expect(dotShown()).toBe(false)
  expect((client.getQueryData(FEED_KEY) as NotificationFeed).hasUnread).toBe(false)
})
