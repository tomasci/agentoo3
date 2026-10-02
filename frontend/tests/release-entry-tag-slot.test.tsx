// features/whats-new/components/release-entry.tsx's tag "slot": the kind
// badge (New/Improved/Fixed) keeps its own natural width, but sits in a slot
// as wide as the widest label in the current language, the same width on
// every row — the operator's complaint this fixes was that a narrower label
// ("New") let that row's text start further left than a wider one
// ("Improved"). happy-dom performs no layout, so there is nothing to measure
// here; what's checked instead is the structure the CSS relies on: all three
// kind badges are always rendered (stacked in one grid cell via `col-start-1
// row-start-1`), only the row's own kind is left visible and announced, and
// that shape is identical whichever kind a given row actually is — a reader
// relying on the cell's own intrinsic sizing (every row offering the same
// three labels) rather than one hard-coded width for one language.

import { expect, test } from 'bun:test'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReleaseEntry } from '@/features/whats-new/components/release-entry'
import type { Release } from '@/features/whats-new/model/changelog.schema'
import en from '@/shared/i18n/locales/en.json'

const testI18n = i18next.createInstance()
await testI18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

function releaseWith(kind: 'new' | 'improved' | 'fixed'): Release {
  return {
    version: '1.0.0',
    date: '2026-01-01',
    changes: [{ kind, en: 'a change', ru: 'изменение' }],
  }
}

function dom(ui: React.ReactElement): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>)
  return el
}

const LABEL: Record<'new' | 'improved' | 'fixed', string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
}

for (const kind of ['new', 'improved', 'fixed'] as const) {
  test(`the "${kind}" row's badge slot stacks all three kind badges, only its own visible`, () => {
    const el = dom(<ReleaseEntry release={releaseWith(kind)} language="en" />)
    const row = el.querySelector('ul > li')
    expect(row).not.toBeNull()

    const slot = row?.firstElementChild as HTMLElement
    expect(slot?.className).toContain('grid')
    expect(slot?.className).toContain('justify-items-start')

    const badges = [...(slot?.querySelectorAll('[data-slot="badge"]') ?? [])]
    // All three kinds are always present, regardless of which one this row
    // actually is — that's what keeps the slot's own intrinsic width the
    // same on every row.
    expect(badges).toHaveLength(3)
    for (const badge of badges) {
      expect(badge.className).toContain('col-start-1')
      expect(badge.className).toContain('row-start-1')
    }

    const visible = badges.filter((b) => !b.className.includes('invisible'))
    const hidden = badges.filter((b) => b.className.includes('invisible'))
    expect(visible).toHaveLength(1)
    expect(hidden).toHaveLength(2)

    expect(visible[0]?.textContent).toContain(LABEL[kind])
    expect(visible[0]?.getAttribute('aria-hidden')).not.toBe('true')
    for (const badge of hidden) {
      expect(badge.getAttribute('aria-hidden')).toBe('true')
    }
  })
}

test('the slot structure (badge count, placement classes) is identical across every kind', () => {
  const shapes = (['new', 'improved', 'fixed'] as const).map((kind) => {
    const el = dom(<ReleaseEntry release={releaseWith(kind)} language="en" />)
    const slot = el.querySelector('ul > li')?.firstElementChild as HTMLElement
    const badges = [...(slot?.querySelectorAll('[data-slot="badge"]') ?? [])]
    return {
      slotClassName: slot?.className,
      count: badges.length,
      placement: badges.map((b) => [b.className.includes('col-start-1'), b.className.includes('row-start-1')]),
    }
  })
  expect(shapes[1]).toEqual(shapes[0])
  expect(shapes[2]).toEqual(shapes[0])
})
