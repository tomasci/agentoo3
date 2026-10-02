// features/whats-new, mounted the way app/root-layout.tsx's Shell actually
// mounts it: the dialog auto-opening in 'installed' mode when GET
// /whats-new answers pending: true (and *not* opening on pending: false),
// closing it firing POST /whats-new/dismiss with the installedAt that was
// displayed and closing immediately regardless of how that request turns
// out, a closed screen staying closed through a refetch that still reports
// pending, and the status bar's version button reopening it in 'manual'
// mode without ever calling dismiss.
//
// Mounted through the real router/shell, the same way tests/shell.test.tsx
// does — WhatsNewScreen and the status bar's version button are both pieces
// of that shell, not of any one page. The two generated whats-new clients are
// replaced through tests/mock-module.ts, the same way
// tests/session-limit-card.test.tsx replaces its own GET/PATCH pair; every
// other query the shell needs is seeded directly, exactly as
// tests/shell.test.tsx seeds them for the same '/library' mount.
//
// No DOM element is ever a matcher operand here — presence is compared as a
// boolean (`dialog() === null`). See tests/whats-new-screen-gaps.test.tsx's
// header comment: a failing `expect(element).toBeNull()` under this
// full-shell happy-dom mount serialises the whole document on a real
// (present) element instead of throwing, which takes ~60s and then does not
// fail at all — so the assertion could never actually catch a regression.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const GET_CLIENT = '@/shared/api/generated/clients/getApiWhatsNew'
const POST_CLIENT = '@/shared/api/generated/clients/postApiWhatsNewDismiss'

type WhatsNewState = { installedVersion: string | null; installedAt: string | null; pending: boolean }

const NOT_PENDING: WhatsNewState = { installedVersion: '1.2.150', installedAt: null, pending: false }
const PENDING: WhatsNewState = {
  installedVersion: '1.2.151',
  installedAt: '2026-10-02T09:00:00.000Z',
  pending: true,
}

let getState: WhatsNewState = NOT_PENDING
let getCalls = 0
let postCalls: { installedAt: string }[] = []
/** When set, the POST rejects with it instead of answering. */
let postFailure: unknown = null
/** When set, GET waits on it before answering — a slow first load, the same
 *  knob tests/whats-new-screen-gaps.test.tsx uses for the same reason. */
let getGate: Promise<void> | null = null

await mockModule(GET_CLIENT, () => ({
  getApiWhatsNew: async () => {
    getCalls++
    if (getGate) await getGate
    return { data: getState }
  },
}))
await mockModule(POST_CLIENT, () => ({
  postApiWhatsNewDismiss: async (opts: { body: { installedAt: string } }) => {
    postCalls.push(opts.body)
    if (postFailure) throw postFailure
    return { data: { ...getState, pending: false } }
  },
}))

const { routeTree } = await import('../src/app/router')
const { getApiWhatsNewQueryKey } = await import(
  '../src/shared/api/generated/hooks/useGetApiWhatsNew'
)
const { Toaster, toast } = await import('../src/shared/ui/toast')

const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
const realWarn = console.warn
let warnings: string[] = []
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => String(a)).join(' ').slice(0, 300))
}
afterAll(() => {
  console.error = realError
  console.warn = realWarn
})

let container: HTMLDivElement
let root: Root | null = null
let client: QueryClient

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount(path = '/library') {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // The shell's own queries, seeded the same way tests/shell.test.tsx seeds
  // them for this same '/library' mount — the whats-new query is
  // deliberately *not* seeded here: it is the one under test, fetched
  // through the mocked client above.
  client.setQueryData([{ url: '/api/projects' }], [])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '1.2.150' })
  client.setQueryData([{ url: '/api/system' }], {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
  client.setQueryData(
    [{ url: '/api/system/prompts/:name', params: { name: 'session-learning' } }],
    {
      name: 'session-learning',
      body: 'Built-in default instruction.',
      path: '/opt/agentoo/library/prompts/session-learning.md',
      source: 'default',
    },
  )
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <JotaiProvider>
        <QueryClientProvider client={client}>
          <Toaster />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
}

beforeEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  problems.length = 0
  warnings = []
  getState = NOT_PENDING
  getCalls = 0
  postCalls = []
  postFailure = null
  getGate = null
})

afterEach(async () => {
  await unmount()
  toast.close()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** Mirrors shell.test.tsx's own `{{var}}` interpolation helper. */
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''))

const dialog = () => document.querySelector('[data-slot="dialog-content"]')
const dialogTitle = () => document.querySelector('[data-slot="dialog-title"]')

const click = async (el: Element | null | undefined, what: string) => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

const statusBarVersionButton = () =>
  [...document.querySelectorAll('footer button')].find((b) =>
    (b.textContent ?? '').trim().startsWith('v'),
  ) as HTMLButtonElement | undefined

// 1. Auto-open on a pending install ------------------------------------------

test('auto-opens in "installed" mode when GET answers pending: true, titled with the installed version', async () => {
  getState = PENDING
  await mount()

  expect(dialog() !== null).toBe(true)
  expect(text(dialogTitle())).toBe(fill(en.whatsNew.installedTitle, { version: '1.2.151' }))
  expect(text(dialog())).toContain(en.whatsNew.installedSubtitle)
  expect(problems).toEqual([])
})

test('does not open when GET answers pending: false', async () => {
  getState = NOT_PENDING
  await mount()
  expect(dialog() === null).toBe(true)
})

