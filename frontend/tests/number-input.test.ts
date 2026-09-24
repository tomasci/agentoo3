// `event.target.valueAsNumber` is `NaN` for an empty or otherwise invalid
// numeric field — the DOM's own convention, not React's — and the old Ark
// NumberInput wrapper existed only to hide that from callers. This is the
// same NaN-to-null translation for the plain shadcn `Input` it replaces.

import { expect, test } from 'bun:test'
import type { ChangeEvent } from 'react'
import { parseNumberInput } from '@/shared/lib/number-input'

function changeEvent(value: string): ChangeEvent<HTMLInputElement> {
  const input = document.createElement('input')
  input.type = 'number'
  input.value = value
  return { target: input } as ChangeEvent<HTMLInputElement>
}

test('parses a valid number', () => {
  expect(parseNumberInput(changeEvent('42'))).toBe(42)
  expect(parseNumberInput(changeEvent('-3.5'))).toBe(-3.5)
})

test('an empty field is null, not NaN', () => {
  expect(parseNumberInput(changeEvent(''))).toBeNull()
})

test('an invalid, still-typing value ("-", "1.") is null, not NaN', () => {
  expect(parseNumberInput(changeEvent('-'))).toBeNull()
})
