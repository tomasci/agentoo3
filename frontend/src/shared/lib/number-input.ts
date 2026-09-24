import type { ChangeEvent } from 'react'

/**
 * `event.target.valueAsNumber` is the DOM's own convention, not React's, and
 * it is `NaN` for an empty or otherwise invalid numeric field. The old Ark
 * NumberInput wrapper existed to hide exactly this juggling from callers;
 * now that the input is a plain shadcn `Input`, this keeps the same
 * NaN-to-null translation so the public shape stays `number | null`, never
 * `NaN`.
 */
export function parseNumberInput(event: ChangeEvent<HTMLInputElement>): number | null {
  const value = event.target.valueAsNumber
  return Number.isNaN(value) ? null : value
}
