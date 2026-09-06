import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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
  /**
   * Renders a dismiss control when given, omits it when not. Optional is
   * load-bearing: 24 existing call sites render an `Alert` with no way to
   * close it and must stay pixel-identical — this can only add a control
   * for the one caller that asks for it (version-skew-alert.tsx, the first
   * `Alert` that sits over other content rather than inline in a page flow,
   * which is what makes it need one at all).
   *
   * Deliberately just a callback, not a dismissed/visible flag: `Alert` has
   * no idea what "the same notice" means to a caller that re-renders it
   * (version-skew-alert.tsx's answer is "same version pair"), so owning that
   * state here would either bake in one caller's definition or force every
   * other caller to feed one in. The caller decides whether to keep
   * rendering `Alert` at all; this only decides whether the button shows.
   */
  onDismiss?: () => void
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
export function Alert({ tone = 'danger', title, children, action, onDismiss }: AlertProps) {
  const { t } = useTranslation()
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
      {onDismiss && (
        <button
          type="button"
          className={styles.dismiss}
          aria-label={t('common.dismiss')}
          onClick={onDismiss}
        >
          ✕
        </button>
      )}
    </div>
  )
}
