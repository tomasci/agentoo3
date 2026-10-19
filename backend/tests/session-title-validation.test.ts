// A session's title at the HTTP boundary: createSessionSchema and
// updateSessionSchema trim it before the length checks, so a whitespace-only
// title is refused and a padded one is stored without the padding. The rename
// UI sends PATCH /sessions/:id through updateSessionSchema, so the update half
// is the one a real client reaches first; create is kept identical so the two
// cannot drift.
//
// Exercised on the schemas directly: the rule lives entirely in them, and the
// route/service wiring around them (no Postgres needed here) does not change it.
import { describe, expect, test } from 'bun:test'
import { createSessionSchema, updateSessionSchema } from '../src/features/sessions/schema'

// createSessionSchema requires an orchestrator; it is irrelevant to the title.
const create = (title: unknown) => createSessionSchema.safeParse({ orchestrator: 'lead', title })
const update = (title: unknown) => updateSessionSchema.safeParse({ title })

describe.each([
  ['create', create],
  ['update', update],
] as const)('%s title', (_name, parse) => {
  test('a whitespace-only title is rejected', () => {
    for (const title of ['   ', ' ', '\t\n ', '  ']) {
      const result = parse(title)
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['title'])
    }
  })

  test('an empty title is still rejected', () => {
    expect(parse('').success).toBe(false)
  })

  test('a padded title parses to the trimmed value', () => {
    const result = parse('  New name  ')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('New name')
  })

  test('inner whitespace is left alone', () => {
    const result = parse('  two  words\tand more ')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBe('two  words\tand more')
  })

  test('200 characters are accepted and 201 are rejected', () => {
    const at = parse('a'.repeat(200))
    expect(at.success).toBe(true)
    if (at.success) expect(at.data.title).toBe('a'.repeat(200))
    expect(parse('a'.repeat(201)).success).toBe(false)
  })

  test('the limit applies to the trimmed value', () => {
    // Padding must not count against the 200, or a title the client could
    // display in full would be refused for whitespace it never sees.
    const padded = parse(`  ${'a'.repeat(200)}  `)
    expect(padded.success).toBe(true)
    if (padded.success) expect(padded.data.title).toBe('a'.repeat(200))
    expect(parse(`  ${'a'.repeat(201)}  `).success).toBe(false)
  })

  test('a non-string title is rejected', () => {
    expect(parse(42).success).toBe(false)
    expect(parse(null).success).toBe(false)
  })
})

describe('title is still optional', () => {
  test('create without a title parses with no title', () => {
    const result = createSessionSchema.safeParse({ orchestrator: 'lead' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBeUndefined()
  })

  test('update that changes only another field parses with no title', () => {
    const result = updateSessionSchema.safeParse({ maxBudgetUsd: 5 })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.title).toBeUndefined()
  })
})

describe('update with only a blank title', () => {
  test('{ title: "   " } is rejected rather than treated as a change', () => {
    const result = updateSessionSchema.safeParse({ title: '   ' })
    expect(result.success).toBe(false)
  })

  test('{} is still rejected as nothing to update', () => {
    const result = updateSessionSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toBe('Nothing to update')
  })

  test('a blank title does not ride along with a valid field', () => {
    expect(updateSessionSchema.safeParse({ title: '   ', maxBudgetUsd: 5 }).success).toBe(false)
  })
})
