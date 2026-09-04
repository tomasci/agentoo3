# Phase 1 — Design System Audit

Scope: `frontend/src` — 20 SCSS files (1,837 lines, ~1,100 declarations) and 31 TSX
files (3,336 lines). Every file was read in full. Baseline at time of audit:
typecheck clean, 74/74 tests passing.

Headline: the codebase has a *partial* token layer (11 CSS custom properties for
colour, 8 Sass variables for layout) that roughly half the code ignores. Colour is
in decent shape; **type, motion, elevation, z-index and radii have no token layer at
all**, and 88 font-size declarations are literals with zero exceptions.

---

## 1. Inventory of hardcoded UI values

### 1.1 Colour

Legitimate definitions: 22 hex literals in `styles/global.scss` (11 tokens × 2 themes).

Raw literals **outside** the token file — 4 distinct values, 12 occurrences:

| Value | Count | Where | Note |
|---|---|---|---|
| `#c0392b` | 8 (7 lines) | `layout.module.scss:207`; `session-page.module.scss:103,109,111,112`; `transcript.module.scss:120` (×2), `:207` | Always as `var(--danger, #c0392b)`. **Matches neither theme's `--danger`** (`#c2410c` light / `#f0785a` dark) — a third, unrelated red |
| `#fff` | 1 | `confirm-dialog.module.scss:45` | `--accent-fg` exists |
| `#0b0c0f` | 1 | `recovery-panel.module.scss:87` | Hardcoded dark terminal pair — |
| `#e6e6ec` | 1 | `recovery-panel.module.scss:88` | — does not respond to theme switch |

Near-duplicate grouping across the token set: `#16161a` / `#17181d` / `#0f1013` are
three distinct near-blacks serving different roles; `#ffffff` and `#0f1013` are each
reused for two roles.

`rgb()` — 3 occurrences, all shadow/overlay, all modern slash syntax:
`rgb(0 0 0 / 0.24)` (`actions-menu:26`), `rgb(0 0 0 / 0.5)` (`confirm-dialog:6`),
`rgb(0 0 0 / 0.28)` (`confirm-dialog:27`). No `hsl()`, no legacy `rgba()`.

**Broken token reference:** `--accent-soft` is consumed at `transcript.module.scss:20`
but defined nowhere. It has always silently resolved to its fallback.

### 1.2 Font sizes — 17 distinct values, 88 declarations, 0 tokenized

`0.6875` (11×) · `0.75` (28×) · `0.8125` (36×) · `0.875` (13×) · `0.9375` (10×) ·
`1rem` (6×) · `1.05` (1×) · `1.0625` (1×) · `1.125` (3×) · `1.25` (2×) rem, plus 7
em-based values in `markdown.module.scss` (`0.85` / `0.9` / `0.95` / `1` / `1.08` /
`1.2` / `1.35em`).

Six heading sizes with no shared ratio. `1.05rem` (`session-page:38`) and `1.0625rem`
(`library:14`) differ by **0.2px** — indistinguishable, separately maintained.

### 1.3 Font weights — 2 values

`500` (5×), `600` (25×). Plus `font: inherit` at 15 sites.

### 1.4 Line heights — 12 distinct values, 27 occurrences

`1` (3×) · `1.2` · `1.3` · `1.4` · `1.45` · `1.5` (5×) · `1.55` (6×) · `1.6` (5×) ·
`1.65` · `1.7` (2×). `1.5`, `1.55` and `1.6` are used interchangeably for the same
body-copy role.

### 1.5 Font families — 3 stacks, 17 declarations

One sans (`global.scss:46`) and **two different monospace stacks used interchangeably**:
`ui-monospace, SFMono-Regular, Menlo, monospace` (7×) and `ui-monospace, Menlo,
monospace` (9×). `recovery-panel.module.scss` and `library.module.scss` each use both.

### 1.6 Spacing

Tokenized: `$space-sm` 39×, `$space-md` 50×, `$space-lg` 33×, `$space-xl` 8×.

