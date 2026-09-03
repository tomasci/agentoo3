import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import type { Tone } from '../lib/types'
import styles from './alert.module.scss'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const TONE: Record<Tone, string> = {
  neutral: styles.toneNeutral as string,
  accent: styles.toneAccent as string,
  success: styles.toneSuccess as string,
  warning: styles.toneWarning as string,
  danger: styles.toneDanger as string,
}

interface AlertProps {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
}

/**
 * 24 call sites today use 5 different visual treatments and only one is
 * announced to assistive tech. Announcement is deliberately not a prop:
 * `danger` is the one tone that interrupts (`role="alert"` +
 * `aria-live="assertive"`), because it is the one tone whose whole point is
 * that something has gone wrong right now. Every other tone is `role="status"`
 * + `aria-live="polite"` — present in the tree, not interrupting.
 *
 * Defaults to `danger`: 24 of 24 existing sites are errors, and a mis-default
 * here should fail toward over-signalling a real error rather than silently
 * downgrading one to `polite`.
 *
 * No `preformatted` prop for the `<pre>` case that used to exist at some call
 * sites — it composes instead: `<Alert tone="danger"><Code block wrap>{stderr}</Code></Alert>`.
 */
export function Alert({ tone = 'danger', title, children, action }: AlertProps) {
  const announced = tone === 'danger'

  return (
    <div
      role={announced ? 'alert' : 'status'}
      aria-live={announced ? 'assertive' : 'polite'}
      className={cx(styles.root, TONE[tone])}
    >
      <div className={styles.body}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.content}>{children}</div>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}
