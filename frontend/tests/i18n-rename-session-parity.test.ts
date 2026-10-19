// The rename-session feature's i18n and changelog:
//
//   - `sessions.rename`, `sessions.renameTitle`, `sessions.renameFailed` and
//     `sessions.renameHint` exist in both locales as non-empty strings, the
//     Russian is actually Russian, none takes an interpolation, and each is
//     referenced by a literal `t('…')` in the files that render them — same
//     approach as tests/i18n-compact-parity.test.ts;
//   - both root changelogs open with a `## 1.4.179 — 2026-10-19` release
//     whose first section is New / Новое and mentions renaming.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const NEW_KEYS = [
  'sessions.rename',
  'sessions.renameTitle',
  'sessions.renameFailed',
  'sessions.renameHint',
] as const

const sessionsFile = (dir: string, file: string) =>
  readFileSync(join(import.meta.dir, '../src/features/sessions', dir, file), 'utf8')
const OWN_SOURCES = [
  sessionsFile('components', 'rename-session-dialog.tsx'),
  sessionsFile('components', 'session-title.tsx'),
]
const ALL_SOURCE = [...OWN_SOURCES, sessionsFile('components', 'sessions-table.tsx')].join('\n')

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

test('no ru value is a copy of the en one, and every ru value is written in Cyrillic', () => {
  expect(NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))).toEqual([])
  expect(NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))).toEqual([])
  // And no Latin letters left over from an untranslated fragment.
  expect(NEW_KEYS.filter((key) => /[A-Za-z]/.test(String(lookup(ru, key))))).toEqual([])
})

test('the English copy is the copy the feature is specified with', () => {
  expect(NEW_KEYS.map((key) => lookup(en, key))).toEqual([
    'Rename',
    'Rename session',
    'Could not rename the session',
    'Click to rename',
  ])
})

test('none of the new keys takes an interpolation the code does not pass', () => {
  expect(
    NEW_KEYS.filter((key) => /\{\{/.test(String(lookup(en, key)) + String(lookup(ru, key)))),
  ).toEqual([])
})

test('the source files reference every key by a literal t() call, and the new files use no template-literal key', () => {
  expect(NEW_KEYS.filter((key) => !ALL_SOURCE.includes(`t('${key}'`))).toEqual([])
  for (const source of OWN_SOURCES) expect(source).not.toMatch(/\bt\(\s*`/)
})

test('the keys the rename UI borrows from elsewhere exist in both locales', () => {
  // The dialog's label and buttons, the placeholder, the menu's other items.
  const borrowed = [
    'sessions.form.title',
    'sessions.untitled',
    'common.save',
    'common.cancel',
    'common.delete',
    'sessions.open',
  ]
  const missing = borrowed.flatMap((key) =>
    [
      ['en', en],
      ['ru', ru],
    ].flatMap(([locale, bundle]) =>
      typeof lookup(bundle, key as string) === 'string' ? [] : [`${locale}:${key}`],
    ),
  )
  expect(missing).toEqual([])
})

const changelog = (file: string) => readFileSync(join(import.meta.dir, '../..', file), 'utf8')
/** The first release block: from the first `## ` heading up to the next. */
const topRelease = (md: string) => {
  const start = md.indexOf('\n## ')
  const next = md.indexOf('\n## ', start + 1)
  return md.slice(start + 1, next === -1 ? undefined : next).trim()
}

for (const [file, section, word] of [
  ['CHANGELOG.md', '### New', /renam/i],
  ['CHANGELOG.ru.md', '### Новое', /переименова/i],
] as const) {
  test(`${file} opens with 1.4.179 — 2026-10-19, whose first section is ${section} and mentions renaming`, () => {
    const lines = topRelease(changelog(file)).split('\n')
    expect(lines[0]).toBe('## 1.4.179 — 2026-10-19')
    const firstSection = lines.find((l) => l.startsWith('### '))
    expect(firstSection).toBe(section)
    const entries = lines.filter((l) => l.startsWith('- '))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((l) => word.test(l))).toBe(true)
  })
}
