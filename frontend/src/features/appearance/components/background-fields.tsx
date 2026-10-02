import { useAtom } from 'jotai'
import { CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { backgroundAtom, backgroundPatternAtom } from '@/shared/store/ui'
import { FieldDescription, FieldLegend, FieldSet } from '@/shared/ui/field'
import {
  BACKGROUND_OPTIONS,
  backgroundTileClassName,
  PATTERN_ICON_PREVIEW_CLASS_NAME,
  PATTERN_OPTIONS,
} from '../lib/catalog'
import { BackgroundPattern } from './background-pattern'

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
 *
 * The caption never truncates: `break-words` lets even a single long word
 * with nowhere to naturally wrap (a Russian colour name with no space in it)
 * break mid-word rather than being cut off with an ellipsis, and the fixed
 * two-line-tall box keeps every swatch in the grid the same height whether
 * its own label needed one line or two.
 */
function Swatch({
  name,
  value,
  checked,
  onSelect,
  label,
  tileClassName,
  size,
  children,
}: {
  name: string
  value: string
  checked: boolean
  onSelect: () => void
  label: string
  tileClassName: string
  size: keyof typeof SWATCH_SIZE
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
            className="absolute inset-0 m-auto size-4 text-foreground"
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

/**
 * The two swatch grids on /settings: a background colour or gradient, and a
 * pattern drawn over whichever one is currently chosen — Telegram-style, so
 * the preview is what the shell actually shows, not a preview of the pattern
 * in isolation. Lives in features/appearance rather than features/settings
 * because both grids read the exact same catalog the shell itself paints
 * from (`lib/catalog.ts`); features/settings only mounts this component.
 */
export function BackgroundFields() {
  const { t } = useTranslation()
  const [background, setBackground] = useAtom(backgroundAtom)
  const [pattern, setPattern] = useAtom(backgroundPatternAtom)

  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">{t('settings.background')}</FieldLegend>
        <div className="flex flex-wrap gap-2">
          {BACKGROUND_OPTIONS.map((option) => (
            <Swatch
              key={option.id}
              name="settings-background"
              value={option.id}
              checked={background === option.id}
              onSelect={() => setBackground(option.id)}
              label={t(option.labelKey)}
              tileClassName={backgroundTileClassName(option.id)}
              size="sm"
            />
          ))}
        </div>
        <FieldDescription>{t('settings.backgroundHint')}</FieldDescription>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t('settings.pattern')}</FieldLegend>
        <div className="flex flex-wrap gap-2">
          {PATTERN_OPTIONS.map((option) => (
            <Swatch
              key={option.id}
              name="settings-pattern"
              value={option.id}
              checked={pattern === option.id}
              onSelect={() => setPattern(option.id)}
              label={t(option.labelKey)}
              tileClassName={backgroundTileClassName(background)}
              size="lg"
            >
              {option.id !== 'none' && (
                <BackgroundPattern
                  pattern={option.id}
                  preview
                  className={cn('absolute inset-0 h-full w-full', PATTERN_ICON_PREVIEW_CLASS_NAME)}
                />
              )}
            </Swatch>
          ))}
        </div>
        <FieldDescription>{t('settings.patternHint')}</FieldDescription>
      </FieldSet>
    </>
  )
}
