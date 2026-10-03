import { useAtom } from 'jotai'
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
import { Swatch } from './swatch'

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