The declared scale is 8 / 12 / 20 / 32px. Hardcoded values landing **between** steps,
forming no secondary scale: `0.1rem` (5×) · `0.15rem` (6×) · `0.2rem` (3×) ·
`0.3rem` (4×) · `0.35rem` (15×) · `0.4rem` (13×) · `0.45rem` (1×) · `0.6rem` (7×) ·
`0.65rem` (2×) · `0.7rem` (1×) · `0.875rem` (1×) · `1.1rem` (1×) · `1.2rem` (1×)
— i.e. 1.6, 2.4, 3.2, 4.8, 5.6, 6.4, 7.2, 9.6, 10.4, 11.2, 14, 17.6, 19.2px.

Separately, `0.5rem` is hardcoded at 13 sites and `0.75rem` at 4 sites where
`$space-sm` / `$space-md` already hold exactly those values.

### 1.7 Radii — 6 effective values, 2 tokenized

`$radius-sm` 6px (29×) · `$radius` 10px (22×) · `calc($radius-sm - 2px)` = 4px (2×) ·
literal `4px` (4×) · `2px` (2×) · `999px` (5×) · `50%` (3×). The same 4px is spelled
two ways.

### 1.8 Shadows — 2 declarations, both untokenized, mutually inconsistent

`0 8px 24px rgb(0 0 0 / 0.24)` (`actions-menu:26`) and
`0 12px 32px rgb(0 0 0 / 0.28)` (`confirm-dialog:27`). Different offset, blur and
alpha for what are two levels of the same idea. Plus `backdrop-filter: blur(2px)`
(`confirm-dialog:7`).

### 1.9 Z-index — 3 values, no scale

`30` (`actions-menu:18`), `40` and `41` (`confirm-dialog:8,18`).

### 1.10 Motion — 4 declarations total

`transition: opacity 120ms ease` (`button:13`), `transition: transform 120ms ease`
(`transcript:70`), `animation: pulse 1.2s ease-in-out infinite` (`project-status:28`),
`@keyframes pulse` (`project-status:31`). Two durations, two easings, **no
`prefers-reduced-motion` guard anywhere in the codebase**.

### 1.11 Borders and focus rings

Widths: `1px` (74×), `2px` (4×), `3px` (1×, `markdown:32`), `0` reset (13×).

Focus ring: `outline: 2px solid var(--accent)` copy-pasted **14 times** with **three
different offsets** — `2px` (4×), `1px` (8×), `-2px` (2×). No mixin, despite Sass.

### 1.12 Breakpoints

Exactly one, untokenized, repeated verbatim 3×: `@media (max-width: 40rem)` at
`layout:161`, `project-picker:52`, `settings-page:64`.

### 1.13 Sizes

Two tokenized (`$sidebar-width`, `$content-width`). **Five different page max-widths
coexist**: 42rem (settings), 46rem (ssh-keys, transcript), 52rem (picker), 60rem
(overview), plus 32/34rem form cards. Plus ~30 one-off rem dimensions.

### 1.14 Letter-spacing — 4 values, no token

`-0.01em`, `0.03em`, `0.04em`, `0.06em` — the last three all applied to the *same*
uppercase micro-label pattern.

---

## 2. Repeated UI patterns not yet components

