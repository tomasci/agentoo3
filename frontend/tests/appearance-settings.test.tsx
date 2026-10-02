// The background/pattern picker on /settings (features/appearance's
// `BackgroundFields`, mounted by features/settings' `SettingsPage`), driven
// through the real router and shell so "the shell reflects it" is observed,
// not assumed — same reasoning as tests/settings-page.test.tsx's header.
//
// Contract:
// - two native radio groups, `settings-background` (none + 12 colours + 5
//   gradients, in that order) and `settings-pattern` (none + 6 patterns);
// - each radio's accessible name is its label's translated text (checked in
//   English and, after switching language, in Russian);
// - exactly one radio per group is checked and it is the atom's value —
//   including when storage holds garbage (then: none);
// - choosing one updates the atom, localStorage and the shell at once;
// - the pattern previews draw over whichever colour is currently chosen;
// - with the shell backdrop and every preview mounted together, every
//   `<pattern id>` is unique and every `url(#…)` fill resolves to the pattern
//   in its own svg;
// - the language/theme selects and the session-limit/learning cards still
//   render.
//
// Real translations, through a private i18next instance handed in by
// `I18nextProvider` (never `.use(initReactI18next)` — see
// tests/settings-page.test.tsx's header for why that would leak).
// Not asserted: preview geometry, the preview icon opacity class and the
// 'none' tile's own class (all being retuned concurrently).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { routeTree } from '../src/app/router'
import { BACKGROUND_CLASS_NAME } from '../src/features/appearance/lib/catalog'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'
import { backgroundAtom, backgroundPatternAtom } from '../src/shared/store/ui'

const BG_KEY = 'agentoo:background'
const PATTERN_KEY = 'agentoo:background-pattern'

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
const PATTERNS = ['code', 'space', 'nature', 'weather', 'doodles', 'geometric'] as const
const BACKGROUND_VALUES = ['none', ...COLORS, ...GRADIENTS]
const PATTERN_VALUES = ['none', ...PATTERNS]

const lookup = (bundle: unknown, path: string): string =>
  String(
    path
      .split('.')
      .reduce<unknown>(
        (n, p) => (n !== null && typeof n === 'object' ? (n as Record<string, unknown>)[p] : undefined),
        bundle,
      ),
  )
const backgroundLabel = (bundle: unknown, id: string) =>
  lookup(bundle, id === 'none' ? 'settings.backgroundNone' : `settings.backgrounds.${id}`)
const patternLabel = (bundle: unknown, id: string) =>
  lookup(bundle, id === 'none' ? 'settings.patternNone' : `settings.patterns.${id}`)

const testI18n = i18next.createInstance()
await testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en }, ru: { translation: ru } },
  interpolation: { escapeValue: false },
})

const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

let container: HTMLDivElement
let root: Root | undefined
let store: ReturnType<typeof createStore>
const errors: string[] = []
const realConsoleError = console.error

