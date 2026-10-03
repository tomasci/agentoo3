import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { accentColorAtom } from '@/shared/store/ui'
import { FieldDescription, FieldLegend, FieldSet } from '@/shared/ui/field'
import { accentColorTileClassName, BACKGROUND_OPTIONS } from '../lib/catalog'
import { Swatch } from './swatch'

/**
 * The reader's accent colour, over the same 18 options and in the same order
 * as `BackgroundFields`' own colour grid — one catalog, two independent
 * choices. Unlike that grid, the tile is the button colour itself
 * (`accentColorTileClassName`), not a pale background tint, so the check
 * mark needs its own contrasting colour per tile rather than `Swatch`'s
 * default: `text-primary-foreground` on every chosen hue (the same token the
 * accent itself repoints `--primary-foreground` against, so it always
 * reads), `text-background` on `'none'` (a plain `bg-foreground` tile, where
 * `--primary-foreground` would be the wrong contrast token to reach for).
 * No "match background" shortcut and no live preview widget — the grid
 * itself, immediately repainting every primary button/link/control on the
 * page, is the preview.
 */
export function AccentColorField() {
  const { t } = useTranslation()
  const [accentColor, setAccentColor] = useAtom(accentColorAtom)

  return (
    <FieldSet>
      <FieldLegend variant="label">{t('settings.accentColor')}</FieldLegend>
      <div className="flex flex-wrap gap-2">
        {BACKGROUND_OPTIONS.map((option) => (
          <Swatch
            key={option.id}
            name="settings-accent-color"
            value={option.id}
            checked={accentColor === option.id}
            onSelect={() => setAccentColor(option.id)}
            label={t(option.labelKey)}
            tileClassName={accentColorTileClassName(option.id)}
            checkClassName={option.id === 'none' ? 'text-background' : 'text-primary-foreground'}
            size="sm"
          />
        ))}
      </div>
      <FieldDescription>{t('settings.accentColorHint')}</FieldDescription>
    </FieldSet>
  )
}
