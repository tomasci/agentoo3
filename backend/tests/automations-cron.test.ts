// Pure unit tests over features/automations/cron.ts — no database, no clock
// but the one each test passes in explicitly. See that module's own header
// for why every function here takes `now`/`after` rather than reading the
// real clock, and backend/README.md's "Automations" section for the 5-minute
// floor this file pins down.

import { expect, test } from 'bun:test'
import './setup-env'
import { nextOccurrenceAfter, previewSchedule, validateCron } from '@/features/automations/cron'

const NOW = new Date('2026-01-01T00:00:00.000Z')

// --- validateCron: shape ------------------------------------------------------

test('validateCron rejects an unknown IANA time zone', () => {
  const result = validateCron('0 0 * * *', 'Not/AZone', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/time zone/i)
})

test('validateCron rejects a 6-field (seconds) expression', () => {
  const result = validateCron('0 0 * * * *', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/5 fields/)
})

test('validateCron rejects an "@" macro', () => {
  const result = validateCron('@daily', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/5 fields/)
})

test('validateCron rejects a syntactically invalid expression', () => {
  // Exactly 5 fields, so this fails cron-parser's own parse rather than the
  // field-count check above — out-of-range minute and hour values.
  const result = validateCron('99 99 * * *', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/Invalid cron expression/)
})

// --- validateCron: never fires ------------------------------------------------

test('validateCron rejects a day-of-month that never occurs (Feb 30)', () => {
  const result = validateCron('0 0 30 2 *', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toBeTruthy()
})

test('validateCron rejects a day-of-month that never occurs (Apr 31)', () => {
  const result = validateCron('0 0 31 4 *', 'UTC', NOW)
  expect(result.valid).toBe(false)
})

// --- validateCron: the 5-minute floor -----------------------------------------

test('validateCron rejects a schedule firing every minute', () => {
  const result = validateCron('* * * * *', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/5 minutes apart/)
})

test('validateCron rejects a schedule firing every 4 minutes', () => {
  const result = validateCron('*/4 * * * *', 'UTC', NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/5 minutes apart/)
})

test('validateCron accepts a schedule firing exactly every 5 minutes', () => {
  const result = validateCron('*/5 * * * *', 'UTC', NOW)
  expect(result.valid).toBe(true)
  expect(result.error).toBeNull()
})

// --- validateCron: the ordinary case ------------------------------------------

test('validateCron accepts an ordinary once-a-day schedule', () => {
  const result = validateCron('0 4 * * *', 'America/New_York', NOW)
  expect(result).toEqual({ valid: true, error: null })
})

test('validateCron accepts a leap-year-only schedule (Feb 29)', () => {
  // Real, if rare — once every four years is not "never fires".
  const result = validateCron('0 0 29 2 *', 'UTC', NOW)
  expect(result.valid).toBe(true)
})

// --- nextOccurrenceAfter -------------------------------------------------------

test('nextOccurrenceAfter is strictly after the given instant, not an exact match', () => {
  const exact = new Date('2026-01-02T04:00:00.000Z')
  const next = nextOccurrenceAfter('0 4 * * *', 'UTC', exact)
  expect(next.toISOString()).toBe('2026-01-03T04:00:00.000Z')
})

test('nextOccurrenceAfter skips several missed days in one step', () => {
  // A worker down for a week: asking "after now" lands on the very next
  // occurrence, never a backlog of the days in between.
  const after = new Date('2026-01-10T12:00:00.000Z')
  const next = nextOccurrenceAfter('0 4 * * *', 'UTC', after)
  expect(next.toISOString()).toBe('2026-01-11T04:00:00.000Z')
})

// --- previewSchedule -----------------------------------------------------------

test('previewSchedule returns the next `count` occurrences when valid', () => {
  const result = previewSchedule('0 4 * * *', 'UTC', 3, NOW)
  expect(result.valid).toBe(true)
  expect(result.error).toBeNull()
  expect(result.nextRuns.map((d) => d.toISOString())).toEqual([
    '2026-01-01T04:00:00.000Z',
    '2026-01-02T04:00:00.000Z',
    '2026-01-03T04:00:00.000Z',
  ])
})

test('previewSchedule reports invalid: false occurrences, same error as validateCron', () => {
  const result = previewSchedule('* * * * *', 'UTC', 5, NOW)
  expect(result.valid).toBe(false)
  expect(result.error).toMatch(/5 minutes apart/)
  expect(result.nextRuns).toEqual([])
})
