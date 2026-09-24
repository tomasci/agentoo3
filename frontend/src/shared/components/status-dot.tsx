import { cn } from '@/shared/lib/utils'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

// The only place a palette colour or a `dark:` variant is allowed (the
// exception "Styling" in frontend/README.md carries by name) — tone is
// meaning, not decoration, so it can't be expressed with the handful of
// semantic tokens alone.
const TONE: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  accent: 'bg-primary',
  success: 'bg-green-500 dark:bg-green-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  danger: 'bg-destructive',
}

interface StatusDotProps {
  tone: Tone
  pulse?: boolean
}

/**
 * A plain `<span aria-hidden>` — always adjacent to text, never the sole
 * carrier of meaning. The reduced-motion block in globals.css collapses
 * every animation with no whitelist, so a caller that relies on `pulse`
 * alone to signal "active" is invisible to a reduced-motion reader; the
 * text next to the dot must say the same thing statically.
 */
export function StatusDot({ tone, pulse = false }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        TONE[tone],
        pulse && 'animate-pulse',
      )}
    />
  )
}
