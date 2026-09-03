# Component contract (Phase 3)

Binding for every component under `frontend/src/shared/ui/`. It exists so that
implementers working in parallel, who cannot see each other's work, produce
components that behave and look like one system.

> **Token names in this document are the real ones.** They were checked against
> `frontend/src/styles/_theme-light.scss`. Do not use `--color-fg`,
> `--color-bg-page`, `--color-bg-surface`, `--color-accent-fg` or
> `--color-danger-solid` — those do not exist. A CSS custom property that does
> not exist fails **silently**: it typechecks, lints, builds, and renders
> transparent. Verify with:
> `grep -oh 'var(--[a-z-]*)' src/shared/ui/**/*.scss | sort -u`
> and confirm every hit appears in `src/styles/`.

## Core rules

1. **No component accepts `className` or `style`.** Props are wrapped in
   `NoStyle<P>` so this is a compile error, not a review comment.
2. **Variants map to classes through a `Record<Union, string>` lookup.**
   `styles[variant]` dynamic indexing is banned — `noUncheckedIndexedAccess` is
   on, so it types as `string | undefined`, and it drifts silently from the
   union when a member is added.
3. **State comes from Ark's data attributes**, never from separately tracked
   React state.
4. **A component never carries its own outer margin.** Spacing between things
   belongs to the parent — that is what `Stack` and `Inline` are for.

## The escape hatch

There is deliberately no `unsafeClassName`, `sx`, or `css` prop; a named escape
hatch is `className` with extra steps. In order:

1. **Spacing is the parent's job** — `Stack` / `Inline`. All 9 existing inline
   `style={{marginTop}}` leaks are spacing nudges that exist because no
   component owned the gap.
2. **Feature code styles its own elements** — put your class on your own
   wrapper, never push one into a shared component.
3. **If a shared component genuinely lacks a look, add the variant to the
   union** — a two-line, greppable, reviewable change.

`asChild` is the one polymorphic door, on `Button` and `Tooltip` only. The child
passed to `asChild` must not carry a `className`: Ark's `mergeProps`
concatenates rather than replaces, which would reopen the leak.

## Shared types — `shared/ui/lib/types.ts`

```ts
export type NoStyle<P> = Omit<P, 'className' | 'style'>
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Size = 'sm' | 'md' | 'lg'
```

## The class joiner — `shared/ui/lib/cx.ts`

Mandatory inside `shared/ui/**`; template-literal joining is banned there
(25 sites do it today).

```ts
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
```

## Variant → class idiom

A module-local record directly below the `styles` import, `SCREAMING_SNAKE`,
named for the prop. `Record<Union, string>` fails the build if a union member is
added without a class.

```ts
import styles from './button.module.scss'

const VARIANT: Record<ButtonVariant, string> = {
  primary: styles.variantPrimary,
  secondary: styles.variantSecondary,
  ghost: styles.variantGhost,
  danger: styles.variantDanger,
}
const SIZE: Record<Size, string> = { sm: styles.sizeSm, md: styles.sizeMd, lg: styles.sizeLg }
```

Class names inside modules are prefixed by prop name in camelCase —
`.variantPrimary`, `.sizeMd`, `.toneDanger`, `.gap3`. Both `variant` and `size`
can contain `md`, so a bare `.md` would collide; the prefix also makes the
record and the stylesheet greppable in both directions.

The component's outer element is always `.root`. Parts of an Ark component use
**Ark's own anatomy part names verbatim** — `.trigger`, `.positioner`,
`.content`, `.item`, `.itemText`, `.indicator`, `.control`, `.thumb`, `.label`,
`.helperText`, `.errorText`, `.backdrop`.

Never style `[data-part]` — it is not scoped and leaks across modules, which is
the exact failure recorded in `library.module.scss:138`.

## `shared/ui/_mixins.scss` — copy byte-for-byte

```scss
// The one focus ring. 14 copies with 3 different offsets existed before this.
@mixin focus-ring {
  &:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
}

// For elements filling a clipping parent — menu items, select items, table
// rows, segment items. A positive offset is painted outside the scroll box and
// vanishes, which is the real reason three offsets existed.
@mixin focus-ring-inset {
  &:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: calc(var(--focus-ring-offset) * -1);
  }
}

@mixin disabled {
  &:disabled,
  &[data-disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

// --color-danger, NOT --color-danger-border. The -border step is a pale banner
// border (#EEC2BF light / #471E1A dark) that measures 1.6:1 and 1.26:1 against
// a control surface — invisible. --color-danger measures 4.87:1 light and
// 5.41:1 dark, clear of the 3:1 WCAG 1.4.11 floor for non-text UI.
@mixin invalid {
  &[data-invalid] {
    border-color: var(--color-danger);
    // A thickness channel, not decoration: doubles the apparent border without
    // a 1px layout shift, so invalid is perceptible without relying on hue.
    box-shadow: inset 0 0 0 1px var(--color-danger);
  }

  &[data-invalid]:focus-visible { outline-color: var(--color-danger); }
}

// The shared shape of every text-entry control and the select trigger. This is
// what keeps separately-built inputs on identical metrics.
@mixin control-surface {
  appearance: none;
  width: 100%;
  min-height: var(--control-height-md);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--text-base);
  line-height: var(--leading-base);
  transition: border-color var(--dur-fast) var(--ease-out);

  &::placeholder { color: var(--color-text-muted); }
  &:hover:not(:disabled):not([data-disabled]) { border-color: var(--color-text-muted); }

  @include focus-ring;
  @include disabled;
  @include invalid;
}
```

