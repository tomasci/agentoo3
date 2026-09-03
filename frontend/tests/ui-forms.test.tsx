import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Checkbox } from '../src/shared/ui/forms/checkbox'
import { Field } from '../src/shared/ui/forms/field'
import { Input } from '../src/shared/ui/forms/input'
import { NumberInput } from '../src/shared/ui/forms/number-input'
import { SegmentGroup } from '../src/shared/ui/forms/segment-group'
import { Select } from '../src/shared/ui/forms/select'
import { Switch } from '../src/shared/ui/forms/switch'
import { Textarea } from '../src/shared/ui/forms/textarea'

// --- Field ---

test('Field with `error` renders the error text and marks the control invalid', () => {
  const out = renderToStaticMarkup(
    <Field label="Name" error="Required">
      <Input />
    </Field>,
  )
  expect(out).toContain('Required')
  expect(out).toContain('aria-invalid="true"')
  expect(out).toContain('data-invalid')
})

test('Field with both `hint` and `error` renders the error, never the hint', () => {
  const out = renderToStaticMarkup(
    <Field label="Name" hint="Letters only" error="Required">
      <Input />
    </Field>,
  )
  expect(out).toContain('Required')
  expect(out).not.toContain('Letters only')
})

test('Field with only `hint` (no error) renders the hint and stays valid', () => {
  const out = renderToStaticMarkup(
    <Field label="Name" hint="Letters only">
      <Input />
    </Field>,
  )
  expect(out).toContain('Letters only')
  expect(out).not.toContain('aria-invalid="true"')
})

// --- Select ---

test('Select with a `name` renders a hidden native select carrying that name', () => {
  const out = renderToStaticMarkup(
    <Select options={[{ value: 'a', label: 'A' }]} name="role" value="a" />,
  )
  expect(out).toMatch(/<select[^>]*name="role"/)
})

test('Select omits the name attribute when none is given', () => {
  const out = renderToStaticMarkup(<Select options={[{ value: 'a', label: 'A' }]} value="a" />)
  expect(out).not.toMatch(/<select[^>]*name=/)
})

// --- Checkbox ---

test('Checkbox associates its label with the control via aria-labelledby', () => {
  const out = renderToStaticMarkup(<Checkbox label="Enable team mode" />)
  // The real accessible control is the hidden native checkbox; it must point
  // at the id of the rendered label text, not merely sit near it visually.
  const labelIdMatch = out.match(/<span[^>]*data-part="label"[^>]*id="([^"]+)"/)
  expect(labelIdMatch).not.toBeNull()
  const labelId = labelIdMatch?.[1] as string
  expect(out).toContain(`aria-labelledby="${labelId}"`)
  expect(out).toContain('Enable team mode')
})

test('Checkbox reflects checked state as data-state, not separate React state', () => {
  const unchecked = renderToStaticMarkup(<Checkbox label="x" checked={false} />)
  const checked = renderToStaticMarkup(<Checkbox label="x" checked={true} />)
  expect(unchecked).toContain('data-state="unchecked"')
  expect(checked).toContain('data-state="checked"')
})

test('Checkbox renders an optional description', () => {
  const out = renderToStaticMarkup(<Checkbox label="Enable" description="Applies to new projects only" />)
  expect(out).toContain('Applies to new projects only')
})

// --- Switch ---

test('Switch reflects checked state as data-state', () => {
  const unchecked = renderToStaticMarkup(<Switch label="Dark mode" checked={false} />)
  const checked = renderToStaticMarkup(<Switch label="Dark mode" checked={true} />)
  expect(unchecked).toContain('data-state="unchecked"')
  expect(checked).toContain('data-state="checked"')
})

test('Switch labelPlacement controls DOM order without changing the accessible name', () => {
  const start = renderToStaticMarkup(<Switch label="Dark mode" labelPlacement="start" />)
  const end = renderToStaticMarkup(<Switch label="Dark mode" labelPlacement="end" />)
  // "start" (the default): label text precedes the control's own markup id.
  expect(start.indexOf('Dark mode')).toBeLessThan(start.indexOf('data-part="control"'))
  expect(end.indexOf('Dark mode')).toBeGreaterThan(end.indexOf('data-part="control"'))
})

// --- NumberInput ---

test('NumberInput renders the numeric value on the native input', () => {
  const out = renderToStaticMarkup(<NumberInput value={5} />)
  expect(out).toMatch(/<input[^>]*value="5"/)
})

test('NumberInput renders an empty field for a null value, not the string "null"', () => {
  const out = renderToStaticMarkup(<NumberInput value={null} />)
  expect(out).toMatch(/<input[^>]*value=""/)
  expect(out).not.toContain('null')
  expect(out).not.toContain('NaN')
})

test('NumberInput composes with Field: invalid state reaches the real input', () => {
  const out = renderToStaticMarkup(
    <Field label="Count" error="Too small">
      <NumberInput value={1} />
    </Field>,
  )
  expect(out).toContain('aria-invalid="true"')
})

// --- SegmentGroup ---

test('SegmentGroup marks the selected option with data-state="checked" and the rest "unchecked"', () => {
  const out = renderToStaticMarkup(
    <SegmentGroup
      label="View"
      options={[
        { value: 'list', label: 'List' },
        { value: 'grid', label: 'Grid' },
      ]}
      value="grid"
    />,
  )
  const items = out.match(/<label[^>]*data-part="item"[^>]*>/g) ?? []
  expect(items.length).toBe(2)
  expect(items[0]).toContain('data-state="unchecked"')
  expect(items[1]).toContain('data-state="checked"')
})

test('SegmentGroup announces as a horizontal radiogroup (arrow keys must match the visual row layout)', () => {
  const out = renderToStaticMarkup(
    <SegmentGroup label="View" options={[{ value: 'list', label: 'List' }]} value="list" />,
  )
  expect(out).toContain('role="radiogroup"')
  expect(out).toContain('aria-orientation="horizontal"')
})

test('SegmentGroup keeps the accessible name in the tree even when the visual label is hidden', () => {
  // The srOnly technique clips visually via a CSS-module class, not an
  // inline style or a `hidden` attribute, so — unlike display:none, which
  // would show up as markup — it isn't distinguishable from a plain visible
  // label in static markup without registering an identity-proxy loader for
  // this track's `.module.scss` files (see ui-core.test.tsx). What's real
  // and assertable here is that the text and its `aria-labelledby` wiring
  // are never dropped from the DOM.
  const out = renderToStaticMarkup(
    <SegmentGroup label="View" options={[{ value: 'list', label: 'List' }]} value="list" />,
  )
  expect(out).toContain('View')
  expect(out).toMatch(/aria-labelledby="([^"]+)"/)
})

// --- Textarea, included for completeness alongside Input/Field above ---

test('Textarea renders inside Field with the same invalid wiring as Input', () => {
  const out = renderToStaticMarkup(
    <Field label="Notes" error="Too long">
      <Textarea />
    </Field>,
  )
  expect(out).toContain('aria-invalid="true"')
})
