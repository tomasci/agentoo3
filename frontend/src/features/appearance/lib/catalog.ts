import {
  Bird,
  Book,
  Braces,
  Bug,
  Camera,
  Circle,
  Cloud,
  CloudLightning,
  CloudRain,
  Code,
  Coffee,
  Diamond,
  Flower2,
  GitBranch,
  GitCommitHorizontal,
  Hexagon,
  Leaf,
  Lightbulb,
  type LucideIcon,
  Moon,
  Music,
  Rocket,
  Satellite,
  Snowflake,
  Sparkles,
  Sprout,
  Square,
  Sun,
  Telescope,
  Terminal,
  Trees,
  Triangle,
} from 'lucide-react'
import type {
  BackgroundColorId,
  BackgroundGradientId,
  BackgroundId,
  BackgroundPatternId,
  BackgroundPatternValue,
} from '@/shared/store/ui'
import {
  BACKGROUND_COLOR_IDS,
  BACKGROUND_GRADIENT_IDS,
  BACKGROUND_PATTERN_IDS,
} from '@/shared/store/ui'

/**
 * The one file in this app allowed OKLCH literals and a `dark:` variant for
 * anything other than `StatusDot` (see frontend/README.md, "Styling") — a
 * named hue like "mint" or "brown" has no shadcn semantic token to carry it,
 * and the operator picked these hues deliberately rather than reusing
 * Tailwind's own palette, whose lightness/chroma at a given step varies by
 * hue far more than a background tint can afford to. Every entry holds the
 * same lightness/chroma budget per theme — only the hue (and, for brown, a
 * deliberately lower lightness/chroma so it reads as brown rather than
 * orange) changes — light ~L0.94–0.96/C0.03–0.05, dark ~L0.21–0.25/
 * C0.03–0.045, so no colour calls more attention to itself than any other.
 * Yellow carries a little extra chroma in both themes; plain L/C at this
 * lightness reads as cream rather than yellow. Gradients spend the same
 * budget across three stops instead of one. Every class string below is a
 * literal — Tailwind's scanner reads source text, not a value assembled at
 * runtime, so a hue interpolated into a template would compile to nothing.
 */
export const BACKGROUND_CLASS_NAME: Record<BackgroundColorId | BackgroundGradientId, string> = {
  red: 'bg-[oklch(0.95_0.045_25)] dark:bg-[oklch(0.23_0.045_25)]',
  orange: 'bg-[oklch(0.95_0.05_55)] dark:bg-[oklch(0.23_0.045_55)]',
  yellow: 'bg-[oklch(0.95_0.06_95)] dark:bg-[oklch(0.24_0.05_95)]',
  green: 'bg-[oklch(0.95_0.04_145)] dark:bg-[oklch(0.22_0.04_145)]',
  mint: 'bg-[oklch(0.95_0.035_170)] dark:bg-[oklch(0.22_0.035_170)]',
  teal: 'bg-[oklch(0.94_0.035_190)] dark:bg-[oklch(0.22_0.035_190)]',
  cyan: 'bg-[oklch(0.95_0.035_215)] dark:bg-[oklch(0.23_0.035_215)]',
  blue: 'bg-[oklch(0.95_0.04_250)] dark:bg-[oklch(0.22_0.04_250)]',
  indigo: 'bg-[oklch(0.94_0.04_275)] dark:bg-[oklch(0.21_0.04_275)]',
  purple: 'bg-[oklch(0.95_0.04_305)] dark:bg-[oklch(0.23_0.04_305)]',
  pink: 'bg-[oklch(0.95_0.045_350)] dark:bg-[oklch(0.24_0.04_350)]',
  brown: 'bg-[oklch(0.9_0.025_60)] dark:bg-[oklch(0.21_0.03_60)]',
  sunset:
    'bg-linear-to-br from-[oklch(0.95_0.05_55)] via-[oklch(0.95_0.045_25)] to-[oklch(0.95_0.045_340)] dark:from-[oklch(0.23_0.045_55)] dark:via-[oklch(0.23_0.045_25)] dark:to-[oklch(0.24_0.04_340)]',
  ocean:
    'bg-linear-to-br from-[oklch(0.95_0.04_250)] via-[oklch(0.95_0.035_230)] to-[oklch(0.94_0.035_190)] dark:from-[oklch(0.22_0.04_250)] dark:via-[oklch(0.22_0.035_230)] dark:to-[oklch(0.22_0.035_190)]',
  forest:
    'bg-linear-to-br from-[oklch(0.95_0.04_145)] via-[oklch(0.94_0.04_160)] to-[oklch(0.93_0.035_175)] dark:from-[oklch(0.22_0.04_145)] dark:via-[oklch(0.215_0.04_160)] dark:to-[oklch(0.21_0.035_175)]',
  lavender:
    'bg-linear-to-br from-[oklch(0.95_0.04_290)] via-[oklch(0.95_0.04_275)] to-[oklch(0.95_0.035_250)] dark:from-[oklch(0.23_0.04_290)] dark:via-[oklch(0.22_0.04_275)] dark:to-[oklch(0.22_0.035_250)]',
  peach:
    'bg-linear-to-br from-[oklch(0.95_0.05_50)] via-[oklch(0.95_0.045_30)] to-[oklch(0.95_0.04_15)] dark:from-[oklch(0.24_0.045_50)] dark:via-[oklch(0.23_0.04_30)] dark:to-[oklch(0.23_0.035_15)]',
}