async function mount(path = '/settings') {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], [])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/system/settings' }], {
    maxConcurrentSessions: { value: 2, source: 'default', defaultValue: 2 },
    learningSchedule: {
      value: { enabled: false, time: '04:00', timezone: 'UTC' },
      source: 'default',
      defaultValue: { enabled: false, time: '04:00', timezone: 'UTC' },
      nextRunAt: null,
    },
  })
  // The status bar's version button and the "what's new" screen
  // (app/root-layout.tsx's Shell) query this on every mount — seeded for the
  // same reason as every other query here, not because this file has
  // anything of its own to say about that screen.
  client.setQueryData(
    [{ url: '/api/whats-new' }],
    { installedVersion: null, installedAt: null, pending: false },
  )

  store = createStore()
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const classesOf = (el: Element | null | undefined) =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
const radios = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)]
const bgRadios = () => radios('settings-background')
const patternRadios = () => radios('settings-pattern')
const checkedValues = (name: string) => radios(name).filter((r) => r.checked).map((r) => r.value)
const radio = (name: string, value: string) => radios(name).find((r) => r.value === value)
/** The accessible name a native radio gets from the <label> wrapping it. */
const nameOf = (input: HTMLInputElement) =>
  (input.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The shell's backdrop layer: aria-hidden, pointer-events-none, inside the
 *  wrapper but not part of the page body — and not an icon (the settings
 *  page's Select chevrons are aria-hidden, pointer-events-none svgs too). */
const backdrop = () =>
  [...document.querySelectorAll('[data-slot="sidebar-wrapper"] [aria-hidden="true"]')].find(
    (el) =>
      classesOf(el).includes('pointer-events-none') &&
      el.tagName.toLowerCase() !== 'svg' &&
      el.closest('[data-slot="sidebar-inset"]') === null,
  )
const hasAll = (el: Element | null | undefined, classes: string) => {
  const have = new Set(classesOf(el))
  return classes.split(/\s+/).filter(Boolean).every((c) => have.has(c))
}
const inset = () => container.querySelector('main[data-slot="sidebar-inset"]')

async function choose(name: string, value: string) {
  const input = radio(name, value)
  if (!input) throw new Error(`no ${name}=${value} radio`)
  await act(async () => {
    input.click()
  })
  await settle()
}

/** Every `<pattern id>` in the document, and every `url(#…)` fill with
 *  whether it resolves to a `<pattern>` inside its own `<svg>`. */
function patternWiring() {
  const ids = [...document.querySelectorAll('pattern')].map((p) => p.getAttribute('id') ?? '')
  const fills = [...document.querySelectorAll('rect[fill^="url(#"]')].map((rect) => {
    const ref = /^url\(#(.+)\)$/.exec(rect.getAttribute('fill') ?? '')?.[1] ?? ''
    const target = document.getElementById(ref)
    return {
      ref,
      ok: target?.tagName.toLowerCase() === 'pattern' && target.closest('svg') === rect.closest('svg'),
    }
  })
  return { ids, fills }
}

beforeEach(async () => {
  document.body.replaceChildren()
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
  await testI18n.changeLanguage('en')
  errors.length = 0
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' ').slice(0, 300))
    realConsoleError(...args)
  }
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  console.error = realConsoleError
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  localStorage.clear()
  document.documentElement.className = ''
})

// --- structure ----------------------------------------------------------------------

test('two radio groups, in the spec order: 18 backgrounds and 7 patterns', async () => {
  await mount()
  expect(bgRadios().map((r) => r.value)).toEqual(BACKGROUND_VALUES)
  expect(patternRadios().map((r) => r.value)).toEqual(PATTERN_VALUES)
})

test('every option is named by its own label, in English', async () => {
  await mount()
  expect(bgRadios().every((r) => r.closest('label') !== null)).toBe(true)
  expect(patternRadios().every((r) => r.closest('label') !== null)).toBe(true)
  expect(bgRadios().map(nameOf)).toEqual(BACKGROUND_VALUES.map((id) => backgroundLabel(en, id)))
  expect(patternRadios().map(nameOf)).toEqual(PATTERN_VALUES.map((id) => patternLabel(en, id)))
})

test('every option is named in Russian once the language is Russian', async () => {
  await mount()
  await act(async () => {
    await testI18n.changeLanguage('ru')
  })
  await settle()
  expect(bgRadios().map(nameOf)).toEqual(BACKGROUND_VALUES.map((id) => backgroundLabel(ru, id)))
  expect(patternRadios().map(nameOf)).toEqual(PATTERN_VALUES.map((id) => patternLabel(ru, id)))
})

test('the group headings are the translated legends', async () => {
  await mount()
  const legends = [...container.querySelectorAll('legend')].map((l) => l.textContent?.trim())
  expect(legends).toContain(en.settings.background)
  expect(legends).toContain(en.settings.pattern)
  // And each group's radios sit inside the fieldset whose legend names it.
  const groupOf = (r: HTMLInputElement) => r.closest('fieldset')?.querySelector('legend')?.textContent?.trim()
  expect([...new Set(bgRadios().map(groupOf))]).toEqual([en.settings.background])
  expect([...new Set(patternRadios().map(groupOf))]).toEqual([en.settings.pattern])
})

