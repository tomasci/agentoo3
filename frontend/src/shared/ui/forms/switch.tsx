import { Switch as ArkSwitch } from '@ark-ui/react'
import type { ReactNode } from 'react'
import styles from './switch.module.scss'

type LabelPlacement = 'start' | 'end'

interface SwitchProps {
  label: ReactNode
  description?: ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  labelPlacement?: LabelPlacement
}

/**
 * Same hidden-input-is-the-real-control story as Checkbox — see its comment
 * for why the focus ring on `.control` is wired through `:has()`.
 *
 * The design direction explicitly forbids an iOS-style toggle (glossy pill,
 * inset groove); the track and thumb below are flat fills with no gradient
 * or inset shadow, distinguished only by `--color-accent` on/off.
 */
export function Switch({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false,
  labelPlacement = 'start',
}: SwitchProps) {
  const text = (
    <span className={styles.text}>
      <ArkSwitch.Label className={styles.label}>{label}</ArkSwitch.Label>
      {description != null && <span className={styles.description}>{description}</span>}
    </span>
  )

  return (
    <ArkSwitch.Root
      className={styles.root}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(details) => onCheckedChange?.(details.checked)}
      disabled={disabled}
    >
      {labelPlacement === 'start' && text}
      <ArkSwitch.Control className={styles.control}>
        <ArkSwitch.Thumb className={styles.thumb} />
      </ArkSwitch.Control>
      {labelPlacement === 'end' && text}
      <ArkSwitch.HiddenInput />
    </ArkSwitch.Root>
  )
}
