import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './definition-list.module.scss'

type DefinitionListLayout = 'inline' | 'stacked'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const LAYOUT: Record<DefinitionListLayout, string> = {
  inline: styles.layoutInline as string,
  stacked: styles.layoutStacked as string,
}

export interface DefinitionItem {
  id: string
  term: ReactNode
  description: ReactNode
}

interface DefinitionListProps {
  items: readonly DefinitionItem[]
  layout?: DefinitionListLayout
}

/** Replaces 3 sites that each carried their own copy of this SCSS. */
export function DefinitionList({ items, layout = 'inline' }: DefinitionListProps) {
  return (
    <dl className={cx(styles.root, LAYOUT[layout])}>
      {items.map((item) => (
        <div key={item.id} className={styles.item}>
          <dt className={styles.term}>{item.term}</dt>
          <dd className={styles.description}>{item.description}</dd>
        </div>
      ))}
    </dl>
  )
}
