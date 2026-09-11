// `blockLabel` is the one-line name the structure explorer shows for a block
// — the closest thing a block has to a filename. A pure function of the block
// (plus the asset filename its caller has already resolved), so it is tested
// directly rather than through the explorer's own DOM.
//
// Every length assertion goes through the exported `BLOCK_LABEL_MAX_LENGTH`
// rather than a hardcoded 60: the constant exists so a change to it moves the
// test with it instead of silently breaking it.

import { expect, test } from 'bun:test'
import type { IdeaBlock } from '../src/features/ideas/hooks/use-idea-canvas'
import { BLOCK_LABEL_MAX_LENGTH, blockLabel } from '../src/features/ideas/lib/block-label'

const BASE = {
  id: 'b-1',
  ideaId: 'idea-1',
  groupId: null,
  seq: 1,
  x: 0,
  y: 0,
  w: null,
  h: null,
} as const

const note = (text: string): IdeaBlock => ({ ...BASE, kind: 'note', text })
const link = (url: string, label: string | null): IdeaBlock => ({
  ...BASE,
  kind: 'link',
  url,
  label,
})
const image = (assetId: string, caption: string | null): IdeaBlock => ({
  ...BASE,
  kind: 'image',
  assetId,
  caption,
})

test('a multi-line note is named by its first non-empty line only', () => {
  expect(blockLabel(note('First line\nsecond line\nthird'))).toBe('First line')
  // A body can open with blank lines; the name is the first line with real
  // content, not the empty string a naive split('\n')[0] would give.
  expect(blockLabel(note('\n\n   \nActual content here\nmore'))).toBe('Actual content here')
  expect(blockLabel(note('Windows line endings\r\nsecond'))).toBe('Windows line endings')
})

test('whitespace runs inside the chosen line collapse to single spaces', () => {
  expect(blockLabel(note('  Too    many\tspaces  here  '))).toBe('Too many spaces here')
})

test('text longer than the exported limit is truncated with a trailing ellipsis', () => {
  const long = 'x'.repeat(BLOCK_LABEL_MAX_LENGTH + 5)
  const label = blockLabel(note(long))

  expect(label).toBe(`${'x'.repeat(BLOCK_LABEL_MAX_LENGTH)}…`)
  expect(label.endsWith('…')).toBe(true)
  // The ellipsis is the only character past the limit.
  expect(label).toHaveLength(BLOCK_LABEL_MAX_LENGTH + 1)
})

test('text exactly at the limit is left alone — no ellipsis', () => {
  const exact = 'y'.repeat(BLOCK_LABEL_MAX_LENGTH)
  const label = blockLabel(note(exact))

  expect(label).toBe(exact)
  expect(label).not.toContain('…')
  expect(label).toHaveLength(BLOCK_LABEL_MAX_LENGTH)
})

test('a blank or whitespace-only body has no name at all, so the caller can fall back', () => {
  // Not the kind label, and not a string of spaces: an empty string, which is
  // falsy, is what lets the explorer row substitute the translated kind name.
  expect(blockLabel(note(''))).toBe('')
  expect(blockLabel(note('   \t  '))).toBe('')
  expect(blockLabel(note('\n\n\n'))).toBe('')
})

test('requirement and example blocks are named from their text the same way', () => {
  expect(blockLabel({ ...BASE, kind: 'requirement', text: 'Must log in\ndetail' })).toBe(
    'Must log in',
  )
  expect(blockLabel({ ...BASE, kind: 'example', text: '  spaced   out  ' })).toBe('spaced out')
})

test('a link prefers its label and falls back to the raw url', () => {
  expect(blockLabel(link('https://example.com/a/b', 'The label'))).toBe('The label')
  expect(blockLabel(link('https://example.com/a/b', null))).toBe('https://example.com/a/b')
  // An empty or whitespace-only label is no label either.
  expect(blockLabel(link('https://example.com/a/b', ''))).toBe('https://example.com/a/b')
  expect(blockLabel(link('https://example.com/a/b', '   Padded  label '))).toBe('Padded label')
})

test('a long link label is truncated like any other name', () => {
  const label = blockLabel(link('https://example.com', 'z'.repeat(BLOCK_LABEL_MAX_LENGTH + 1)))
  expect(label).toBe(`${'z'.repeat(BLOCK_LABEL_MAX_LENGTH)}…`)
})

test('an image prefers the asset filename, then the caption, then the raw assetId', () => {
  expect(blockLabel(image('asset-1', 'A caption'), 'diagram.png')).toBe('diagram.png')
  // The asset can be deleted out from under the block that references it —
  // the caption, then the id, are what is left to name it by.
  expect(blockLabel(image('asset-1', 'A caption'))).toBe('A caption')
  expect(blockLabel(image('asset-1', null))).toBe('asset-1')
  expect(blockLabel(image('asset-1', ''))).toBe('asset-1')
  expect(blockLabel(image('asset-1', 'A caption'), '')).toBe('A caption')
})