test('the existing language/theme selects and both server-backed cards still render', async () => {
  await mount()
  expect(container.querySelector('#settings-language') !== null).toBe(true)
  expect(container.querySelector('#settings-theme') !== null).toBe(true)
  const text = container.textContent ?? ''
  expect(text).toContain(en.settings.sessionsHeading)
  expect(text).toContain(en.settings.learningHeading)
  expect(errors).toEqual([])
})

// --- checked state ------------------------------------------------------------------

test('by default exactly none is checked in each group', async () => {
  await mount()
  expect(checkedValues('settings-background')).toEqual(['none'])
  expect(checkedValues('settings-pattern')).toEqual(['none'])
})

test('the stored choice is the one checked radio in each group', async () => {
  localStorage.setItem(BG_KEY, '"pink"')
  localStorage.setItem(PATTERN_KEY, '"weather"')
  await mount()
  expect(checkedValues('settings-background')).toEqual(['pink'])
  expect(checkedValues('settings-pattern')).toEqual(['weather'])
})

for (const raw of ['{not json', '7', '{"id":"blue"}', '"Purple"', '"stripes"']) {
  test(`garbage in storage (${raw}) checks none in both groups, without errors`, async () => {
    localStorage.setItem(BG_KEY, raw)
    localStorage.setItem(PATTERN_KEY, raw)
    await mount()
    expect(checkedValues('settings-background')).toEqual(['none'])
    expect(checkedValues('settings-pattern')).toEqual(['none'])
    expect(errors).toEqual([])
  })
}

// --- choosing --------------------------------------------------------------------------

test('choosing each background updates the atom, storage and the shell immediately', async () => {
  await mount()
  const wrong: string[] = []
  for (const id of [...COLORS, ...GRADIENTS]) {
    await choose('settings-background', id)
    if (store.get(backgroundAtom) !== id) wrong.push(`${id}: atom=${store.get(backgroundAtom)}`)
    if (localStorage.getItem(BG_KEY) !== JSON.stringify(id))
      wrong.push(`${id}: storage=${localStorage.getItem(BG_KEY)}`)
    if (checkedValues('settings-background').join() !== id)
      wrong.push(`${id}: checked=${checkedValues('settings-background').join()}`)
    if (!hasAll(backdrop(), BACKGROUND_CLASS_NAME[id])) wrong.push(`${id}: backdrop lacks its classes`)
    if (!classesOf(inset()).includes('backdrop-blur-xl')) wrong.push(`${id}: inset not glass`)
  }
  expect(wrong).toEqual([])
})

test('choosing each pattern updates the atom, storage and the shell immediately', async () => {
  await mount()
  const wrong: string[] = []
  for (const id of PATTERNS) {
    await choose('settings-pattern', id)
    if (store.get(backgroundPatternAtom) !== id) wrong.push(`${id}: atom`)
    if (localStorage.getItem(PATTERN_KEY) !== JSON.stringify(id)) wrong.push(`${id}: storage`)
    if (checkedValues('settings-pattern').join() !== id) wrong.push(`${id}: checked`)
    if (!backdrop()?.querySelector('svg pattern')) wrong.push(`${id}: no pattern in backdrop`)
  }
  expect(wrong).toEqual([])
  // Choosing a pattern never touched the background choice.
  expect(store.get(backgroundAtom)).toBe('none')
})

test('choosing none again in both groups removes the backdrop and the glass', async () => {
  await mount()
  await choose('settings-background', 'teal')
  await choose('settings-pattern', 'space')
  expect(backdrop() !== undefined).toBe(true)

  await choose('settings-background', 'none')
  await choose('settings-pattern', 'none')
  expect(store.get(backgroundAtom)).toBe('none')
  expect(store.get(backgroundPatternAtom)).toBe('none')
  expect(checkedValues('settings-background')).toEqual(['none'])
  expect(checkedValues('settings-pattern')).toEqual(['none'])
  expect(backdrop() === undefined).toBe(true)
  expect(classesOf(inset()).filter((c) => c === 'backdrop-blur-xl' || c === 'bg-background/70')).toEqual([])
})

