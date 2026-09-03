import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import type { Tone } from '../lib/types'
import styles from './badge.module.scss'

type BadgeVariant = 'soft' | 'outline'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const TONE: Record<Tone, string> = {
  neutral: styles.toneNeutral as string,
  accent: styles.toneAccent as string,
  success: styles.toneSuccess as string,
  warning: styles.toneWarning as string,
  danger: styles.toneDanger as string,
}
const VARIANT: Record<BadgeVariant, string> = {
  soft: styles.variantSoft as string,
  outline: styles.variantOutline as string,
}

interface BadgeProps {
  tone?: Tone
  variant?: BadgeVariant
  children: ReactNode
}

/**
 * A plain `<span>` — no Ark equivalent, because a badge carries no state and
 * no interaction. Replaces 5 pill definitions that used 5 different paddings
 * and 2 font sizes.
 */
export function Badge({ tone = 'neutral', variant = 'soft', children }: BadgeProps) {
  return <span className={cx(styles.root, TONE[tone], VARIANT[variant])}>{children}</span>
}
