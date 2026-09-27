// The keys the sessions-list rework (search box, four-column table) added
// exist in both locale files, the Russian copy is actually Russian, and the
// reworded `sessions.empty` no longer points at a form "above" that is now
// behind a button.
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

const NEW_KEYS = [
  'sessions.searchPlaceholder',
  'sessions.noMatches',
  'sessions.table.title',
  'sessions.table.date',
  'sessions.table.status',
  'sessions.empty',
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

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('sessions.table holds exactly title, date and status in both locales', () => {
  for (const bundle of [en, ru]) {
    expect(Object.keys(lookup(bundle, 'sessions.table') as object).sort()).toEqual([
      'date',
      'status',
      'title',
    ])
  }
})

test('sessions.empty no longer says "Create one above", in either locale', () => {
  expect(String(lookup(en, 'sessions.empty'))).not.toContain('Create one above')
  // The old ru copy was "Сессий пока нет. Создайте выше — …".
  expect(String(lookup(ru, 'sessions.empty'))).not.toContain('Создайте выше')
})

test('the components reference every new key', async () => {
  const src = (p: string) =>
    Bun.file(new URL(`../src/features/sessions/components/${p}`, import.meta.url)).text()
  const all = (await Promise.all(['project-sessions.tsx', 'sessions-table.tsx'].map(src))).join('\n')
  const unreferenced = NEW_KEYS.filter((key) => !all.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})
