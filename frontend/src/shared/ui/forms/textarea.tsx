import { Field } from '@ark-ui/react'
import type { ComponentPropsWithRef } from 'react'
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
  mono?: boolean
  resize?: Resize
}

/** Same standalone-or-bound story as `Input` — see its comment. */
export function Textarea({ rows = 4, mono = false, resize = 'vertical', ...props }: TextareaProps) {
  return (
    <Field.Textarea
      rows={rows}
      className={cx(styles.root, RESIZE[resize], mono && styles.mono)}
      {...props}
    />
  )
}
