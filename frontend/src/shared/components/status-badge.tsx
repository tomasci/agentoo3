import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { StatusDot, type Tone } from './status-dot'

interface StatusBadgeProps {
  tone?: Tone
  pulse?: boolean
  children: ReactNode
  /** Layout only (a grid placement, `invisible`) — see `className` on a
   *  shadcn component in frontend/README.md's "Styling". whats-new's
   *  `ReleaseEntry` is the one caller that needs this, to stack same-sized
   *  badges in one cell (its own comment explains why). */
  className?: string
  'aria-hidden'?: boolean
}

/**
 * `Badge variant="outline"` plus a `StatusDot` — dashboard-01's own status
 * pattern (see `section-cards.tsx` in a freshly-added, since-deleted copy of
 * that block). Replaces the old tone-coloured `Badge`: shadcn's `Badge`
 * carries no tone prop of its own, so the colour now lives entirely in the
 * dot next to a neutral outline pill.
 */
export function StatusBadge({
  tone = 'neutral',
  pulse = false,
  children,
  className,
  'aria-hidden': ariaHidden,
}: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn('gap-1.5', className)} aria-hidden={ariaHidden}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </Badge>
  )
}