| Pattern | Copies | Evidence |
|---|---|---|
| **Card / panel** | 11 SCSS definitions | Solid: `library:75`, `project-overview:14`, `ssh-keys-page:13`, `settings-page:21`, `sessions:77`, `session-page:26,72`. Dashed form card **byte-identical** in `create-project-form:3`, `ssh-keys-page:20`, `sessions:45` |
| **Page header (title + actions)** | 6 sites, 4 CSS copies | Same 4 declarations at `project-overview:5`, `sessions:84`, `ssh-keys-page:47`, `session-page:26` |
| **Empty state** | 6 definitions, 4 character-identical | `library:64`, `projects-table:66` (**dead**), `project-picker:35`, `sessions:106`, `ssh-keys-page:101`, `transcript:5` |
| **Loading state** | 9 sites, 2 incompatible treatments | Styled via `.empty` (5×) vs **unclassed bare `<p>`** at `project-layout.tsx:20`, `session-page.tsx:67,125`, `agent-editor-page.tsx:103`, `skill-editor-page.tsx:44`. No spinner or skeleton exists |
| **Error / alert banner** | 24 sites, **5 visual treatments** | Inline `.error` text (5 files, identical); `<pre>` variant `recovery-panel:13`; boxed `.failure` `session-page:106`; **plain-text `.failure`** `recovery-panel:114` (same class name, different rendering); `.problem` `project-picker:44`; `.errorText` `transcript:205` |
| **Badge / status pill** | 5 definitions | All `border-radius: 999px`, **five different paddings, two font sizes**: `library:51`, `sessions:95`, `recovery-panel:43`, `transcript:106`, `project-status:3` |
| **Status dot** | 3 copies | `layout:142`, `project-status:14`, `session-page:60` — all `0.5rem` circles |
| **Form field group** | ~22 sites, **3 incompatible implementations** | Ark `Field` (6 sites); hand-rolled `div.field>label+input+hint` (11 sites in the library editors); flat label/input siblings, no wrapper (5 sites). `.field/.label/.input/.hint` redefined in 5 SCSS files |
| **Button row / toolbar** | 8 copies of one flex rule | `project-overview:35`, `recovery-panel:70`, `sessions:69`, `library:140`, `ssh-keys-page:76`, `create-project-form:115,94`, `confirm-dialog:40` |
| **Data table** | 2 copies of 30-line markup + 60-line SCSS | `library-page.tsx:26-57` ≈ `projects-table.tsx:93-124`; `library:23-62` ≈ `projects-table:3-64` |
| **Definition list** | 3 sites, 3 SCSS copies | `project-overview:23`, `sessions:30`, `transcript:177` |
| **Code / mono block** | 17 font-family declarations | Across 10 files, using two different stacks |
| **Uppercase eyebrow heading** | 3 identical rules + 4 near | `layout:85`, `project-picker:26`, `transcript:31,139,180,196` |
| **Link-styled button** | 3 copies | `recovery-panel:103`, `sessions:5` (**dead**), `library:141` |
| **Transient "saved" confirmation** | 3 hand-rolled timers | `copy-button.tsx:33` (1500ms), `project-library-page.tsx:50` (2000ms), `project-overview.tsx:55` (2000ms) |
| **Checkbox list row** | 2 sites | `project-library-page.tsx:79,107` |
| **Tooltip** | 3 sites, native `title=` only | `status-bar.tsx:60,66,78` |

Not present at all: avatars, dividers, pagination, skeletons, spinners.

---

## 3. Existing components

**Genuinely reusable (5 — the entire shared library, 213 lines):**
`Button`, `ConfirmDialog`, `ActionsMenu`, `CopyButton`, `Markdown` — all in `shared/ui/`.

**Reusable but stranded in feature folders (2):**
- `Collapsible` — `transcript.tsx:15-51`, a general disclosure primitive
- `ProjectStatusBadge` — `project-status.tsx`, a general status pill

**Near-duplicates of each other (4 pairs):**
- `library-page.tsx:24-59` `DataTable` ↔ `projects-table.tsx:93-124` — same table, twice
- `agent-editor-page.tsx` (309 ln) ↔ `skill-editor-page.tsx` (149 ln) — identical
  back-link / card / field / prompt / controls / ConfirmDialog scaffold
- `session-card.tsx` ↔ `ssh-key-card.tsx` — same article/head/meta/actions/dialog shape
- `SystemSidebar` ↔ `ProjectSidebar` (`sidebar.tsx:12` and `:52`) — identical structure
  over the same classes, differing only in link set

Internal duplication: `recovery-panel.tsx` has 3 near-identical option blocks;
`project-library-page.tsx` has 2 identical checkbox sections; `library-page.tsx` has 2
structurally identical table sections.

**One-off (≈26):** everything else under `app/` and `features/`.

Ratio: **5 shared primitives against ~26 one-offs.** Only `Button` has any styling API.

---

## 4. Ark UI: hand-rolled behaviour and inconsistent usage

Ark UI 5.39.1 is a dependency but is imported in **5 of 31 component files**.

### 4.1 Hand-rolled behaviour Ark already provides

