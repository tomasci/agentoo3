// The timezone picker's own helpers (src/features/settings/lib/timezones.ts):
// the offset computed per zone, and the full option list the Select in
// settings/components/learning-schedule-card.tsx renders. `UTC` is the
// schedule's own default (see that card's `DEFAULT_VALUES`), so it gets its
// own cases here rather than being left to whatever a zone happens to format
// to — see that file's own comment on why it reads bare rather than with a
// "(UTC+0)" that would just repeat the name back.

import { expect, test } from 'bun:test'
import { timezoneOptions, zoneWithOffset } from '../src/features/settings/lib/timezones'

test('UTC is offered in the Select, pinned first, labelled bare', () => {
  const zones = timezoneOptions()
  expect(zones[0]).toEqual({ value: 'UTC', label: 'UTC' })
  // Not a second, duplicate row even though a modern engine's own
  // Intl.supportedValuesOf('timeZone') already lists 'UTC' among the rest.
  expect(zones.filter((z) => z.value === 'UTC')).toHaveLength(1)
})

test('every other zone keeps its offset in the label, so UTC is the one exception, not the rule', () => {
  const zones = timezoneOptions()
  const london = zones.find((z) => z.value === 'Europe/London')
  expect(london?.label).toMatch(/^Europe\/London \(UTC[+-±]\S+\)$/)
})

test('the list is sorted alphabetically by zone name after the pinned UTC row', () => {
  const [, ...rest] = timezoneOptions()
  const values = rest.map((z) => z.value)
  expect(values).toEqual([...values].sort((a, b) => a.localeCompare(b)))
})

test('zoneWithOffset renders UTC bare, "UTC", not "UTC, UTC+0"', () => {
  expect(zoneWithOffset('UTC')).toBe('UTC')
})

test('zoneWithOffset still shows the offset for a real zone', () => {
  expect(zoneWithOffset('Asia/Tokyo')).toBe('Asia/Tokyo, UTC+9')
})
