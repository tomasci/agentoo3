import { Field } from '@ark-ui/react'
import type { ComponentPropsWithRef } from 'react'
import { cx } from '../lib/cx'
import type { NoStyle, Size } from '../lib/types'
import styles from './input.module.scss'

// See core/button.tsx for why each value is cast individually rather than
// the object literal as a whole.
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

// The native `size` attribute on <input> is a column-count number; the
// design-system `size` prop below is 'sm'|'md'|'lg'. Omitting the native one
// is what TS2430 was pointing at — the two can't merge into one property.
interface InputProps extends Omit<NoStyle<ComponentPropsWithRef<'input'>>, 'size'> {
  size?: Size
  mono?: boolean
}

/**
 * Ark's `Field.Input` reads `useFieldContext()` with `strict: false` (verified
 * in component-contract.md), so it renders correctly whether or not it sits
 * inside `<Field>` — one component for both the bound and the standalone
 * case, rather than the two incompatible input implementations this replaces.
 */
export function Input({ size = 'md', mono = false, ...props }: InputProps) {
  return <Field.Input className={cx(styles.root, SIZE[size], mono && styles.mono)} {...props} />
}
