// checkEnvFilePath (features/env-files/path-rules.ts) — the one function both
// the HTTP boundary (schema.ts's envFilePathSchema) and materialize.ts lean
// on, so this pins its behaviour directly rather than only through a route.

import { describe, expect, test } from 'bun:test'
import { checkEnvFilePath } from '../src/features/env-files/path-rules'

function ok(path: string) {
  const result = checkEnvFilePath(path)
  if (!result.ok) throw new Error(`expected ok:true for ${JSON.stringify(path)}, got: ${result.reason}`)
}

function rejected(path: string) {
  const result = checkEnvFilePath(path)
  if (result.ok) throw new Error(`expected ok:false for ${JSON.stringify(path)}`)
  return result.reason
}

describe('accepted shapes', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.env.development',
    'db.env',
    'server/.env',
    'webapp/.env.local',
    '.devcontainer/.env',
    'a/b/c/.env',
  ]) {
    test(`"${path}" is accepted`, () => ok(path))
  }
})

describe('basename must look like an env file', () => {
  for (const path of ['package.json', 'secrets.txt', 'server/README.md', 'env', 'envfile']) {
    test(`"${path}" is rejected`, () => expect(rejected(path).length).toBeGreaterThan(0))
  }
})

describe('path shape rules', () => {
  test('empty path is rejected', () => rejected(''))
  test('a path over 255 characters is rejected', () => rejected(`${'a/'.repeat(130)}.env`))
  test('a leading slash is rejected', () => rejected('/.env'))
  test('a trailing slash is rejected', () => rejected('server/'))
  test('a backslash is rejected', () => rejected('server\\.env'))
  test('a NUL byte is rejected', () => rejected('server/.en\0v'))
  test('an empty segment ("a//b") is rejected', () => rejected('server//.env'))
  test('a "." segment is rejected', () => rejected('./.env'))
  test('a ".." segment is rejected', () => rejected('../.env'))
  test('a ".." segment deeper in the path is rejected', () => rejected('server/../.env'))
})

describe('.git and node_modules are refused as directory segments', () => {
  test('.git is rejected', () => rejected('.git/.env'))
  test('.git is rejected case-insensitively', () => rejected('.GIT/.env'))
  test('node_modules is rejected', () => rejected('node_modules/.env'))
})

describe('leading-dot directories are otherwise allowed', () => {
  test('.devcontainer is accepted', () => ok('.devcontainer/.env'))
})
