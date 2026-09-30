// The pure formatting/threshold helpers behind the Usage page
// (src/features/system/lib/usage.ts): percent rounding, the three-level
// meter emphasis, the stale-reset check, the countdown/relative-time
// formatters, currency, and the account/overage/behavior label mappings.
// Everything here is plain data in, plain data out — no rendering, no fake
// timers required. `formatDurationShort` alone needs a real `t`, since its
// own unit words now come from i18n (en/ru) rather than being hardcoded —
// a real i18next instance loaded with both bundles is the same approach
// tests/usage-page.test.tsx and tests/usage-page-verify.test.tsx already
// take for exactly that reason.

import { expect, test } from 'bun:test'
import i18next from 'i18next'
import {
  behaviorLabelKey,
  capitalize,
  displayPercent,
  formatCurrencyMinor,
  formatDurationShort,
  formatRelativeTime,
  hasWindowReset,
  meterLevel,
  overageReasonKey,
  overageStatusLabel,
  resolveAuthDisplay,
  roundPercent,
  usageWindowLabelKey,
} from '../src/features/system/lib/usage'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})
const russian = i18next.createInstance()
await russian.init({
  lng: 'ru',
  fallbackLng: 'en',
  resources: { en: { translation: en }, ru: { translation: ru } },
  interpolation: { escapeValue: false },
})

// --- roundPercent -----------------------------------------------------------

test('roundPercent rounds to the nearest integer', () => {
  expect(roundPercent(8)).toBe(8)
  expect(roundPercent(23.4)).toBe(23)
  expect(roundPercent(64.5)).toBe(65)
})

// --- meterLevel --------------------------------------------------------------

test('below 75% reads as normal', () => {
  expect(meterLevel(0)).toBe('normal')
  expect(meterLevel(74.9)).toBe('normal')
})

test('75% up to just under 90% reads as warning', () => {
  expect(meterLevel(75)).toBe('warning')
  expect(meterLevel(89.9)).toBe('warning')
})

test('90% and above reads as critical', () => {
  expect(meterLevel(90)).toBe('critical')
  expect(meterLevel(100)).toBe('critical')
})

// --- displayPercent --------------------------------------------------------

test('a negative percent clamps to 0', () => {
  expect(displayPercent(-5)).toBe(0)
  expect(displayPercent(-0.4)).toBe(0)
})

test('an over-100 percent is left as-is — the bar, not the label, is what caps it', () => {
  expect(displayPercent(130)).toBe(130)
})

test('a normal in-range percent rounds the same way roundPercent does', () => {
  expect(displayPercent(23.4)).toBe(23)
})

// --- hasWindowReset ------------------------------------------------------

test('a resetsAt still ahead of now has not reset', () => {
  const now = new Date('2026-09-30T06:00:00.000Z').getTime()
  expect(hasWindowReset('2026-09-30T09:50:00.000Z', now)).toBe(false)
})

test('a resetsAt already behind now has reset', () => {
  const now = new Date('2026-09-30T10:00:00.000Z').getTime()
  expect(hasWindowReset('2026-09-30T09:50:00.000Z', now)).toBe(true)
})

test('a resetsAt exactly at now counts as reset, not still pending', () => {
  const now = new Date('2026-09-30T09:50:00.000Z').getTime()
  expect(hasWindowReset('2026-09-30T09:50:00.000Z', now)).toBe(true)
})

test('a null resetsAt has nothing to have reset', () => {
  expect(hasWindowReset(null, Date.now())).toBe(false)
})

// --- formatDurationShort ------------------------------------------------

test('hours and minutes render as the two largest units', () => {
  expect(formatDurationShort(3 * 3_600_000 + 16 * 60_000, english.t)).toBe('3h 16m')
})

test('days and hours render once a duration crosses a day', () => {
  expect(formatDurationShort(5 * 86_400_000 + 17 * 3_600_000 + 40 * 60_000, english.t)).toBe(
    '5d 17h',
  )
})

