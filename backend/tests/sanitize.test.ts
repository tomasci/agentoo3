import { expect, test } from 'bun:test'
import { sanitizeForDb } from '../src/db/sanitize'

// Built, never written as a literal or an escape: this file is itself read and
// recorded by agents working on this repo, and spelling the character out
// reproduces the very bug these tests cover.
const NUL = String.fromCharCode(0)
const ESC = String.fromCharCode(27)

test('strips the NUL character from a bare string', () => {
  expect(sanitizeForDb(`level: ${NUL}`)).toBe('level: ')
})

test('strips it from deep inside a tool_result payload', () => {
  const payload = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: `TextRunHarfBuzz error, level: '${NUL}', script: -1` },
      ],
    },
  }
  const clean = sanitizeForDb(payload)
  const text = (clean.message.content[0] as { content: string }).content
  expect(text).toBe("TextRunHarfBuzz error, level: '', script: -1")
  expect(JSON.stringify(clean).includes(NUL)).toBe(false)
})

test('strips it from an object key as well as a value', () => {
  const clean = sanitizeForDb({ [`bad${NUL}key`]: `bad${NUL}value` })
  expect(Object.keys(clean)).toEqual(['badkey'])
  expect(clean.badkey).toBe('badvalue')
})

test('reaches through arrays at any depth', () => {
  const clean = sanitizeForDb({ a: [{ b: [`x${NUL}y`] }] })
  expect(clean.a[0]?.b[0]).toBe('xy')
})

// The important one: an over-eager sanitizer that ate real content would
// corrupt more transcripts than the bug it was written to fix.
test('leaves every other control character and non-ASCII text untouched', () => {
  const kept = `line1\nline2\ttabbed ${ESC}[31mred${ESC}[0m emoji 🎉 cjk 漢字 astral 𝄞`
  expect(sanitizeForDb(kept)).toBe(kept)
})

test('returns the identical reference when there is nothing to strip', () => {
  const payload = { message: { content: [{ text: 'all clean' }] } }
  expect(sanitizeForDb(payload)).toBe(payload)
  const s = 'no nul here'
  expect(sanitizeForDb(s)).toBe(s)
})

test('passes Date instances through unchanged, not walked into an object', () => {
  const now = new Date('2026-09-04T21:00:00.000Z')
  const clean = sanitizeForDb({ updatedAt: now, note: `x${NUL}` })
  expect(clean.updatedAt).toBeInstanceOf(Date)
  expect(clean.updatedAt.toISOString()).toBe('2026-09-04T21:00:00.000Z')
  expect(clean.note).toBe('x')
})

test('handles null, undefined and primitives', () => {
  expect(sanitizeForDb(null)).toBeNull()
  expect(sanitizeForDb(undefined)).toBeUndefined()
  expect(sanitizeForDb(42)).toBe(42)
  expect(sanitizeForDb(true)).toBe(true)
  expect(sanitizeForDb({ a: null, b: undefined, c: 0 })).toEqual({ a: null, b: undefined, c: 0 })
})

test('strips every occurrence, not just the first', () => {
  expect(sanitizeForDb(`a${NUL}b${NUL}c${NUL}`)).toBe('abc')
})
