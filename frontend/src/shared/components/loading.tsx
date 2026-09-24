import { cn } from '@/shared/lib/utils'
import { Spinner } from '@/shared/ui/spinner'

interface LoadingProps {
  /**
   * Required, no default: the reduced-motion block in globals.css collapses
   * the spin animation with no whitelist, so this text is the only channel
   * left for what the spinner communicates.
   */
  label: string
  block?: boolean
}

/** `ui/spinner`, decorative, next to a label the wrapper's `role="status"` announces. */
export function Loading({ label, block = false }: LoadingProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 text-sm text-muted-foreground',
        block && 'justify-center py-8',
      )}
    >
      <Spinner aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
