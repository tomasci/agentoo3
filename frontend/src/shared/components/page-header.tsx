import type { ReactNode } from 'react'

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
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        {eyebrow && <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>}
        <Heading className="text-2xl font-semibold tracking-tight text-foreground">{title}</Heading>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
