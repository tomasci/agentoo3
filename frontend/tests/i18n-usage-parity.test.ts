// The strings the Usage page added: every one exists in both en.json and
// ru.json, the Russian copy is actually Russian, and the page (or the
// sidebar, for nav.usage) references the keys it is supposed to. Modelled on
// tests/i18n-ports-parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts.
//
// Two concepts here are pluralised (`usage.breakdown.requestsCount` and
// `.sessionsCount`) with a *different number* of CLDR categories per
// language — English's `_one`/`_other` versus Russian's `_one`/`_few`/
// `_many` — so, per tests/i18n-ideas-parity.test.ts's own precedent, they
// are checked by their base name (with a trailing plural suffix stripped),
// not compared as a literal string set.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

/** Every leaf key under `node`, dotted, with a trailing CLDR plural category
 * stripped — see the header comment above on why a literal-suffix comparison
 * is the wrong notion of parity for a pluralised key. */
const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix.replace(PLURAL_SUFFIX, '')]

/** Whether `key` resolves to a translated string, either directly or (for a
 * pluralised base name with no literal value of its own) through at least
 * one of its `_one`/`_few`/`_many`/`_other`/… variants. */
const resolvable = (bundle: unknown, key: string): boolean =>
  typeof lookup(bundle, key) === 'string' ||
  PLURAL_SUFFIXES.some((suffix) => typeof lookup(bundle, key + suffix) === 'string')

const NEW_KEYS = [
  'nav.usage',
  'usage.heading',
  'usage.lead',
  'usage.loadFailed',
  'usage.refresh',
  'usage.updated',
  'usage.limits.heading',
  'usage.limits.status.warning',
  'usage.limits.status.rejected',
  'usage.limits.source.live',
  'usage.limits.source.observed',
  'usage.limits.source.observedNote',
  'usage.limits.source.none',
  'usage.limits.overage.line',
  'usage.limits.overage.linePrefix',
  'usage.limits.overage.allowed',
  'usage.limits.overage.notAvailable',
  'usage.limits.overage.inUse',
  'usage.limits.overage.reason.org_level_disabled',
  'usage.limits.overage.reason.org_level_disabled_until',
  'usage.limits.overage.reason.out_of_credits',
  'usage.limits.overage.reason.overage_not_provisioned',
  'usage.limits.overage.reason.member_level_disabled',
  'usage.limits.overage.reason.seat_tier_level_disabled',
  'usage.limits.extraUsage.heading',
  'usage.limits.extraUsage.disabled',
  'usage.limits.extraUsage.amount',
  'usage.window.five_hour',
  'usage.window.seven_day',
  'usage.window.seven_day_opus',
  'usage.window.seven_day_sonnet',
  'usage.window.seven_day_oauth_apps',
  'usage.window.model',
  'usage.window.modelFallback',
  'usage.window.resetsIn',
  'usage.window.resetSinceReport',
  'usage.window.duration.daysHours',
  'usage.window.duration.hoursMinutes',
  'usage.window.duration.minutesOnly',
  'usage.window.duration.lessThanMinute',
  'usage.account.heading',
  'usage.account.unavailable',
  'usage.account.plan',
  'usage.account.unknownPlan',
  'usage.account.authentication',
  'usage.account.authOAuth',
  'usage.account.authApiKey',
  'usage.account.provider',
  'usage.account.providerAnthropic',
  'usage.account.email',
  'usage.account.organization',
  'usage.breakdown.heading',
  'usage.breakdown.unavailable',
  'usage.breakdown.period.label',
  'usage.breakdown.period.day',
  'usage.breakdown.period.week',
  'usage.breakdown.requests',
  'usage.breakdown.behaviors.heading',
  'usage.breakdown.behaviors.note',
  'usage.breakdown.behaviors.cache_miss',
  'usage.breakdown.behaviors.long_context',
  'usage.breakdown.behaviors.subagent_heavy',
  'usage.breakdown.behaviors.high_parallel',
  'usage.breakdown.behaviors.cron',
  'usage.breakdown.agents',
  'usage.breakdown.skills',
  'usage.breakdown.plugins',
  'usage.breakdown.mcpServers',
  'usage.breakdown.footnote',
] as const

// The two pluralised base names — see the header comment. Neither has a
// literal value of its own, only `_one`/`_few`/`_many`/`_other` variants, so
// they are checked separately from `NEW_KEYS`'s plain string lookups.
const PLURAL_KEYS = ['usage.breakdown.requestsCount', 'usage.breakdown.sessionsCount'] as const

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

test('the pluralised requests/sessions counts carry every category each language needs', () => {
  const problems: string[] = []
  const categories: Record<'en' | 'ru', string[]> = {
    en: ['_one', '_other'],
    ru: ['_one', '_few', '_many'],
  }
  for (const base of PLURAL_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      for (const suffix of categories[locale]) {
        const value = lookup(bundle, base + suffix)
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`${locale}:${base}${suffix}`)
        }
      }
    }
  }
  expect(problems).toEqual([])
})

