import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './card.module.scss'

type CardVariant = 'solid' | 'dashed'
type CardPadding = 'none' | 'sm' | 'md'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const VARIANT: Record<CardVariant, string> = {
  solid: styles.variantSolid as string,
  dashed: styles.variantDashed as string,
}
const PADDING: Record<CardPadding, string> = {
  none: styles.paddingNone as string,
  sm: styles.paddingSm as string,
  md: styles.paddingMd as string,
}

interface CardProps {
  as?: 'div' | 'section' | 'article'
  variant?: CardVariant
  padding?: CardPadding
  children: ReactNode
}

/**
 * Replaces 11 card definitions. `solid` pairs a raised surface with a shadow
 * (see card.module.scss for why both, not just the shadow, are needed for
 * the contrast to survive dark theme); `dashed` is a border-only outline with
 * no shadow, for a slot that is empty or provisional rather than filled.
 */
export function Card({ as = 'section', variant = 'solid', padding = 'md', children }: CardProps) {
  const Tag = as

  return <Tag className={cx(styles.root, VARIANT[variant], PADDING[padding])}>{children}</Tag>
}
