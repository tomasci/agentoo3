// The strings the Settings page's "Session limit" card added: every one exists
// in both en.json and ru.json, the Russian copy is actually Russian, the
// `{{value}}` placeholders line up, the client-side schema's error keys
// resolve to real strings, and the card references every new key. Modelled on
// tests/i18n-library-prompts-parity.test.ts.
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
  'settings.sessionsHeading',
  'settings.sessionsLead',
  'settings.maxConcurrentSessions',
  'settings.maxConcurrentSessionsHint',
  'settings.maxConcurrentSessionsUsingDefault',
  'settings.maxConcurrentSessionsOverridden',
  'settings.resetToDefault',
  'settings.saved',
  'settings.reset',
  'settings.saveFailed',
  'settings.resetFailed',
  'settings.loadFailed',
  'settings.errors.maxConcurrentSessionsInvalid',
  'settings.errors.maxConcurrentSessionsTooHigh',
] as const

/** `{{name}}` placeholders in a string, sorted — `{{value}}` here. */
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

test('the whole settings block has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'settings')).sort()).toEqual(leaves(lookup(en, 'settings')).sort())
})

test('every settings string carries the same interpolation placeholders in both locales', () => {
  const mismatched = leaves(lookup(en, 'settings'))
    .map((k) => `settings.${k}`)
    .filter((key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join())
  expect(mismatched).toEqual([])
})

test('the default/override status lines interpolate {{value}} in both locales', () => {
  for (const key of [
    'settings.maxConcurrentSessionsUsingDefault',
    'settings.maxConcurrentSessionsOverridden',
  ]) {
    expect(placeholders(lookup(en, key))).toEqual(['value'])
    expect(placeholders(lookup(ru, key))).toEqual(['value'])
  }
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the reworded settings.lead changed in both locales, not only in English', () => {
  // The lead used to say everything here is stored in the browser; with a
  // server-held setting on the page it now names both. A ru copy left on the
  // old wording would still claim "stored in your browser".
  expect(lookup(en, 'settings.lead')).not.toBe(
    'Preferences for this installation, stored in your browser.',
  )
  expect(String(lookup(ru, 'settings.lead'))).toMatch(/сервер/)
})

test("every message key the form schema can raise resolves to a string in both locales", async () => {
  const schema = await Bun.file(
    new URL('../src/features/settings/model/system-settings-form.schema.ts', import.meta.url),
  ).text()
  const keys = [...new Set([...schema.matchAll(/'(settings\.errors\.[\w.]+)'/g)].map((m) => m[1]))]
  expect(keys.length).toBeGreaterThan(0)
  const unresolved = keys.filter(
    (key) => typeof lookup(en, key as string) !== 'string' || typeof lookup(ru, key as string) !== 'string',
  )
  expect(unresolved).toEqual([])
})

test('the session limit card references every new key', async () => {
  const card = await Bun.file(
    new URL('../src/features/settings/components/session-limit-card.tsx', import.meta.url),
  ).text()
  const schema = await Bun.file(
    new URL('../src/features/settings/model/system-settings-form.schema.ts', import.meta.url),
  ).text()
  const unreferenced = NEW_KEYS.filter(
    (key) => !card.includes(`'${key}'`) && !schema.includes(`'${key}'`),
  )
  expect(unreferenced).toEqual([])
})
