import { describe, expect, test } from 'bun:test'

import './setup-env'

/**
 * Mirrors the pinned contract rather than importing the module's own types, so
 * this file still runs while `branch-name.ts` is being written: the `.catch`
 * turns "module not there yet" into one readable failure per behaviour instead
 * of a file that aborts before bun has registered a single test and so reports
 * nothing about what is covered.
 */
type BranchNameCheck = { ok: true } | { ok: false; reason: string }
type CheckBranchName = (name: string) => BranchNameCheck

const checkBranchName: CheckBranchName = await import('../src/lib/branch-name')
  .then((module) => module.checkBranchName)
  .catch((error: unknown) => () => {
    throw new Error(`src/lib/branch-name.ts did not load: ${String(error)}`)
  })

const SOH = String.fromCharCode(1)
const DEL = String.fromCharCode(127)

/** The rule under test, and one name that breaks exactly that rule. */
const rejected: Array<[rule: string, name: string]> = [
  ['empty', ''],
  ['longer than 255', 'a'.repeat(256)],
  ['a space', 'feat/add thing'],
  ['a tab', 'feat/add\tthing'],
  ['a newline', 'feat/add\nthing'],
  ['a carriage return', 'feat/add\rthing'],
  ['a control character', `feat/add${SOH}thing`],
  ['DEL', `feat/add${DEL}thing`],
  ['a leading dash', '-feat'],
  ['a leading slash', '/feat'],
  ['a trailing slash', 'feat/'],
  ['a trailing dot', 'feat.'],
  ['a trailing .lock', 'feat.lock'],
  ['a double dot', 'feat..thing'],
  ['a double slash', 'feat//thing'],
  ['an at-brace', 'feat@{1}'],
  ['a tilde', 'feat~1'],
  ['a caret', 'feat^'],
  ['a colon', 'feat:thing'],
  ['a question mark', 'feat?'],
  ['a star', 'feat*'],
  ['an open bracket', 'feat[1'],
  ['a backslash', 'feat\\thing'],
  ['a leading dot', '.feat'],
  ['a component starting with a dot', 'feat/.hidden'],
  ['bare @', '@'],
  ['bare HEAD', 'HEAD'],
]

const accepted = [
  'main',
  'develop',
  'feature/add-thing',
  'release/1.2.3',
  '12oct26/fix-session-resume',
  'v1.2.3',
  'agentoo/s-5fc6aed6',
  'a'.repeat(255),
]

describe('checkBranchName rejects what git check-ref-format would', () => {
  for (const [rule, name] of rejected) {
    test(`rejects ${rule}`, () => {
      expect(checkBranchName(name)).toMatchObject({ ok: false })
    })
  }
})

describe('checkBranchName accepts ordinary branch names', () => {
  for (const name of accepted) {
    const label = name.length > 40 ? `${name.slice(0, 12)}... (${name.length} chars)` : name
    test(`accepts ${label}`, () => {
      expect(checkBranchName(name)).toEqual({ ok: true })
    })
  }
})

test('a leading dash is refused, because the name reaches git as an argument', () => {
  // The guard that matters. A branch name is interpolated into an argv, so a
  // name beginning with `-` is read as an option rather than a ref, and
  // `--upload-pack=` turns a fetch into arbitrary command execution on this box.
  expect(checkBranchName('--upload-pack=/evil').ok).toBe(false)
  expect(checkBranchName('-x').ok).toBe(false)
})

test('the length limit cuts at 255, not at 254', () => {
  expect(checkBranchName('a'.repeat(255)).ok).toBe(true)
  expect(checkBranchName('a'.repeat(256)).ok).toBe(false)
})

test('a rejection carries a reason a user can act on', () => {
  const result = checkBranchName('feat/add thing')
  if (result.ok) throw new Error('expected "feat/add thing" to be rejected')
  // An empty reason reaches the UI as a blank error toast.
  expect(result.reason.length).toBeGreaterThan(0)
})

test('checkBranchName answers synchronously, so a validator can use it inline', () => {
  expect(checkBranchName('main')).not.toBeInstanceOf(Promise)
})
