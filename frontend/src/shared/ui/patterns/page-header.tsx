import type { ReactNode } from 'react'
import styles from './page-header.module.scss'

interface PageHeaderProps {
  title: ReactNode
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  level?: 1 | 2 | 3
}

/**
 * `level` picks the heading tag — `h1`/`h2`/`h3` — for document semantics; it
 * does not change the rendered size, which stays fixed regardless of where
 * the header sits in the hierarchy.
 */
export function PageHeader({ title, eyebrow, description, actions, level = 1 }: PageHeaderProps) {
  const Heading = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'

  return (
    <div className={styles.root}>
      <div className={styles.text}>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
        <Heading className={styles.title}>{title}</Heading>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
