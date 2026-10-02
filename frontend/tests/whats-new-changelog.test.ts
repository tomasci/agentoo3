// features/whats-new/model/changelog.schema.ts (the pure sort/parse
// functions) and lib/format.ts (the release-date formatter). The feature's
// own changelog is exercised too — real data (CHANGELOG.md + CHANGELOG.ru.md,
// merged by tests/setup.ts the same way vite.config.ts merges them for a real
// build — see tests/whats-new-changelog-markdown.test.ts for the parser
// itself), not only fixtures, proving the zod boundary actually accepts it
// and the module-load sort in model/changelog.ts never throws.

import { expect, test } from 'bun:test'
import { formatReleaseDate } from '../src/features/whats-new/lib/format'
import {
  type Release,
  parseChangelog,
  sortReleasesByVersionDescending,
} from '../src/features/whats-new/model/changelog.schema'

const change = (en: string) => ({ kind: 'new' as const, en, ru: en })

test('sorts numerically, newest first — not lexicographically', () => {
  // A plain string sort would put "1.2.9" after "1.2.10": '9' > '1'.
  const releases: Release[] = [
    { version: '1.2.9', date: '2026-01-01', changes: [change('a')] },
    { version: '1.2.10', date: '2026-01-02', changes: [change('b')] },
    { version: '1.10.0', date: '2026-01-03', changes: [change('c')] },
    { version: '1.2.1', date: '2026-01-04', changes: [change('d')] },
    { version: '2.0.0', date: '2026-01-05', changes: [change('e')] },
  ]
  expect(sortReleasesByVersionDescending(releases).map((r) => r.version)).toEqual([
    '2.0.0',
    '1.10.0',
    '1.2.10',
    '1.2.9',
    '1.2.1',
  ])
})

test('sorting does not mutate the input array, and is stable for equal versions', () => {
  const releases: Release[] = [
    { version: '1.0.0', date: '2026-01-01', changes: [change('a')] },
    { version: '1.0.0', date: '2026-01-02', changes: [change('b')] },
  ]
  const sorted = sortReleasesByVersionDescending(releases)
  expect(sorted).not.toBe(releases)
  expect(sorted.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-02'])
})

test('parseChangelog sorts newest-first even when the file itself is out of order', () => {
  const releases = parseChangelog({
    releases: [
      { version: '1.0.0', date: '2026-01-01', changes: [change('old')] },
      { version: '2.0.0', date: '2026-02-01', changes: [change('new')] },
      { version: '1.5.0', date: '2026-01-15', changes: [change('mid')] },
    ],
  })
  expect(releases.map((r) => r.version)).toEqual(['2.0.0', '1.5.0', '1.0.0'])
})

test('parseChangelog fails loudly on a malformed shape rather than returning something half-valid', () => {
  expect(() => parseChangelog({ releases: [{ version: '1.0.0' }] })).toThrow()
  expect(() => parseChangelog({ releases: [{ version: 'not-a-version', date: '2026-01-01', changes: [change('x')] }] })).toThrow()
  expect(() =>
    parseChangelog({
      releases: [{ version: '1.0.0', date: '2026-01-01', changes: [{ kind: 'nonsense', en: 'x', ru: 'x' }] }],
    }),
  ).toThrow()
  expect(() => parseChangelog({ releases: [{ version: '1.0.0', date: 'not-a-date', changes: [change('x')] }] })).toThrow()
  expect(() => parseChangelog(null)).toThrow()
})

test('the real changelog (CHANGELOG.md + CHANGELOG.ru.md) parses and ends up sorted newest-first', async () => {
  const { releases } = await import('../src/features/whats-new/model/changelog')
  expect(releases.length).toBeGreaterThan(0)
  const versions = releases.map((r) => r.version)
  expect(versions).toEqual(
    [...versions].sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
        if (diff !== 0) return diff
      }
      return 0
    }),
  )
  for (const release of releases) {
    expect(release.changes.length).toBeGreaterThan(0)
    for (const c of release.changes) {
      expect(c.en.length).toBeGreaterThan(0)
      expect(c.ru.length).toBeGreaterThan(0)
    }
  }
})

test('formatReleaseDate follows the i18n language, not the browser locale', () => {
  expect(formatReleaseDate('2026-10-02', 'en')).toBe('Oct 2, 2026')
  expect(formatReleaseDate('2026-10-02', 'ru')).toMatch(/2026/)
  expect(formatReleaseDate('2026-10-02', 'ru')).not.toBe(formatReleaseDate('2026-10-02', 'en'))
})

test('formatReleaseDate pins UTC so a date-only string never shifts a day for a western timezone', () => {
  // Decided at a UTC day boundary: formatting with the local (non-UTC)
  // timezone would show Oct 1 in anything west of Greenwich.
  expect(formatReleaseDate('2026-10-02', 'en')).toContain('2')
  expect(formatReleaseDate('2026-10-02', 'en')).not.toContain('Oct 1,')
})

test('formatReleaseDate falls back to the raw string for something unparsable', () => {
  expect(formatReleaseDate('not-a-date', 'en')).toBe('not-a-date')
})