| Site | Hand-rolled | Ark primitive |
|---|---|---|
| `transcript.tsx:15-51` | Full disclosure: `useState`, manual `aria-expanded`, manual chevron class, hard unmount | **Collapsible** |
| `tab-bar.tsx:15-97` | `role="tablist"`, **manual roving tabIndex**, **manual Arrow key handler**, no `aria-controls`, no `tabpanel` — a broken ARIA contract | **Tabs** |
| `create-project-form.tsx:77-90` | `<fieldset>` of `aria-pressed` buttons, no keyboard group semantics | **SegmentGroup** |
| `copy-button.tsx:13-43` | Clipboard write + `execCommand` fallback + `useState` + `setTimeout` | **Clipboard** (⚠ see below) |
| 10 sites | Native `<select>`, each styled by a *different* rule; two-line options and disabled options unstyleable | **Select** |
| 5 sites | Raw `<input type="checkbox">`, no focus-within, no checked styling | **Checkbox** / **CheckboxGroup** |
| `agent-editor-page.tsx:145-159` | Boolean mode rendered as a checkbox | **Switch** |
| `agent-editor-page.tsx:201`, `project-sessions.tsx:89` | `<input type="number">` with String↔Number juggling | **NumberInput** |
| `status-bar.tsx:60,66,78` | Native `title=` tooltips — no touch, unstyleable, keyboard-invisible | **Tooltip** |
| 3 sites | Three separate `useState` + `setTimeout` transient confirmations | **Toast** |
| 7 sites | Each re-declares dialog open state; 2 idioms for the same thing | **Dialog** uncontrolled / a `useConfirm()` hook |
| `project-status.module.scss:27` | `@keyframes pulse` as the only indeterminate-progress signal | **Progress** |

⚠ **`CopyButton` regression risk:** the `execCommand` fallback at `copy-button.tsx:22-31`
is documented in-source as the *usual* path on plain-HTTP tailnet origins. Ark's
Clipboard uses `navigator.clipboard` only. The fallback must be preserved.

**Already correct:** `Portal` is used properly in both overlay components. There is no
manual focus trap, outside-click handler or `createPortal` anywhere. The gap is
breadth, not depth.

### 4.2 Ark used but styled inconsistently

1. **`[data-invalid]` is styled in zero files** — verified: `invalid=` is set at
   `create-project-form.tsx:92,106,142` and `ssh-keys-page.tsx:48`, and `grep -c
   data-invalid` across all SCSS returns **0**. An invalid field keeps a neutral
   border; only the helper text changes. Highest-value single fix.
2. **`[data-state]` is styled in one file only** (`actions-menu:41`). The dialog has no
   open/closed transition and no `:focus-visible` reset, unlike the menu.
3. **Two ad-hoc elevation levels**: menu uses `$radius-sm` + `0 8px 24px/.24`; dialog
   uses `$radius` + `0 12px 32px/.28`.
4. **`Field` is skinned from *page* stylesheets**, not a shared one — `.input` is
   defined identically in `create-project-form.module.scss:30` and
   `ssh-keys-page.module.scss:32`, with a third hand-rolled copy at `library:88`.
5. **6 buttons bypass `Button` entirely** (`tab-bar.tsx:56,79,92`,
   `create-project-form.tsx:80`, `recovery-panel.tsx:107`, `transcript.tsx:35`,
   `projects-table.tsx:42`) and get none of its hover/disabled/focus styling.
6. **Two competing variant strategies**: `Button` takes `className`; `ConfirmDialog`
   invents a `destructive` boolean.

---

## 5. Inconsistencies worth flagging

**Styling API leaks — 19 sites.** `ConfirmDialog` pushes a class *into* `Button`
across module boundaries, so which background wins depends on stylesheet order
(`confirm-dialog.tsx:56`). `Collapsible` exposes **two** escape hatches, `className`
and `badgeClass` (`transcript.tsx:26,28`). **9 inline `style={{...}}` overrides**
(verified) at `router.tsx:151,152`, `recovery-panel.tsx:130`,
`project-overview.tsx:149`, `skill-editor-page.tsx:71,86`,
`agent-editor-page.tsx:213,229,239` — all of them spacing nudges, i.e. the missing
spacing scale leaking into JSX. `router.tsx`'s `NotFound` has no stylesheet at all.

**Cross-component stylesheet sharing.** `ssh-key-card.tsx` imports a *page's*
stylesheet; `session-card.tsx` likewise; 4 library pages share one
`library.module.scss`; 3 shell components share `layout.module.scss`. This has already
caused a collision — `library.module.scss:138` carries a comment recording that
`.row` "collided with the table-row class above and turned every `<tr>` into a flex
container."

