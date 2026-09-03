import { Field as ArkField } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './field.module.scss'

interface FieldProps {
  label: ReactNode
  children: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  disabled?: boolean
  readOnly?: boolean
  labelHidden?: boolean
}

/**
 * There is no `invalid` prop: it is derived from `error != null`. Today all
 * four Ark call sites separately maintain `invalid={Boolean(errors.x)}` next
 * to a render condition for the message — two expressions that must be kept
 * in step by hand. Deriving one from the other deletes that bug class.
 *
 * `Field.Input` / `Textarea` / `Select` (see the other files in this
 * directory) read field state through `useFieldContext()`, so wrapping them
 * in `children` here is enough to wire up `id`, `aria-describedby`,
 * `aria-invalid` and `data-invalid` without this component reaching into
 * them.
 */
export function Field({
  label,
  children,
  hint,
  error,
  required = false,
  disabled = false,
  readOnly = false,
  labelHidden = false,
}: FieldProps) {
  const invalid = error != null

  return (
    <ArkField.Root
      className={styles.root}
      invalid={invalid}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
    >
      <ArkField.Label className={cx(styles.label, labelHidden && styles.srOnly)}>
        {label}
        <ArkField.RequiredIndicator className={styles.requiredIndicator} />
      </ArkField.Label>
      {children}
      {invalid ? (
        // Stacked hint-then-error is where the eye stops reading, so hint
        // never renders once there's an error — one message, not two.
        <ArkField.ErrorText className={styles.errorText}>{error}</ArkField.ErrorText>
      ) : (
        hint != null && (
          <ArkField.HelperText className={styles.helperText}>{hint}</ArkField.HelperText>
        )
      )}
    </ArkField.Root>
  )
}