`--color-border-strong` is the form-control border — the only neutral step that
clears 3:1 (light `neutral-500` 3.22:1, dark `neutral-600` 3.05:1). Cards and
dividers keep the softer `--color-border`.

Which mixin each component uses:

| `focus-ring` (offset +2px) | `focus-ring-inset` (offset −2px) |
|---|---|
| Button, Input, Textarea, Select trigger, NumberInput input and steppers, Checkbox control, Switch control, Collapsible trigger, Tooltip trigger, ActionsMenu trigger, CopyButton, Dialog close | Menu item, Select item, SegmentGroup item, DataTable row link, Toast close |

One carve-out from "visible focus ring": Ark `*.Content` elements that take
programmatic focus (`Dialog.Content` has `tabIndex: -1`; `Menu.Content` holds
focus while items are highlighted) set `&:focus-visible { outline: none; }` —
they are not operable elements, and the ring belongs on the highlighted item.

## Ark data attributes

| Attribute | Styling |
|---|---|
| `[data-state="open"/"closed"]` | Enter/exit animation only, never resting appearance. `--dur-base` / `--dur-slow` with `--ease-out`. |
| `[data-state="checked"/"unchecked"]` | Checked fill: `--color-accent` background, `--color-text-on-accent` mark. |
| `[data-highlighted]` | `background: var(--color-surface-hover)`. This — not `:hover`, not `:focus` — is the keyboard-and-pointer highlight. Do **not** add a separate `:hover`, you will get two highlights. |
| `[data-selected]` | `color: var(--color-accent-text)` plus the item indicator. |
| `[data-disabled]` | `@include disabled`. |
| `[data-invalid]` | `@include invalid`. |
| `[data-focus]` / `[data-focus-visible]` | Not styled — the ring goes on `.control`. Two focus systems is how implementations diverge. |

## Loading

Reduced-motion collapses all durations with **no whitelist**, so a pure CSS
spinner communicates nothing to a reduced-motion user. `Spinner` is Ark
`Progress` with `value={null}` rendered as `Progress.Circle` (SVG, no
dependency), which supplies `role="progressbar"` and the aria wiring.

Two channels, always both: motion (`--dur-progress` with `--ease-linear`) and
text. `label` is a **required prop with no default** — under reduced motion the
ring freezes and the text carries the meaning.

`Button loading` is one canonical implementation so widths never differ: Button
always wraps children in `<span class={styles.label}>`; `loading` sets
`disabled`, `aria-busy="true"` and `data-loading`, and the SCSS is
`[data-loading] .label { visibility: hidden; }` with the spinner absolutely
centred. No layout shift, no per-caller decision.

## Error, in three non-overlapping levels

- **Field** — `[data-invalid]`, via the mixin.
- **Block** — `Alert`. Error is `danger`. Warning is `warning`. Informational is
  `accent`; there is no info hue. This resolves the app using two colours for
  one meaning today.
- **Transient** — `toast({ tone: 'danger' })`.

Error text is `var(--color-danger-text)` at `--text-xs`: 8.33:1 light, 7.47:1
dark. The label is deliberately **not** reddened — border, inset ring and
message are already three reds for one fact.

Helper text is not rendered when invalid; `Field` drops `hint` when `error` is
set. Stacked hint-then-error is where the eye stops reading.

## z-index — declare on `Content`, never on `Positioner`

Verified in `@zag-js/popper`: the positioner gets **inline**
`z-index: var(--z-index)`, and Zag sets that property from the *Content's*
computed `z-index`. An inline declaration beats a class, so a `z-index` in a
`.positioner` class is dead code — `actions-menu.module.scss:18`'s `z-index: 30`
has never applied; the menu paints on top only because the portal appends last.

```scss
.content    { position: relative; z-index: var(--z-dropdown); }  /* --z-tooltip for Tooltip */
.positioner { /* no z-index, ever */ }
```

Dialog is different: it emits no inline z-index, so declare `var(--z-modal)` on
`.backdrop`, `.positioner` and `.content` in SCSS as today.

Toast cannot be won: `@zag-js/toast` puts inline `zIndex: 2147483647` on the
viewport and it is not configurable. Do not fight it with `!important`;
`--z-toast` is advisory.

## Verified package facts

- **Ark's Clipboard already has the `execCommand` fallback**
  (`@zag-js/clipboard` `dist/clipboard.dom.js`): it tries
  `navigator.clipboard.writeText`, otherwise selects an off-screen node and
  calls `document.execCommand('copy')`. The plain-HTTP tailnet path that
  `copy-button.tsx` documents is therefore preserved by wrapping Ark, and Ark's
  `Selection`/`Range` approach preserves newlines better than the current
  `<textarea>` — which matters, since two of three call sites copy multi-line
  content.
- **`Field.Input`/`Textarea`/`Select`** use `useFieldContext()` with
  `strict: false`, so they work standalone outside a `Field.Root`. One
  component, not two.
- **`@zag-js/presence`** unmounts immediately when `animationName === "none"` or
  `animationDuration === "0s"`, so the global reduced-motion kill cannot strand
  an exit animation.

## Definition of done, per track

```
bun run typecheck && bun run lint && bunx stylelint 'src/**/*.scss' && bun test tests/
```

plus one render smoke test per track in its own file, so `tests/` does not
become a shared surface.
