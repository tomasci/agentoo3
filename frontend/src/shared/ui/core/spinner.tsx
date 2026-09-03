import { Progress } from '@ark-ui/react'
import { useId } from 'react'
import { cx } from '../lib/cx'
import type { Size } from '../lib/types'
import styles from './spinner.module.scss'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

interface SpinnerProps {
  /**
   * Required, no default: reduced-motion collapses the animation to nothing
   * (no whitelist — see design-tokens.md), so this text is the only channel
   * left for what the spinner communicates.
   */
  label: string
  labelPlacement?: 'visible' | 'sr-only'
  size?: Size
  block?: boolean
}

/**
 * Ark `Progress` with `value={null}` — an indeterminate progressbar, which is
 * what supplies `role="progressbar"` and the aria wiring for free. Rendered as
 * an SVG circle rather than a spinning `<div>` border so it can carry a track
 * and range like every other Progress instance in the system.
 */
export function Spinner({
  label,
  labelPlacement = 'visible',
  size = 'md',
  block = false,
}: SpinnerProps) {
  const labelId = useId()

  return (
    <Progress.Root value={null} className={cx(styles.root, block && styles.block)}>
      <Progress.Circle aria-labelledby={labelId} className={cx(styles.circle, SIZE[size])}>
        <Progress.CircleTrack className={styles.track} />
        <Progress.CircleRange className={styles.range} />
      </Progress.Circle>
      <Progress.Label
        id={labelId}
        className={cx(styles.label, labelPlacement === 'sr-only' && styles.srOnly)}
      >
        {label}
      </Progress.Label>
    </Progress.Root>
  )
}