/** The literal Tailwind class for any id, including `'none'` — the one case
 * `BACKGROUND_CLASS_NAME` doesn't carry, since the shell's own backdrop
 * renders nothing at all for it (`background-backdrop.tsx`) rather than an
 * element with a class. The picker needs a class even for `'none'`, to draw
 * its "Default" swatch and to preview a pattern over no chosen colour — both
 * cases want the ordinary default *shell* surface, which is `bg-sidebar`
 * (the surface root-layout.tsx's wrapper and `ShellSidebar` actually paint
 * when no backdrop is active), not `bg-background` — the two differ enough
 * in dark mode (0.145 vs 0.205) that `bg-background` read as a near-black
 * swatch rather than "no colour chosen". Already a semantic token, not part
 * of the exception above. */
export function backgroundTileClassName(background: BackgroundId): string {
  return background === 'none' ? 'bg-sidebar' : BACKGROUND_CLASS_NAME[background]
}

interface CatalogOption<Id extends string> {
  id: Id
  labelKey: string
}

/** Display order for the settings page's colour/gradient grid: the default
 * first, then every colour, then every gradient. */
export const BACKGROUND_OPTIONS: ReadonlyArray<CatalogOption<BackgroundId>> = [
  { id: 'none', labelKey: 'settings.backgroundNone' },
  ...BACKGROUND_COLOR_IDS.map((id) => ({ id, labelKey: `settings.backgrounds.${id}` })),
  ...BACKGROUND_GRADIENT_IDS.map((id) => ({ id, labelKey: `settings.backgrounds.${id}` })),
]

/** Display order for the settings page's pattern grid: none, then every pattern. */
export const PATTERN_OPTIONS: ReadonlyArray<CatalogOption<BackgroundPatternValue>> = [
  { id: 'none', labelKey: 'settings.patternNone' },
  ...BACKGROUND_PATTERN_IDS.map((id) => ({ id, labelKey: `settings.patterns.${id}` })),
]

/**
 * A handful of lucide icons per pattern, repeated across the tile rather than
 * sixteen distinct icons — the same thing Telegram's own patterned chat
 * backgrounds do, and what keeps a pattern reading as one cohesive texture
 * instead of a grab-bag.
 */
export const PATTERN_ICONS: Record<BackgroundPatternId, readonly LucideIcon[]> = {
  code: [Code, Terminal, GitBranch, GitCommitHorizontal, Braces, Bug],
  space: [Rocket, Satellite, Moon, Sparkles, Telescope],
  nature: [Leaf, Trees, Flower2, Sprout, Bird],
  weather: [Sun, Cloud, CloudRain, Snowflake, CloudLightning],
  doodles: [Coffee, Music, Camera, Book, Lightbulb],
  geometric: [Circle, Square, Triangle, Hexagon, Diamond],
}

/**
 * The pattern tile's own colour: `currentColor` at an opacity low enough
 * to read as texture rather than content, one value per theme since the
 * two genuinely differ under `.dark` (not just the colour they're an
 * opacity of) — the `dark:` half of this file's own exception, kept here
 * rather than inside `background-pattern.tsx` so that file's own source
 * never has to carry the variant itself.
 */
