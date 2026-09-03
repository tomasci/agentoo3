import { NumberInput as ArkNumberInput } from '@ark-ui/react'
import { cx } from '../lib/cx'
import type { Size } from '../lib/types'
import styles from './number-input.module.scss'

// See core/button.tsx for why each value is cast individually rather than
// the object literal as a whole.
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

interface NumberInputProps {
  value?: number | null
  defaultValue?: number
  onValueChange?: (value: number | null) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  size?: Size
  name?: string
}

/**
 * Ark's value is a string (it has to be, mid-typing "-" or "1." isn't a
 * valid number yet) and its change event carries `valueAsNumber`, which is
 * `NaN` for an empty field. The two call sites doing this NaN-to-null
 * juggling by hand today is exactly the bug this centralises: the public
 * API only ever sees `number | null`, never `NaN`.
 */
export function NumberInput({
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  step = 1,
  disabled = false,
  size = 'md',
  name,
}: NumberInputProps) {
  return (
    <ArkNumberInput.Root
      className={styles.root}
      value={value === undefined ? undefined : (value?.toString() ?? '')}
      defaultValue={defaultValue !== undefined ? defaultValue.toString() : undefined}
      onValueChange={(details) => {
        onValueChange?.(Number.isNaN(details.valueAsNumber) ? null : details.valueAsNumber)
      }}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      name={name}
    >
      <ArkNumberInput.Control className={cx(styles.control, SIZE[size])}>
        <ArkNumberInput.DecrementTrigger className={styles.trigger}>
          −
        </ArkNumberInput.DecrementTrigger>
        <ArkNumberInput.Input className={styles.input} />
        <ArkNumberInput.IncrementTrigger className={styles.trigger}>
          +
        </ArkNumberInput.IncrementTrigger>
      </ArkNumberInput.Control>
    </ArkNumberInput.Root>
  )
}
