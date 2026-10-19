// The compact-session feature's i18n: `sessions.compact.*` exists in both
// locales with the same set of keys, the Russian is actually Russian, the
// banner keeps its `{{cost}}` placeholder, and the files that render the keys
// really reference each one by a literal `t('…')` — same approach as
// tests/i18n-turn-mode-parity.test.ts.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const NEW_KEYS = [
  'sessions.compact.action',
  'sessions.compact.actionTooltip',
  'sessions.compact.inProgress',
  'sessions.compact.inProgressTooltip',
  'sessions.compact.busyTooltip',
  'sessions.compact.failed',
  'sessions.compact.statusFailed',
  'sessions.compact.bannerTitle',
  'sessions.compact.bannerBody',
  'sessions.compact.bannerAction',
  'sessions.compact.contextHeading',
  'sessions.compact.contextSource',
  'sessions.compact.contextSourceFallback',
  'sessions.compact.contextEmpty',
  'sessions.compact.contextNote',
] as const

const sessionsFile = (dir: string, file: string) =>
  readFileSync(join(import.meta.dir, '../src/features/sessions', dir, file), 'utf8')
// The files this feature added. session-page.tsx is read for its references
// only: it already builds one key from a template literal
// (`sessions.status.${status}`), which is not this feature's to change.
const OWN_SOURCES = [
  sessionsFile('components', 'compact-session-button.tsx'),
  sessionsFile('components', 'compact-suggestion.tsx'),
  sessionsFile('hooks', 'use-compact-session.ts'),
]
const ALL_SOURCE = [
  ...OWN_SOURCES,
  sessionsFile('components', 'session-page.tsx'),
  sessionsFile('components', 'transcript.tsx'),
].join('\n')

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

test('en.json and ru.json hold exactly the same keys under sessions.compact, and they are the new keys', () => {
  expect(Object.keys(ru.sessions.compact).sort()).toEqual(Object.keys(en.sessions.compact).sort())
  expect(Object.keys(en.sessions.compact).sort()).toEqual(
    NEW_KEYS.map((key) => key.split('.')[2] ?? '').sort(),
  )
})

test('no ru value is a copy of the en one', () => {
  expect(NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))).toEqual([])
})

test('every ru value is written in Cyrillic', () => {
  expect(NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))).toEqual([])
})

test('the visible labels are the ones the feature is specified with', () => {
  expect(en.sessions.compact.action).toBe('Compact session')
  expect(en.sessions.compact.bannerAction).toBe('Compact session and start new one')
  expect(en.sessions.compact.inProgress).toBe('Compacting…')
  expect(en.sessions.compact.contextHeading).toBe('Compacted context from previous session')
  expect(ru.sessions.compact.action).toBe('Сжать сессию')
  expect(ru.sessions.compact.bannerAction).toBe('Сжать сессию и начать новую')
})

test('the banner body keeps its {{cost}} placeholder in both locales', () => {
  // `t('sessions.compact.bannerBody', { cost })` — a translation that dropped
  // it would state a threshold crossing without the figure that crossed it.
  expect(en.sessions.compact.bannerBody).toContain('{{cost}}')
  expect(ru.sessions.compact.bannerBody).toContain('{{cost}}')
})

test('no other key in the block takes an interpolation the code does not pass', () => {
  const withPlaceholders = NEW_KEYS.filter(
    (key) => /\{\{/.test(String(lookup(en, key))) || /\{\{/.test(String(lookup(ru, key))),
  )
  expect(withPlaceholders).toEqual(['sessions.compact.bannerBody'])
})

test('the reasons a button is disabled differ from each other and from what it does', () => {
  for (const bundle of [en, ru]) {
    const { actionTooltip, inProgressTooltip, busyTooltip } = bundle.sessions.compact
    expect(new Set([actionTooltip, inProgressTooltip, busyTooltip]).size).toBe(3)
  }
})

test('the source files reference every key by a literal t() call, and the new files use no template-literal key', () => {
  expect(NEW_KEYS.filter((key) => !ALL_SOURCE.includes(`'${key}'`))).toEqual([])
  for (const source of OWN_SOURCES) expect(source).not.toMatch(/\bt\(\s*`/)
})

test('nothing was added under sessions.detailsFields, which is pinned to three keys', () => {
  expect(Object.keys(en.sessions.detailsFields).sort()).toEqual(['cost', 'created', 'worktree'])
  expect(Object.keys(ru.sessions.detailsFields).sort()).toEqual(['cost', 'created', 'worktree'])
})
