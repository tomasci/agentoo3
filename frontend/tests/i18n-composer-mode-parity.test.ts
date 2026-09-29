// The visual/raw toggle's i18n: `sessions.composerMode.*` exists in both
// locales, the Russian is actually Russian, and `composer.tsx` really
// references each key — same approach as tests/i18n-tooltips-parity.test.ts.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const NEW_KEYS = [
  'sessions.composerMode.source',
  'sessions.composerMode.showSource',
  'sessions.composerMode.showFormatted',
] as const

const COMPOSER = readFileSync(
  join(import.meta.dir, '../src/features/sessions/components/composer.tsx'),
  'utf8',
)

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

test('no ru value is a copy of the en one', () => {
  expect(NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))).toEqual([])
})

test('every ru value is written in Cyrillic', () => {
  expect(NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))).toEqual([])
})

test('composer.tsx references each new key', () => {
  const unreferenced = NEW_KEYS.filter((key) => !COMPOSER.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})

test("showSource and showFormatted are different labels, in both locales", () => {
  expect(en.sessions.composerMode.showSource).not.toBe(en.sessions.composerMode.showFormatted)
  expect(ru.sessions.composerMode.showSource).not.toBe(ru.sessions.composerMode.showFormatted)
})
