import { CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * The two sizes a swatch comes in: colours stay small (a plain tint doesn't
 * need room to prove itself), patterns stay large (`BackgroundPattern`'s
 * `preview` tile is drawn 1:1 at `size-16`, see `PATTERN_PREVIEW_TILE_SIZE`'s
 * own comment — shrinking this would shrink the icons in it right along with
 * it). The wrapper grows with the tile so the caption underneath keeps the
 * same margin either way.
 */
const SWATCH_SIZE = {
  sm: { wrapper: 'w-16', tile: 'size-12' },
  lg: { wrapper: 'w-20', tile: 'size-16' },
} as const

/**
 * One colour, gradient or pattern choice: a native radio (arrow-key
 * navigation and the group's own semantics come from `FieldSet`/`FieldLegend`
 * around the whole grid for free — there's no shadcn swatch/radio-card
 * component) with the actual input visually hidden behind the square. A
 * visible caption under the square carries the same name a sighted reader
 * needs, rather than a tooltip: this grid is exactly the kind of small,
 * touch-sized target `app/status-bar.tsx`'s own `HostMetric`/phone `Popover`
 * split was built around avoiding tooltips for. Selection shows twice —
 * a ring around the square and a check mark inside it — so it reads at a
 * glance against any colour underneath it, including the lightest tints.
 * `checkClassName` lets a caller swap the check mark's own colour (the
 * accent grid's tiles are themselves `bg-primary`, so `text-foreground`
 * — this component's own default, right for the pale background swatches —
 * would all but disappear on them); it defaults to today's class so every
 * existing grid keeps its exact look unchanged.
 *
 * The caption never truncates: `break-words` lets even a single long word
 * with nowhere to naturally wrap (a Russian colour name with no space in it)
 * break mid-word rather than being cut off with an ellipsis, and the fixed
 * two-line-tall box keeps every swatch in the grid the same height whether
 * its own label needed one line or two.
 */
export function Swatch({
  name,
  value,
  checked,
  onSelect,
  label,
  tileClassName,
  size,
  checkClassName = 'text-foreground',
  children,
}: {
  name: string
  value: string
  checked: boolean
  onSelect: () => void
  label: string
  tileClassName: string
  size: keyof typeof SWATCH_SIZE
  checkClassName?: string
  children?: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col items-center gap-1 rounded-md p-1 outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
        SWATCH_SIZE[size].wrapper,
      )}
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-md ring-1 ring-border',
          SWATCH_SIZE[size].tile,
          tileClassName,
          checked && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        )}
      >
        {children}
        {checked && (
          <CheckIcon
            aria-hidden="true"
            className={cn('absolute inset-0 m-auto size-4', checkClassName)}
          />
        )}
      </span>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="flex h-8 w-full items-center justify-center text-center text-xs break-words text-muted-foreground">
        {label}
      </span>
    </label>
  )
}
