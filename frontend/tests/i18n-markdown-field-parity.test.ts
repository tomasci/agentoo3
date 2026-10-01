// `MarkdownField`'s toggle i18n: `markdownField.*` exists in both locales, the
// Russian is actually Russian, and `markdown-field.tsx` really references
// each key — same approach as tests/i18n-composer-mode-parity.test.ts.

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
  'markdownField.source',
  'markdownField.showSource',
  'markdownField.showFormatted',
] as const

const FIELD = readFileSync(
  join(import.meta.dir, '../src/shared/components/markdown-field.tsx'),
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

test('the markdownField namespace has exactly the same keys in en and ru', () => {
  expect(Object.keys(ru.markdownField).sort()).toEqual(Object.keys(en.markdownField).sort())
})

test('no ru value is a copy of the en one', () => {
  expect(NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))).toEqual([])
})

test('every ru value is written in Cyrillic', () => {
  expect(NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))).toEqual([])
})

test('markdown-field.tsx references each new key', () => {
  expect(NEW_KEYS.filter((key) => !FIELD.includes(`'${key}'`))).toEqual([])
})

test('showSource and showFormatted are different labels, in both locales', () => {
  expect(en.markdownField.showSource).not.toBe(en.markdownField.showFormatted)
  expect(ru.markdownField.showSource).not.toBe(ru.markdownField.showFormatted)
})
