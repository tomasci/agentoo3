import type { ReactNode } from 'react'
import { Badge } from '@/shared/ui/badge'
import { StatusDot, type Tone } from './status-dot'

interface StatusBadgeProps {
  tone?: Tone
  pulse?: boolean
  children: ReactNode
}

/**
 * `Badge variant="outline"` plus a `StatusDot` — dashboard-01's own status
 * pattern (see `section-cards.tsx` in a freshly-added, since-deleted copy of
 * that block). Replaces the old tone-coloured `Badge`: shadcn's `Badge`
 * carries no tone prop of its own, so the colour now lives entirely in the
 * dot next to a neutral outline pill.
 */
export function StatusBadge({ tone = 'neutral', pulse = false, children }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </Badge>
  )
}
