// The strings the System tab's Docker page (docker-system-page.tsx,
// docker-system-table.tsx) added: every one exists in both en.json and
// ru.json, the Russian copy is actually Russian, and the components
// reference the keys they are supposed to. Same shape as
// tests/i18n-sessions-dashboard-parity.test.ts, this feature's own closest
// analog.
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

/** Every leaf key under `node`, dotted. */
const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix]

const NEW_KEYS = [
  'nav.dockerSystem',
  'docker.system.heading',
  'docker.system.lead',
  'docker.system.refresh',
  'docker.system.updatedAt',
  'docker.system.loadFailed',
  'docker.system.disabledNotice',
  'docker.system.daemon.notInstalledTitle',
  'docker.system.daemon.notInstalled',
  'docker.system.daemon.unavailableTitle',
  'docker.system.daemon.unavailable',
  'docker.system.empty.title',
  'docker.system.empty.description',
  'docker.system.table.name',
  'docker.system.table.status',
  'docker.system.table.ports',
  'docker.system.table.owner',
  'docker.system.status.running',
  'docker.system.status.stopped',
  'docker.system.status.stoppedWithCode',
  'docker.system.status.paused',
  'docker.system.status.restarting',
  'docker.system.status.removing',
  'docker.system.owner.editor',
  'docker.system.owner.open',
  'docker.system.stop',
  'docker.system.stopDisabledReason',
  'docker.system.stopConfirmTitle',
  'docker.system.stopConfirmBody',
  'docker.system.stopSucceeded',
  'docker.system.stopFailed',
  'docker.system.stopConflict',
] as const

// Two of the keys above are the "Docker" brand name and read the same in
// both locales, the same as this feature's existing `docker.heading` /
// `nav.docker` (never asserted otherwise by any test) — excluded from the
// "not a copy"/"actually Russian" checks below for that reason, not
// forgotten by them.
const BRAND_KEYS = new Set(['nav.dockerSystem', 'docker.system.heading'])

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

test('docker.system has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'docker.system')).sort()).toEqual(
    leaves(lookup(en, 'docker.system')).sort(),
  )
})

test('the nav block has exactly the same keys in both locales', () => {
  expect(Object.keys(ru.nav).sort()).toEqual(Object.keys(en.nav).sort())
})

test('the whole files agree, allowing only per-language plural suffixes', () => {
  const PLURAL = /_(zero|one|two|few|many|other|plural)$/
  const base = (keys: string[]) => new Set(keys.map((k) => k.replace(PLURAL, '')))
  const enKeys = base(leaves(en))
  const ruKeys = base(leaves(ru))
  expect({
    missingInRu: [...enKeys].filter((k) => !ruKeys.has(k)).sort(),
    missingInEn: [...ruKeys].filter((k) => !enKeys.has(k)).sort(),
  }).toEqual({ missingInRu: [], missingInEn: [] })
})

test('every {{placeholder}} in an en value is also in the matching ru value', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
  const mismatched = NEW_KEYS.filter((key) => {
    const enValue = String(lookup(en, key))
    const ruValue = String(lookup(ru, key))
    return placeholders(enValue).join(',') !== placeholders(ruValue).join(',')
  })
  expect(mismatched).toEqual([])
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const checked = NEW_KEYS.filter((key) => !BRAND_KEYS.has(key))
  const copied = checked.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = checked.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the components reference every new key', async () => {
  const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text()
  const all = (
    await Promise.all(
      [
        'app/sidebar.tsx',
        'features/docker/components/docker-system-page.tsx',
        'features/docker/components/docker-system-table.tsx',
        'features/docker/lib/system.ts',
      ].map(src),
    )
  ).join('\n')
  const unreferenced = NEW_KEYS.filter((key) => !all.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})

test('every docker.system key the page/table read exists in both locales', async () => {
  const page = await Bun.file(
    new URL('../src/features/docker/components/docker-system-page.tsx', import.meta.url),
  ).text()
  const table = await Bun.file(
    new URL('../src/features/docker/components/docker-system-table.tsx', import.meta.url),
  ).text()
  const used = [...`${page}\n${table}`.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(used.length).toBeGreaterThan(0)
  const missing = used.filter(
    (key) => typeof lookup(en, key) !== 'string' || typeof lookup(ru, key) !== 'string',
  )
  expect(missing).toEqual([])
})
