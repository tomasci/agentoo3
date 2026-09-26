// The keys the session-page change added (stop failure, the details popover,
// the transcript's empty-state description) exist in both locale files, and
// the Russian copy is actually Russian.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts. That file already pins every key
// transcript.tsx references; this one covers the ones session-page.tsx and
// composer.tsx reference, scoped to exactly the keys this change introduced
// or re-worded plus a source check that the components really use them.

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
  'sessions.stopFailed',
  'sessions.details',
  'sessions.detailsFields.worktree',
  'sessions.detailsFields.cost',
  'sessions.transcript.empty',
  'sessions.transcript.emptyDescription',
  'sessions.stop',
] as const

/** Identical en/ru copy on purpose: "worktree" is a git term, kept as-is. */
const INTENTIONAL_LOANWORDS = new Set(['sessions.detailsFields.worktree'])

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

test('ru values are not copies of the en ones, except the intentional loanword', () => {
  const copied = NEW_KEYS.filter(
    (key) => !INTENTIONAL_LOANWORDS.has(key) && lookup(en, key) === lookup(ru, key),
  )
  expect(copied).toEqual([])
})

test('ru values that are not loanwords are written in Cyrillic', () => {
  const latinOnly = NEW_KEYS.filter(
    (key) => !INTENTIONAL_LOANWORDS.has(key) && !/[Ѐ-ӿ]/.test(String(lookup(ru, key))),
  )
  expect(latinOnly).toEqual([])
})

test('the worktree loanword is the one deliberate exception, and it is "Worktree"', () => {
  expect(lookup(ru, 'sessions.detailsFields.worktree')).toBe('Worktree')
})

test('session-page.tsx, composer.tsx and transcript.tsx reference every new key', async () => {
  const src = (p: string) => Bun.file(new URL(`../src/features/sessions/components/${p}`, import.meta.url)).text()
  const all = (await Promise.all(['session-page.tsx', 'composer.tsx', 'transcript.tsx'].map(src))).join('\n')
  const unreferenced = NEW_KEYS.filter((key) => !all.includes(`'${key}'`))
  expect(unreferenced).toEqual([])
})

test('detailsFields holds exactly worktree and cost in both locales', () => {
  expect(Object.keys(lookup(en, 'sessions.detailsFields') as object).sort()).toEqual([
    'cost',
    'worktree',
  ])
  expect(Object.keys(lookup(ru, 'sessions.detailsFields') as object).sort()).toEqual([
    'cost',
    'worktree',
  ])
})
