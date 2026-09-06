import { expect, test } from 'bun:test'
import './setup-env'
import { sessionAttachmentsDir, sessionUploadsDir } from '../src/lib/paths'
import { sanitizeFilename } from '../src/features/attachments/storage'

const ID = 'ab12cd34-ef56-7890-abcd-ef1234567890'

test('shard derivation: first two hex chars, then the next two, then the full dashed id', () => {
  const dir = sessionAttachmentsDir(ID)
  expect(dir.endsWith(`sessions/ab/12/${ID}`)).toBe(true)
})

test('uploads dir is the shard dir plus /uploads', () => {
  expect(sessionUploadsDir(ID)).toBe(`${sessionAttachmentsDir(ID)}/uploads`)
})

test('a non-uuid session id is refused before it ever reaches a path', () => {
  expect(() => sessionAttachmentsDir('../../etc')).toThrow()
  expect(() => sessionAttachmentsDir('not-a-uuid')).toThrow()
})

test('sanitizeFilename flattens path separators entirely — no traversal survives', () => {
  const out = sanitizeFilename('../../etc/passwd')
  expect(out).not.toContain('/')
  expect(out).not.toContain('\\')
})

test('sanitizeFilename strips a leading dot (no hidden files)', () => {
  expect(sanitizeFilename('.bashrc')).toBe('bashrc')
  expect(sanitizeFilename('..profile')).toBe('profile')
})

test('sanitizeFilename collapses unsafe characters and keeps a normal name intact', () => {
  expect(sanitizeFilename('error.log')).toBe('error.log')
  expect(sanitizeFilename('spec v2 (final).pdf')).toBe('spec_v2__final_.pdf')
})

test('sanitizeFilename drops control characters rather than substituting them', () => {
  const withControl = `bad${String.fromCharCode(7)}name.txt`
  expect(sanitizeFilename(withControl)).toBe('badname.txt')
})

test('sanitizeFilename caps length and never returns empty', () => {
  expect(sanitizeFilename('a'.repeat(500)).length).toBeLessThanOrEqual(100)
  expect(sanitizeFilename('...')).toBe('file')
  expect(sanitizeFilename('')).toBe('file')
  expect(sanitizeFilename(String.fromCharCode(1, 2, 3))).toBe('file')
})

test('a .claude-shaped name cannot produce a subdirectory', () => {
  const out = sanitizeFilename('.claude/skills/evil/SKILL.md')
  expect(out).not.toContain('/')
})
