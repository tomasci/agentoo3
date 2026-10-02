// The strings the Env files page added (`envFiles.*`, `nav.env`): every key
// the feature reads exists in both en.json and ru.json, the Russian copy is
// actually Russian, interpolations carry their placeholders in both, and the
// path-rule reason keys (handed back by lib/path-rules.ts and passed through
// `t()`) resolve. Modelled on tests/i18n-ports-parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// which is why this is a test rather than something a reviewer would notice.

import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
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

const FEATURE = new URL('../src/features/env-files/', import.meta.url)
const featureSources = async () => {
  const files = readdirSync(FEATURE, { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.tsx?$/.test(f),
  )
  return (await Promise.all(files.map((f) => Bun.file(new URL(f, FEATURE)).text()))).join('\n')
}

const ENV_KEYS = leaves(lookup(en, 'envFiles')).map((k) => `envFiles.${k}`)

test('envFiles has exactly the same keys in both locales, and nav.env exists in both', () => {
  expect(leaves(lookup(ru, 'envFiles')).sort()).toEqual(leaves(lookup(en, 'envFiles')).sort())
  expect(en.nav.env).toBe('Env files')
  expect(typeof ru.nav.env).toBe('string')
  expect(Object.keys(ru.nav).sort()).toEqual(Object.keys(en.nav).sort())
})

test('every envFiles key is a non-empty string in both locales', () => {
  const problems: string[] = []
  for (const key of [...ENV_KEYS, 'nav.env']) {
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

test('ru values are not copies of en, and are written in Cyrillic', () => {
  const keys = [...ENV_KEYS, 'nav.env']
  const copied = keys.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = keys.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  // `envFiles.card.meta` is `{{size}} · updated {{updatedAt}}` — it still
  // has a translatable word, so it is not exempt.
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('interpolated keys carry the same placeholders in both locales', () => {
  const tokens = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()
  const mismatched = ENV_KEYS.filter(
    (key) => JSON.stringify(tokens(String(lookup(en, key)))) !== JSON.stringify(tokens(String(lookup(ru, key)))),
  )
  expect(mismatched).toEqual([])
  // And the ones the components pass values for really have them.
  expect(tokens(en.envFiles.card.meta)).toEqual(['size', 'updatedAt'])
  for (const k of ['contentLabel', 'saved', 'deleted', 'deleteConfirmBody'] as const) {
    expect(tokens(en.envFiles.card[k])).toEqual(['path'])
  }
})

test('every literal t() key the feature and sidebar read exists in both locales', async () => {
  const src =
    (await featureSources()) +
    (await Bun.file(new URL('../src/app/sidebar.tsx', import.meta.url)).text())
  const used = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(used).toContain('nav.env')
  expect(used.filter((k) => k.startsWith('envFiles.')).length).toBeGreaterThan(20)
  const missing = used.filter(
    (key) => typeof lookup(en, key) !== 'string' || typeof lookup(ru, key) !== 'string',
  )
  expect(missing).toEqual([])
})

test('every validation reason key path-rules.ts can hand back exists in both locales', async () => {
  const rules = await Bun.file(new URL('lib/path-rules.ts', FEATURE)).text()
  const keys = [...rules.matchAll(/messageKey: '([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(keys.length).toBe(12)
  const missing = keys.filter(
    (key) => typeof lookup(en, key) !== 'string' || typeof lookup(ru, key) !== 'string',
  )
  expect(missing).toEqual([])
})

test('no envFiles key is dead: each one is referenced by the feature', async () => {
  const src = await featureSources()
  const unreferenced = ENV_KEYS.filter((key) => !src.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})
