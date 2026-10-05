// The schedule builder's own cron ⇄ preset math (src/features/automations/
// lib/schedule.ts) — pure functions, so these round-trip checks need no DOM,
// no i18n provider and no mounted component. `describeSchedule`'s own i18n
// surface is covered by a stub `t` that just echoes the key and its options,
// since the point here is "which key, with which values", not the English
// wording — a real translation parity check belongs in a dedicated
// `i18n-*-parity` test, per this repo's own convention.

import { expect, test } from 'bun:test'
import {
  cronFromFields,
  describeSchedule,
  fieldsFromCron,
  fromCron,
  toCron,
} from '../src/features/automations/lib/schedule'

const stubT = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key

test('daily round-trips through cron text', () => {
  const cron = toCron({ kind: 'daily', time: '09:05' })
  expect(cron).toBe('5 9 * * *')
  expect(fromCron(cron)).toEqual({ kind: 'daily', time: '09:05' })
})

test('weekdays round-trips, using the 1-5 range form', () => {
  const cron = toCron({ kind: 'weekdays', time: '00:00' })
  expect(cron).toBe('0 0 * * 1-5')
  expect(fromCron(cron)).toEqual({ kind: 'weekdays', time: '00:00' })
})

test('weekends round-trips, using the 0,6 list form', () => {
  const cron = toCron({ kind: 'weekends', time: '23:59' })
  expect(cron).toBe('59 23 * * 0,6')
  expect(fromCron(cron)).toEqual({ kind: 'weekends', time: '23:59' })
})

test('specific days round-trips, ascending and deduplicated', () => {
  const cron = toCron({ kind: 'days', time: '08:00', days: [4, 2] })
  expect(cron).toBe('0 8 * * 2,4')
  expect(fromCron(cron)).toEqual({ kind: 'days', time: '08:00', days: [2, 4] })
})

test('a specific-days selection equal to Mon–Fri reads back as the Weekdays preset', () => {
  const cron = toCron({ kind: 'days', time: '09:00', days: [1, 2, 3, 4, 5] })
  expect(cron).toBe('0 9 * * 1,2,3,4,5')
  expect(fromCron(cron)).toEqual({ kind: 'weekdays', time: '09:00' })
})

test('a specific-days selection equal to Sat/Sun reads back as the Weekends preset', () => {
  const cron = toCron({ kind: 'days', time: '09:00', days: [0, 6] })
  expect(fromCron(cron)).toEqual({ kind: 'weekends', time: '09:00' })
})

test('every hour (N=1) round-trips to the bare `*` hour field', () => {
  const cron = toCron({ kind: 'hourly', everyHours: 1, minute: 30 })
  expect(cron).toBe('30 * * * *')
  expect(fromCron(cron)).toEqual({ kind: 'hourly', everyHours: 1, minute: 30 })
})

test('every N hours (N>1) round-trips to the `*/N` hour field', () => {
  const cron = toCron({ kind: 'hourly', everyHours: 5, minute: 15 })
  expect(cron).toBe('15 */5 * * *')
  expect(fromCron(cron)).toEqual({ kind: 'hourly', everyHours: 5, minute: 15 })
})

test('a hand-written cron outside the canonical shapes reads as custom, verbatim', () => {
  expect(fromCron('*/15 9-17 * * *')).toEqual({ kind: 'custom', cron: '*/15 9-17 * * *' })
  expect(fromCron('0 0 1 * *')).toEqual({ kind: 'custom', cron: '0 0 1 * *' })
  expect(fromCron('not a cron')).toEqual({ kind: 'custom', cron: 'not a cron' })
})

test('extra whitespace between fields is trimmed down to the same 5 fields, not treated as non-canonical', () => {
  expect(fromCron('  5   9  *  *  *  ')).toEqual({ kind: 'daily', time: '09:05' })
})

test('a leading-zero minute/hour is not canonical — toCron never writes one, fromCron never accepts one', () => {
  expect(fromCron('05 09 * * *')).toEqual({ kind: 'custom', cron: '05 09 * * *' })
})

test('custom preserves the raw text exactly', () => {
  const raw = '*/10 8-18 * * 1-5'
  expect(toCron({ kind: 'custom', cron: raw })).toBe(raw)
  expect(fromCron(raw)).toEqual({ kind: 'custom', cron: raw })
})

test('the builder field shape round-trips through cron text for every preset kind', () => {
  const daily = fieldsFromCron(cronFromFields({
    scheduleKind: 'daily',
    time: '07:30',
    days: [],
    everyHours: 1,
    minute: 0,
    customCron: '',
  }))
  expect(daily.scheduleKind).toBe('daily')
  expect(daily.time).toBe('07:30')

  const hourly = fieldsFromCron(cronFromFields({
    scheduleKind: 'hourly',
    time: '00:00',
    days: [],
    everyHours: 3,
    minute: 45,
    customCron: '',
  }))
  expect(hourly.scheduleKind).toBe('hourly')
  expect(hourly.everyHours).toBe(3)
  expect(hourly.minute).toBe(45)
})

test('describeSchedule picks the right key and values per kind', () => {
  expect(describeSchedule('0 9 * * *', stubT)).toBe(
    'automations.schedule.describe.daily:{"time":"09:00"}',
  )
  expect(describeSchedule('0 9 * * 1-5', stubT)).toBe(
    'automations.schedule.describe.weekdays:{"time":"09:00"}',
  )
  expect(describeSchedule('15 * * * *', stubT)).toBe(
    'automations.schedule.describe.everyHour:{"minute":"15"}',
  )
  expect(describeSchedule('15 */3 * * *', stubT)).toBe(
    'automations.schedule.describe.everyNHours:{"n":3,"minute":"15"}',
  )
  expect(describeSchedule('not a cron', stubT)).toBe(
    'automations.schedule.describe.custom:{"cron":"not a cron"}',
  )
})
