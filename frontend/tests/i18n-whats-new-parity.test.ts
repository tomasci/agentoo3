// The "What's new" screen's own `whatsNew` namespace: every key is a
// non-empty, really-translated string in both locales, the key sets match,
// interpolation placeholders line up, and every key is actually referenced
// from the feature's own source. Modelled on tests/i18n-settings-parity.test.ts.

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
  'whatsNew.installedTitle',
  'whatsNew.installedSubtitle',
  'whatsNew.manualTitle',
  'whatsNew.manualSubtitle',
  'whatsNew.close',
  'whatsNew.statusBarLabel',
  'whatsNew.dismissFailed',
  'whatsNew.kind.new',
  'whatsNew.kind.improved',
  'whatsNew.kind.fixed',
] as const

/** `{{name}}` placeholders in a string, sorted. */
const placeholders = (value: unknown) =>
  [...String(value).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()

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

test('the whole whatsNew namespace has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'whatsNew')).sort()).toEqual(leaves(lookup(en, 'whatsNew')).sort())
})

test('every whatsNew string carries the same interpolation placeholders in both locales', () => {
  const mismatched = leaves(lookup(en, 'whatsNew'))
    .map((k) => `whatsNew.${k}`)
    .filter((key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join())
  expect(mismatched).toEqual([])
})

test('the titles that name a version actually interpolate {{version}} in both locales', () => {
  for (const key of ['whatsNew.installedTitle', 'whatsNew.manualSubtitle']) {
    expect(placeholders(lookup(en, key))).toEqual(['version'])
    expect(placeholders(lookup(ru, key))).toEqual(['version'])
  }
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the feature references every new key', async () => {
  const base = new URL('../src/features/whats-new/', import.meta.url).pathname
  const files: string[] = []
  for await (const rel of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: base })) files.push(`${base}${rel}`)
  // The status bar is the other reader of whatsNew.statusBarLabel.
  files.push(new URL('../src/app/status-bar.tsx', import.meta.url).pathname)

  const sources = await Promise.all(files.map((f) => Bun.file(f).text()))
  const combined = sources.join('\n')

  const unreferenced = NEW_KEYS.filter((key) => {
    if (key.startsWith('whatsNew.kind.')) {
      // Read as a template literal, `t(\`whatsNew.kind.${change.kind}\`)`, not a string literal.
      return !combined.includes('whatsNew.kind.${')
    }
    return !combined.includes(`'${key}'`)
  })
  expect(unreferenced).toEqual([])
})
