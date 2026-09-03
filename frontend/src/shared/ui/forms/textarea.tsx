import { Field } from '@ark-ui/react'
import type { ComponentPropsWithRef, CSSProperties } from 'react'
import { cx } from '../lib/cx'
import type { NoStyle } from '../lib/types'
import styles from './textarea.module.scss'

type Resize = 'none' | 'vertical'

const RESIZE: Record<Resize, string> = {
  none: styles.resizeNone as string,
  vertical: styles.resizeVertical as string,
}

interface TextareaProps extends NoStyle<ComponentPropsWithRef<'textarea'>> {
  rows?: number
  /** A height ceiling: grows with `rows` up to this many lines, then scrolls. */
  maxRows?: number
  mono?: boolean
  resize?: Resize
}

/** Same standalone-or-bound story as `Input` — see its comment. */
export function Textarea({
  rows = 4,
  maxRows,
  mono = false,
  resize = 'vertical',
  ...props
}: TextareaProps) {
  return (
    <Field.Textarea
      rows={rows}
      // Component-owned style, not a caller-supplied one: the contract's ban
      // is on `className`/`style` reaching in from outside, not on a
      // component reading its own prop into a custom property the SCSS
      // computes from. See textarea.module.scss for the max-height formula.
      style={maxRows != null ? ({ '--textarea-max-rows': maxRows } as CSSProperties) : undefined}
      className={cx(styles.root, RESIZE[resize], mono && styles.mono)}
      {...props}
    />
  )
}
