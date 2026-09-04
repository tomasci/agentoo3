# Token migration map

The single source of truth for Phase 2b/Phase 4 mechanical migration. Every
literal in a `*.module.scss` maps to exactly one token via this table. It exists
because several agents migrate different files in parallel and must converge on
identical choices — if a value you hit is not listed, do not invent a mapping,
report it.

Values marked **snap** deliberately change rendering: the old value sat between
scale steps. That is the sanctioned exception to "rendering unchanged".

## Colour

| Old | New |
|---|---|
| `var(--bg)` | `var(--color-bg-app)` |
| `var(--surface)` | `var(--color-surface)` |
| `var(--fg)` | `var(--color-text-primary)` |
| `var(--muted-fg)` | `var(--color-text-secondary)` — but `var(--color-text-muted)` on uppercase micro-labels, hints, and status-bar metrics |
| `var(--muted)` | `var(--color-text-disabled)` |
| `var(--border)` | `var(--color-border)` — but `var(--color-border-strong)` on form controls (input, select, textarea) |
| `var(--accent)` | `var(--color-accent)`; in a focus ring use `var(--color-focus-ring)` |
| `var(--accent-fg)` | `var(--color-text-on-accent)` |
| `var(--ok)` | `var(--color-success)` |
| `var(--warn)` | `var(--color-warning)` |
| `var(--danger)` / `var(--danger, #c0392b)` | `var(--color-danger)` — drop the hex fallback, it matched neither theme |
| `var(--accent-soft, …)` | `var(--color-accent-subtle-bg)` |
| `#fff` (confirm-dialog:45) | `var(--color-text-on-accent)` |
| `#0b0c0f` (recovery-panel:87) | `var(--color-surface-code)` |
| `#e6e6ec` (recovery-panel:88) | `var(--color-text-code)` |
| `rgb(0 0 0 / 0.5)` backdrop | `var(--color-scrim)` |
| `color-mix(… var(--warn) 8%, transparent)` | `var(--color-warning-bg)` |
| `color-mix(… var(--danger) 8%, transparent)` | `var(--color-danger-bg)` |
| `transparent`, `inherit`, `currentColor`, `none` | unchanged |

Error text: `.error` currently uses `--warn` in 5 files and `--danger` in 1. All
of them mean "this failed" — use `var(--color-danger-text)` everywhere.

## Font size — always set the paired leading and tracking

Setting `font-size: var(--text-X)` means also setting
`line-height: var(--leading-X)`, and `letter-spacing: var(--tracking-X)` where
the file already set one.

| Old | New |
|---|---|
| `0.6875rem` | `--text-2xs` |
| `0.75rem` | `--text-xs` |
| `0.8125rem` | `--text-sm` |
| `0.875rem` | `--text-base` |
| `0.9375rem` | `--text-base` **snap** (15→14) |
| `1rem` | `--text-md` |
| `1.05rem`, `1.0625rem` | `--text-md` **snap** (17→16) |
| `1.125rem` | `--text-lg` |
| `1.25rem` | `--text-lg` **snap** (20→18) |

`markdown.module.scss` em-based sizes: `1.35em`→`--text-xl`, `1.2em`→`--text-lg`,
`1.08em`→`--text-md`, `1em`→`--text-md`, `0.95em`/`0.9em`→`--text-base`,
`0.85em`→`--text-sm`. Inline `code` at `0.9em`→`--text-sm`.

Line heights not attached to a font-size change: `1.5`/`1.55`/`1.6` on body copy
→ the paired `--leading-*` for that element's size; a `<pre>`/code block →
`--leading-code`. `line-height: 1` on icon buttons → keep `1`.

## Font weight / family

`500`→`var(--weight-medium)`, `600`→`var(--weight-semibold)`. `font: inherit`
stays. Both mono stacks →`var(--font-mono)`. Sans →`var(--font-sans)`.

## Letter-spacing

Every uppercase micro-label (`0.03em`, `0.04em`, `0.06em`) →
`var(--tracking-caps)`. `-0.01em` on the logo → `var(--tracking-lg)`.

## Spacing — 4px base

| Old (px) | New |
|---|---|
| `0.1rem` 1.6, `0.15rem` 2.4, `0.2rem` 3.2, `0.25rem` 4, `0.3rem` 4.8 | `--space-1` **snap** |
| `0.35rem` 5.6, `0.4rem` 6.4, `0.45rem` 7.2, `0.5rem` 8, `0.6rem` 9.6 | `--space-2` **snap** |
| `0.65rem` 10.4, `0.7rem` 11.2, `0.75rem` 12, `0.875rem` 14 | `--space-3` **snap** |
| `1rem` 16, `1.1rem` 17.6 | `--space-4` **snap** |
| `1.2rem` 19.2, `1.25rem` 20 | `--space-5` **snap** |
| `1.5rem` 24 | `--space-6` |
| `2rem` 32 | `--space-8` |
| `v.$space-sm` / `md` / `lg` / `xl` | `--space-2` / `-3` / `-5` / `-8` (exact) |
| `0`, `auto` | unchanged |

## Radii

| Old | New |
|---|---|
| `2px`, `4px`, `calc(v.$radius-sm - 2px)`, `v.$radius-sm` (6px) | `--radius-sm` |
| `v.$radius` (10px) on a form control | `--radius-md` |
| `v.$radius` (10px) on a card, panel, menu, dialog, code well | `--radius-lg` |
| `999px` | `--radius-full` |
| `50%` | `50%` (unchanged — a circle, not a radius step) |

## Elevation, motion, layering

| Old | New |
|---|---|
| `0 8px 24px rgb(0 0 0 / 0.24)` (menu) | `var(--shadow-md)` |
| `0 12px 32px rgb(0 0 0 / 0.28)` (dialog) | `var(--shadow-lg)` |
| `120ms` | `var(--dur-fast)` |
| `1.2s` (pulse) | `var(--dur-progress)` |
| `ease` | `var(--ease-out)` |
| `ease-in-out` | `var(--ease-in-out)` |
| `z-index: 30` | `var(--z-dropdown)` |
| `z-index: 40` | `var(--z-overlay)` |
| `z-index: 41` | `var(--z-modal)` |

Any component relying on `--shadow-sm` to separate itself must also set
`--color-surface-raised`; dark `--shadow-sm` is `none`.

## Borders and focus

Border widths: `1px` and `2px` stay literal (device-pixel concerns). The single
`3px` in `markdown.module.scss:32` → `2px` **snap**.

The focus ring is 14 copies with 3 different offsets today. One declaration,
copied byte-identically:

```scss
&:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
```

The only sanctioned deviation is `outline-offset: -2px` where the ring must sit
inside a clipped container (`tab-bar` triggers, `layout` nav items). Keep that
literal; the enforcement config allows it.

## Layout constants and breakpoints

`v.$sidebar-width`→`var(--layout-sidebar-width)`,
`v.$content-width`→`var(--layout-content-width)`.

Replace `@media (max-width: 40rem)` with:

```scss
@use '@/styles/breakpoints' as bp;   // at the top of the file

@include bp.below(sm) { … }
```

`_breakpoints.scss` is the ONLY styles partial a `*.module.scss` may `@use` —
every module is its own Sass compilation unit, so importing a partial that emits
declarations duplicates that whole block into the module's output.

Drop `@use '@/styles/variables' as v;` from any file once its last `v.$…`
reference is gone.

## Out of scope for the mechanical pass

Do not restructure, rename classes, extract shared components, delete dead
classes, or touch any `.tsx`. Value substitution only.
