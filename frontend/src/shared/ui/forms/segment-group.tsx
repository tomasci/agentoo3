import { SegmentGroup as ArkSegmentGroup } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './segment-group.module.scss'

type SegmentGroupSize = 'sm' | 'md'

// See core/button.tsx for why each value is cast individually rather than
// the object literal as a whole.
const SIZE: Record<SegmentGroupSize, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
}

export interface SegmentOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface SegmentGroupProps {
  label: string
  labelHidden?: boolean
  options: readonly SegmentOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  size?: SegmentGroupSize
}

/**
 * Replaces a `<fieldset>` of `aria-pressed` buttons with a real radio group:
 * arrow keys move the selection, only one item sits in the tab sequence, and
 * `[data-state]` is Zag's own radio-group machine state (verified in
 * @zag-js/radio-group's connect.js — it reuses "checked"/"unchecked", not
 * "data-selected", which belongs to listbox-style machines).
 *
 * The design direction forbids the iOS segmented control — a pill sliding in
 * a recessed groove. `Indicator` is rendered because Ark's anatomy expects
 * it in the tree, but it carries no fill: selection reads instead as a flat
 * background directly on the selected item, the same convention already
 * used for the plain-button picker this replaces.
 */
export function SegmentGroup({
  label,
  labelHidden = true,
  options,
  value,
  defaultValue,
  onValueChange,
  size = 'md',
}: SegmentGroupProps) {
  return (
    <ArkSegmentGroup.Root
      className={cx(styles.root, SIZE[size])}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(details) => onValueChange?.(details.value ?? '')}
      // Zag's radio-group defaults to "vertical" (Up/Down navigation); every
      // caller here lays items out in a row, so the announced orientation
      // and the arrow keys that actually move focus (Left/Right) must match.
      orientation="horizontal"
    >
      <ArkSegmentGroup.Label className={cx(styles.label, labelHidden && styles.srOnly)}>
        {label}
      </ArkSegmentGroup.Label>
      {options.map((option) => (
        <ArkSegmentGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={styles.item}
        >
          <ArkSegmentGroup.ItemText>{option.label}</ArkSegmentGroup.ItemText>
          <ArkSegmentGroup.ItemControl className={styles.itemControl} />
          <ArkSegmentGroup.ItemHiddenInput />
        </ArkSegmentGroup.Item>
      ))}
      <ArkSegmentGroup.Indicator className={styles.indicator} />
    </ArkSegmentGroup.Root>
  )
}
