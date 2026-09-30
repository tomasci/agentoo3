// The strings the Ports page added: every one exists in both en.json and
// ru.json, the Russian copy is actually Russian, and the page references the
// keys it is supposed to. Modelled on tests/i18n-sessions-dashboard-parity.test.ts.
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
  'nav.ports',
  'ports.heading',
  'ports.lead',
  'ports.loadFailed',
  'ports.refresh',
  'ports.scope.label',
  'ports.scope.listening',
  'ports.scope.all',
  'ports.filter.placeholder',
  'ports.count',
  'ports.empty',
  'ports.noMatch',
  'ports.unknownProcess',
  'ports.table.protocol',
  'ports.table.localAddress',
  'ports.table.port',
  'ports.table.pid',
  'ports.table.processName',
  'ports.table.state',
  'ports.table.peer',
  'ports.unattributed.withUser',
  'ports.unattributed.withoutUser',
  'ports.unattributed.root',
  'ports.truncated',
  'ports.lastRefreshed',
  'ports.source.ss',
  'ports.source.proc',
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

test('ports has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'ports')).sort()).toEqual(leaves(lookup(en, 'ports')).sort())
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

test('the sidebar label is the one the spec names', () => {
  expect(en.nav.ports).toBe('Ports')
  expect(ru.nav.ports).toBe('Порты')
})

// `PID`, `ss` and `/proc` are literal technical tokens (an acronym, a
// command name, a filesystem path) rather than words — correctly identical
// in both locales, unlike every other new key here.
const UNTRANSLATABLE_KEYS = ['ports.table.pid', 'ports.source.ss', 'ports.source.proc']
const TRANSLATABLE_KEYS = NEW_KEYS.filter((key) => !UNTRANSLATABLE_KEYS.includes(key))

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = TRANSLATABLE_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = TRANSLATABLE_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the untranslatable technical tokens really are identical in both locales', () => {
  const mismatched = UNTRANSLATABLE_KEYS.filter((key) => lookup(en, key) !== lookup(ru, key))
  expect(mismatched).toEqual([])
})

test('the interpolated keys carry their placeholders in both locales', () => {
  const placeholders: Record<string, string[]> = {
    'ports.count': ['{{shown}}', '{{total}}'],
    'ports.table.peer': ['{{hostPort}}'],
    'ports.unattributed.withUser': ['{{count}}', '{{total}}', '{{user}}'],
    'ports.unattributed.withoutUser': ['{{count}}', '{{total}}'],
    'ports.unattributed.root': ['{{count}}', '{{total}}'],
    'ports.truncated': ['{{shown}}', '{{total}}'],
    'ports.lastRefreshed': ['{{time}}', '{{source}}'],
  }
  const missing: string[] = []
  for (const [key, tokens] of Object.entries(placeholders)) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = String(lookup(bundle, key))
      for (const token of tokens) {
        if (!value.includes(token)) missing.push(`${locale}:${key}:${token}`)
      }
    }
  }
  expect(missing).toEqual([])
})

test('the sidebar and the ports page reference the new keys', async () => {
  const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text()
  const all = (
    await Promise.all(['app/sidebar.tsx', 'features/system/components/ports-page.tsx'].map(src))
  ).join('\n')
  // `ports.source.ss` / `ports.source.proc` are read through a template
  // literal (`` t(`ports.source.${ports.data.source}`) ``), not a literal key.
  const templated = /ports\.source\.\$\{/.test(all)
  const unreferenced = NEW_KEYS.filter((key) =>
    key.startsWith('ports.source.') ? !templated : !all.includes(`'${key}'`),
  )
  expect(unreferenced).toEqual([])
})

test('every ports.* and nav.ports key the page and sidebar read exists in both locales', async () => {
  const page = await Bun.file(
    new URL('../src/features/system/components/ports-page.tsx', import.meta.url),
  ).text()
  const used = [...page.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(used.length).toBeGreaterThan(0)
  const missing = used.filter(
    (key) => typeof lookup(en, key) !== 'string' || typeof lookup(ru, key) !== 'string',
  )
  expect(missing).toEqual([])
})
