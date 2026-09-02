import { expect, test } from 'bun:test'
import { formatBytes } from '../src/features/system/lib/format'

test('bytes are scaled to the shortest readable unit', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1024)).toBe('1.0 KB')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(536_870_912)).toBe('512 MB')
  expect(formatBytes(2_254_857_830)).toBe('2.1 GB')
  expect(formatBytes(1_099_511_627_776)).toBe('1.0 TB')
})

test('a decimal is shown only where it says something', () => {
  // 2.1 GB is worth a digit; 512 MB is not, and "512.0 MB" is just wider.
  expect(formatBytes(2_254_857_830)).toContain('.')
  expect(formatBytes(536_870_912)).not.toContain('.')
})

test('nonsense input does not render as NaN in the status bar', () => {
  expect(formatBytes(Number.NaN)).toBe('0 B')
  expect(formatBytes(-1)).toBe('0 B')
  expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
})

test('very large values stay in a real unit', () => {
  expect(formatBytes(1024 ** 6)).toContain('PB')
})
