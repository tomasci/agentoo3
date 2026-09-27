// The strings the Sessions dashboard and the Overview → Settings move added:
// every one exists in both en.json and ru.json, the Russian copy is actually
// Russian, the headings keep their `{{count}}`, and the components reference
// the keys they are supposed to.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

/** Every leaf key under `node`, dotted. */
const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix]

const NEW_KEYS = [
  'nav.systemSessions',
  'nav.projectSettings',
  'sessions.dashboard.heading',
  'sessions.dashboard.lead',
  'sessions.dashboard.loadFailed',
  'sessions.dashboard.table.project',
  'sessions.dashboard.table.lastActivity',
  'sessions.dashboard.table.finished',
  'sessions.dashboard.running.heading',
  'sessions.dashboard.running.empty',
  'sessions.dashboard.unchecked.heading',
  'sessions.dashboard.unchecked.empty',
  'sessions.dashboard.recent.heading',
  'sessions.dashboard.recent.empty',
  'sessions.dashboard.recent.windowLabel',
  'sessions.dashboard.recent.window.1d',
  'sessions.dashboard.recent.window.3d',
  'sessions.dashboard.recent.window.7d',
] as const

test('every new key is a non-empty string in en.json and ru.json', () => {
  const problems: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}:${key}`)
    }
  }
  expect(problems).toEqual([])
})

test('sessions.dashboard has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'sessions.dashboard')).sort()).toEqual(
    leaves(lookup(en, 'sessions.dashboard')).sort(),
  )
})

test('the nav block has exactly the same keys in both locales', () => {
  expect(Object.keys(ru.nav).sort()).toEqual(Object.keys(en.nav).sort())
})

test('the whole files agree, allowing only per-language plural suffixes', () => {
  const PLURAL = /_(zero|one|two|few|many|other|plural)$/
  const base = (keys: string[]) => new Set(keys.map((k) => k.replace(PLURAL, '')))
  const enKeys = base(leaves(en))
  const ruKeys = base(leaves(ru))
  expect({
    missingInRu: [...enKeys].filter((k) => !ruKeys.has(k)).sort(),
    missingInEn: [...ruKeys].filter((k) => !enKeys.has(k)).sort(),
  }).toEqual({ missingInRu: [], missingInEn: [] })
})

test('the sidebar labels are the ones the spec names', () => {
  expect([en.nav.systemSessions, en.nav.projectSettings]).toEqual(['Sessions', 'Settings'])
  expect([ru.nav.systemSessions, ru.nav.projectSettings]).toEqual(['Сессии', 'Настройки'])
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('every section heading interpolates {{count}} in both locales', () => {
  const missing: string[] = []
  for (const section of ['running', 'unchecked', 'recent']) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const key = `sessions.dashboard.${section}.heading`
      if (!String(lookup(bundle, key)).includes('{{count}}')) missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('the components reference every new key', async () => {
  const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text()
  const all = (
    await Promise.all(
      ['app/sidebar.tsx', 'features/sessions/components/sessions-dashboard-page.tsx'].map(src),
    )
  ).join('\n')
  // The three window labels are built from a template literal over `WINDOWS`.
  const templated = /sessions\.dashboard\.recent\.window\.\$\{/.test(all)
  const unreferenced = NEW_KEYS.filter((key) =>
    key.startsWith('sessions.dashboard.recent.window.') ? !templated : !all.includes(`'${key}'`),
  )
  expect(unreferenced).toEqual([])
})

test('every sessions.dashboard key the dashboard page reads exists in both locales', async () => {
  const page = await Bun.file(
    new URL('../src/features/sessions/components/sessions-dashboard-page.tsx', import.meta.url),
  ).text()
  const used = [...page.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(used.length).toBeGreaterThan(0)
  const missing = used.filter(
    (key) => typeof lookup(en, key) !== 'string' || typeof lookup(ru, key) !== 'string',
  )
  expect(missing).toEqual([])
})
