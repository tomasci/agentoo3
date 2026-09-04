# Design tokens — reference

Source of truth for values: `design-system-audit.md` §6. This is a
quick-reference, not the derivation.

## The two-tier rule

Two layers of CSS custom properties, both on `:root`:

- **Primitives** (`--indigo-600`, `--neutral-200`, `--space-4`) — raw scale
  steps, colour or otherwise. Defined in `_palette.scss` / `_scales.scss`.
  Referenced **only** from `_theme-light.scss` / `_theme-dark.scss`.
- **Semantics** (`--color-surface`, `--color-text-muted`) — what a primitive
  *means* in a given theme. This is what component SCSS consumes.

Component `*.module.scss` files use `--color-*` and the non-colour scales
(`--space-*`, `--text-*`, `--radius-*`, …) exclusively. They never reference
a primitive directly — that boundary is what lets a theme swap a whole ramp
without touching a single component file. (Enforcement: stylelint rule
scoped to `*.module.scss`, design-system-audit.md §6.9 — not yet wired up in
this phase.)

## Colour

Primitives: `--neutral-{0,50,100,200,300,400,500,600,700,800,850,875,900,910,925,950,975}`,
`--indigo-{50,100,200,300,400,500,600,700,800,900,950}`, plus `--green-*`,
`--amber-*`, `--red-*` status ramps (bg/border/text/solid per theme).

| Semantic token | Use |
|---|---|
| `--color-bg-app` | page background |
| `--color-surface` / `-raised` / `-overlay` / `-sunken` | elevation planes, low to high (sunken is *below* app) |
| `--color-surface-hover` / `-active` / `-disabled` / `-code` | interaction and content states |
| `--color-text-primary` / `-secondary` / `-muted` / `-disabled` | body text, descending contrast |
| `--color-text-inverted` / `-on-accent` / `-code` | text on a surface of the opposite value, on an accent fill, in a mono block |
| `--color-border-subtle` / `-border` / `-border-strong` | hairlines, ascending contrast — `-strong` is the only step that clears WCAG 1.4.11 (3:1); use it for form control boundaries (input/select/textarea), not for cards or dividers, which should stay near-invisible on plain `--color-border` |
| `--color-accent` / `-hover` / `-active` | interactive fill, resting/hover/pressed |
| `--color-accent-subtle-bg` / `-subtle-border` / `-text` | tinted accent backgrounds and accent-coloured text |
| `--color-focus-ring` | `box-shadow`/`outline` colour for `:focus-visible` |
| `--color-success` / `-warning` / `-danger` (+ `-text` / `-bg` / `-border`) | status, restrained — no `info`, the accent covers that |
| `--color-scrim` | overlay behind a modal/dialog |

## Type

| Token | rem | Paired `--leading-*` | Paired `--tracking-*` |
|---|---|---|---|
| `--text-2xs` | 0.6875 | 1rem | 0.01em |
| `--text-xs` | 0.75 | 1.125rem | 0.005em |
| `--text-sm` | 0.8125 | 1.25rem | 0 |
| `--text-base` (body default) | 0.875 | 1.375rem | 0 |
| `--text-md` (rendered prose) | 1 | 1.625rem | -0.006em |
| `--text-lg` | 1.125 | 1.625rem | -0.01em |
| `--text-xl` | 1.375 | 1.875rem | -0.014em |
| `--text-2xl` | 1.75 | 2.25rem | -0.018em |
| `--text-3xl` | 2.25 | 2.625rem | -0.022em |

Also: `--font-sans`, `--font-mono`; `--leading-code: 1.55` (unitless, for
mono blocks); `--tracking-caps: 0.06em` (uppercase micro-labels);
`--weight-{regular,medium,semibold}` = 400/500/600.

## Spacing — base 4px

`--space-{0,px,1,2,3,4,5,6,8,10,12,16}` = 0, 1px, 4, 8, 12, 16, 20, 24, 32,
40, 48, 64px. `$space-sm/md/lg/xl` (old Sass vars) map to `2/3/5/8` exactly.

## Radii

`--radius-sm` 6px (badges/chips/checkboxes) · `--radius-md` 9px (**all** form
controls, all sizes) · `--radius-lg` 12px (cards/menus/popovers) ·
`--radius-xl` 16px (dialogs) · `--radius-2xl` 20px (feature panels) ·
`--radius-full` 9999px (avatars/dots/pills — never a form control).

## Elevation

`--shadow-{xs,sm,md,lg,focus}`. Light: warm-tinted shadows scaling in blur
and opacity. Dark: elevation is a **lighter surface**, not a shadow —
`--shadow-xs` and `--shadow-sm` are `none`; `--shadow-md`/`-lg` are a real
drop shadow plus a faint inset top highlight, used only on floating layers
(menus, dialogs).

> **Contract:** a component that relies on `--shadow-sm` alone to separate
> itself from what's behind it is invisible in dark theme. Anything at that
> elevation must also change `--color-surface-raised` (or equivalent) — the
> lightness step *is* the separation in dark.

## Motion, z-index

`--dur-fast` 120ms · `--dur-base` 160ms · `--dur-slow` 200ms ·
`--dur-progress` 900ms (a loop period, not a transition — outside the
120–200ms band on purpose). `--ease-{out,in,in-out,linear}`.

`--z-{base,raised,sticky,dropdown,overlay,modal,toast,tooltip}` = 0, 10,
100, 1000, 1100, 1200, 1300, 1400.

`prefers-reduced-motion: reduce` collapses every `--dur-*` to `0.01ms` and
hard-stops `*, *::before, *::after` globally — no whitelist.

> **Contract:** anything that communicates ongoing state *only* through
> animation (a spinner, a pulsing dot) becomes permanently ambiguous under
> reduced motion. It must also say so statically — text, an icon, a colour
> change that doesn't depend on the animation still running.

## Breakpoints

Sass-only — media queries can't read a custom property, so these live in
`_breakpoints.scss` as a `$breakpoints` map (`sm` 40rem, `md` 56rem, `lg`
72rem, `xl` 90rem), not as tokens. It is the **only** file in `styles/` a
`*.module.scss` may `@use`, and it must never gain a bare declaration:
every module is its own Sass compilation unit, so anything other than a map
and mixins in that file would be duplicated into every module that imports
it.

```scss
@use '@/styles/breakpoints' as bp;

.sidebar {
  width: 100%;

  @include bp.up(md) {
    width: var(--layout-sidebar-width);
  }
}
```

`@include bp.below(sm) { ... }` compiles to `max-width: calc(40rem - 0.0625rem)`.
Both mixins `@error` on an unrecognised name.

## Theming

`data-theme` is set on `<html>` (`:root[data-theme='dark']`); its absence
is light. `_theme-light.scss` and `_theme-dark.scss` each define the
complete `--color-*` set — dark doesn't inherit or patch light, it replaces
it outright, so a token missing from one theme file falls back to the
*light* value rather than erroring, which is worth catching in review.

## Migration shim

`global.scss` re-declares the pre-token names (`--bg`, `--surface`, `--fg`,
…) as pass-throughs to their `--color-*` equivalents, for the ~20
`*.module.scss` files not yet migrated (design-system-audit.md §7). It is
temporary and is deleted once that migration finishes — do not add new
consumers of the old names.
