// features/sessions/lib/drafts.ts on its own: the persisted per-session
// composer draft (`agentoo:draft:<sessionId>` → `{ text, fileIds }`).
//
//   - `readDraft` never throws and never hands back a half-valid record:
//     missing key, bad JSON, or a stored value of the wrong shape all read as
//     the empty draft (the key may have been written by an older build, or
//     edited by hand).
//   - `updateDraft` merges only the patched field over what is *stored now* —
//     the text writer (use-session-draft.ts) and the tray writer
//     (use-session-files.ts) never clobber each other's field — removes the
//     key once both fields are empty, and notifies only that session's
//     subscribers.
//   - drafts are per session id, unbounded in number, and independent.
//
// Pure module plus localStorage, so no React here; the hooks built on top
// have their own files (tests/use-session-draft.test.tsx,
// tests/use-session-files-drafts.test.tsx).

import { beforeEach, expect, test } from 'bun:test'
import { readDraft, subscribeDraft, updateDraft } from '../src/features/sessions/lib/drafts'
import { swapLocalStorage } from './storage-spy'

const key = (id: string) => `agentoo:draft:${id}`
const stored = (id: string): unknown => {
  const raw = localStorage.getItem(key(id))
  return raw === null ? null : JSON.parse(raw)
}
const EMPTY = { text: '', fileIds: [] }

beforeEach(() => {
  localStorage.clear()
})

// --- D1. readDraft is defensive ---------------------------------------------

test('readDraft on a missing key is the empty draft', () => {
  expect(readDraft('nope')).toEqual(EMPTY)
})

test('readDraft returns a well-formed stored draft as-is', () => {
  localStorage.setItem(key('s1'), JSON.stringify({ text: 'hi', fileIds: ['f1', 'f2'] }))
  expect(readDraft('s1')).toEqual({ text: 'hi', fileIds: ['f1', 'f2'] })
})

test('readDraft drops unknown extra fields rather than passing them through', () => {
  localStorage.setItem(key('s1'), JSON.stringify({ text: 'hi', fileIds: [], extra: 1 }))
  expect(readDraft('s1')).toEqual({ text: 'hi', fileIds: [] })
})

const MALFORMED: [string, string][] = [
  ['not JSON at all', '{nope'],
  ['truncated JSON', '{"text":"hi","fileIds":["f1"'],
  ['JSON null', 'null'],
  ['a JSON string', '"hello"'],
  ['a JSON number', '42'],
  ['a JSON array', '["hi", ["f1"]]'],
  ['text missing', JSON.stringify({ fileIds: ['f1'] })],
  ['fileIds missing', JSON.stringify({ text: 'hi' })],
  ['text is a number', JSON.stringify({ text: 5, fileIds: [] })],
  ['text is null', JSON.stringify({ text: null, fileIds: [] })],
  ['fileIds is a string', JSON.stringify({ text: 'hi', fileIds: 'f1' })],
  ['fileIds is an object', JSON.stringify({ text: 'hi', fileIds: { 0: 'f1' } })],
  ['fileIds holds a number', JSON.stringify({ text: 'hi', fileIds: ['f1', 2] })],
  ['fileIds holds null', JSON.stringify({ text: 'hi', fileIds: [null] })],
]

for (const [what, raw] of MALFORMED) {
  test(`readDraft on ${what} is the empty draft, and does not throw`, () => {
    localStorage.setItem(key('s1'), raw)
    let result: unknown
    expect(() => {
      result = readDraft('s1')
    }).not.toThrow()
    expect(result).toEqual(EMPTY)
  })
}

test('readDraft survives localStorage itself throwing', () => {
  localStorage.setItem(key('s1'), JSON.stringify({ text: 'hi', fileIds: [] }))
  let reads = 0
  const restore = swapLocalStorage({
    overrides: {
      getItem: () => {
        reads++
        throw new Error('SecurityError: storage disabled')
      },
    },
  })
  try {
    expect(readDraft('s1')).toEqual(EMPTY)
    // The throwing stand-in really was the one consulted.
    expect(reads).toBe(1)
  } finally {
    restore()
  }
})

// --- D1. updateDraft merges, removes when empty -----------------------------

test('a text-only patch never drops stored fileIds', () => {
  localStorage.setItem(key('s1'), JSON.stringify({ text: '', fileIds: ['f1'] }))
  updateDraft('s1', { text: 'hello' })
  expect(stored('s1')).toEqual({ text: 'hello', fileIds: ['f1'] })
})

test('a fileIds-only patch never drops stored text', () => {
  updateDraft('s1', { text: 'hello' })
  updateDraft('s1', { fileIds: ['f1', 'f2'] })
  expect(stored('s1')).toEqual({ text: 'hello', fileIds: ['f1', 'f2'] })
})

test('the merge reads the *stored* value, not a snapshot taken before another write', () => {
  // Two writers interleaved: the tray writes fileIds between two text writes.
  updateDraft('s1', { text: 'a' })
  updateDraft('s1', { fileIds: ['f1'] })
  updateDraft('s1', { text: 'ab' })
  expect(stored('s1')).toEqual({ text: 'ab', fileIds: ['f1'] })
})

