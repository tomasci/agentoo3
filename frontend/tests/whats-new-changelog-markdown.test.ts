// features/whats-new/model/changelog-markdown.ts — the parser that turns
// CHANGELOG.md / CHANGELOG.ru.md into the shape changelog.schema.ts
// validates, and the merge that pairs the two languages by position. Both
// are meant to fail loudly (frontend/README.md's "Adding a changelog entry"):
// every error below is checked for the file name *and* line number it names,
// not just "this throws".

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { expect, test } from 'bun:test'
import {
  mergeChangelogMarkdown,
  parseChangelogMarkdown,
} from '../src/features/whats-new/model/changelog-markdown'

// ── a valid file ────────────────────────────────────────────────────────────

test('parses a valid file: intro ignored, releases newest-first as written, kinds in order', () => {
  const text = `# Changelog

Some intro paragraph that mentions ## nothing in particular and - certainly
isn't a bullet either, since no release heading has appeared yet.

## 1.2.0 — 2026-02-01

### New
- second release, new thing

## 1.0.0 — 2026-01-01

### New
- first release, new thing
- first release, another new thing

### Improved
- first release, improved thing

### Fixed
- first release, fixed thing
`
  const releases = parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')
  expect(releases).toEqual([
    { version: '1.2.0', date: '2026-02-01', changes: [{ kind: 'new', lines: ['second release, new thing'] }] },
    {
      version: '1.0.0',
      date: '2026-01-01',
      changes: [
        { kind: 'new', lines: ['first release, new thing', 'first release, another new thing'] },
        { kind: 'improved', lines: ['first release, improved thing'] },
        { kind: 'fixed', lines: ['first release, fixed thing'] },
      ],
    },
  ])
})

test('accepts a hyphen, an en dash and an em dash as the version/date separator', () => {
  for (const dash of ['-', '–', '—']) {
    const text = `# Changelog\n\n## 1.0.0 ${dash} 2026-01-01\n\n### New\n- a change\n`
    expect(parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toEqual([
      { version: '1.0.0', date: '2026-01-01', changes: [{ kind: 'new', lines: ['a change'] }] },
    ])
  }
})

test('Russian kind headings are recognised when parsing as "ru"', () => {
  const text = `# Changelog

## 1.0.0 — 2026-01-01

### Новое
- что-то новое

### Улучшено
- что-то улучшили

### Исправлено
- что-то починили
`
  const releases = parseChangelogMarkdown(text, 'ru', 'CHANGELOG.ru.md')
  expect(releases).toEqual([
    {
      version: '1.0.0',
      date: '2026-01-01',
      changes: [
        { kind: 'new', lines: ['что-то новое'] },
        { kind: 'improved', lines: ['что-то улучшили'] },
        { kind: 'fixed', lines: ['что-то починили'] },
      ],
    },
  ])
})

// ── strict errors, each naming the file and line ────────────────────────────

test('throws on a malformed release heading, naming the line', () => {
  const text = `# Changelog\n\n## not a heading\n\n### New\n- x\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:3:/)
})

test('throws on an unknown kind heading, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### Nonsense\n- x\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:5:.*Nonsense/)
})

test('throws on a bullet outside any kind section, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n- x\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:5:/)
})

test('throws on a stray non-blank, non-bullet line inside a kind section, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### New\nnot a bullet\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:6:/)
})

test('throws on a duplicate kind heading within one release, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### New\n- a\n\n### New\n- b\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:8:/)
})

test('throws when kind headings appear out of order, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### Fixed\n- a\n\n### New\n- b\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:8:/)
})

test('throws on an empty release (a heading with no changes under it), naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n## 2.0.0 — 2026-02-01\n\n### New\n- x\n`
  // The error fires once the *next* heading (or EOF) proves the first
  // release never got any changes — so it names that next heading's line.
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:5:.*1\.0\.0/)
})

test('throws on a duplicate version, naming the line of the second occurrence', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### New\n- a\n\n## 1.0.0 — 2026-02-01\n\n### New\n- b\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:8:.*duplicate/)
})

test('throws on an empty bullet, naming the line', () => {
  const text = `# Changelog\n\n## 1.0.0 — 2026-01-01\n\n### New\n- \n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.md')).toThrow(/CHANGELOG\.md:6:/)
})

test('error messages are prefixed with the file label passed in, not a hard-coded name', () => {
  const text = `# Changelog\n\n## not a heading\n`
  expect(() => parseChangelogMarkdown(text, 'en', 'CHANGELOG.ru.md')).toThrow(/^CHANGELOG\.ru\.md:3:/)
})

// ── merge: every kind of en/ru disagreement ─────────────────────────────────