test('clicking the swatch label, not the hidden input, also selects it', async () => {
  await mount()
  const label = radio('settings-background', 'forest')?.closest('label')
  await act(async () => {
    label?.click()
  })
  await settle()
  expect(store.get(backgroundAtom)).toBe('forest')
  expect(checkedValues('settings-background')).toEqual(['forest'])
})

test('a change from another tab moves the checked radio here', async () => {
  await mount()
  const oldValue = localStorage.getItem(BG_KEY)
  localStorage.setItem(BG_KEY, '"brown"')
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: BG_KEY, oldValue, newValue: '"brown"', storageArea: localStorage }),
    )
  })
  await settle()
  expect(checkedValues('settings-background')).toEqual(['brown'])
})

// --- previews -------------------------------------------------------------------------

/** For each pattern option, whether its label contains an element carrying
 *  every class of `colour`. */
const previewsOver = (colour: keyof typeof BACKGROUND_CLASS_NAME) =>
  patternRadios().map((r) => {
    const label = r.closest('label')
    return [...(label?.querySelectorAll('*') ?? [])].some((el) => hasAll(el, BACKGROUND_CLASS_NAME[colour]))
  })

test('the pattern previews draw over the currently chosen colour, and follow a change', async () => {
  await mount()
  await choose('settings-background', 'indigo')
  expect(previewsOver('indigo')).toEqual(PATTERN_VALUES.map(() => true))

  await choose('settings-background', 'peach')
  expect(previewsOver('peach')).toEqual(PATTERN_VALUES.map(() => true))
  expect(previewsOver('indigo')).toEqual(PATTERN_VALUES.map(() => false))
})

test('every pattern option except none carries a preview of its pattern', async () => {
  await mount()
  const withPattern = patternRadios().map((r) => !!r.closest('label')?.querySelector('svg pattern'))
  expect(withPattern).toEqual(PATTERN_VALUES.map((id) => id !== 'none'))
})

test('background swatches each show their own colour', async () => {
  await mount()
  const own = bgRadios()
    .filter((r) => r.value !== 'none')
    .map((r) => {
      const id = r.value as keyof typeof BACKGROUND_CLASS_NAME
      const label = r.closest('label')
      return [...(label?.querySelectorAll('*') ?? [])].some((el) => hasAll(el, BACKGROUND_CLASS_NAME[id]))
    })
  expect(own).toEqual([...COLORS, ...GRADIENTS].map(() => true))
})

// --- ids ---------------------------------------------------------------------------------

test('shell backdrop plus every preview: unique pattern ids, each fill wired to its own svg', async () => {
  // 'code' is both the shell's pattern and a preview's — the collision case.
  localStorage.setItem(BG_KEY, '"blue"')
  localStorage.setItem(PATTERN_KEY, '"code"')
  await mount()
  expect(backdrop()?.querySelectorAll('pattern').length).toBe(1)

  const { ids, fills } = patternWiring()
  expect(ids).toHaveLength(1 + PATTERNS.length)
  expect(ids.filter((id) => id === '')).toEqual([])
  expect(new Set(ids).size).toBe(ids.length)
  expect(fills).toHaveLength(ids.length)
  expect(fills.filter((f) => !f.ok)).toEqual([])
})

test('ids stay unique after switching the shell pattern back and forth', async () => {
  await mount()
  for (const id of ['geometric', 'code', 'geometric', 'nature'] as const) {
    await choose('settings-pattern', id)
  }
  const { ids, fills } = patternWiring()
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toHaveLength(1 + PATTERNS.length)
  expect(fills.filter((f) => !f.ok)).toEqual([])
})
