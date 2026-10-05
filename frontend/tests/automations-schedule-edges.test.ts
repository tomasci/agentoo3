// Edge cases for the schedule builder's cron ⇄ preset rules
// (src/features/automations/lib/schedule.ts), beyond the round trips in
// tests/automations-schedule.test.ts.
//
// The rule under test: `toCron` only ever writes the five canonical forms,
// with no leading zeros; `fromCron` reads back exactly those (plus the
// specific-days list that equals 1-5 / 0,6), and *anything else* — a leading
// zero, a range or step it never writes, an out-of-range value — is Custom,
// with the raw text kept so editing it never rewrites someone's cron.
//
// `describeSchedule` is checked against the real en and ru bundles through
// real i18next instances, so a missing or mis-keyed string shows up here as
// the wrong sentence, not as a key echoed back.

import { describe, expect, test } from 'bun:test'
import i18next from 'i18next'
import {
  cronFromFields,
  describeSchedule,
  fieldsFromCron,
  fromCron,
  type SchedulePreset,
  toCron,
} from '../src/features/automations/lib/schedule'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const custom = (cron: string): SchedulePreset => ({ kind: 'custom', cron })

describe('leading zeros are not canonical', () => {
  test.each([['09 9 * * *'], ['0 09 * * *'], ['00 9 * * *'], ['05 */3 * * *'], ['0 07 * * 1-5']])(
    '%p reads back as Custom, raw text kept',
    (cron) => {
      expect(fromCron(cron)).toEqual(custom(cron))
    },
  )

  test('toCron never writes a leading zero, for any time of day', () => {
    for (let h = 0; h < 24; h++) {
      for (let mi = 0; mi < 60; mi++) {
        const time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
        const cron = toCron({ kind: 'daily', time })
        expect(cron).toBe(`${mi} ${h} * * *`)
        expect(fromCron(cron)).toEqual({ kind: 'daily', time })
      }
    }
  })
})

describe('day-of-week lists', () => {
  test('"1,2,3,4,5" and "1-5" both read back as Weekdays', () => {
    expect(fromCron('0 9 * * 1,2,3,4,5')).toEqual({ kind: 'weekdays', time: '09:00' })
    expect(fromCron('0 9 * * 1-5')).toEqual({ kind: 'weekdays', time: '09:00' })
  })

  test('"0,6" reads back as Weekends; the reversed "6,0" is Custom', () => {
    expect(fromCron('0 9 * * 0,6')).toEqual({ kind: 'weekends', time: '09:00' })
    expect(fromCron('0 9 * * 6,0')).toEqual(custom('0 9 * * 6,0'))
  })

  test('a single day round-trips as Specific days', () => {
    expect(toCron({ kind: 'days', time: '09:00', days: [3] })).toBe('0 9 * * 3')
    expect(fromCron('0 9 * * 3')).toEqual({ kind: 'days', time: '09:00', days: [3] })
  })

  test('toCron sorts and de-duplicates the picked days', () => {
    expect(toCron({ kind: 'days', time: '06:00', days: [5, 1, 3, 1] })).toBe('0 6 * * 1,3,5')
  })

  test.each([
    ['0 9 * * 3,1'], // not ascending
    ['0 9 * * 1,1'], // duplicate
    ['0 9 * * 1-3'], // a range other than 1-5
    ['0 9 * * 0-6'],
    ['0 9 * * MON'], // names
    ['0 9 * * */2'], // a step
  ])('%p is not a canonical day list → Custom', (cron) => {
    expect(fromCron(cron)).toEqual(custom(cron))
  })
})

describe('every N hours', () => {
  test('"0 */1 * * *" is not the canonical N=1 form ("0 * * * *") → Custom', () => {
    expect(fromCron('0 */1 * * *')).toEqual(custom('0 */1 * * *'))
    expect(toCron({ kind: 'hourly', everyHours: 1, minute: 0 })).toBe('0 * * * *')
  })

  test('"0 */24 * * *" → Custom (beyond the builder\'s 12-hour step)', () => {
    expect(fromCron('0 */24 * * *')).toEqual(custom('0 */24 * * *'))
  })

  test('"0 */13 * * *" → Custom; "0 */12 * * *" → every 12 hours', () => {
    expect(fromCron('0 */13 * * *')).toEqual(custom('0 */13 * * *'))
    expect(fromCron('0 */12 * * *')).toEqual({ kind: 'hourly', everyHours: 12, minute: 0 })
  })

  test('every step 1..12 and every minute round-trips', () => {
    for (let n = 1; n <= 12; n++) {
      for (let mi = 0; mi < 60; mi++) {
        const cron = toCron({ kind: 'hourly', everyHours: n, minute: mi })
        expect(cron).toBe(n === 1 ? `${mi} * * * *` : `${mi} */${n} * * *`)
        expect(fromCron(cron)).toEqual({ kind: 'hourly', everyHours: n, minute: mi })
      }
    }
  })

  test('a step with a day-of-week restriction is Custom', () => {
    expect(fromCron('0 */3 * * 1-5')).toEqual(custom('0 */3 * * 1-5'))
  })

  test('every minute ("* * * * *") is Custom, not hourly', () => {
    expect(fromCron('* * * * *')).toEqual(custom('* * * * *'))
  })
})

