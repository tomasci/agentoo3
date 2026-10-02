// features/whats-new: the spec points tests/whats-new-screen.test.tsx does not
// itself exercise — Esc as a close route (in both modes), the X in manual
// mode, the changelog actually rendered newest-first, Russian changelog lines
// (including a regional code such as `ru-RU` reaching i18n), the bare editor
// launcher route, the status bar opening it before GET /whats-new has
// answered, and the accessible names of the two close/open controls.
//
// Mounted exactly the way tests/whats-new-screen.test.tsx mounts it: the real
// router and shell, the two generated whats-new clients replaced through
// tests/mock-module.ts, every other shell query seeded.
//
// No DOM element is ever a matcher operand here — presence is compared as a
// boolean (`dialog() === null`). See tests/transcript-row.test.tsx's tokens
// comment: a failing matcher serialises a happy-dom element's whole document.
// Under this full-shell mount that does worse than print a heap dump:
// `expect(element).toBeNull()` with the element present spends ~60s and then
// does not throw at all, so the test passes.

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  mergeChangelogMarkdown,
  parseChangelogMarkdown,
} from '../src/features/whats-new/model/changelog-markdown'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { mockModule } from './mock-module'

// The changelog itself now lives as Markdown at the repo root rather than as
// this feature's own changelog.json (see frontend/README.md's "Adding a
// changelog entry") — read and merged here with the same parser
// vite.config.ts and tests/setup.ts use, so `rawChangelog.releases` below is
// still the same shape (and the same content) it always was.
const enPath = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url))
const ruPath = fileURLToPath(new URL('../../CHANGELOG.ru.md', import.meta.url))
const rawChangelog = {
  releases: mergeChangelogMarkdown(
    parseChangelogMarkdown(readFileSync(enPath, 'utf8'), 'en', 'CHANGELOG.md'),
    parseChangelogMarkdown(readFileSync(ruPath, 'utf8'), 'ru', 'CHANGELOG.ru.md'),
    'CHANGELOG.md',
    'CHANGELOG.ru.md',
  ),
}

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
/** When set, GET waits on it before answering — a slow first load. */
let getGate: Promise<void> | null = null
let postCalls: { installedAt: string }[] = []

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
    return { data: { ...getState, pending: false } }
  },
}))

const { routeTree } = await import('../src/app/router')
const { i18n } = await import('../src/shared/i18n')
const { sortReleasesByVersionDescending } = await import(
  '../src/features/whats-new/model/changelog.schema'
)

const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
const realWarn = console.warn
console.warn = () => {}
afterAll(async () => {
  console.error = realError
  console.warn = realWarn
  // The app's i18n singleton is shared with every later file in this process.
  await i18n.changeLanguage('en')
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
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
    )
  })
  await settle()
}

beforeEach(async () => {
  document.body.replaceChildren()
  localStorage.clear()
  await i18n.changeLanguage('en')
  problems.length = 0
  getState = NOT_PENDING
  getCalls = 0
  getGate = null
  postCalls = []
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''))

const dialog = () => document.querySelector('[data-slot="dialog-content"]')
const dialogTitle = () => document.querySelector('[data-slot="dialog-title"]')
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])]
/** The generated "X": the one dialog button that is not the footer's close. */
const closeX = (closeLabel: string) => buttons().find((b) => text(b) !== closeLabel)
const statusBarVersionButton = () =>
  [...document.querySelectorAll('footer button')].find((b) =>
    (b.textContent ?? '').trim().startsWith('v'),
  ) as HTMLButtonElement | undefined

const click = async (el: Element | null | undefined, what: string) => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

/** Esc as a bubbling keydown from inside the dialog — dispatched on the popup
 *  itself rather than the focused "Got it" button, so a key that merely
 *  activates the focused button (Enter/Space) cannot pass for Esc here. */
const pressEscape = async () => {
  const target = (dialog() as HTMLElement | null) ?? document.body
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
  })
  await settle()
}

// Esc ----------------------------------------------------------------------------

test('Esc closes the auto-opened screen and posts exactly one dismiss with the displayed installedAt', async () => {
  getState = PENDING
  await mount()
  expect(dialog() !== null).toBe(true)

  await pressEscape()

  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([{ installedAt: PENDING.installedAt as string }])
  expect(problems).toEqual([])
})

test('Esc closes a manually opened screen without posting dismiss', async () => {
  await mount()
  await click(statusBarVersionButton(), 'status bar version button')
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)

  await pressEscape()

  expect(dialog() === null).toBe(true)
  expect(postCalls).toEqual([])
})