**Dynamic class indexing.** `styles[state]` (`status-bar.tsx:41`) and
`styles[project.status]` (`project-status.tsx:10`) — untyped, invisible to dead-class
tooling, must be kept in lockstep with an API union by hand.

**25 sites** hand-join class names with template literals; no `cx()` helper exists.

**Two colours for one meaning.** `.error` is `var(--warn)` in 5 files but
`var(--danger)` in `session-page.module.scss:103`.

**Accessibility gaps.** 9 of 18 module files define no `:focus-visible` at all. The
transcript disclosure trigger (`transcript:49`), the composer textarea
(`session-page:81`), the source segmented control (`create-project-form:77`) and 4
form controls have **no visible keyboard focus**. Only 1 of 24 error renders is
announced (`session-page.tsx:119` `role="alert"`). `:disabled` is styled in 2 files
despite `disabled` being passed to many more.

**Dead code** (verified unreferenced): `projects-table.module.scss:66` `.empty`;
`sessions.module.scss` `.back`, `.notice`, `.projectHead`, `.projectName`;
`transcript.module.scss` `.promptPending`, `.text`; `ssh-keys-page.module.scss:29`
`.field`. Plus dead whitespace at `layout:93,115` and `transcript:147`.

**Dead import:** `global.scss:1` does `@use './variables' as v` and never references
`v`. `project-status.module.scss` imports `v` and uses zero variables.

---

## 6. Proposed token scales

Two tiers. Primitives (`--indigo-600`, `--space-4`) are referenced **only** inside the
two theme files. Component SCSS consumes semantic aliases (`--color-*`) exclusively;
the boundary is machine-enforced by stylelint (§6.9).

### 6.1 Accent — indigo-leaning, hue 233

A cyan-leaning blue in a dark-default app reads neon and competes with syntax-
highlighted agent output. Hue 233 sits ~20° off every stock framework blue (all
clustered at 211–217) while staying blue rather than violet, and saturation is held at
50–55% against their 90%+ — that is what makes it read as chosen.

`50 #F3F4FC` · `100 #E7E9F8` · `200 #CCD0F0` · `300 #A8AFE6` · `400 #848FDB` ·
`500 #616ED1` · `600 #4452C0` · `700 #3642A1` · `800 #2D367B` · `900 #252B5B` ·
`950 #181C39`

Not the banned blues: `#4452C0` is hue 233 / S 50%, against `#007AFF` (hue 211,
S 100%), `#3B82F6` (hue 217, S 91%), `#0D6EFD` (hue 217, S 94%) — lower green and
blue channels than all three, visibly desaturated beside any of them.

Light accent **600**; dark accent **400** (a 600-weight indigo on near-black is both
low-contrast and dense as a fill). Hover/active: light `600→700→800`, dark `400→300→500`.

### 6.2 Neutrals — warm, hue 40, S 6–12%

Apple's system gray is neutral-to-cool-violet; shifting warm is the one move that
reads as "not Apple" without going loud, and a warm neutral against a cool indigo
creates the temperature contrast that makes a single accent feel sufficient.

`0 #FFFFFF` · `50 #FBFAF9` · `100 #F6F5F3` · `200 #EDEBE8` · `300 #DDDAD5` ·
`400 #B4AFA7` · `500 #948F84` · `600 #6E695E` · `700 #5A564E` · `800 #3E3C37` ·
`850 #32302C` · `875 #282622` · `900 #201F1D` · `910 #1F1E1B` · `925 #171614` ·
`950 #0F0E0D` · `975 #0B0A09`

Fifteen-plus steps, over-sampled at the dark end on purpose: dark elevation lives
entirely in the 850–975 range and needs ~3% lightness steps.

> `--neutral-600` was corrected from the proposed `#787368` to **`#6E695E`** during
> review: `#787368` on `--color-surface` measures **4.33:1**, below the 4.5:1 floor,
> and muted text on a card is one of the most common pairs in the app. `#6E695E`
> measures 5.46 / 5.01 / 4.59 on white / surface / sunken.

