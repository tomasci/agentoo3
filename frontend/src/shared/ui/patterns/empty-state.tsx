import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './empty-state.module.scss'

type EmptyStateSize = 'sm' | 'md'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const SIZE: Record<EmptyStateSize, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
}

interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  size?: EmptyStateSize
}

/** Replaces 6 definitions, 4 of them character-identical. */
export function EmptyState({ title, description, action, size = 'md' }: EmptyStateProps) {
  return (
    <div className={cx(styles.root, SIZE[size])}>
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {action}
    </div>
  )
}
