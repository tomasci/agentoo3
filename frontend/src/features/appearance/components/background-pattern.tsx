import { useId } from 'react'
import { cn } from '@/shared/lib/utils'
import type { BackgroundPatternId } from '@/shared/store/ui'
import {
  PATTERN_ICON_CLASS_NAME,
  PATTERN_ICONS,
  PATTERN_PREVIEW_SLOTS,
  PATTERN_PREVIEW_TILE_SIZE,
  PATTERN_SLOTS,
  PATTERN_TILE_SIZE,
} from '../lib/catalog'

interface BackgroundPatternProps {
  pattern: BackgroundPatternId
  className?: string
  /**
   * Draws `PATTERN_PREVIEW_SLOTS`'s small, dense layout instead of the shell
   * backdrop's own sparse `PATTERN_SLOTS` — the settings page's swatch passes
   * this; the shell's full-size backdrop never does, so it keeps exactly the
   * tile it always had.
   */
  preview?: boolean
}

/**
 * One repeating tile of lucide icons — Telegram's own patterned-chat-
 * background trick: a handful of outline icons, scattered and rotated
 * (`PATTERN_SLOTS`, or `PATTERN_PREVIEW_SLOTS` in `preview` mode), in a
 * colour so faint it reads as texture rather than content. The colour itself
 * (`PATTERN_ICON_CLASS_NAME`, `text-foreground` at ~6%/8% opacity — the two
 * genuinely differ under `.dark`, not just the colour they're an opacity of)
 * stays a catalog export rather than a class literal in this file, so the
 * `dark:` variant it needs lives inside `lib/catalog.ts` with the feature's
 * other colours, the one file frontend/README.md names for this exception. A
 * caller can still override it through `className` (see
 * `PATTERN_ICON_PREVIEW_CLASS_NAME`'s own comment on why that's a
 * `className` override and not a second prop).
 *
 * `useId` keys the `<pattern>` element's `id`: the shell's backdrop and every
 * swatch on the settings page can render the same pattern at once, and an
 * SVG id is global to the document — two unqualified ones would collide, and
 * one tile would silently start painting the other's fill.
 */
export function BackgroundPattern({ pattern, className, preview = false }: BackgroundPatternProps) {
  const reactId = useId().replace(/:/g, '')
  const patternId = `background-pattern-${pattern}-${reactId}`
  const icons = PATTERN_ICONS[pattern]
  const slots = preview ? PATTERN_PREVIEW_SLOTS : PATTERN_SLOTS
  const tileSize = preview ? PATTERN_PREVIEW_TILE_SIZE : PATTERN_TILE_SIZE

  return (
    <svg aria-hidden="true" className={cn(PATTERN_ICON_CLASS_NAME, className)}>
      <defs>
        <pattern id={patternId} patternUnits="userSpaceOnUse" width={tileSize} height={tileSize}>
          {slots.map((slot, index) => {
            const Icon = icons[index % icons.length]
            if (!Icon) return null
            return (
              <g
                key={`${slot.x}-${slot.y}`}
                transform={`translate(${slot.x} ${slot.y}) rotate(${slot.rotate})`}
              >
                <Icon
                  x={-slot.size / 2}
                  y={-slot.size / 2}
                  width={slot.size}
                  height={slot.size}
                  strokeWidth={1.5}
                />
              </g>
            )
          })}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}
