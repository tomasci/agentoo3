import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './card.module.scss'

type CardVariant = 'solid' | 'dashed'
type CardPadding = 'none' | 'sm' | 'md'
type CardTone = 'neutral' | 'danger'

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
// 'neutral' overrides nothing — the ordinary border and background already
// come from `variant`. It still gets a Record entry so the exhaustiveness
// check stays live if a third tone ever shows up.
const TONE: Record<CardTone, string> = {
  neutral: '',
  danger: styles.toneDanger as string,
}

interface CardProps {
  as?: 'div' | 'section' | 'article'
  variant?: CardVariant
  padding?: CardPadding
  tone?: CardTone
  children: ReactNode
}

/**
 * Replaces 11 card definitions. `solid` pairs a raised surface with a shadow
 * (see card.module.scss for why both, not just the shadow, are needed for
 * the contrast to survive dark theme); `dashed` is a border-only outline with
 * no shadow, for a slot that is empty or provisional rather than filled.
 *
 * `tone="danger"` layers a soft red border and tinted surface on top of
 * either variant, for a destructive section such as a "danger zone" — not a
 * form control, which signals invalid state with `--color-danger` instead
 * (see `_mixins.scss`'s `invalid` mixin for the contrast reasoning).
 */
export function Card({
  as = 'section',
  variant = 'solid',
  padding = 'md',
  tone = 'neutral',
  children,
}: CardProps) {
  const Tag = as

  return (
    <Tag className={cx(styles.root, VARIANT[variant], PADDING[padding], TONE[tone])}>
      {children}
    </Tag>
  )
}
