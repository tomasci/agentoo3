// The strings the Library page's "System prompts" section added: every one
// exists in both en.json and ru.json, the Russian copy is actually Russian,
// the page references them, and the retired sidebar label `nav.prompts` is
// gone from both. Modelled on tests/i18n-usage-parity.test.ts.
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

const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix]

const NEW_KEYS = [
  'library.systemPrompts',
  'library.table.source',
  'library.promptSource.custom',
  'library.promptSource.default',
  'prompts.items.idea-to-prompt.title',
  'prompts.items.idea-to-prompt.description',
] as const

test('every new key is a non-empty string in en.json and ru.json', () => {
  const missing: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('library.promptSource and prompts.items have exactly the same keys in both locales', () => {
  for (const group of ['library.promptSource', 'prompts.items']) {
    expect(leaves(lookup(ru, group)).sort()).toEqual(leaves(lookup(en, group)).sort())
  }
})

// Compared by base name, plural suffix stripped: English and Russian need a
// different set of plural categories (library.usedByCount, .bundledCount), so
// a literal key-set comparison would flag a correct translation — the same
// reasoning as tests/i18n-usage-parity.test.ts.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other|plural)$/
const baseNames = (node: unknown) => [...new Set(leaves(node).map((k) => k.replace(PLURAL_SUFFIX, '')))].sort()

test('the whole library and prompts blocks have the same keys in both locales (by plural base name)', () => {
  for (const group of ['library', 'prompts']) {
    expect(baseNames(lookup(ru, group))).toEqual(baseNames(lookup(en, group)))
  }
})

test('nav.prompts is gone from both locales, and nav keys still match', () => {
  expect(lookup(en, 'nav.prompts')).toBeUndefined()
  expect(lookup(ru, 'nav.prompts')).toBeUndefined()
  expect(Object.keys(ru.nav).sort()).toEqual(Object.keys(en.nav).sort())
})

test('the English labels are the ones the spec names', () => {
  expect(lookup(en, 'library.systemPrompts')).toBe('System prompts')
  expect(lookup(en, 'library.table.source')).toBe('Source')
  expect(lookup(en, 'library.promptSource.custom')).toBe('Custom')
  expect(lookup(en, 'library.promptSource.default')).toBe('Built-in default')
  expect(lookup(en, 'prompts.items.idea-to-prompt.title')).toBe('Idea → prompt instruction')
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('nothing under src/ still reads nav.prompts', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const srcDir = new URL('../src/', import.meta.url).pathname
  const hits: string[] = []
  for await (const file of glob.scan(srcDir)) {
    if (file.includes('/generated/')) continue
    const text = await Bun.file(srcDir + file).text()
    if (text.includes("'nav.prompts'")) hits.push(file)
  }
  expect(hits).toEqual([])
})

test('the library page references every new key (prompt items through their template prefix)', async () => {
  const page = await Bun.file(
    new URL('../src/features/library/components/library-page.tsx', import.meta.url),
  ).text()
  const unreferenced = NEW_KEYS.filter((key) => {
    if (page.includes(`'${key}'`)) return false
    return !(key.startsWith('prompts.items.') && page.includes('`prompts.items.${'))
  })
  expect(unreferenced).toEqual([])
})
