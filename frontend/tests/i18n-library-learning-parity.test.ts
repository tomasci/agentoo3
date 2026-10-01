// The strings the session-learning feature added: the Library tabs
// (library.tabs), the Suggested view's learning panel (library.learning),
// the suggestion lists and review page (library.suggestions), the agent/
// skill editors' version history (library.history), the new
// `session-learning` system prompt (prompts.items), and the Settings page's
// "Session learning" card (settings.learning*, settings.errors.learning*) —
// every one exists in both en.json and ru.json, the Russian copy is actually
// Russian, and the `{{...}}` placeholders line up. Modelled on
// tests/i18n-library-prompts-parity.test.ts and tests/i18n-settings-
// parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts.

import { expect, test } from 'bun:test'
import i18next from 'i18next'
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
  'library.tabs.nav',
  'library.tabs.library',
  'library.tabs.suggested',
  'library.tabs.rejected',

  'library.learning.heading',
  'library.learning.runNow',
  'library.learning.runFailed',
  'library.learning.runQueued',
  'library.learning.runRunning',
  'library.learning.lastRun',
  'library.learning.noRuns',
  'library.learning.lastRunWhen',
  'library.learning.lastRunSessions',
  'library.learning.lastRunCreated',
  'library.learning.lastRunDuplicates',
  'library.learning.lastRunCost',
  'library.learning.lastRunError',
  'library.learning.lastRunNote',
  'library.learning.scheduleOn',
  'library.learning.scheduleOff',
  'library.learning.scheduleNextRun',
  'library.learning.scheduleLink',
  'library.learning.loadFailed',

  'library.suggestions.modifyHeading',
  'library.suggestions.createHeading',
  'library.suggestions.noModify',
  'library.suggestions.noCreate',
  'library.suggestions.loadFailed',
  'library.suggestions.review',
  'library.suggestions.reject',
  'library.suggestions.rejected',
  'library.suggestions.rejectTitle',
  'library.suggestions.rejectConfirm',
  'library.suggestions.rejectFailed',
  'library.suggestions.stale',
  'library.suggestions.targetMissing',
  'library.suggestions.targetTaken',
  'library.suggestions.createdAt',
  'library.suggestions.sourceSessions',
  'library.suggestions.kind.agent',
  'library.suggestions.kind.skill',
  'library.suggestions.action.create',
  'library.suggestions.action.modify',
  'library.suggestions.rejectedHeading',
  'library.suggestions.rejectedIntro',
  'library.suggestions.noRejected',
  'library.suggestions.deletePermanently',
  'library.suggestions.deleteTitle',
  'library.suggestions.deleteConfirm',
  'library.suggestions.deleteFailed',
  'library.suggestions.table.kind',
  'library.suggestions.table.action',
  'library.suggestions.table.title',
  'library.suggestions.table.rejectedAt',
  'library.suggestions.detail.loadFailed',
  'library.suggestions.detail.apply',
  'library.suggestions.detail.applied',
  'library.suggestions.detail.applyTitleModify',
  'library.suggestions.detail.applyConfirmModify',
  'library.suggestions.detail.applyTitleCreate',
  'library.suggestions.detail.applyConfirmCreate',
  'library.suggestions.detail.applyFailed',
  'library.suggestions.detail.staleBody',
  'library.suggestions.detail.diffCaptionApplied',
  'library.suggestions.detail.diffCaptionRejected',
  'library.suggestions.detail.targetMissingBody',
  'library.suggestions.detail.targetTakenBody',
  'library.suggestions.detail.preview',
  'library.suggestions.detail.rawMarkdown',
  'library.suggestions.detail.showUnchanged',
  'library.suggestions.detail.status.pending',
  'library.suggestions.detail.status.applied',
  'library.suggestions.detail.status.rejected',
  'library.suggestions.detail.appliedVersion',
  'library.suggestions.detail.viewInLibrary',

  'library.history.heading',
  'library.history.empty',
  'library.history.snapshot',
  'library.history.appliedSuggestion',
  'library.history.view',
  'library.history.viewSuggestion',
  'library.history.versionLabel',
  'library.history.loadFailed',

  'prompts.items.session-learning.title',
  'prompts.items.session-learning.description',
  'prompts.items.session-learning.bodyHint',
  'prompts.items.idea-to-prompt.bodyHint',

  'settings.learningHeading',
  'settings.learningLead',
  'settings.learningEnabled',
  'settings.learningEnabledHint',
  'settings.learningTime',
  'settings.learningTimeHint',
  'settings.learningTimezone',
  'settings.learningScheduleOn',
  'settings.learningScheduleOff',
  'settings.learningNextRun',
  'settings.learningNextRunNone',
  'settings.learningUsingDefault',
  'settings.learningOverridden',
  'settings.errors.learningTimeInvalid',
  'settings.errors.learningTimezoneInvalid',
] as const