const release = (version: string, kind: 'new' | 'improved' | 'fixed', ...lines: string[]) => [
  { version, date: '2026-01-01', changes: [{ kind, lines }] },
]

test('merges two agreeing files by position, pairing bullets in order', () => {
  const en = [
    {
      version: '1.0.0',
      date: '2026-01-01',
      changes: [
        { kind: 'new' as const, lines: ['a', 'b'] },
        { kind: 'fixed' as const, lines: ['c'] },
      ],
    },
  ]
  const ru = [
    {
      version: '1.0.0',
      date: '2026-01-01',
      changes: [
        { kind: 'new' as const, lines: ['а', 'б'] },
        { kind: 'fixed' as const, lines: ['в'] },
      ],
    },
  ]
  expect(mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toEqual([
    {
      version: '1.0.0',
      date: '2026-01-01',
      changes: [
        { kind: 'new', en: 'a', ru: 'а' },
        { kind: 'new', en: 'b', ru: 'б' },
        { kind: 'fixed', en: 'c', ru: 'в' },
      ],
    },
  ])
})

test('throws when the two files have a different number of releases', () => {
  const en = [...release('1.0.0', 'new', 'a'), ...release('2.0.0', 'new', 'b')]
  const ru = release('1.0.0', 'new', 'а')
  expect(() => mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toThrow(
    /CHANGELOG\.md has 2 release.*CHANGELOG\.ru\.md has 1/,
  )
})

test('throws naming the version when the two files disagree on a version at the same position', () => {
  const en = release('1.0.0', 'new', 'a')
  const ru = release('1.0.1', 'new', 'а')
  expect(() => mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toThrow(
    /1\.0\.0.*1\.0\.1/,
  )
})

test('throws naming the version when the two files disagree on a date', () => {
  const en = release('1.0.0', 'new', 'a')
  const ru = [{ ...release('1.0.0', 'new', 'а')[0], date: '2026-01-02' }]
  expect(() => mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toThrow(
    /1\.0\.0.*2026-01-01.*2026-01-02/,
  )
})

test('throws naming the version when the two files disagree on which kinds a release has', () => {
  const en = release('1.0.0', 'new', 'a')
  const ru = release('1.0.0', 'fixed', 'а')
  expect(() => mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toThrow(/1\.0\.0/)
})

test('throws naming the version and kind when bullet counts for a kind differ', () => {
  const en = [
    { version: '1.0.0', date: '2026-01-01', changes: [{ kind: 'new' as const, lines: ['a', 'b'] }] },
  ]
  const ru = [{ version: '1.0.0', date: '2026-01-01', changes: [{ kind: 'new' as const, lines: ['а'] }] }]
  expect(() => mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')).toThrow(
    /"new".*1\.0\.0/,
  )
})

// ── the real repo files ──────────────────────────────────────────────────────

test('the real CHANGELOG.md and CHANGELOG.ru.md parse, merge, and agree with each other', () => {
  const enPath = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url))
  const ruPath = fileURLToPath(new URL('../../CHANGELOG.ru.md', import.meta.url))
  const en = parseChangelogMarkdown(readFileSync(enPath, 'utf8'), 'en', 'CHANGELOG.md')
  const ru = parseChangelogMarkdown(readFileSync(ruPath, 'utf8'), 'ru', 'CHANGELOG.ru.md')
  const merged = mergeChangelogMarkdown(en, ru, 'CHANGELOG.md', 'CHANGELOG.ru.md')

  expect(merged.length).toBeGreaterThan(0)
  const versions = merged.map((r) => r.version)
  expect(versions).toContain('1.3.159')
  expect(versions).toContain('1.2.156')
  expect(versions).not.toContain('1.2.151')

  // Newest-first, exactly as written (parseChangelog, the zod-validated
  // reader, is what actually re-sorts; this file's own order is the source
  // of truth the operator edits, and it should already read newest-first).
  const numeric = (v: string) => v.split('.').map(Number)
  for (let i = 1; i < versions.length; i++) {
    const a = numeric(versions[i - 1] as string)
    const b = numeric(versions[i] as string)
    const cmp = a[0] !== b[0] ? (a[0] as number) - (b[0] as number) : a[1] !== b[1] ? (a[1] as number) - (b[1] as number) : (a[2] as number) - (b[2] as number)
    expect(cmp).toBeGreaterThan(0)
  }

  for (const release of merged) {
    expect(release.changes.length).toBeGreaterThan(0)
    for (const change of release.changes) {
      expect(change.en.length).toBeGreaterThan(0)
      expect(change.ru.length).toBeGreaterThan(0)
    }
  }
})