describe('out-of-range values', () => {
  test.each([
    ['60 9 * * *'],
    ['0 24 * * *'],
    ['0 9 * * 7'],
    ['0 9 * * 1,8'],
    ['60 * * * *'],
    ['99 */3 * * *'],
    ['-1 9 * * *'],
  ])('%p → Custom, raw text kept', (cron) => {
    expect(fromCron(cron)).toEqual(custom(cron))
  })

  test('the boundaries themselves are fine', () => {
    expect(fromCron('59 23 * * *')).toEqual({ kind: 'daily', time: '23:59' })
    expect(fromCron('0 0 * * 0,6')).toEqual({ kind: 'weekends', time: '00:00' })
    expect(fromCron('0 0 * * 0,1,2,3,4,5,6')).toEqual({
      kind: 'days',
      time: '00:00',
      days: [0, 1, 2, 3, 4, 5, 6],
    })
  })
})

describe('shape and whitespace', () => {
  test('extra spaces, tabs and a trailing newline still read as the canonical form', () => {
    expect(fromCron('  0   9  *  * *  ')).toEqual({ kind: 'daily', time: '09:00' })
    expect(fromCron('\t30\t7 * * 1-5\n')).toEqual({ kind: 'weekdays', time: '07:30' })
    expect(fromCron(' 15  */3 * * * ')).toEqual({ kind: 'hourly', everyHours: 3, minute: 15 })
  })

  test('a Custom cron keeps its inner text, trimmed only at the ends', () => {
    expect(fromCron('  0 9 1 * *  ')).toEqual(custom('0 9 1 * *'))
    expect(fieldsFromCron('  0  9 1 * * ').customCron).toBe('0  9 1 * *')
  })

  test.each([[''], ['   '], ['0 9 * *'], ['0 9 * * * *'], ['@daily'], ['nonsense']])(
    '%p (wrong field count) → Custom',
    (cron) => {
      expect(fromCron(cron)).toEqual(custom(cron.trim()))
    },
  )

  test('anything touching day-of-month or month is Custom', () => {
    for (const cron of ['0 9 1 * *', '0 9 * 1 *', '0 9 */2 * *', '0 9 ? * *']) {
      expect(fromCron(cron)).toEqual(custom(cron))
    }
  })
})

describe('fields ⇄ cron (what the dialog reads and writes)', () => {
  test('a Custom cron survives fieldsFromCron → cronFromFields unchanged', () => {
    for (const cron of ['0 9 1 * *', '09 9 * * *', '0 */1 * * *', '*/5 * * * *']) {
      expect(cronFromFields(fieldsFromCron(cron))).toBe(cron)
    }
  })

  test('every canonical cron survives fieldsFromCron → cronFromFields unchanged', () => {
    for (const cron of [
      '0 9 * * *',
      '30 7 * * 1-5',
      '5 10 * * 0,6',
      '0 8 * * 1,3,5',
      '15 */3 * * *',
      '0 * * * *',
    ]) {
      expect(cronFromFields(fieldsFromCron(cron))).toBe(cron)
    }
  })
})

// ── describeSchedule, both locales ──────────────────────────────────────────

const instance = async (lng: 'en' | 'ru') => {
  const i = i18next.createInstance()
  await i.init({
    lng,
    fallbackLng: false,
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  return i.t.bind(i) as (key: string, options?: Record<string, unknown>) => string
}
const tEn = await instance('en')
const tRu = await instance('ru')

describe('describeSchedule', () => {
  test.each([
    ['0 9 * * *', 'Every day at 09:00', 'Каждый день в 09:00'],
    ['30 7 * * 1-5', 'Weekdays at 07:30', 'По будням в 07:30'],
    ['0 9 * * 1,2,3,4,5', 'Weekdays at 09:00', 'По будням в 09:00'],
    ['5 10 * * 0,6', 'Weekends at 10:05', 'По выходным в 10:05'],
    ['0 8 * * 1,3,5', 'Mon, Wed, Fri at 08:00', 'Пн, Ср, Пт в 08:00'],
    ['0 8 * * 0,3', 'Sun, Wed at 08:00', 'Вс, Ср в 08:00'],
    ['15 */3 * * *', 'Every 3 hours at :15', 'Каждые 3 ч. в :15'],
    ['30 * * * *', 'Every hour at :30', 'Каждый час в :30'],
    ['0 9 1 * *', 'Custom: 0 9 1 * *', 'Другое: 0 9 1 * *'],
    ['09 9 * * *', 'Custom: 09 9 * * *', 'Другое: 09 9 * * *'],
  ])('%p → en %p, ru %p', (cron, expectedEn, expectedRu) => {
    expect(describeSchedule(cron, tEn)).toBe(expectedEn)
    expect(describeSchedule(cron, tRu)).toBe(expectedRu)
  })

  // A minute under 10 must read like a clock minute (":05"), the same way the
  // daily form pads its "09:05" — not ":5", which reads as a different time.
  test('a single-digit minute is padded: "5 * * * *" → "Every hour at :05"', () => {
    expect(describeSchedule('5 * * * *', tEn)).toBe('Every hour at :05')
    expect(describeSchedule('5 */2 * * *', tEn)).toBe('Every 2 hours at :05')
    expect(describeSchedule('5 * * * *', tRu)).toBe('Каждый час в :05')
  })

  test('no key is ever echoed back (every key exists in both bundles)', () => {
    for (const cron of [
      '0 9 * * *',
      '0 9 * * 1-5',
      '0 9 * * 0,6',
      '0 9 * * 0,1,2,3,4,5,6',
      '0 * * * *',
      '0 */2 * * *',
      'x',
    ]) {
      expect(describeSchedule(cron, tEn)).not.toContain('automations.')
      expect(describeSchedule(cron, tRu)).not.toContain('automations.')
    }
  })
})