/** `{{name}}` placeholders in a string, sorted. */
const placeholders = (value: unknown) =>
  [...String(value).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()

/** i18next v26 resolves a key used with `{{count}}` through its CLDR-suffixed
 *  siblings (`_one`, `_other`, â€¦), not the bare name — a key that has moved
 *  there (as `showUnchanged` did) no longer exists as that literal property,
 *  so a check that wants "the string for this key" has to follow the same
 *  resolution, or it is just checking whether a property that was deliberately
 *  removed still exists. Only redirects when the bare key is actually gone
 *  and a `_one` sibling has taken its place — every other NEW_KEYS entry
 *  still resolves to itself. */
function resolveKey(bundle: unknown, key: string): string {
  const parts = key.split('.')
  const leaf = parts.pop() as string
  const parent = parts.length ? lookup(bundle, parts.join('.')) : bundle
  const hasLeaf = parent !== null && typeof parent === 'object' && leaf in (parent as object)
  const hasOne = parent !== null && typeof parent === 'object' && `${leaf}_one` in (parent as object)
  return !hasLeaf && hasOne ? `${key}_one` : key
}

/** The sibling property names actually present for `key`'s leaf in `bundle` —
 *  the bare leaf (if still there) plus every `leaf_*` suffix — read off the
 *  key's own parent object rather than assembled by hand, so a stray or
 *  missing suffix shows up here too. */
function pluralSiblings(bundle: unknown, key: string): string[] {
  const parts = key.split('.')
  const leaf = parts.pop() as string
  const parent = parts.length ? lookup(bundle, parts.join('.')) : bundle
  if (parent === null || typeof parent !== 'object') return []
  return Object.keys(parent as Record<string, unknown>).filter(
    (k) => k === leaf || k.startsWith(`${leaf}_`),
  )
}

test('every new key is a non-empty string in en.json and ru.json', () => {
  const missing: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, resolveKey(bundle, key))
      if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('every new string carries the same interpolation placeholders in both locales', () => {
  const mismatched = NEW_KEYS.filter(
    (key) =>
      placeholders(lookup(en, resolveKey(en, key))).join() !==
      placeholders(lookup(ru, resolveKey(ru, key))).join(),
  )
  expect(mismatched).toEqual([])
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter(
    (key) => lookup(en, resolveKey(en, key)) === lookup(ru, resolveKey(ru, key)),
  )
  const latinOnly = NEW_KEYS.filter(
    (key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, resolveKey(ru, key)))),
  )
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

// i18next v26 reads CLDR plural suffixes off a key used with `{{count}}`
// (`_one`/`_other` for English; Russian also needs `_few`/`_many`) — it does
// not understand the old v3-style `_plural` suffix at all, so a key written
// that way (as `showUnchanged_plural` was) silently renders the unsuffixed
// string for every count, which is how "Show 83 unchanged line" happened.
const COUNT_KEYS = NEW_KEYS.filter((key) => {
  const value = lookup(en, resolveKey(en, key))
  return typeof value === 'string' && /\{\{\s*count\b/.test(value)
})

test('a counted key never carries the `_plural` suffix i18next v26 ignores', () => {
  const offenders: string[] = []
  for (const key of COUNT_KEYS) {
    const leaf = key.split('.').at(-1) as string
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      if (pluralSiblings(bundle, key).includes(`${leaf}_plural`)) offenders.push(`${locale}:${key}`)
    }
  }
  expect(offenders).toEqual([])
})

test('a counted key carries every CLDR plural form its locale needs', () => {
  const missing: string[] = []
  for (const key of COUNT_KEYS) {
    const leaf = key.split('.').at(-1) as string
    const formOf = (name: string) => (name === leaf ? '' : name.slice(leaf.length + 1))
    const enForms = new Set(pluralSiblings(en, key).map(formOf))
    const ruForms = new Set(pluralSiblings(ru, key).map(formOf))
    for (const form of ['one', 'other']) if (!enForms.has(form)) missing.push(`en:${key}_${form}`)
    for (const form of ['one', 'few', 'many', 'other'])
      if (!ruForms.has(form)) missing.push(`ru:${key}_${form}`)
  }
  // Guards against the audit silently checking nothing if every counted key
  // were ever removed or renamed out from under COUNT_KEYS's own detection.
  expect(COUNT_KEYS.length).toBeGreaterThan(0)
  expect(missing).toEqual([])
})

// A real i18next instance, not just "the right keys exist" — proves the fix
// for "Show 83 unchanged line" renders the actual singular/plural text for
// both the exact counts the bug report named and a couple of Russian's own
// in-between categories (`_few`/`_many`), not just `_one`/`_other`.
test('showUnchanged renders the correct singular/plural text for 1 vs 83, in English and Russian', async () => {
  const probe = i18next.createInstance()
  await probe.init({
    lng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  const key = 'library.suggestions.detail.showUnchanged'

  expect(probe.t(key, { count: 1 })).toBe('Show 1 unchanged line')
  expect(probe.t(key, { count: 83 })).toBe('Show 83 unchanged lines')

  await probe.changeLanguage('ru')
  expect(probe.t(key, { count: 1 })).toBe('Показать 1 неизменённую строку')
  expect(probe.t(key, { count: 2 })).toBe('Показать 2 неизменённые строки')
  expect(probe.t(key, { count: 5 })).toBe('Показать 5 неизменённых строк')
})

test('the old top-level prompts.title/description/bodyHint are gone — replaced by per-item keys', () => {
  expect(lookup(en, 'prompts.title')).toBeUndefined()
  expect(lookup(en, 'prompts.description')).toBeUndefined()
  expect(lookup(en, 'prompts.bodyHint')).toBeUndefined()
  expect(lookup(ru, 'prompts.title')).toBeUndefined()
  expect(lookup(ru, 'prompts.description')).toBeUndefined()
  expect(lookup(ru, 'prompts.bodyHint')).toBeUndefined()
})

// Compared by base name, plural suffix stripped: English and Russian need a
// different set of plural categories (`detail.showUnchanged`), so a literal
// key-set comparison would flag a correct translation — the same reasoning
// as tests/i18n-library-prompts-parity.test.ts.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other|plural)$/
const baseNames = (node: unknown) =>
  [...new Set(leaves(node).map((k) => k.replace(PLURAL_SUFFIX, '')))].sort()

test('the whole library.learning, library.suggestions and library.history blocks match key-for-key', () => {
  for (const group of ['library.learning', 'library.suggestions', 'library.history', 'library.tabs']) {
    expect(baseNames(lookup(ru, group))).toEqual(baseNames(lookup(en, group)))
  }
})

test('KNOWN_PROMPTS lists session-learning, and prompts.items has an entry for it', async () => {
  const prompts = await Bun.file(
    new URL('../src/features/library/model/prompts.ts', import.meta.url),
  ).text()
  expect(prompts).toContain("'session-learning'")
  expect(lookup(en, 'prompts.items.session-learning')).toBeTruthy()
  expect(lookup(ru, 'prompts.items.session-learning')).toBeTruthy()
})

test('the new components reference every new library.* and prompts.items.session-learning key', async () => {
  const files = [
    'src/features/library/components/library-tabs.tsx',
    'src/features/library/components/learning-panel.tsx',
    'src/features/library/components/suggested-page.tsx',
    'src/features/library/components/suggestion-card.tsx',
    'src/features/library/components/rejected-page.tsx',
    'src/features/library/components/suggestion-review-page.tsx',
    'src/features/library/components/suggestion-diff.tsx',
    'src/features/library/components/item-version-history.tsx',
  ]
  const sources = await Promise.all(
    files.map((f) => Bun.file(new URL(`../${f}`, import.meta.url)).text()),
  )
  const combined = sources.join('\n')

  const unreferenced = NEW_KEYS.filter((key) => {
    if (key.startsWith('settings.') || key.startsWith('prompts.')) return false
    if (combined.includes(`'${key}'`)) return false
    // Template-literal keys (`t(\`library.suggestions.kind.${...}\`)`) are
    // referenced through their own prefix rather than the literal leaf.
    const prefix = key.replace(/\.[^.]+$/, '')
    return !combined.includes(`\`${prefix}.$\{`)
  })
  expect(unreferenced).toEqual([])
})

test('the settings card and its schema reference every new settings.* key', async () => {
  const card = await Bun.file(
    new URL('../src/features/settings/components/learning-schedule-card.tsx', import.meta.url),
  ).text()
  const schema = await Bun.file(
    new URL('../src/features/settings/model/learning-schedule-form.schema.ts', import.meta.url),
  ).text()
  const combined = card + schema
  const unreferenced = NEW_KEYS.filter(
    (key) => key.startsWith('settings.') && !combined.includes(`'${key}'`),
  )
  expect(unreferenced).toEqual([])
})
