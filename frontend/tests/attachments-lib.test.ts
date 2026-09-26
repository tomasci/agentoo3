import { expect, test } from 'bun:test'
import {
  attachmentDescription,
  isInlineImage,
  sessionFileUrl,
} from '../src/features/sessions/lib/attachments'

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

test('attachmentDescription prefixes the upper-cased extension to the detail', () => {
  expect(attachmentDescription('photo.png', '1 KB')).toBe('PNG · 1 KB')
  expect(attachmentDescription('notes.md', '42%')).toBe('MD · 42%')
})

test('attachmentDescription uses only the last extension of a multi-dot name', () => {
  expect(attachmentDescription('a.tar.gz', '3 MB')).toBe('GZ · 3 MB')
})

test('attachmentDescription upper-cases a mixed-case extension', () => {
  expect(attachmentDescription('x.JpEg', '9 B')).toBe('JPEG · 9 B')
})

test('attachmentDescription falls back to just the detail when there is no real extension', () => {
  expect(attachmentDescription('Makefile', '1 KB')).toBe('1 KB')
  expect(attachmentDescription('.env', '1 KB')).toBe('1 KB')
  expect(attachmentDescription('weird.', '1 KB')).toBe('1 KB')
  expect(attachmentDescription('', '1 KB')).toBe('1 KB')
})