test('the X closes a manually opened screen without posting dismiss, even while an install is pending', async () => {
  // pending, but already auto-opened and dismissed on this page load — then
  // reopened from the status bar: closing that must not dismiss again.
  getState = PENDING
  await mount()
  await click(
    buttons().find((b) => text(b) === en.whatsNew.close),
    'Got it',
  )
  expect(postCalls).toHaveLength(1)

  await click(statusBarVersionButton(), 'status bar version button')
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)
  await click(closeX(en.whatsNew.close), 'close (X)')

  expect(dialog() === null).toBe(true)
  expect(postCalls).toHaveLength(1)
})

// Content ------------------------------------------------------------------------

test('the rendered changelog lists every release, newest first, ending with the oldest', async () => {
  getState = PENDING
  await mount()

  const rendered = [...(dialog()?.querySelectorAll('ol > li') ?? [])].map(
    (li) => li.querySelector('span.font-medium')?.textContent,
  )
  const expected = sortReleasesByVersionDescending(rawChangelog.releases).map((r) => `v${r.version}`)
  expect(rendered).toEqual(expected)
  expect(rendered.length).toBe(rawChangelog.releases.length)
})

test('in Russian the title, kind labels and every changelog line are the Russian ones', async () => {
  await i18n.changeLanguage('ru')
  getState = PENDING
  await mount()

  expect(text(dialogTitle())).toBe(fill(ru.whatsNew.installedTitle, { version: '1.2.151' }))
  const newest = sortReleasesByVersionDescending(rawChangelog.releases)[0]
  const firstRelease = dialog()?.querySelector('ol > li')
  // Each row is [badge slot, line span] — read separately, not as one
  // concatenated textContent. The badge slot stacks all three kind badges
  // (release-entry.tsx's own comment explains why — the tag-alignment
  // fix), with the other two kept `invisible` rather than removed, so
  // `badgeSlot.textContent` alone would read all three concatenated; query
  // down to the one that isn't `invisible` first.
  const rows = [...(firstRelease?.querySelectorAll('ul > li') ?? [])].map((li) => {
    const [badgeSlot, line] = [...li.children]
    const badge = badgeSlot?.querySelector('[data-slot="badge"]:not(.invisible)')
    return [text(badge), text(line)]
  })
  expect(rows).toEqual(
    newest.changes.map((c) => [ru.whatsNew.kind[c.kind as 'new' | 'improved' | 'fixed'], c.ru]),
  )
})

test('a regional code such as ru-RU still resolves to Russian changelog lines, not the English fallback', async () => {
  // What the browser language detector hands i18n for a ru-RU browser with no
  // saved preference. The component compares i18n.language === 'ru'; this
  // pins that i18n normalises the regional code down to 'ru' rather than
  // keeping 'ru-RU' (which would show Russian chrome around English lines).
  await i18n.changeLanguage('ru-RU')
  expect(i18n.language).toBe('ru')
  getState = PENDING
  await mount()

  const newest = sortReleasesByVersionDescending(rawChangelog.releases)[0]
  expect(text(dialog()?.querySelector('ol > li ul > li'))).toContain(newest.changes[0].ru)
})

// Where it must not appear ---------------------------------------------------------

test('a pending install does not show the screen on the bare editor launcher route, nor even fetch it', async () => {
  getState = PENDING
  await mount('/projects/p1/sessions/s1/editor')

  expect(dialog() === null).toBe(true)
  expect(document.body.textContent).not.toContain(fill(en.whatsNew.installedTitle, { version: '1.2.151' }))
  expect(getCalls).toBe(0)
})

// Racing the first GET -------------------------------------------------------------

test('opening it from the status bar before GET /whats-new answers keeps it a manual "What\'s new" — closing it does not dismiss', async () => {
  // Spec: the status-bar reopen is titled "What's new" and closing it never
  // calls dismiss. A slow first GET that then answers pending: true must not
  // turn the operator's manual open into an "installed" one under them.
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
  expect(text(dialogTitle())).toBe(en.whatsNew.manualTitle)

  await click(buttons().find((b) => text(b) === en.whatsNew.close), 'Got it')
  expect(postCalls).toEqual([])
})

// Accessible names -----------------------------------------------------------------

test('the status bar version button’s accessible name contains its visible text (WCAG 2.5.3 label in name)', async () => {
  await mount()
  const button = statusBarVersionButton()
  const visible = text(button)
  expect(visible).toBe('v1.2.150')
  const name = button?.getAttribute('aria-label') ?? visible
  expect(name).toContain(visible)
})

test('in Russian the X’s accessible name is Russian too, not the English "Close"', async () => {
  await i18n.changeLanguage('ru')
  getState = PENDING
  await mount()
  const x = closeX(ru.whatsNew.close)
  expect(x !== undefined).toBe(true)
  const name = x?.getAttribute('aria-label') ?? text(x)
  expect(name).not.toBe('Close')
  expect(name).toMatch(/[А-Яа-яЁё]/)
})
