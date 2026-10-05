// The notification bell's own `notifications` namespace: every key the
// feature reads is a non-empty string in both locales, the key sets match,
// interpolation placeholders line up, no value carries a count placeholder
// (the bell never shows one), and the Russian is a real translation rather
// than the English copied over. Modelled on tests/i18n-whats-new-parity.test.ts.

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

const placeholders = (value: unknown) =>
  [...String(value).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()

const featureSources = async () => {
  const base = new URL('../src/features/notifications/', import.meta.url).pathname
  const files: string[] = []
  for await (const rel of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: base })) {
    files.push(`${base}${rel}`)
  }
  return (await Promise.all(files.map((f) => Bun.file(f).text()))).join('\n')
}

/** Every `notifications.*` key the feature's source reads as a string literal. */
const usedKeys = async () =>
  [
    ...new Set(
      [...(await featureSources()).matchAll(/'(notifications\.[\w.]+)'/g)].map((m) => m[1]),
    ),
  ]
    .filter((k): k is string => Boolean(k))
    .sort()

const ALL_KEYS = leaves(lookup(en, 'notifications')).map((k) => `notifications.${k}`)

test('the feature reads at least the keys the spec names', async () => {
  const used = await usedKeys()
  for (const key of [
    'notifications.bell',
    'notifications.bellUnread',
    'notifications.unread',
    'notifications.loadFailed',
    'notifications.empty.title',
    'notifications.empty.description',
    'notifications.truncated',
  ]) {
    expect(used).toContain(key)
  }
})

test('every notifications.* key the feature reads is a non-empty string in en.json and ru.json', async () => {
  const missing: string[] = []
  for (const key of await usedKeys()) {
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

test('the whole notifications namespace has exactly the same keys in both locales', () => {
  expect(ALL_KEYS.length).toBeGreaterThan(0)
  expect(leaves(lookup(ru, 'notifications')).sort()).toEqual(
    leaves(lookup(en, 'notifications')).sort(),
  )
})

test('every key in the namespace is used by the feature (no dead strings)', async () => {
  const used = await usedKeys()
  expect(ALL_KEYS.filter((k) => !used.includes(k))).toEqual([])
})

test('placeholders line up, and no notifications string interpolates a count', () => {
  const mismatched = ALL_KEYS.filter(
    (key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join(),
  )
  expect(mismatched).toEqual([])
  const withCount = ALL_KEYS.filter((key) =>
    [...placeholders(lookup(en, key)), ...placeholders(lookup(ru, key))].includes('count'),
  )
  expect(withCount).toEqual([])
  const withDigits = ALL_KEYS.filter((key) =>
    /\d/.test(`${String(lookup(en, key))}${String(lookup(ru, key))}`),
  )
  expect(withDigits).toEqual([])
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = ALL_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = ALL_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the borrowed keys a row renders exist in both locales for every value the API can send', async () => {
  const { sessionNotificationItemStatusEnum } = await import(
    '../src/shared/api/generated/types/SessionNotificationItem'
  )
  const { suggestionNotificationItemKindEnum, suggestionNotificationItemActionEnum } = await import(
    '../src/shared/api/generated/types/SuggestionNotificationItem'
  )
  const keys = [
    'common.loading',
    'sessions.untitled',
    ...Object.values(sessionNotificationItemStatusEnum).map((s) => `sessions.status.${s}`),
    ...Object.values(suggestionNotificationItemActionEnum).map(
      (a) => `library.suggestions.action.${a}`,
    ),
    ...Object.values(suggestionNotificationItemKindEnum).map(
      (k) => `library.suggestions.kind.${k}`,
    ),
  ]
  const missing: string[] = []
  for (const key of keys) {
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
