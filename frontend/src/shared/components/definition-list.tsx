import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

type DefinitionListLayout = 'inline' | 'stacked'

export interface DefinitionItem {
  id: string
  term: ReactNode
  description: ReactNode
}

interface DefinitionListProps {
  items: readonly DefinitionItem[]
  layout?: DefinitionListLayout
}

/**
 * `inline` lays each `dt`/`dd` pair out as two grid columns via
 * `display: contents` on the wrapping `div` — that lets the pair join the
 * `dl`'s own grid instead of the wrapper eating a column of its own — and
 * falls back to stacked below `sm`, where there isn't room for two columns.
 * The description column is `minmax(0,1fr)`, not a bare `1fr`: a grid track
 * won't shrink past its content's min-content size otherwise, so a long
 * unbroken token (a path, a hash) in `dd` would push the column wider than
 * the row rather than wrapping — `min-w-0` on `dd` closes the same gap for
 * flex/grid item sizing, and `wrap-anywhere` is what actually breaks the
 * token once the column can shrink.
 */
export function DefinitionList({ items, layout = 'inline' }: DefinitionListProps) {
  return (
    <dl
      className={cn(
        'text-sm',
        layout === 'inline'
          ? 'sm:grid sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-1.5'
          : 'flex flex-col gap-3',
      )}
    >
      {items.map((item) => (
        <div key={item.id} className={cn(layout === 'inline' && 'sm:contents')}>
          <dt className="text-muted-foreground">{item.term}</dt>
          <dd className="min-w-0 wrap-anywhere text-foreground">{item.description}</dd>
        </div>
      ))}
    </dl>
  )
}