test('usage has exactly the same keys in both locales', () => {
  const dedupe = (paths: string[]) => [...new Set(paths)].sort()
  expect(dedupe(leaves(lookup(ru, 'usage')))).toEqual(dedupe(leaves(lookup(en, 'usage'))))
})

test('the nav block has exactly the same keys in both locales', () => {
  expect(Object.keys(ru.nav).sort()).toEqual(Object.keys(en.nav).sort())
})

test('the sidebar label is the one the spec names', () => {
  expect(en.nav.usage).toBe('Usage')
})

// `Anthropic` is a proper noun — correctly identical in both locales, unlike
// every other new key here (mirrors ports-parity's own treatment of `ss`,
// `/proc` and `PID` as untranslatable technical tokens).
const UNTRANSLATABLE_KEYS = ['usage.account.providerAnthropic']
const TRANSLATABLE_KEYS = NEW_KEYS.filter((key) => !UNTRANSLATABLE_KEYS.includes(key))

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = TRANSLATABLE_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = TRANSLATABLE_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the pluralised counts are Russian too, not copied from English', () => {
  const copied: string[] = []
  const latinOnly: string[] = []
  for (const base of PLURAL_KEYS) {
    for (const suffix of ['_one', '_few', '_many']) {
      const ruValue = lookup(ru, base + suffix)
      if (typeof ruValue !== 'string') continue
      if (ruValue === lookup(en, `${base}_one`) || ruValue === lookup(en, `${base}_other`)) {
        copied.push(`${base}${suffix}`)
      }
      if (!/[Ѐ-ӿ]/.test(ruValue)) latinOnly.push(`${base}${suffix}`)
    }
  }
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test('the untranslatable technical tokens really are identical in both locales', () => {
  const mismatched = UNTRANSLATABLE_KEYS.filter((key) => lookup(en, key) !== lookup(ru, key))
  expect(mismatched).toEqual([])
})

test('the interpolated keys carry their placeholders in both locales', () => {
  const placeholders: Record<string, string[]> = {
    'usage.updated': ['{{time}}'],
    'usage.limits.source.observed': ['{{relative}}'],
    'usage.limits.overage.line': ['{{status}}'],
    'usage.limits.extraUsage.amount': ['{{used}}', '{{limit}}'],
    'usage.window.model': ['{{label}}'],
    'usage.window.resetsIn': ['{{duration}}'],
    'usage.window.duration.daysHours': ['{{days}}', '{{hours}}'],
    'usage.window.duration.hoursMinutes': ['{{hours}}', '{{minutes}}'],
    'usage.window.duration.minutesOnly': ['{{minutes}}'],
    'usage.account.authOAuth': ['{{source}}'],
    'usage.breakdown.requests': ['{{requests}}', '{{sessions}}'],
  }
  const missing: string[] = []
  for (const [key, tokens] of Object.entries(placeholders)) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = String(lookup(bundle, key))
      for (const token of tokens) {
        if (!value.includes(token)) missing.push(`${locale}:${key}:${token}`)
      }
    }
  }
  expect(missing).toEqual([])
})

test('every plural category of the requests/sessions counts carries {{count}}', () => {
  const missing: string[] = []
  const categories: Record<'en' | 'ru', string[]> = {
    en: ['_one', '_other'],
    ru: ['_one', '_few', '_many'],
  }
  for (const base of PLURAL_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      for (const suffix of categories[locale]) {
        const value = String(lookup(bundle, base + suffix))
        if (!value.includes('{{count}}')) missing.push(`${locale}:${base}${suffix}`)
      }
    }
  }
  expect(missing).toEqual([])
})

test('the sidebar and the usage page reference the new keys', async () => {
  const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text()
  const all = (
    await Promise.all(
      [
        'app/sidebar.tsx',
        'features/system/components/usage-page.tsx',
        'features/system/lib/usage.ts',
      ].map(src),
    )
  ).join('\n')
  // The four dynamic groups are read through a template literal (a runtime
  // enum value or reason code interpolated into the key), not a literal
  // string — `usageWindowLabelKey`/`behaviorLabelKey`/`overageReasonKey`/the
  // overage status line build the key at runtime, so only their fixed
  // prefix is checked here.
  const dynamicPrefixes = [
    'usage.window.',
    'usage.breakdown.behaviors.',
    'usage.limits.overage.reason.',
    'usage.limits.overage.',
  ]
  const unreferenced = [...NEW_KEYS, ...PLURAL_KEYS].filter((key) => {
    if (all.includes(`'${key}'`)) return false
    return !dynamicPrefixes.some((prefix) => key.startsWith(prefix) && all.includes(`'${prefix}`))
  })
  expect(unreferenced).toEqual([])
})

test('every usage.* and nav.usage key the page reads exists in both locales', async () => {
  const page = await Bun.file(
    new URL('../src/features/system/components/usage-page.tsx', import.meta.url),
  ).text()
  const used = [...page.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1] as string)
  expect(used.length).toBeGreaterThan(0)
  const missing = used.filter((key) => !resolvable(en, key) || !resolvable(ru, key))
  expect(missing).toEqual([])
})