test('updateDraft returns the merged draft it wrote', () => {
  updateDraft('s1', { fileIds: ['f1'] })
  expect(updateDraft('s1', { text: 'x' })).toEqual({ text: 'x', fileIds: ['f1'] })
})

test('a patch over a malformed stored value starts from the empty draft', () => {
  localStorage.setItem(key('s1'), '{broken')
  updateDraft('s1', { text: 'x' })
  expect(stored('s1')).toEqual({ text: 'x', fileIds: [] })
})

test('the key is removed once both text and fileIds are empty', () => {
  updateDraft('s1', { text: 'x', fileIds: ['f1'] })
  updateDraft('s1', { text: '' })
  expect(stored('s1')).toEqual({ text: '', fileIds: ['f1'] })
  updateDraft('s1', { fileIds: [] })
  expect(localStorage.getItem(key('s1'))).toBeNull()
})

test('writing an empty patch to an absent draft leaves no key behind', () => {
  updateDraft('s1', { text: '' })
  updateDraft('s1', { fileIds: [] })
  expect(localStorage.getItem(key('s1'))).toBeNull()
  expect(localStorage.length).toBe(0)
})

test('whitespace-only text is still a draft worth keeping', () => {
  updateDraft('s1', { text: '  ' })
  expect(stored('s1')).toEqual({ text: '  ', fileIds: [] })
})

test('updateDraft does not throw when storage refuses the write', () => {
  let attempts = 0
  const restore = swapLocalStorage({
    overrides: {
      setItem: () => {
        attempts++
        throw new Error('QuotaExceededError')
      },
    },
  })
  try {
    let result: unknown
    expect(() => {
      result = updateDraft('s1', { text: 'x' })
    }).not.toThrow()
    expect(attempts).toBe(1)
    // The in-memory answer is still the merged draft, for this tab's use.
    expect(result).toEqual({ text: 'x', fileIds: [] })
  } finally {
    restore()
  }
})

// --- D1. subscribeDraft is per session --------------------------------------

test("updateDraft notifies that session's subscribers, and only theirs", () => {
  const seen: string[] = []
  const offA1 = subscribeDraft('A', () => seen.push('A1'))
  const offA2 = subscribeDraft('A', () => seen.push('A2'))
  const offB = subscribeDraft('B', () => seen.push('B'))

  updateDraft('A', { text: 'x' })
  expect(seen.sort()).toEqual(['A1', 'A2'])

  seen.length = 0
  updateDraft('B', { fileIds: ['f1'] })
  expect(seen).toEqual(['B'])

  offA1()
  offA2()
  offB()
})

test('a subscriber is notified for a fileIds-only write too', () => {
  let n = 0
  const off = subscribeDraft('A', () => n++)
  updateDraft('A', { fileIds: ['f1'] })
  expect(n).toBe(1)
  off()
})

test('unsubscribing stops notifications for that listener only', () => {
  const seen: string[] = []
  const off1 = subscribeDraft('A', () => seen.push('1'))
  const off2 = subscribeDraft('A', () => seen.push('2'))
  off1()
  updateDraft('A', { text: 'x' })
  expect(seen).toEqual(['2'])
  off2()
  updateDraft('A', { text: 'y' })
  expect(seen).toEqual(['2'])
})

test('a session that loses its last subscriber can be subscribed to again', () => {
  const off = subscribeDraft('A', () => {})
  off()
  let n = 0
  const off2 = subscribeDraft('A', () => n++)
  updateDraft('A', { text: 'x' })
  expect(n).toBe(1)
  off2()
})

// --- D4. many independent drafts -------------------------------------------

test('drafts for many sessions (different projects) coexist independently', () => {
  // Session ids are global (UUIDs), so a draft is keyed by session id alone —
  // two sessions in two different projects are just two different keys.
  const ids = Array.from({ length: 50 }, (_, i) => `proj${i % 5}-session-${i}`)
  for (const [i, id] of ids.entries()) {
    updateDraft(id, { text: `text ${i}`, fileIds: i % 2 ? [`f${i}`] : [] })
  }
  for (const [i, id] of ids.entries()) {
    expect(readDraft(id)).toEqual({ text: `text ${i}`, fileIds: i % 2 ? [`f${i}`] : [] })
  }
  expect(localStorage.length).toBe(50)
})

test("editing, or clearing, one session's draft never touches another's key", () => {
  updateDraft('A', { text: 'alpha', fileIds: ['a1'] })
  updateDraft('B', { text: 'beta', fileIds: ['b1'] })
  const rawB = localStorage.getItem(key('B'))

  updateDraft('A', { text: 'alpha 2' })
  updateDraft('A', { fileIds: ['a1', 'a2'] })
  expect(localStorage.getItem(key('B'))).toBe(rawB)

  updateDraft('A', { text: '', fileIds: [] })
  expect(localStorage.getItem(key('A'))).toBeNull()
  expect(localStorage.getItem(key('B'))).toBe(rawB)
})

test('an unrelated localStorage key is left alone by every draft write', () => {
  localStorage.setItem('agentoo:tabs', '["keep"]')
  updateDraft('A', { text: 'x' })
  updateDraft('A', { text: '' })
  expect(localStorage.getItem('agentoo:tabs')).toBe('["keep"]')
})
