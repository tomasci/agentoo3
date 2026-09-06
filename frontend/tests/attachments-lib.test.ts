import { expect, test } from 'bun:test'
import { isInlineImage, sessionFileUrl } from '../src/features/sessions/lib/attachments'

test('sessionFileUrl builds the hand-written download route', () => {
  // Not in the generated client on purpose — see the module's own comment —
  // so this is the one place the URL shape is allowed to live.
  expect(sessionFileUrl('s1', 'f1')).toBe('/api/sessions/s1/files/f1')
})

test('isInlineImage matches only the four types the backend serves inline', () => {
  expect(isInlineImage('image/png')).toBe(true)
  expect(isInlineImage('image/jpeg')).toBe(true)
  expect(isInlineImage('image/webp')).toBe(true)
  expect(isInlineImage('image/gif')).toBe(true)
  expect(isInlineImage('application/pdf')).toBe(false)
  expect(isInlineImage('text/plain')).toBe(false)
  expect(isInlineImage('image/svg+xml')).toBe(false)
})
