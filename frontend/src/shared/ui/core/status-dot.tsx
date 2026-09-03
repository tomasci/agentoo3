import { cx } from '../lib/cx'
import type { Tone } from '../lib/types'
import styles from './status-dot.module.scss'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const TONE: Record<Tone, string> = {
  neutral: styles.toneNeutral as string,
  accent: styles.toneAccent as string,
  success: styles.toneSuccess as string,
  warning: styles.toneWarning as string,
  danger: styles.toneDanger as string,
}

interface StatusDotProps {
  tone: Tone
  pulse?: boolean
}

/**
 * A plain `<span aria-hidden>` — always adjacent to text, never the sole
 * carrier of meaning. `prefers-reduced-motion` collapses every `--dur-*`
 * globally with no whitelist (design-tokens.md), so a caller that relies on
 * `pulse` alone to signal "active" is invisible to a reduced-motion user;
 * the text next to the dot must say the same thing statically.
 */
export function StatusDot({ tone, pulse = false }: StatusDotProps) {
  return <span aria-hidden className={cx(styles.root, TONE[tone], pulse && styles.pulse)} />
}