### 6.3 Status hues — restrained, never a second accent

| | light bg / border / text | dark bg / border / text |
|---|---|---|
| success | `#EDF7F3` / `#B9DFCD` / `#1C6945` | `#0F241A` / `#19382A` / `#84CDAB` |
| warning | `#FAF4EA` / `#EBD4AD` / `#7E5816` | `#281D0C` / `#413116` / `#DDBA7E` |
| danger | `#FBF0EE` / `#EEC2BF` / `#922920` | `#2A100E` / `#471E1A` / `#E88F87` |

Solid fills: light `#359769` / `#B6832B` / `#C94236`; dark `#4FBB88` / `#D2A14B` / `#DE695E`.
No `info` hue — informational state uses the accent. One accent means one.

### 6.4 Type

```
--font-sans: 'InterVariable','Inter','IBM Plex Sans','Segoe UI Variable Text',
             'Segoe UI',Roboto,ui-sans-serif,system-ui,-apple-system,
             'Helvetica Neue',Arial,sans-serif
--font-mono: 'JetBrains Mono','IBM Plex Mono','Cascadia Mono','SF Mono',Menlo,
             Consolas,'DejaVu Sans Mono','Liberation Mono',ui-monospace,monospace
```

Inter leads for its 0.727em x-height and open apertures, and the least confusable
l/I/1 of any commonly installed grotesque. `-apple-system` sits near the *end* — SF Pro
is a last resort, not the identity. No webfont is added (no new dependencies).

| token | rem | px | line-height | tracking |
|---|---|---|---|---|
| `--text-2xs` | 0.6875 | 11 | 1rem | 0.01em |
| `--text-xs` | 0.75 | 12 | 1.125rem | 0.005em |
| `--text-sm` | 0.8125 | 13 | 1.25rem | 0 |
| **`--text-base`** | **0.875** | **14** | 1.375rem | 0 |
| `--text-md` | 1 | 16 | 1.625rem | -0.006em |
| `--text-lg` | 1.125 | 18 | 1.625rem | -0.01em |
| `--text-xl` | 1.375 | 22 | 1.875rem | -0.014em |
| `--text-2xl` | 1.75 | 28 | 2.25rem | -0.018em |
| `--text-3xl` | 2.25 | 36 | 2.625rem | -0.022em |

Line-heights are absolute rem so row heights stay predictable; `--leading-code: 1.55`
is the one unitless exception. `--tracking-caps: 0.06em` replaces the three competing
micro-label values. Body default **14px** — 16 is marketing spacing at this density,
13 is IDE. Rendered prose steps to `--text-md`. Weights: **400 / 500 / 600 only**.

### 6.5 Spacing — base 4px

`0` · `px 1px` · `1 4` · `2 8` · `3 12` · `4 16` · `5 20` · `6 24` · `8 32` ·
`10 40` · `12 48` · `16 64` (px).

Every existing Sass value maps exactly — `$space-sm→2`, `$space-md→3`, `$space-lg→5`,
`$space-xl→8`. Nothing is snapped. The ad-hoc values are: `0.15rem`→`1`,
`0.35rem`→`1` or `2` by role, `0.45rem`→`2`, `0.3rem`→`1`, `0.875rem`→`3`.

Density (moderate): control height **32px** default (28 / 36 for sm / lg), inline
padding `--space-3`; card padding `--space-5`; page padding `--space-8 --space-6`.

### 6.6 Radii

`sm 6px` badges/chips/checkboxes · **`md 9px` all form controls, all sizes** ·
`lg 12px` cards/menus/popovers · `xl 16px` dialogs · `2xl 20px` feature panels ·
`full 9999px` avatars/dots/count pills — never a form control.

No 2–4px step exists in the scale, so it cannot be reached by accident. 9px is ~28% of
a 32px control: 8 reads mechanical at small sizes, 10 reads consumer-soft at 28px.
Radii scale by *element class*, not instance size — a row mixing sm and md buttons
with different radii looks broken.

### 6.7 Elevation — 4 planes

Light shadows use warm `rgb(32 31 29 / …)`, not black (pure black under warm neutrals
goes grey-blue):