// 2. Closing dismisses ---------------------------------------------------------

test('closing the auto-opened screen (the footer button) posts dismiss with the displayed installedAt, and closes', async () => {
  getState = PENDING
  await mount()
  expect(dialog() !== null).toBe(true)

  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')

  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([{ installedAt: PENDING.installedAt }])
  expect(problems).toEqual([])
})

test('closing through the "X" also dismisses with the same installedAt', async () => {
  getState = PENDING
  await mount()
  // The feature's own "X" (whats-new-screen.tsx), not the generated one:
  // DialogContent is mounted with `showCloseButton={false}` — the one
  // button in the dialog whose accessible name is not the footer's own.
  const closeX = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => b.getAttribute('aria-label') === en.whatsNew.closeX && text(b) !== en.whatsNew.close,
  )
  await click(closeX, 'close (X)')

  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([{ installedAt: PENDING.installedAt }])
})

test('a failed dismiss still closes the screen immediately and reports the localized failure, not a trapped operator or the raw error', async () => {
  getState = PENDING
  postFailure = new Error('Request failed with status code 500')
  await mount()

  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')

  // Closed regardless of the request's outcome.
  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([{ installedAt: PENDING.installedAt }])
  // ...and the failure was reported as the localized, generic message — never
  // the raw "Request failed with status code 500" apiErrorMessage would have
  // surfaced for any other Error.
  const toastTitles = [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) =>
    text(el),
  )
  expect(toastTitles).toContain(en.whatsNew.dismissFailed)
  expect(toastTitles.some((title) => title.includes('500'))).toBe(false)
})

// 3. Stays closed through a racing refetch -----------------------------------

test('once closed, a refetch that still reports pending does not reopen the screen', async () => {
  getState = PENDING
  await mount()
  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')
  expect(dialog() === null).toBe(true)

  // Simulate the dismiss POST not having landed yet: GET still says pending.
  await act(async () => {
    await client.refetchQueries({ queryKey: getApiWhatsNewQueryKey() })
  })
  await settle()
  expect(dialog() === null).toBe(true)
})

// 4. The status bar's version button -----------------------------------------

test('the status bar’s version button shows "v{version}" and opens the screen in manual mode without calling dismiss', async () => {
  getState = NOT_PENDING
  await mount()
  expect(dialog() === null).toBe(true)

  const button = statusBarVersionButton()
  expect(button !== undefined).toBe(true)
  expect(text(button)).toBe('v1.2.150')
  // WCAG 2.5.3 label-in-name: the accessible name must contain the visible
  // text, not replace it with a different phrase — so either there is no
  // aria-label at all (the visible text is the name) or, if there is one, it
  // starts with that same text.
  const name = button?.getAttribute('aria-label') ?? text(button)
  expect(name.startsWith('v1.2.150')).toBe(true)

  await click(button, 'status bar version button')

  expect(dialog() !== null).toBe(true)
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)
  expect(text(dialog())).toContain(fill(en.whatsNew.manualSubtitle, { version: '1.2.150' }))
  expect(postCalls).toEqual([])

  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')
  expect(dialog() === null).toBe(true)
  // Manual mode never dismisses — there is nothing here to acknowledge.
  expect(postCalls).toEqual([])
})

// 5. A manual open must not be taken over by a late pending answer -----------

test('clicking the status bar version button while the first GET is still in flight opens a manual screen, not one a later pending: true answer can flip into "installed"', async () => {
  // Reproduces the "manual open turns into a dismiss" defect exactly: the
  // first GET /whats-new is slow, the operator clicks the status bar's
  // version button before it answers (so the screen opens in 'manual' mode
  // against no data yet), and only then does GET resolve with pending: true.
  // The auto-open effect must latch itself shut without reaching for a mode
  // that is already open — never silently turning this into the
  // auto-opened, dismiss-on-close 'installed' screen.
  let release: () => void = () => {}
  getGate = new Promise<void>((r) => {
    release = r
  })
  getState = PENDING
  await mount()
  expect(dialog() === null).toBe(true)

  await click(statusBarVersionButton(), 'status bar version button')
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)

  await act(async () => {
    release()
  })
  await settle()

  // Still the manual title — not silently switched to "installed".
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)

  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')
  expect(dialog() === null).toBe(true)
  // A manual close never dismisses — there was nothing here to acknowledge.
  expect(postCalls).toEqual([])
})

// 6. Closing a manual open before the first GET answers must not auto-open --

test('closing a manual open before the first GET answers does not let that answer auto-open the screen', async () => {
  // Reproduces: install pending, slow first GET, operator opens the status
  // bar's version button (manual, against no data yet), closes it, and only
  // then does GET resolve with pending: true. That answer must not pop the
  // screen open on its own — the operator already saw (and dismissed) a
  // screen this page load, auto-opened or not.
  let release: () => void = () => {}
  getGate = new Promise<void>((r) => {
    release = r
  })
  getState = PENDING
  await mount()
  expect(dialog() === null).toBe(true)

  await click(statusBarVersionButton(), 'status bar version button')
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)

  const gotIt = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => text(b) === en.whatsNew.close,
  )
  await click(gotIt, 'Got it')
  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([])

  await act(async () => {
    release()
  })
  await settle()

  // The late pending: true answer must not auto-open the screen the operator
  // already closed this page load.
  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([])
})
