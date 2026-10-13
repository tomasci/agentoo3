// shared/lib/date.ts — the date-fns helpers the sessions list and the session
// page's details popover format through, in both UI languages:
//
//   - dateLocale: `ru*` → Russian, anything else (undefined included) → en-US;
//   - formatTimeOfDay: 24-hour `HH:mm`, the same in both languages;
//   - formatDateTime: the locale's medium date, then `HH:mm`;
//   - formatDayLabel: short month and day, month-first in English and
//     day-first in Russian, no year;
//   - all three answer '' for an invalid date instead of throwing.
//
// The expected strings are literals, not re-derived through date-fns, and the
// inputs are built with the local-time Date constructor so they read the same
// under any TZ the runner has.

import { describe, expect, test } from 'bun:test'
import { enUS } from 'date-fns/locale/en-US'
import { ru } from 'date-fns/locale/ru'
import { dateLocale, formatDateTime, formatDayLabel, formatTimeOfDay } from '../src/shared/lib/date'

/** Local wall-clock time; month is 1-based here. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

const SEP_28 = local(2026, 9, 28, 14, 32)

describe('dateLocale', () => {
  test('ru and its regional variants are Russian', () => {
    expect(dateLocale('ru')).toBe(ru)
    expect(dateLocale('ru-RU')).toBe(ru)
  })

  test('everything else is English, including no language yet', () => {
    for (const lang of ['en', 'en-GB', 'de', 'cimode', '', undefined]) {
      expect(dateLocale(lang)).toBe(enUS)
    }
  })
})

describe('formatTimeOfDay', () => {
  test('24-hour HH:mm in both languages', () => {
    expect(formatTimeOfDay(SEP_28, 'en')).toBe('14:32')
    expect(formatTimeOfDay(SEP_28, 'ru')).toBe('14:32')
  })

  test('zero-padded, and never AM/PM', () => {
    expect(formatTimeOfDay(local(2026, 9, 28, 9, 5), 'en')).toBe('09:05')
    expect(formatTimeOfDay(local(2026, 9, 28, 0, 0), 'en')).toBe('00:00')
    expect(formatTimeOfDay(local(2026, 9, 28, 23, 59), 'en')).toBe('23:59')
  })

  test('accepts an ISO string as well as a Date', () => {
    expect(formatTimeOfDay(SEP_28.toISOString(), 'en')).toBe('14:32')
  })
})

describe('formatDateTime', () => {
  test('English: "Sep 28, 2026, 14:32"', () => {
    expect(formatDateTime(SEP_28, 'en')).toBe('Sep 28, 2026, 14:32')
    expect(formatDateTime(SEP_28.toISOString(), 'en')).toBe('Sep 28, 2026, 14:32')
  })

  test('Russian: "28 сент. 2026 г., 14:32"', () => {
    expect(formatDateTime(SEP_28, 'ru')).toBe('28 сент. 2026 г., 14:32')
    expect(formatDateTime(SEP_28, 'ru-RU')).toBe('28 сент. 2026 г., 14:32')
  })

  test('no language yet formats as English', () => {
    expect(formatDateTime(SEP_28, undefined)).toBe('Sep 28, 2026, 14:32')
  })

  test('24-hour time even in English', () => {
    expect(formatDateTime(local(2026, 3, 1, 21, 7), 'en')).toBe('Mar 1, 2026, 21:07')
  })
})

describe('formatDayLabel', () => {
  test('English is month first: "Oct 7"', () => {
    expect(formatDayLabel(local(2026, 10, 7, 15), 'en')).toBe('Oct 7')
  })

  test('Russian is day first: "7 окт."', () => {
    expect(formatDayLabel(local(2026, 10, 7, 15), 'ru')).toBe('7 окт.')
    // The genitive (formatting) month form, as a date reads in Russian.
    expect(formatDayLabel(local(2026, 5, 12), 'ru')).toBe('12 мая')
  })

  test('carries no year', () => {
    expect(formatDayLabel(local(2026, 10, 7), 'en')).not.toContain('2026')
    expect(formatDayLabel(local(2026, 10, 7), 'ru')).not.toContain('2026')
  })
})

describe('an invalid date', () => {
  const inputs: [string, string | Date][] = [
    ['empty string', ''],
    ['garbage string', 'not-a-date'],
    ['NaN Date', new Date(Number.NaN)],
  ]
  for (const [name, input] of inputs) {
    for (const lang of ['en', 'ru']) {
      test(`${name} (${lang}) formats as '' from all three, without throwing`, () => {
        expect(formatTimeOfDay(input, lang)).toBe('')
        expect(formatDateTime(input, lang)).toBe('')
        expect(formatDayLabel(input, lang)).toBe('')
      })
    }
  }
})
