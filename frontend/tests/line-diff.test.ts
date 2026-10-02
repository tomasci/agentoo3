// diffLines (src/shared/lib/line-diff.ts): the pure line-diff behind the
// suggestion review page's before/after view. Covered directly, with no
// rendering involved, per the "diff function" bullet in the learning
// feature's test requirements — insertions, deletions, replacements,
// identical input and empty input.

import { expect, test } from 'bun:test'
import { diffLines } from '../src/shared/lib/line-diff'

const types = (before: string, after: string) => diffLines(before, after).map((l) => l.type)
const lines = (before: string, after: string) =>
  diffLines(before, after).map((l) => `${l.type[0]}:${l.text}`)

test('two empty strings produce no lines at all', () => {
  expect(diffLines('', '')).toEqual([])
})

test('empty before, non-empty after is a pure insertion', () => {
  expect(lines('', 'a\nb')).toEqual(['a:a', 'a:b'])
})

test('non-empty before, empty after is a pure deletion', () => {
  expect(lines('a\nb', '')).toEqual(['r:a', 'r:b'])
})

test('identical documents are all context, nothing added or removed', () => {
  const doc = 'line one\nline two\nline three'
  const result = diffLines(doc, doc)
  expect(types(doc, doc)).toEqual(['context', 'context', 'context'])
  expect(result.map((l) => l.text)).toEqual(doc.split('\n'))
})

test('an inserted line in the middle shows as context, add, context', () => {
  expect(lines('a\nc', 'a\nb\nc')).toEqual(['c:a', 'a:b', 'c:c'])
})

test('a deleted line in the middle shows as context, remove, context', () => {
  expect(lines('a\nb\nc', 'a\nc')).toEqual(['c:a', 'r:b', 'c:c'])
})

test('a changed line is a replacement: remove the old, add the new', () => {
  expect(lines('a\nb\nc', 'a\nx\nc')).toEqual(['c:a', 'r:b', 'a:x', 'c:c'])
})

test('appending lines at the end is a pure trailing insertion', () => {
  expect(lines('a\nb', 'a\nb\nc\nd')).toEqual(['c:a', 'c:b', 'a:c', 'a:d'])
})

test('removing lines from the end is a pure trailing deletion', () => {
  expect(lines('a\nb\nc\nd', 'a\nb')).toEqual(['c:a', 'c:b', 'r:c', 'r:d'])
})

test('completely different documents of the same length diff line by line', () => {
  expect(lines('a\nb', 'x\ny')).toEqual(['r:a', 'r:b', 'a:x', 'a:y'])
})

test('a duplicated line is not collapsed: each occurrence is accounted for', () => {
  // Three 'x's before, two after — exactly one must be removed, and the
  // other two line up as context rather than the diff inventing an add/remove
  // pair that cancels out.
  expect(lines('x\nx\nx', 'x\nx')).toEqual(['c:x', 'c:x', 'r:x'])
})
