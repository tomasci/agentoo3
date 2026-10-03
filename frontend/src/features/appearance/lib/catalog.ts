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
  AccentColorId,
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
 * `HIGHLIGHT_TINT_CLASS_NAME` and `HIGHLIGHT_TINT_ALIAS_CLASS_NAME` further down
 * carry the same two exceptions for a second reason: tinting every hover/
 * selected/open highlight to match a chosen background re-points `--accent`
 * itself per hue, and that hue is exactly the literal this file already
 * holds for the backdrop swatch. `ACCENT_COLOR_CLASS_NAME` carries them for a
 * third: the user-chosen accent colour (independent of the background —
 * `shared/store/ui.ts`'s `accentColorAtom`) re-points `--primary` per hue the
 * same way, and `ACCENT_COLOR_FIXED_TONE_CLASS_NAME` re-points a fixed-tone
 * subtree's `--primary` to `var(--foreground)` — not a fresh OKLCH literal —
 * because CSS has no way to read back globals.css's own neutral `--primary`
 * once a class has overridden it on an ancestor; `--foreground` sits close
 * enough in lightness (~0.06 apart) to be indistinguishable in practice, and
 * only ever applies while some accent is chosen at all.
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

/**
 * Every hover/selected/open highlight in the app — tabs, sidebar nav,
 * collapsible transcript rows, the Docker/Editor/Info/three-dots buttons on
 * a session page, dropdown menu items, ghost/outline buttons, table rows —
 * is drawn from one of four existing shadcn tokens: `--sidebar-accent`,
 * `--secondary` and `--muted` ship equal to `--accent` itself (0.97 light /
 * 0.269 dark, `globals.css`); `--input` doesn't (0.922 light, white at 15% in
 * dark) and is only re-pointed, below, for its one dark-mode ghost/outline
 * hover. Re-pointing just `--accent` per chosen hue, as classes on
 * `document.body` (`useHighlightTint`, hooks/use-highlight-tint.ts), is enough
 * to carry the hue into every one of them without a new CSS variable, a
 * `globals.css` edit, or touching a single generated `shared/ui` component —
 * see `HIGHLIGHT_TINT_ALIAS_CLASS_NAME` below for how the other three tokens
 * ride along. One id, one literal class, same reasoning and the same two
 * budgets (light/dark) as `BACKGROUND_CLASS_NAME` above — this is only ever
 * the *tint* a highlight turns, so it is deliberately a little stronger per
 * theme than that swatch's own chroma, the same way a hover state is always
 * meant to read as more present than the surface it sits on.
 */
export const HIGHLIGHT_TINT_CLASS_NAME: Record<BackgroundColorId | BackgroundGradientId, string> = {
  red: '[--accent:oklch(0.9_0.045_25)] dark:[--accent:oklch(0.31_0.05_25)]',
  orange: '[--accent:oklch(0.9_0.045_55)] dark:[--accent:oklch(0.31_0.05_55)]',
  yellow: '[--accent:oklch(0.9_0.07_95)] dark:[--accent:oklch(0.32_0.06_95)]',
  green: '[--accent:oklch(0.9_0.045_145)] dark:[--accent:oklch(0.31_0.05_145)]',
  mint: '[--accent:oklch(0.9_0.045_170)] dark:[--accent:oklch(0.31_0.05_170)]',
  teal: '[--accent:oklch(0.9_0.045_190)] dark:[--accent:oklch(0.31_0.05_190)]',
  cyan: '[--accent:oklch(0.9_0.045_215)] dark:[--accent:oklch(0.31_0.05_215)]',
  blue: '[--accent:oklch(0.9_0.045_250)] dark:[--accent:oklch(0.31_0.05_250)]',
  indigo: '[--accent:oklch(0.9_0.045_275)] dark:[--accent:oklch(0.31_0.05_275)]',
  purple: '[--accent:oklch(0.9_0.045_305)] dark:[--accent:oklch(0.31_0.05_305)]',
  pink: '[--accent:oklch(0.9_0.045_350)] dark:[--accent:oklch(0.31_0.05_350)]',
  brown: '[--accent:oklch(0.85_0.035_60)] dark:[--accent:oklch(0.29_0.04_60)]',
  // Gradients tint from their middle (`via`) stop's own hue, at the same
  // light/dark lightness-and-chroma budget as every plain colour above —
  // one hue is what a highlight can carry, so picking the stop a reader's
  // eye lands on first (dead centre) is the one that reads as "this
  // gradient's colour" rather than either edge.
  sunset: '[--accent:oklch(0.9_0.045_25)] dark:[--accent:oklch(0.31_0.05_25)]',
  ocean: '[--accent:oklch(0.9_0.045_230)] dark:[--accent:oklch(0.31_0.05_230)]',
  forest: '[--accent:oklch(0.9_0.045_160)] dark:[--accent:oklch(0.31_0.05_160)]',
  lavender: '[--accent:oklch(0.9_0.045_275)] dark:[--accent:oklch(0.31_0.05_275)]',
  peach: '[--accent:oklch(0.9_0.045_30)] dark:[--accent:oklch(0.31_0.05_30)]',
}

/**
 * The other three tokens a highlight might be drawn from, carried as one
 * second class alongside `HIGHLIGHT_TINT_CLASS_NAME[id]` (`useHighlightTint`
 * applies both to `document.body`) rather than folded into it: unlike
 * `--accent`, none of these three should simply equal the tinted accent at
 * all times.
 *
 * `--sidebar-accent` and `--secondary` are re-pointed unconditionally. The
 * sidebar's own hover/active nav highlight and the tab row's active-tab pill
 * (a permanent "selected" state rather than a hover) want the tint all the
 * time, not only mid-hover — and so, by the same accepted logic, do
 * `--secondary`'s static surfaces: the count-chip `Badge` (`library-tabs.tsx`,
 * `recovery-panel.tsx`), the Reload button (`version-skew-alert.tsx`) and the
 * not-found page's back link (`router.tsx`) are meant to read as themed
 * chrome, not as grey leftovers, so they tint along with everything else.
 * `--muted` and `--input`, by contrast, back ordinary static surfaces that
 * must stay neutral grey (code blocks, skeletons, log consoles) right up
 * until the moment they are actually hovered, expanded or pressed — so those
 * two are re-pointed only inside a selector scoped to exactly that moment, on
 * whichever element is in it: an `a`, `button` or `tr` that is itself
 * `:hover`, `[aria-expanded=true]` or `[aria-pressed=true]`, or that
 * `:has()` an expanded descendant (a table row whose own open menu trigger
 * lives one level down, not on the `tr` itself — `shared/ui/table.tsx`'s
 * `has-aria-expanded:bg-muted/50`), plus `[data-slot=attachment]` (the
 * attachment card's own hover reaches `--muted` through a
 * `:has(>a,>button):hover` on itself, not a descendant —
 * `shared/ui/attachment.tsx`). `--input` only needs the dark-mode half: its
 * one hover usage (`outline`/`ghost` button, `dark:hover:bg-input/50`) is
 * itself a `dark:` rule in `shared/ui/button.tsx`, so there is nothing for a
 * light-mode selector to ever match. Every selector here reads through
 * `document.body` (see `useHighlightTint`'s own comment for why `<body>` rather
 * than `<html>`), so it applies equally to the handful of cases above living
 * in a portal (menus, dialogs, the phone sidebar) rather than inline in the
 * shell.
 */
export const HIGHLIGHT_TINT_ALIAS_CLASS_NAME =
  '[--sidebar-accent:var(--accent)] [--secondary:var(--accent)] [&_:is(a,button,tr,[data-slot=attachment]):is(:hover,[aria-expanded=true],[aria-pressed=true],:has([aria-expanded=true]))]:[--muted:var(--accent)] dark:[&_:is(a,button):hover]:[--input:var(--accent)]'

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

/**
 * The user's chosen accent colour (`shared/store/ui.ts`'s `accentColorAtom`)
 * — independent of the background above, so a reader can match the two or
 * pick any other pairing — re-points shadcn's own `--primary` per hue, the
 * same mechanism `HIGHLIGHT_TINT_CLASS_NAME` uses for `--accent`. `--primary`
 * is what every "this asks for your attention" control already reads: the
 * default `Button` variant, `text-primary` links, a checked `Checkbox`/
 * `Switch`. Deliberately *not* touched: `--primary-foreground` (the text/icon
 * drawn on top of a primary-coloured fill, which still has to read against
 * whichever of these hues ends up under it), `--ring` (focus must look the
 * same regardless of the reader's colour choice) and `--sidebar-primary`
 * (unused by anything today). Light values sit at L0.5 so `--primary-
 * foreground`'s existing light value (near-white) stays readable on top, and
 * carry noticeably more chroma than `HIGHLIGHT_TINT_CLASS_NAME`'s highlight
 * tones — a button or link has to read as a deliberate colour, not a tint.
 * Dark values sit at L0.74, light enough for the existing dark
 * `--primary-foreground` (near-black) to stay readable, with chroma eased
 * back from the light value the same way every other dark-mode tone in this
 * file is. Gradients again take their middle (`via`) stop's own hue; `sunset`
 * and `lavender` intentionally share their numbers with `red` and `indigo`,
 * the same pairing the backdrop swatch and the highlight tint both already
 * carry for those two.
 */
export const ACCENT_COLOR_CLASS_NAME: Record<BackgroundColorId | BackgroundGradientId, string> = {
  red: '[--primary:oklch(0.5_0.185_25)] dark:[--primary:oklch(0.74_0.145_25)]',
  orange: '[--primary:oklch(0.5_0.115_55)] dark:[--primary:oklch(0.74_0.16_55)]',
  yellow: '[--primary:oklch(0.5_0.095_95)] dark:[--primary:oklch(0.74_0.14_95)]',
  green: '[--primary:oklch(0.5_0.145_145)] dark:[--primary:oklch(0.74_0.16_145)]',
  mint: '[--primary:oklch(0.5_0.09_170)] dark:[--primary:oklch(0.74_0.135_170)]',
  teal: '[--primary:oklch(0.5_0.08_190)] dark:[--primary:oklch(0.74_0.12_190)]',
  cyan: '[--primary:oklch(0.5_0.08_215)] dark:[--primary:oklch(0.74_0.12_215)]',
  blue: '[--primary:oklch(0.5_0.13_250)] dark:[--primary:oklch(0.74_0.125_250)]',
  indigo: '[--primary:oklch(0.5_0.19_275)] dark:[--primary:oklch(0.74_0.12_275)]',
  purple: '[--primary:oklch(0.5_0.19_305)] dark:[--primary:oklch(0.74_0.15_305)]',
  pink: '[--primary:oklch(0.5_0.19_350)] dark:[--primary:oklch(0.74_0.16_350)]',
  brown: '[--primary:oklch(0.47_0.05_60)] dark:[--primary:oklch(0.72_0.06_60)]',
  sunset: '[--primary:oklch(0.5_0.185_25)] dark:[--primary:oklch(0.74_0.145_25)]',
  ocean: '[--primary:oklch(0.5_0.09_230)] dark:[--primary:oklch(0.74_0.135_230)]',
  forest: '[--primary:oklch(0.5_0.1_160)] dark:[--primary:oklch(0.74_0.15_160)]',
  lavender: '[--primary:oklch(0.5_0.19_275)] dark:[--primary:oklch(0.74_0.12_275)]',
  peach: '[--primary:oklch(0.5_0.185_30)] dark:[--primary:oklch(0.74_0.145_30)]',
}

/**
 * Scopes `--primary` back to `var(--foreground)` — see this file's own
 * header comment for why a token read rather than a fresh OKLCH literal —
 * for exactly the subtrees that must ignore the accent entirely: a *closed*
 * meaning scale, where the colour itself is the information (a status dot's
 * green/amber/red, a diff line's add/remove tint) rather than a decoration
 * that can take the reader's taste. `[data-slot=progress-indicator]` is
 * `Progress`'s own generated slot (`shared/ui/progress.tsx`) — every bar
 * already exists today, none is being added — and `[data-fixed-tone]` is a
 * marker this app's own components carry for the same reason (`StatusDot`,
 * `SuggestionDiff`). Applied alongside `ACCENT_COLOR_CLASS_NAME[id]` on
 * `document.body` by `useAccentColor`, as a descendant selector, so it wins
 * over the body-level `--primary` re-point without undoing it anywhere else.
 */
export const ACCENT_COLOR_FIXED_TONE_CLASS_NAME =
  '[&_:is([data-slot=progress-indicator],[data-fixed-tone])]:[--primary:var(--foreground)]'

/** The literal Tailwind class for the accent swatch's own tile — the button
 * colour itself, not the pale background tint `backgroundTileClassName`
 * draws for the same id. `'none'` reads as `bg-foreground`: the accent has
 * no backdrop-style default surface to fall back on (unlike `'none'`'s
 * `bg-sidebar` above), so the tile instead previews today's actual `Button`
 * colour, which is `--primary` left at its own unmodified, foreground-near
 * value. */
export function accentColorTileClassName(id: AccentColorId): string {
  return id === 'none' ? 'bg-foreground' : `bg-primary ${ACCENT_COLOR_CLASS_NAME[id]}`
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

/**
 * The one frosted-glass recipe every backdrop-active surface uses — the page
 * body (`SidebarInset`, root-layout.tsx), the tab pill and the sidebar's own
 * nav lists (tab-bar.tsx, sidebar.tsx) — so the three can't quietly drift
 * into three different "glassy" looks. `bg-background/70` reads white-ish in
 * light and near-black in dark for free, since it's an opacity of the same
 * semantic token each surface already uses when no backdrop is active.
 */
export const GLASS_CLASS_NAME = 'bg-background/70 ring-1 ring-border/50 backdrop-blur-xl'
