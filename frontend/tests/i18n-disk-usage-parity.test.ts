// The strings the disk-usage feature added — the table's "Size" column header
// (`projects.table.size`) and the `projects.diskUsage` block behind the table
// cell and the Settings page's "Size on disk" fact: every one exists in both
// en.json and ru.json, the block has exactly the same keys in both locales,
// the `{{placeholders}}` line up, the ru copy is actually Russian and not a
// copy of the English, and the components reference every key. Modelled on
// tests/i18n-git-identity-parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      root,
    )

const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix]

const NEW_KEYS = [
  'projects.table.size',
  'projects.diskUsage.term',
  'projects.diskUsage.measuring',
  'projects.diskUsage.loadFailed',
  'projects.diskUsage.recalculate',
  'projects.diskUsage.breakdown',
  'projects.diskUsage.measuredAt',
  'projects.diskUsage.measureFailed',
  'projects.diskUsage.refreshFailed',
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

test('the whole projects.diskUsage block has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'projects.diskUsage')).sort()).toEqual(
    leaves(lookup(en, 'projects.diskUsage')).sort(),
  )
})

test('every new string carries the same interpolation placeholders in both locales', () => {
  const mismatched = NEW_KEYS.filter(
    (key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join(),
  )
  expect(mismatched).toEqual([])
})

test('the strings that take a value interpolate the ones the components pass', () => {
  const expected: Record<string, string[]> = {
    'projects.diskUsage.breakdown': ['repo', 'worktrees'],
    'projects.diskUsage.measuredAt': ['when'],
    'projects.diskUsage.measureFailed': ['reason'],
  }
  for (const [key, names] of Object.entries(expected)) {
    expect(placeholders(lookup(en, key))).toEqual(names)
    expect(placeholders(lookup(ru, key))).toEqual(names)
  }
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the table, the cell, the Settings page and the fact reference every new key', async () => {
  const read = (name: string) =>
    Bun.file(new URL(`../src/features/projects/components/${name}`, import.meta.url)).text()
  const source = (
    await Promise.all([
      read('projects-table.tsx'),
      read('project-size-cell.tsx'),
      read('project-overview.tsx'),
      read('project-disk-usage-fact.tsx'),
    ])
  ).join('\n')
  const unreferenced = NEW_KEYS.filter((key) => !source.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})
