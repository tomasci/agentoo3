// The Automations feature's strings: `nav.automations` and the whole
// `automations` namespace have the same keys and the same {{placeholders}} in
// en.json and ru.json, every key the feature reads exists in both, and the
// Russian is a translation rather than the English copied over. Modelled on
// tests/i18n-notifications-parity.test.ts. Plural suffixes are collapsed the
// way tests/i18n-ideas-parity.test.ts does, so en's one/other and ru's
// one/few/many count as the same concept.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

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

const EN_KEYS = leaves(lookup(en, 'automations')).map((k) => `automations.${k}`)
const RU_KEYS = leaves(lookup(ru, 'automations')).map((k) => `automations.${k}`)
const collapse = (keys: string[]) =>
  [...new Set(keys.map((k) => k.replace(PLURAL_SUFFIX, '')))].sort()

const featureSources = async () => {
  const roots = ['../src/features/automations/', '../src/app/']
  const texts: string[] = []
  for (const r of roots) {
    const base = new URL(r, import.meta.url).pathname
    for await (const rel of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: base })) {
      texts.push(await Bun.file(`${base}${rel}`).text())
    }
  }
  return texts.join('\n')
}

test('nav.automations is a non-empty string in both locales, translated', () => {
  expect(lookup(en, 'nav.automations')).toBe('Automations')
  const ruValue = lookup(ru, 'nav.automations')
  expect(typeof ruValue).toBe('string')
  expect(String(ruValue).trim()).not.toBe('')
  expect(ruValue).not.toBe('Automations')
  expect(placeholders(ruValue)).toEqual(placeholders(lookup(en, 'nav.automations')))
})

test('the automations namespace has exactly the same keys in both locales', () => {
  expect(EN_KEYS.length).toBeGreaterThan(0)
  const enSet = collapse(EN_KEYS)
  const ruSet = collapse(RU_KEYS)
  expect({ missingInRu: enSet.filter((k) => !ruSet.includes(k)) }).toEqual({ missingInRu: [] })
  expect({ missingInEn: ruSet.filter((k) => !enSet.includes(k)) }).toEqual({ missingInEn: [] })
})

test('every leaf is a non-empty string in both locales', () => {
  const bad: string[] = []
  for (const [locale, bundle, keys] of [
    ['en', en, EN_KEYS],
    ['ru', ru, RU_KEYS],
  ] as const) {
    for (const key of keys) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') bad.push(`${locale}:${key}`)
    }
  }
  expect(bad).toEqual([])
})

test('{{placeholders}} are identical between en and ru for every key', () => {
  const mismatched = EN_KEYS.filter((key) => RU_KEYS.includes(key))
    .filter((key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join())
    .map(
      (key) => `${key}: en ${placeholders(lookup(en, key))} / ru ${placeholders(lookup(ru, key))}`,
    )
  expect(mismatched).toEqual([])
})

test('every automations.* key the source reads as a literal exists in both locales', async () => {
  const src = await featureSources()
  const used = [
    ...new Set([...src.matchAll(/'(automations\.[\w.]+)'/g)].map((m) => m[1] as string)),
  ]
  expect(used.length).toBeGreaterThan(20)
  const missing: string[] = []
  for (const key of used) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      if (typeof lookup(bundle, key) !== 'string') missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('the keys the feature builds at runtime exist for every value they can take', async () => {
  const { automationRunStatusEnum, automationRunSessionStatusEnum } = await import(
    '../src/shared/api/generated/types/AutomationRun'
  )
  const keys = [
    ...['daily', 'weekdays', 'weekends', 'days', 'hourly', 'custom'].map(
      (k) => `automations.schedule.kind.${k}`,
    ),
    ...Object.values(automationRunStatusEnum).map((s) => `automations.runs.status.${s}`),
    ...Object.values(automationRunSessionStatusEnum).map((s) => `sessions.status.${s}`),
    'sessions.untitled',
    'common.loading',
    'common.edit',
    'common.delete',
    'common.save',
    'common.cancel',
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

test('ru values are not copies of the en ones', () => {
  const copied = EN_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  expect(copied).toEqual([])
})