```
--shadow-xs: 0 1px 2px rgb(32 31 29 / 5%)
--shadow-sm: 0 1px 2px rgb(32 31 29 / 4%), 0 2px 6px rgb(32 31 29 / 5%)
--shadow-md: 0 2px 4px rgb(32 31 29 / 4%), 0 6px 16px rgb(32 31 29 / 7%)
--shadow-lg: 0 4px 8px rgb(32 31 29 / 5%), 0 16px 32px rgb(32 31 29 / 10%)
```

**Dark elevation is surface lightening, not shadow** — `xs`/`sm` are `none`, because a
drop shadow on near-black separates nothing:

```
sunken #0B0A09 (L 4.0%) → page #0F0E0D (5.5) → surface #171614 (8.5)
                        → raised #1F1E1B (11.5) → overlay #282622 (14.5)
```

3-point steps: the smallest reliably perceptible separation at these lightnesses, the
largest that still reads as one material. Dark borders sit one plane-step above their
surface, so a border is a seam, not an outline. Floating dark layers get
`0 4px 12px rgb(0 0 0 / 40%)` plus a 4% inset top highlight to define the upper edge.

### 6.8 Motion, z-index, breakpoints

`--dur-fast 120ms` (colour/opacity) · `--dur-base 160ms` (disclosure, tabs) ·
`--dur-slow 200ms` (overlays) · `--dur-progress 900ms` — the only value outside the
120–200ms band, and it is a loop period, not a transition.

`--ease-out cubic-bezier(.22,.61,.36,1)` default · `--ease-in (.55,.06,.68,.19)` exits
· `--ease-in-out (.65,0,.35,1)` · `--ease-linear`. No overshoot curves: a spring is
decorative by definition.

`prefers-reduced-motion` collapses all duration tokens to `0.01ms` and hard-stops
animations globally, with **no whitelist**. Consequence, stated as a component
contract: anything communicating ongoing state through animation must also
communicate it statically.

Z-index: `base 0` · `raised 10` · `sticky 100` · `dropdown 1000` · `overlay 1100` ·
`modal 1200` · `toast 1300` · `tooltip 1400`.

Breakpoints stay in Sass — media queries cannot read custom properties. This is the
one thing that is not a CSS variable: `sm 40rem` (existing), `md 56rem`, `lg 72rem`,
`xl 90rem`, consumed as `@include bp.up(md)` / `@include bp.below(sm)`.

### 6.9 Enforcement

`stylelint` 16.26.0 + `stylelint-config-standard-scss` 17.0.0 (installed, exact-pinned).
Base config for all SCSS; strict rules in an `overrides` block scoped to
`src/**/*.module.scss`, so the token files are exempt *by construction* rather than by
a drift-prone ignore list.

The strict block rejects, in module files only: any hex or colour function
(`color-no-hex`, `function-disallowed-list`), **any reference to a primitive token**
(`var(--indigo-|--neutral-|--green-|--amber-|--red-)`) — the rule that makes the
two-tier boundary real — raw px outside `{0, 1px, 2px}` on borders and outlines only,
non-token `font-family` / `font-weight` / `box-shadow` / `z-index`, and any literal
duration or easing keyword.

Raw px is confined to hairlines and focus rings because those are device-pixel
concerns: a 1px border in rem scales with root font size and goes blurry. Everything
participating in layout rhythm must be a token.

---

## 7. Migration order (Phase 4), by surface area

| # | Area | tsx + scss |
|---|---|---|
| 1 | Session page + transcript | 364 + 334 = **698** |
| 2 | App shell (tab bar, sidebars, status bar) | 334 + 311 = **645** |
| 3 | New-tab picker + create form + projects table | 400 + 246 = **646** |
| 4 | Project overview + recovery panel | 371 + 206 = **577** |
| 5 | Library pages (4 files, one shared stylesheet) | 890 + 169 = **1059** |
| 6 | Sessions list + session card | 230 + 130 = **360** |
| 7 | SSH keys page + card | 184 + 116 = **300** |
| 8 | Settings | 68 + 67 = **135** |
| 9 | 404 | 9 + 0 |

Shared stylesheets force grouping: `library.module.scss` is co-owned by 4 pages,
`sessions.module.scss` by 2, `layout.module.scss` by 3. Each group migrates as one
unit or the shared sheet fights the migration.