export const PATTERN_ICON_CLASS_NAME = 'text-foreground/6 dark:text-foreground/8'

/**
 * The same tile, for the small swatch on the settings page rather than the
 * full shell backdrop: at swatch size, `PATTERN_ICON_CLASS_NAME`'s ~6–8%
 * barely registers, so the preview needs a noticeably stronger value to
 * actually read as "this pattern" rather than "no pattern" — still well
 * short of solid, so it stays distinguishable from a filled icon.
 * `BackgroundPattern`'s `className` prop overrides `PATTERN_ICON_CLASS_NAME`
 * with this (tailwind-merge resolves the conflicting `text-foreground/*`
 * utility in favour of whichever one is passed last), so the shell's own
 * backdrop — which never passes this — keeps its original, barely-there
 * opacity untouched.
 */
export const PATTERN_ICON_PREVIEW_CLASS_NAME = 'text-foreground/30 dark:text-foreground/35'

/** The side of the square `<pattern>` tile, in user units (SVG pixels). */
export const PATTERN_TILE_SIZE = 256

interface PatternSlot {
  x: number
  y: number
  size: number
  rotate: number
}

/**
 * Where each icon in a tile sits, how big it is and how far it's rotated —
 * shared by every pattern, which only changes which icon fills a given slot.
 * Kept well clear of the tile's own edge (a 40px margin, more than a rotated
 * 30px icon's own half-diagonal) so nothing is cut off by the `<pattern>`
 * element's implicit clip at the tile boundary — a `<pattern>` repeats its
 * content exactly, so a clipped icon would repeat clipped, a visible seam
 * every 256px. This is the shell backdrop's own layout — deliberately sparse,
 * so a full-page tile never looks like a repeating sticker sheet up close —
 * and it stays exactly as it is; `PATTERN_PREVIEW_SLOTS` below is a separate,
 * denser layout for the settings page's small swatch.
 */
export const PATTERN_SLOTS: ReadonlyArray<PatternSlot> = [
  { x: 50, y: 45, size: 22, rotate: -12 },
  { x: 120, y: 35, size: 18, rotate: 25 },
  { x: 195, y: 55, size: 28, rotate: -8 },
  { x: 40, y: 120, size: 26, rotate: 15 },
  { x: 115, y: 105, size: 16, rotate: -30 },
  { x: 200, y: 125, size: 24, rotate: 10 },
  { x: 60, y: 195, size: 20, rotate: -18 },
  { x: 135, y: 205, size: 28, rotate: 22 },
  { x: 210, y: 200, size: 18, rotate: -25 },
  { x: 90, y: 160, size: 22, rotate: 30 },
  { x: 165, y: 165, size: 16, rotate: -15 },
  { x: 30, y: 215, size: 24, rotate: 8 },
]

/**
 * The side of the small `<pattern>` tile `BackgroundPattern` draws when its
 * `preview` prop is set, in user units — chosen to equal the settings page's
 * own pattern swatch (`size-16`, 64px), so with no `viewBox` and no transform
 * one native unit is exactly one on-screen pixel: an icon's `size` below *is*
 * its final rendered size, no scale-factor arithmetic involved.
 */
export const PATTERN_PREVIEW_TILE_SIZE = 64

/**
 * Three icons, hand-placed rather than reusing `PATTERN_SLOTS` at a smaller
 * scale: shrinking the full twelve-slot layout to fit a swatch either crops
 * most of the icons at the tile's edge or shrinks the survivors past
 * legibility — the two are the same knob, and neither setting of it is good
 * enough. A dedicated, denser layout sized for exactly this box sidesteps the
 * trade-off: three icons, 14–16px each, kept comfortably clear of the 64px
 * tile's edge at any of their rotations, and loosely centred as a group.
 */
export const PATTERN_PREVIEW_SLOTS: ReadonlyArray<PatternSlot> = [
  { x: 20, y: 20, size: 16, rotate: -10 },
  { x: 44, y: 26, size: 14, rotate: 12 },
  { x: 32, y: 48, size: 16, rotate: -8 },
]
