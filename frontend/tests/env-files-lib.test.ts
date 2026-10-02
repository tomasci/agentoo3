// The env files page's pure helpers: the client-side path check
// (features/env-files/lib/path-rules.ts — a mirror of the backend's
// `checkEnvFilePath`, used by the Add form for instant feedback), the folder
// grouping the list renders (lib/group-files.ts) and the size/updated
// formatting on each card (lib/format.ts).
//
// The rejected/accepted corpora are the spec's own, plus the edges the rules
// imply: case, length, control characters, and the order the checks run in
// (each rejected path is asserted against the *specific* reason key, so a
// reordering that changes which message the user sees is caught too).

import { describe, expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import { formatFileSize, formatUpdatedAt } from '../src/features/env-files/lib/format'
import { groupEnvFilesByFolder } from '../src/features/env-files/lib/group-files'
import { checkEnvFilePath } from '../src/features/env-files/lib/path-rules'

const reason = (path: string) => {
  const result = checkEnvFilePath(path)
  return result.ok ? 'ok' : result.messageKey
}

describe('checkEnvFilePath', () => {
  test.each([
    ['.env'],
    ['.env.local'],
    ['.env.development'],
    ['server/.env'],
    ['webapp/.env'],
    ['docker/db.env'],
    ['.devcontainer/.env'],
    ['db.env'],
    ['a/b/c/d/.env.test'],
    ['Server-1/my_app.env'],
    // `.git` is refused case-insensitively, but only as a whole segment.
    ['.github/.env'],
    ['git/.env'],
  ])('accepts %p', (path) => {
    expect(checkEnvFilePath(path)).toEqual({ ok: true })
  })

  test.each([
    ['../.env', 'envFiles.validation.dotSegment'],
    ['server/../.env', 'envFiles.validation.dotSegment'],
    ['./.env', 'envFiles.validation.dotSegment'],
    ['/x/.env', 'envFiles.validation.leadingSlash'],
    ['/.env', 'envFiles.validation.leadingSlash'],
    ['a//.env', 'envFiles.validation.emptySegment'],
    ['.git/.env', 'envFiles.validation.gitSegment'],
    ['.GIT/.env', 'envFiles.validation.gitSegment'],
    ['sub/.Git/.env', 'envFiles.validation.gitSegment'],
    ['node_modules/.env', 'envFiles.validation.nodeModulesSegment'],
    ['app/node_modules/x/.env', 'envFiles.validation.nodeModulesSegment'],
    ['package.json', 'envFiles.validation.badBasename'],
    ['server/config.yml', 'envFiles.validation.badBasename'],
    ['env', 'envFiles.validation.badBasename'],
    ['.envrc', 'envFiles.validation.badBasename'],
    ['.env.', 'envFiles.validation.badBasename'],
    ['server\\.env', 'envFiles.validation.backslash'],
    ['server/', 'envFiles.validation.trailingSlash'],
    ['', 'envFiles.validation.empty'],
    ['my app/.env', 'envFiles.validation.invalidChars'],
    ['srv/é.env', 'envFiles.validation.invalidChars'],
    ['a\u0000.env', 'envFiles.validation.controlChars'],
    ['a\t.env', 'envFiles.validation.controlChars'],
    ['a\u007f.env', 'envFiles.validation.controlChars'],
    ['a\u0085.env', 'envFiles.validation.controlChars'],
  ])('rejects %p with %s', (path, key) => {
    expect(reason(path)).toBe(key)
  })

  test('the length cap is 255 characters, inclusive', () => {
    const at = `${'a'.repeat(251)}.env` // 255
    const over = `${'a'.repeat(252)}.env` // 256
    expect(at.length).toBe(255)
    expect(reason(at)).toBe('ok')
    expect(reason(over)).toBe('envFiles.validation.tooLong')
  })

  test('every reason key it can return exists in en.json', () => {
    const keys = Object.keys(en.envFiles.validation).map((k) => `envFiles.validation.${k}`)
    const produced = [
      '',
      'x'.repeat(300),
      '/a.env',
      'a/',
      'a\\b.env',
      'a\u0001.env',
      'a//b.env',
      '../a.env',
      '.git/a.env',
      'node_modules/a.env',
      'a b.env',
      'a.txt',
    ].map(reason)
    expect(new Set(produced)).toEqual(new Set(keys))
  })
})

const file = (path: string) => ({ path, content: '', size: 0, updatedAt: '2026-10-01T00:00:00.000Z' })

describe('groupEnvFilesByFolder', () => {
  test('root first, then folders alphabetically, each with its files in the given order', () => {
    const groups = groupEnvFilesByFolder(
      ['.env', '.env.local', 'server/.env', 'webapp/.env'].map(file),
    )
    expect(groups.map((g) => [g.folder, g.files.map((f) => f.path)])).toEqual([
      ['', ['.env', '.env.local']],
      ['server', ['server/.env']],
      ['webapp', ['webapp/.env']],
    ])
  })

  test('a root file that sorts after a folder path still lands in the single root group, first', () => {
    // Server order is by whole path: "aaa/.env" < "zz.env".
    const groups = groupEnvFilesByFolder(['.env', 'aaa/.env', 'zz.env'].map(file))
    expect(groups.map((g) => [g.folder, g.files.map((f) => f.path)])).toEqual([
      ['', ['.env', 'zz.env']],
      ['aaa', ['aaa/.env']],
    ])
  })

  test('nested folders are their own group, keyed by the full folder path', () => {
    const groups = groupEnvFilesByFolder(
      ['docker/dev/.env', 'docker/.env', '.devcontainer/.env', 'server/.env'].map(file),
    )
    expect(groups.map((g) => g.folder)).toEqual(['.devcontainer', 'docker', 'docker/dev', 'server'])
  })

  test('no root group is invented when there are no root files', () => {
    expect(groupEnvFilesByFolder([file('server/.env')]).map((g) => g.folder)).toEqual(['server'])
  })

  test('an empty list gives no groups', () => {
    expect(groupEnvFilesByFolder([])).toEqual([])
  })
})

describe('format', () => {
  test.each([
    [0, '0 B'],
    [-5, '0 B'],
    [Number.NaN, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [2150, '2.1 KB'],
    [10 * 1024, '10 KB'],
    [64 * 1024, '64 KB'],
  ])('formatFileSize(%p) = %p', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected)
  })

  test('formatUpdatedAt gives null for a non-date and a string for a real instant', () => {
    expect(formatUpdatedAt('not a date')).toBeNull()
    expect(formatUpdatedAt('')).toBeNull()
    expect(typeof formatUpdatedAt('2026-10-01T12:00:00.000Z')).toBe('string')
  })
})
