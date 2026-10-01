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
  'library.suggestions.detail.targetMissingBody',
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

test('every new string carries the same interpolation placeholders in both locales', () => {
  const mismatched = NEW_KEYS.filter(
    (key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join(),
  )
  expect(mismatched).toEqual([])
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  const copied = NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
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
