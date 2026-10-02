// The strings the custom-background picker on /settings added: every one
// exists in both en.json and ru.json, the Russian is actually Russian, the
// colour/pattern blocks hold exactly the catalog's ids, every catalog
// `labelKey` resolves in both locales, and `settings.lead` was reworded in
// both. Modelled on tests/i18n-settings-parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// which is why this file exists at all.

import { expect, test } from 'bun:test'
import { BACKGROUND_OPTIONS, PATTERN_OPTIONS } from '../src/features/appearance/lib/catalog'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
const PATTERNS = ['code', 'space', 'nature', 'weather', 'doodles', 'geometric'] as const

const NEW_KEYS = [
  'settings.background',
  'settings.backgroundHint',
  'settings.backgroundNone',
  ...[...COLORS, ...GRADIENTS].map((id) => `settings.backgrounds.${id}`),
  'settings.pattern',
  'settings.patternHint',
  'settings.patternNone',
  ...PATTERNS.map((id) => `settings.patterns.${id}`),
]

const LOCALES = [
  ['en', en],
  ['ru', ru],
] as const

test('every new key is a non-empty string in en.json and ru.json', () => {
  expect(NEW_KEYS).toHaveLength(3 + 17 + 3 + 6)
  const missing: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of LOCALES) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('settings.backgrounds and settings.patterns hold exactly the catalog ids, in both locales', () => {
  for (const [, bundle] of LOCALES) {
    expect(Object.keys(lookup(bundle, 'settings.backgrounds') as object).sort()).toEqual(
      [...COLORS, ...GRADIENTS].sort(),
    )
    expect(Object.keys(lookup(bundle, 'settings.patterns') as object).sort()).toEqual(
      [...PATTERNS].sort(),
    )
  }
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('no two options in a group share a label, in either locale', () => {
  // Two swatches with the same accessible name are indistinguishable to a
  // screen reader.
  for (const [locale, bundle] of LOCALES) {
    for (const options of [BACKGROUND_OPTIONS, PATTERN_OPTIONS]) {
      const labels = options.map((o) => lookup(bundle, o.labelKey))
      expect({ locale, unique: new Set(labels).size }).toEqual({ locale, unique: labels.length })
    }
  }
})

test('every catalog labelKey resolves to a string in both locales', () => {
  const keys = [...BACKGROUND_OPTIONS, ...PATTERN_OPTIONS].map((o) => o.labelKey)
  expect(keys).toHaveLength(18 + 7)
  const unresolved: string[] = []
  for (const key of keys) {
    for (const [locale, bundle] of LOCALES) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') unresolved.push(`${locale}:${key}`)
    }
  }
  expect(unresolved).toEqual([])
})

test('settings.lead was reworded in both locales and now mentions the background', () => {
  // The wording before this feature, from `git show HEAD:…/locales/*.json`.
  expect(lookup(en, 'settings.lead')).not.toBe(
    'Preferences for this installation — language and theme stay in your browser, the session limit lives on the server.',
  )
  expect(lookup(ru, 'settings.lead')).not.toBe(
    'Параметры этой установки — язык и тема хранятся в вашем браузере, а лимит сессий — на сервере.',
  )
  expect(String(lookup(en, 'settings.lead'))).toMatch(/background/i)
  expect(String(lookup(ru, 'settings.lead'))).toMatch(/фон/i)
})

test('the picker component references the group headings and hints', async () => {
  const source = await Bun.file(
    new URL('../src/features/appearance/components/background-fields.tsx', import.meta.url),
  ).text()
  const keys = [
    'settings.background',
    'settings.backgroundHint',
    'settings.pattern',
    'settings.patternHint',
  ]
  expect(keys.filter((key) => !source.includes(`'${key}'`))).toEqual([])
})