test('under a minute renders as a bare minutes figure', () => {
  expect(formatDurationShort(45 * 60_000, english.t)).toBe('45m')
})

test('under a minute reads as "<1m" rather than "0m", which would read as already due', () => {
  expect(formatDurationShort(30_000, english.t)).toBe('<1m')
})

test('a negative gap (already due) is clamped rather than shown as negative', () => {
  expect(formatDurationShort(-5_000, english.t)).toBe('<1m')
})

test('the ru bundle spells out its own units rather than reusing "h"/"m"/"d"', () => {
  expect(formatDurationShort(3 * 3_600_000 + 16 * 60_000, russian.t)).toBe('3 ч 16 мин')
  expect(formatDurationShort(5 * 86_400_000 + 17 * 3_600_000, russian.t)).toBe('5 д 17 ч')
  expect(formatDurationShort(45 * 60_000, russian.t)).not.toMatch(/\d+m\b/)
})

// --- formatRelativeTime ---------------------------------------------------

test('a few minutes in the past reads as "N minutes ago"', () => {
  const now = new Date('2026-09-30T10:04:00.000Z').getTime()
  expect(formatRelativeTime('2026-09-30T10:00:00.000Z', now, 'en')).toBe('4 minutes ago')
})

test('an unparsable timestamp is returned verbatim rather than "Invalid Date"', () => {
  expect(formatRelativeTime('not-a-date', Date.now(), 'en')).toBe('not-a-date')
})

test('59m40s old reads as "1 hour ago", never "60 minutes ago" — the unit is chosen after rounding', () => {
  const now = new Date('2026-09-30T10:00:00.000Z').getTime()
  const then = new Date(now - 59 * 60_000 - 40_000).toISOString()
  expect(formatRelativeTime(then, now, 'en')).toBe('1 hour ago')
})

test('59.4 seconds old still reads in seconds, never "1 minutes ago"', () => {
  const now = new Date('2026-09-30T10:00:00.000Z').getTime()
  const then = new Date(now - 59_400).toISOString()
  expect(formatRelativeTime(then, now, 'en')).not.toContain('1 minute')
})

test('23h40m old reads as "1 day ago", never "24 hours ago" — same rounding fix at the hour/day boundary', () => {
  const now = new Date('2026-09-30T10:00:00.000Z').getTime()
  const then = new Date(now - 23 * 3_600_000 - 40 * 60_000).toISOString()
  expect(formatRelativeTime(then, now, 'en')).toBe('yesterday')
})

// --- formatCurrencyMinor --------------------------------------------------

test('minor units (cents) render as a currency figure', () => {
  expect(formatCurrencyMinor(1234, 'USD')).toBe('$12.34')
})

test('a null currency falls back to USD', () => {
  expect(formatCurrencyMinor(5000, null)).toBe('$50.00')
})

test('the locale follows the caller (i18n.language), not the runtime default', () => {
  expect(formatCurrencyMinor(1234, 'EUR', 'ru')).toBe(
    new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' }).format(12.34),
  )
  expect(formatCurrencyMinor(1234, 'EUR', 'ru')).not.toBe('€12.34')
})

// --- usageWindowLabelKey ---------------------------------------------------

test('every fixed window key maps to its own i18n key', () => {
  expect(usageWindowLabelKey('five_hour')).toBe('usage.window.five_hour')
  expect(usageWindowLabelKey('seven_day')).toBe('usage.window.seven_day')
  expect(usageWindowLabelKey('seven_day_opus')).toBe('usage.window.seven_day_opus')
  expect(usageWindowLabelKey('seven_day_sonnet')).toBe('usage.window.seven_day_sonnet')
  expect(usageWindowLabelKey('seven_day_oauth_apps')).toBe('usage.window.seven_day_oauth_apps')
})

test('a model row always maps to the same interpolated key, whatever its label', () => {
  expect(usageWindowLabelKey('model')).toBe('usage.window.model')
})

test('an unrecognised window key falls back to null, so the caller shows it raw', () => {
  expect(usageWindowLabelKey('seven_day_haiku')).toBeNull()
})

