// `formatHostPort` (src/features/system/lib/format.ts): the Ports page's own
// helper for rendering a peer address and port as one unambiguous string —
// see ports-page.tsx's own comment on why a bare IPv6 peer needs brackets.

import { expect, test } from 'bun:test'
import { formatHostPort } from '../src/features/system/lib/format'

test('IPv4 stays unbracketed', () => {
  expect(formatHostPort('93.184.216.34', 443)).toBe('93.184.216.34:443')
})

test('IPv6 is bracketed so its own colons cannot be mistaken for the port separator', () => {
  expect(formatHostPort('2001:4860:4840:400::', 443)).toBe('[2001:4860:4840:400::]:443')
})

test('an IPv6 zone suffix stays inside the brackets', () => {
  expect(formatHostPort('fe80::1%eth0', 546)).toBe('[fe80::1%eth0]:546')
})

test('the wildcard address has no colon of its own, so it stays unbracketed', () => {
  expect(formatHostPort('*', 8080)).toBe('*:8080')
})

test('a null port renders the address alone, with no dangling colon', () => {
  expect(formatHostPort('93.184.216.34', null)).toBe('93.184.216.34')
  expect(formatHostPort('2001:4860:4840:400::', null)).toBe('[2001:4860:4840:400::]')
})
