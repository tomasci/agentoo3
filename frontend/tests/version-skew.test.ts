// The comparison behind the "your tab is out of date" notice: server.ts
// serves index.html `no-cache` but /assets/ `immutable`, so a tab left open
// and never navigated can run indefinitely against a build the backend has
// moved past. This is what decides whether that has happened.

import { expect, test } from 'bun:test'
import { isVersionSkewed } from '../src/features/health/lib/version-skew'

test('equal versions are silent', () => {
  expect(isVersionSkewed('0.1.79', '0.1.79', true)).toBe(false)
})

test('a tab behind the server raises the notice in prod', () => {
  expect(isVersionSkewed('0.1.79', '0.1.80', true)).toBe(true)
})

// A deploy can land the frontend's static assets before the backend
// restarts, so the tab is briefly ahead of the server it is polling. That
// must stay silent: it clears itself within one poll of the backend catching
// up, and the notice's own copy ("running an older build than the server")
// would be false in this direction.
test('a tab ahead of the server is silent', () => {
  expect(isVersionSkewed('0.1.80', '0.1.79', true)).toBe(false)
})

// Comparison is numeric, not lexicographic: a string compare would put "9" >
// "10" and misfire the moment a build number crosses a digit boundary.
test('numeric build comparison, not string comparison', () => {
  expect(isVersionSkewed('0.1.9', '0.1.10', true)).toBe(true)
  expect(isVersionSkewed('0.1.10', '0.1.9', true)).toBe(false)
})

test('a difference in major or minor is compared the same way as build', () => {
  expect(isVersionSkewed('0.1.79', '1.0.0', true)).toBe(true)
  expect(isVersionSkewed('1.0.0', '0.1.79', true)).toBe(false)
})

// Dev legitimately disagrees with a backend restarted on a newer commit than
// the tree currently checked out, constantly and for no reason anyone needs
// to act on — this must stay silent regardless of how far apart the two
// versions are.
test('non-prod is always silent, even when the versions differ', () => {
  expect(isVersionSkewed('0.1.79', '0.1.80', false)).toBe(false)
})

// The health poll hasn't answered yet (or is down): nothing to compare
// against, so this must not be reported as skew.
test('no backend version yet is silent', () => {
  expect(isVersionSkewed('0.1.79', undefined, true)).toBe(false)
})

// `useHealth` does not validate its own response, so a `version` that is not
// exactly `major.minor.build` must be parsed and rejected here rather than
// crashing the comparison or being cast straight into it.
for (const malformed of ['', 'abc', '0.1', '0.1.79.2', '0.1.-1', '0.1.7 ']) {
  test(`an unparseable backend version (${JSON.stringify(malformed)}) is silent, not thrown`, () => {
    expect(() => isVersionSkewed('0.1.79', malformed, true)).not.toThrow()
    expect(isVersionSkewed('0.1.79', malformed, true)).toBe(false)
  })
}

test('an unparseable build version is silent, not thrown', () => {
  expect(() => isVersionSkewed('not-a-version', '0.1.80', true)).not.toThrow()
  expect(isVersionSkewed('not-a-version', '0.1.80', true)).toBe(false)
})
