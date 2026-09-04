import { Checkbox as ArkCheckbox } from '@ark-ui/react'
import type { ReactNode } from 'react'
import styles from './checkbox.module.scss'

interface CheckboxProps {
  label: ReactNode
  description?: ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  name?: string
  value?: string
}

/**
 * Ark's `checked` is `boolean | 'indeterminate'`; no call site here needs the
 * third state, so the public prop stays a plain `boolean` and the callback
 * narrows Ark's details the same way — `'indeterminate'` never reaches the
 * caller because nothing ever sets it in the first place.
 *
 * The hidden native checkbox is the actual focusable, checkable element
 * (Ark toggles it via a real `<label htmlFor>` click, which is a genuine
 * browser "click" + "change" on the input, not a synthetic one) — `.control`
 * is `aria-hidden` and decorative. `:has()` on `.root` is what lets the ring
 * live on the decorative box while still only firing for real keyboard focus
 * on the input, per the "ring goes on .control" rule in the component
 * contract's data-attribute table.
 */
export function Checkbox({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false,
  name,
  value,
}: CheckboxProps) {
  return (
    <ArkCheckbox.Root
      className={styles.root}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(details) => onCheckedChange?.(details.checked === true)}
      disabled={disabled}
      name={name}
      value={value}
    >
      <ArkCheckbox.Control className={styles.control}>
        <ArkCheckbox.Indicator className={styles.indicator} aria-hidden>
          ✓
        </ArkCheckbox.Indicator>
      </ArkCheckbox.Control>
      <span className={styles.text}>
        <ArkCheckbox.Label className={styles.label}>{label}</ArkCheckbox.Label>
        {description != null && <span className={styles.description}>{description}</span>}
      </span>
      <ArkCheckbox.HiddenInput />
    </ArkCheckbox.Root>
  )
}