// --- behaviorLabelKey ------------------------------------------------------

test('the five named behaviors each map to their own key', () => {
  expect(behaviorLabelKey('cache_miss')).toBe('usage.breakdown.behaviors.cache_miss')
  expect(behaviorLabelKey('long_context')).toBe('usage.breakdown.behaviors.long_context')
  expect(behaviorLabelKey('subagent_heavy')).toBe('usage.breakdown.behaviors.subagent_heavy')
  expect(behaviorLabelKey('high_parallel')).toBe('usage.breakdown.behaviors.high_parallel')
  expect(behaviorLabelKey('cron')).toBe('usage.breakdown.behaviors.cron')
})

test('an unrecognised behavior key falls back to null, so the caller shows it raw', () => {
  expect(behaviorLabelKey('something_new')).toBeNull()
})

// --- overageReasonKey -------------------------------------------------------

test('every named overage reason maps to its own key', () => {
  expect(overageReasonKey('org_level_disabled')).toBe('usage.limits.overage.reason.org_level_disabled')
  expect(overageReasonKey('org_level_disabled_until')).toBe(
    'usage.limits.overage.reason.org_level_disabled_until',
  )
  expect(overageReasonKey('out_of_credits')).toBe('usage.limits.overage.reason.out_of_credits')
  expect(overageReasonKey('overage_not_provisioned')).toBe(
    'usage.limits.overage.reason.overage_not_provisioned',
  )
  expect(overageReasonKey('member_level_disabled')).toBe(
    'usage.limits.overage.reason.member_level_disabled',
  )
  expect(overageReasonKey('seat_tier_level_disabled')).toBe(
    'usage.limits.overage.reason.seat_tier_level_disabled',
  )
})

test('an unrecognised reason code falls back to null, so the caller shows it raw', () => {
  expect(overageReasonKey('some_future_reason')).toBeNull()
})

// --- overageStatusLabel ------------------------------------------------------

test('rejected reads as not available', () => {
  expect(overageStatusLabel('rejected')).toBe('notAvailable')
})

test('allowed and allowed_warning both read as allowed', () => {
  expect(overageStatusLabel('allowed')).toBe('allowed')
  expect(overageStatusLabel('allowed_warning')).toBe('allowed')
})

test('no verdict at all is null, not a guess', () => {
  expect(overageStatusLabel(null)).toBeNull()
})

// --- resolveAuthDisplay ------------------------------------------------------

test('an OAuth token source names itself, verbatim, for the caller to interpolate', () => {
  expect(resolveAuthDisplay('CLAUDE_CODE_OAUTH_TOKEN', null)).toEqual({
    kind: 'oauth',
    source: 'CLAUDE_CODE_OAUTH_TOKEN',
  })
})

test('an API key source needs no interpolation', () => {
  expect(resolveAuthDisplay(null, 'ANTHROPIC_API_KEY')).toEqual({ kind: 'apiKey' })
})

test('a literal "none" tokenSource falls through to a real apiKeySource behind it', () => {
  expect(resolveAuthDisplay('none', 'ANTHROPIC_API_KEY')).toEqual({ kind: 'apiKey' })
})

test('both null (or both "none") is the none case', () => {
  expect(resolveAuthDisplay(null, null)).toEqual({ kind: 'none' })
  expect(resolveAuthDisplay('none', 'none')).toEqual({ kind: 'none' })
})

test('an unrecognised source is shown raw rather than guessed at', () => {
  expect(resolveAuthDisplay('SOME_FUTURE_TOKEN', null)).toEqual({
    kind: 'raw',
    value: 'SOME_FUTURE_TOKEN',
  })
})

// --- capitalize --------------------------------------------------------------

test('capitalize upcases just the first letter', () => {
  expect(capitalize('pro')).toBe('Pro')
  expect(capitalize('max')).toBe('Max')
})

test('an empty string stays empty', () => {
  expect(capitalize('')).toBe('')
})
