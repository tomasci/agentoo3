# frontend

React SPA, built with Vite and run by Bun. The projects page is real; sessions
come next.

## Stack

| Concern | Choice |
|---|---|
| UI | React 19, shadcn/ui (style `base-nova`) on Base UI primitives, default neutral theme |
| Markdown editing | CodeMirror 6, with a repo-owned Obsidian-style live-preview layer (`shared/lib/markdown-live-preview.ts`) — the session composer's visual mode and `shared/components/markdown-field.tsx`'s (the library's agent prompt, skill body, and system prompt editors); see "Styling" below, and that file's own comment for why not a rich-text editor |
| Build | Vite 8, Bun as runtime and package manager |
| Styling | Tailwind v4 (`@tailwindcss/vite`) + shadcn's own generated CSS variables — see "Styling" below |
| Icons | lucide-react |
| Font | Geist Variable (`@fontsource-variable/geist`), includes Cyrillic for the Russian locale |
| Server state | TanStack Query + axios |
| Client state | Jotai |
| Forms | React Hook Form + Zod (via `@hookform/resolvers`) |
| i18n | i18next + react-i18next, English and Russian |
| Logging | consola |
| Lint/format | Biome |
| Hooks | Lefthook (config at the repo root) |
| API codegen | Kubb (OpenAPI → types, Zod schemas, Query hooks) |
| Types | TypeScript 7 |

Versions are pinned exactly in `package.json` — no ranges, no `latest`.
`bun.lock` is committed, and the installer uses `--frozen-lockfile`.

## Commands

```
bun run dev         # Vite dev server, proxies /api to the backend
bun run build       # tsc --noEmit && vite build  -> dist/
bun run start       # serve dist/ with Bun (what the service runs)
bun run typecheck
bun run lint        # biome check
bun run lint:fix
bun run codegen     # kubb: regenerate the API client from backend/openapi.json
bun run hooks       # install lefthook git hooks
```

## Structure

```
src/
  app/                 router, root layout, shell chrome (sidebar, tab bar, status bar)
  features/            one directory per feature, self-contained
    appearance/  docker/  editor/  health/  ideas/  library/  projects/
    sessions/  settings/  ssh-keys/  storage/  system/  whats-new/
  shared/
    api/               client config + generated/ (kubb output, git-ignored)
    components/        hand-written app compositions, one barrel
    config/            parsed env
    hooks/             use-mobile.ts
    i18n/              i18next setup + locales (en, ru)
    lib/               utils.ts (shadcn's `cn`), number-input.ts, logger.ts
    store/             jotai atoms (theme, sidebar, tabs)
    ui/                generated shadcn components
  styles/              globals.css — shadcn's own generated theme, nothing else
```

A feature owns its own `api/`, `model/`, `hooks/` and `components/`, and exposes
a single `index.ts`. Import across features through that barrel, never by
reaching into another feature's internals. Anything genuinely shared moves to
`shared/`.

`shared/ui` and `shared/components` are a deliberate two-layer split, not one
folder that grew a subfolder. `ui/` is shadcn's own output — one file per
component (`src/shared/ui/button.tsx`, imported as `@/shared/ui/button`), no
barrel, regenerated with `npx shadcn@latest add` and never hand-edited (see
"Styling" below). `components/` is everything hand-written on top of it —
`StatusDot`/`Tone` (its root span also carries `data-fixed-tone`, so the
reader's chosen accent colour never touches its success/warning/danger dots —
see "Styling" below), `StatusBadge`, `Loading`, `ConfirmDialog`, `ActionsMenu`,
`DataTable`, `Code`, `CopyButton`, `Markdown`, `DefinitionList`, `PageHeader`,
a `toast` re-export — with the one barrel a feature actually imports through
(`@/shared/components`). Dependency direction is one-way: features →
`shared/components` → `shared/ui` → `@base-ui/react`.

### Adding a changelog entry

Two Markdown files at the **repo root** — `CHANGELOG.md` (English) and
`CHANGELOG.ru.md` (Russian), kept in step — drive the "What's new" screen (an
operator sees it full-screen right after an update, and can reopen it from the
version number in the status bar). Readable on GitHub by design, not just
inside the app. When a commit ships something user-visible, add a release at
the **top** of both files, with the version that commit will produce — the
pre-commit hook bumps `version.json`'s build by one per commit, so check it
rather than guessing:

```
## 1.2.150 — 2026-10-02

### New
- One line, present tense, what the operator can now do.

### Improved
- One line about something that already existed.

### Fixed
- One line naming the problem that's gone.
```

The heading is `## <major.minor.build> — <date>` (`YYYY-MM-DD`; a hyphen, en
dash or em dash all work as the separator). Each kind section — `New` /
`Improved` / `Fixed` in English, `Новое` / `Улучшено` / `Исправлено` in
Russian — appears **at most once**, in that order, and only if it has
entries; 1–4 short one-liners per release is plenty. Anything above the first
`## ` heading (the title, the one-paragraph intro, the link to the other
language) is free-form and ignored by the parser.

Both files are parsed and merged by `features/whats-new/model/
changelog-markdown.ts` — a small, dependency-free parser, not a Markdown
library, because `vite.config.ts` needs to run it at config-load time, before
a `@/...` alias would even resolve — into the shape `features/whats-new/model/
changelog.schema.ts` validates with zod, the same "fail loudly rather than
render a blank line" rule the old hand-edited JSON had. `vite.config.ts`
`define`s the result as `__CHANGELOG__`, so **the build fails** (with a
message naming the file, line, and what's wrong) on a malformed heading, a
bullet outside a kind section, or the two languages disagreeing on versions,
dates, kinds or how many changes a kind has — keeping both files in step is
enforced, not just asked for. The version at the top of both files has to be
the one **this commit** will actually produce once the hook bumps the build
number, not the one already in `version.json` when you start editing.

`bun test` never runs Vite, so `tests/setup.ts` parses the same two files the
same way and seeds `globalThis.__CHANGELOG__` itself, before any test can
import `model/changelog.ts` — component tests render the real changelog, not
a fixture. `vite dev` also can't pick up an edit to either file on its own
(`define` is fixed at config-load time); a small inline plugin in
`vite.config.ts` watches both and calls `server.restart()` when either
changes, which re-reads and re-parses them from scratch.

## Styling

The operator's decision for this app is to use shadcn's default components and
not restyle them. `src/styles/globals.css` is exactly what `shadcn init`
generated for the `base-nova` style on the `neutral` base colour — there is no
hand-authored token layer sitting on top of it, and there is not meant to be
one. The rule that keeps it that way:

- Reach for a shadcn component first. Only fall back to a bare element plus
  Tailwind utilities when there genuinely isn't one for the job.
- When you do reach for utilities, stay on Tailwind's default scale and
  shadcn's semantic colours only: `bg-background|card|muted|accent|primary|
  secondary|destructive|sidebar`, `text-foreground|muted-foreground|primary|
  destructive`, `border`, `border-input`, `ring-ring` — opacity modifiers
  (`/50` and so on) are fine. No Tailwind palette classes (`bg-blue-500`,
  `text-red-600`, …) anywhere except `StatusDot`'s success/warning dots
  (`shared/components/status-dot.tsx`), which carry a meaning none of the
  semantic tokens do. No `dark:` variant anywhere else — every case that
  matters is already a semantic token swapping under `.dark`. No hex, rgb or
  oklch literals, no new CSS custom properties, no new CSS files. No inline
  `style` except a value actually computed at runtime (a measured height, a
  live percentage); anything static belongs in a class.
- Class strings have to be literal. Tailwind's scanner reads source text, not
  runtime values, so a template like `` `bg-${tone}-500` `` compiles to
  nothing at build time.
- `className` on a shadcn component is for layout — spacing, width, a grid
  placement — not for recreating a look the component already exposes an API
  for (a `variant`, a `size`). The status bar's host-load bars are a
  deliberate exception of the same kind `StatusDot` is: `HostMetric`
  (`app/status-bar.tsx`) reaches through a `**:data-[slot=progress-indicator]:`
  descendant selector to mute `Progress`'s default `bg-primary` indicator and
  drops the label's `text-destructive` at high usage, because the operator
  judged the shipped look too attention-grabbing for a strip that live-updates
  constantly.
- `features/appearance/lib/catalog.ts` is the other exception of that kind,
  and the only file beyond `StatusDot` allowed OKLCH literals and the `dark:`
  variant: custom backgrounds let a reader pick a named hue (mint, brown,
  sunset, …) the shadcn tokens have no room for, and Tailwind's own palette
  swings too wildly in lightness/chroma between hues at any one step to stand
  in for one consistent tint. The catalog spends the same lightness/chroma
  budget per theme on every hue, switching `dark:` only because the operator
  wants a visibly different, independently-tuned tint per theme rather than
  one colour read through an opacity change — not because this app's `dark:`
  rule has loosened. It stays inside that one file: `app/root-layout.tsx` and
  `features/settings` only ever reach the catalog's literal class strings
  through `features/appearance`'s own components and barrel, never by writing
  a colour literal of their own. The same file also carries `HIGHLIGHT_TINT_CLASS_NAME`/
  `HIGHLIGHT_TINT_ALIAS_CLASS_NAME`, which re-point `--accent`, `--muted`,
  `--secondary` and `--sidebar-accent` — four tokens `globals.css` already
  ships equal to each other — as classes on `document.body` rather than
  adding any new CSS property, inline `style`, or `globals.css` edit, and
  `ACCENT_COLOR_CLASS_NAME`, which re-points `--primary` the same way for the
  reader's independently-chosen accent colour; see the "Layout" section below
  for what both buy. `--primary` also backs a handful of *closed* meaning
  scales that must never follow that accent — `StatusDot`'s tones and
  `SuggestionDiff`'s add/remove lines (`features/library/components/
  suggestion-diff.tsx`) — so each of those carries a `data-fixed-tone`
  attribute on its own root element; `ACCENT_COLOR_FIXED_TONE_CLASS_NAME`
  scopes `--primary` back to `var(--foreground)` for exactly `[data-fixed-tone]`
  and `Progress`'s own `[data-slot=progress-indicator]`, close enough to the
  unmodified token (see the catalog's own header comment for the exact
  numbers) to be indistinguishable, and only in effect while an accent is
  actually chosen. Any future subtree whose colour is itself the information,
  not decoration, carries the same attribute rather than being special-cased
  by name.
- A link that should look like a button is
  `<Link className={buttonVariants({ variant: … })}>`, not
  `<Button render={<a/>}>`: Base UI logs an error and stamps `role="button"`
  on the anchor if you try the latter (see `app/router.tsx`,
  `features/sessions/components/session-page.tsx`).
- A scroll container whose position is driven by code — the session
  transcript, a log console — stays a plain `overflow-y-auto` div, never
  `ScrollArea`: code that reads or writes `scrollTop` needs an element that is
  actually the one scrolling.
- The idea canvas is the one deliberate exception with a stylesheet of its
  own: it keeps `@xyflow/react/dist/base.css` and maps React Flow's `--xy-*`
  variables onto the shadcn variables with arbitrary-property classes
  (`features/ideas/canvas/idea-flow-canvas.tsx`), so the canvas follows
  `.dark` with no second light/dark signal of its own.
- The markdown editor (`shared/components/markdown-editor.tsx`) is a
  different kind of exception — it adds no stylesheet of its own, but
  CodeMirror injects its own base one at runtime as a plain, unlayered
  `<style>` tag, while Tailwind v4 wraps every utility in `@layer utilities`;
  an unlayered rule beats a layered one regardless of source order or
  specificity, so anything CM sets (its monospace `.cm-scroller` font, the
  padding baked into `.cm-content`/`.cm-line`, its own focus outline) has to
  be overridden with Tailwind's `!` modifier to win at all, from a wrapper
  `className` — still literal utility classes, still following `.dark`, never
  a colour literal. The live-preview layer built on top
  (`shared/lib/markdown-live-preview.ts`) follows the same semantic-colour
  rule as everywhere else in its own decoration classes, which live as
  literal strings in that file rather than here, since Tailwind's scanner
  never sees a class name assembled at runtime. `shared/components/
  markdown-field.tsx` wraps this same editor for a whole markdown *document*
  rather than a chat-sized box — the library's agent prompt, skill body, and
  system prompt fields — behind a border meant to look like the `Textarea`
  it replaces (`rounded-lg border border-input`, focus shown with
  `focus-within` since the actual focusable control is CodeMirror's
  contenteditable a layer inside it) rather than `InputGroup`'s own framing.

### Adding a shadcn component

```
cd frontend
npx shadcn@latest add <name>
```

It reads `components.json`'s aliases and writes `src/shared/ui/<name>.tsx`.
Don't hand-edit the result — a later `add` (or anyone re-running it to pick up
an upstream fix) silently overwrites whatever was changed by hand. If a
component needs behaviour shadcn didn't ship, wrap it in
`src/shared/components/` instead, the way `ConfirmDialog` wraps `AlertDialog`.

`bunfig.toml`'s `[install] exact = true` makes bun's own install step pin
anything the command adds to `package.json` exactly, the same as every other
dependency here — but the command isn't guaranteed to only touch versions
through that path. Check `package.json`/`bun.lock` after adding a component,
the way you would after any dependency change, and pin by hand anything that
landed with a `^` or `~`.

### A known i18n gap

A handful of strings inside the generated components are hard-coded in
English rather than run through i18next: the sidebar's phone `Sheet` carries
a screen-reader-only title ("Sidebar") and a screen-reader-only close label
("Close"), and the toast close button has an English `aria-label` ("Close
toast"). None of them are visible in the sighted UI, which is how they were
missed rather than translated — but they still reach a Russian screen-reader
user. Fixing them means editing generated files, which the rule above rules
out; it wants a real answer (a thin wrapper around the affected part, or a
patch step after `add`) rather than an edit to `ui/sheet.tsx` or `ui/toast.tsx`
that the next regeneration would quietly undo.

## Layout

An IDE-style shell rather than a centred column: a row of open tabs across the
top, that tab's own navigation down the side, one working area, and a status
strip along the bottom.

```
┌──────────────────────────────────────────────┐
│ tab bar        System │ my-project │ …  [+]   │
├───────────┬────────────────────────────────────┤
│  sidebar  │ page body — its own surface,        │
│(offcanvas,│ scrolls; full width on an empty tab,│
│ per tab)  │ full-bleed on a session's own page  │
├───────────┴────────────────────────────────────┤
│ status bar                                      │
└──────────────────────────────────────────────────┘
```

`SidebarProvider` owns the whole thing as one column — the tab bar, then a
`relative` row holding the sidebar and the page body, then the status bar —
sized to `--shell-height` rather than `100dvh`. `100dvh` is computed from the
*layout* viewport, which iOS never shrinks for its own on-screen keyboard;
`app/use-visual-viewport.ts` publishes `--shell-height` from the *visual*
viewport instead, only while a keyboard (not a pinch-zoom, not an Android URL
bar) is actually open, and removes the property the rest of the time so every
other case falls through to the stylesheet's own `100dvh`. Safe-area insets
are padding on that same column, not a second wrapper around it.

Inside the row, the sidebar (`Sidebar variant="inset" collapsible="offcanvas"`)
is pulled `absolute h-auto`, overriding shadcn's own `fixed h-svh` on the same
element — without that, the sidebar would pin itself to the whole browser
viewport, on top of the tab bar and the status bar, instead of resolving
against the row it actually belongs in.

The sidebar, the tab bar and the status bar are drawn as one continuous
surface, not three pieces of chrome: the `inset` sidebar variant turns the
whole wrapper `bg-sidebar`, and the tab bar and status bar are plain siblings
of that row with no background or border of their own. The page body
(`SidebarInset`) is the only thing that stands off that surface — its own
`bg-background`, rounded corners, a small shadow, a gap on every side — and it
is the only thing that scrolls.

That surface can carry a reader's own chosen backdrop: a colour, a gradient or
an icon pattern (`features/appearance`), picked on `/settings` and persisted
per browser (`localStorage['agentoo:background']`,
`localStorage['agentoo:background-pattern']`), the same way the theme is.
`Shell` paints it as an `absolute inset-0 -z-10` layer behind everything else
in the row, so it shows through the tab bar strip, the sidebar area and the
status bar strip, including the safe-area padding around them. While one is
active, the sidebar's own opaque surface turns transparent so the backdrop
shows through it too, and `SidebarInset` turns to frosted glass — a
translucent `bg-background` plus a backdrop blur — instead of its ordinary
opaque one. Neither change happens at all when no backdrop is chosen: no
backdrop element is rendered, the sidebar keeps its ordinary opaque surface,
and `SidebarInset` keeps its ordinary background. The wrapper's own `relative
isolate` (what lets that `absolute inset-0 -z-10` layer resolve against the
shell rather than escape it) is there unconditionally, backdrop or not, but
is inert on its own. The same condition also puts a small glass pill — one
shared `GLASS_CLASS_NAME` recipe, read everywhere through
`features/appearance`'s own `useBackdropActive()` — around the tab row,
around each sidebar nav list, and around the project sidebar's footer menu,
never the whole tab bar or the whole sidebar. A chosen colour or gradient
(not a pattern on its own — `backgroundAtom` has to be something other than
`'none'`) carries one step further: `useHighlightTint()`, mounted next to
`useBackdropActive()` in `Shell`, tints every hover, selected and open
highlight in the app — tabs, sidebar nav, dropdown menu items, table rows,
ghost/outline buttons — to that same hue, so the chrome a reader just
recoloured doesn't go back to plain grey the moment they interact with it.

A reader can separately choose an **accent colour** — the same 18 options as
the background, but its own choice and its own key
(`localStorage['agentoo:accent-color']`): matching the background is up to
the reader, the two atoms never read off each other. `useAccentColor()`,
mounted in `RootLayout` itself rather than `Shell` — reader-wide like the
theme, not scoped to the workspace shell, since the bare-shell editor
launcher's own buttons are calls to attention too — re-points `--primary` to
the chosen hue, which is what every primary `Button`, `text-primary` link and
checked `Checkbox`/`Switch` already reads. It deliberately leaves untouched:
status dots, progress meters and diff lines (each a closed meaning scale,
marked `data-fixed-tone` or caught by `Progress`'s own slot — see "Styling"
above) and every focus ring (`--ring` is never re-pointed), so those look
exactly the same regardless of what a reader picks. `'none'`, the default,
changes nothing at all.

An empty tab (the project picker) has nothing to navigate yet, so its sidebar
is forced closed and empty and the body takes the full width. A session's own
page is full-bleed instead: its body has no padding, and the page draws its
own scrolling transcript and composer edge to edge. The editor launcher
(`features/editor`) skips all of this — no tab bar, no sidebar, no status
bar — because it opens in its own browser tab, not inside the workspace.

Below `md` (768px), the sidebar becomes shadcn's `Sheet`, opened by a
`SidebarTrigger` in the tab bar and closed again on every navigation, so a tap
on a nav link never leaves the drawer sitting open over the page it just
opened. The tab row itself gives way to `TabSwitcher`, a dropdown naming the
active tab — a row that scrolls sideways past a twentieth open project is
worse than a menu, on a screen too narrow for either shape to show every tab
at once. Whether the sidebar is open persists per browser
(`sidebarOpenAtom`, localStorage `agentoo:sidebar-open`), the same as the
theme.

### Tables and dialogs

The project list is a TanStack Table — **v8, not the v9 on `@latest`**. v9 is a
feature-based rewrite whose typed setup wants `createTableHook` boilerplate and
explicit feature declarations to get `getVisibleCells`; for a three-column list
that is ceremony without payoff, and v8 is what every piece of documentation
still describes. shadcn's own dashboard-01 demo ships a table built for v9's
shape; it was deliberately not pulled in for the same reason, and `DataTable`
(`shared/components/data-table.tsx`) wraps a plain v8 instance in shadcn's
`ui/table` parts instead. Revisit when v9 settles.

Destructive actions use `ConfirmDialog`, built on shadcn's `AlertDialog`, not
`window.confirm`. `window.confirm` blocks the page, cannot format the name of
the thing being deleted, is unstyleable, and — the part that matters —
browsers let a user suppress it, which silently turns "are you sure" into
"yes".

### The open project

Opening a project puts it in its own tab, and it stays open as you move
around — the tab row is the workspace, the way a file manager's tab row is,
rather than a page you visited and left. That tab's sidebar shows its
project-scoped navigation; the permanent system tab (library, SSH keys,
configuration) gets the installation's navigation instead.

Each project tab remembers only the project's **id**, never the project
itself, so a rename or a status change is picked up for free — a tab's label
is read live off the project list, not copied at the moment it was opened. A
tab pointing at a project that no longer exists closes itself, but only once
the project list has actually loaded — a slow request must not be read as
"gone" and drop the tab early. Only a **ready** project can be opened from the
picker: one still cloning has no checkout to work in yet.

Language and theme are no longer a corner of the sidebar — they live on
`/settings`, in the system tab, as two `Select`s: a project tab has no
business changing the language of the whole app.

The status bar answers "is this working": backend reachable, whether a Claude
credential is present, host CPU/memory/disk load, and the running version. It
says nothing about which project is open — the tab row already answers that,
and repeating it here would just be a second, slower answer to the same
question. It also says nothing about SSH keys — the system sidebar already
links to `/ssh-keys`, and a count here would just be a second, slower answer
to the same question. A reader should not have to open a page to discover the
backend is down.

Pages are full width. Card lists use `auto-fill` with a minimum track, so they
fill a wide monitor in columns instead of stretching one card across it.

## Routing

TanStack Router, defined in code rather than by file convention
(`src/app/router.tsx`):

| URL | Page |
|---|---|
| `/` | redirects to `/sessions` |
| `/sessions` | Sessions dashboard: running, unchecked and recent, across every project — the System tab's default page |
| `/projects` | project list |
| `/projects/$projectId` | redirects to `/projects/$projectId/sessions` |
| `/projects/$projectId/sessions` | that project's sessions |
| `/projects/$projectId/settings` | project settings: details, SSH key, retry, delete |
| `/ssh-keys` | SSH keys |

`/sessions` (`features/sessions/components/sessions-dashboard-page.tsx`) is
three lists, not one: **Running** (status `running` or `queued`, right now,
across every project), **Unchecked results** (a turn settled since the
operator last opened that session — the backend's own `unchecked` flag on the
Session DTO), and **Recent** (any activity within a 1d/3d/7d window, switched
with a `ToggleGroup`, and free to repeat a session already listed above it —
that overlap is the backend's own contract, not a bug here). A session drops
out of Unchecked the moment the operator actually opens it while the tab is
visible: `SessionPage` posts `/sessions/{id}/seen` itself the instant a loaded
session reads `unchecked: true` while `document.visibilityState === 'visible'`,
and again on `visibilitychange` if the turn settled while the tab was hidden
behind another — never on a click of the operator's own, since checking a
result is something reading the page already does.

Code-based rather than file-based because file-based needs a Vite plugin and a
generated `routeTree.gen.ts`, and this project already generates its API client
at install time — one codegen step is enough.

Every page has a real URL, so deep links and the back button work. That puts a
requirement on the server: `server.ts` returns the SPA shell for unknown *routes*
but a genuine 404 for unknown *assets*, since answering a `.js` request with HTML
makes the browser report a MIME type error instead of the missing file.

## The API client is generated, not committed

`src/shared/api/generated/` is kubb's output from `backend/openapi.json`.
**Neither is committed.** Both are produced during installation, from the backend
source on that machine, so the client always matches the backend actually
running there — a snapshot taken on someone's laptop can silently disagree with
what is deployed.

That means a fresh checkout does not typecheck or build until you generate:

```
cd backend  && bun run openapi     # render openapi.json from the Hono app
cd frontend && bun run codegen     # types, zod schemas, query hooks, clients
bun run build
```

You rarely have to. `scripts/gen-api-client.sh` does both steps in order, and
the git hooks call it: `pre-push` unconditionally, `pre-commit` only when a
checkout has no client at all. That matters because every session runs on its
own fresh worktree, so every session starts without one.

The installer does the same two steps: step `backend` renders the spec, step
`frontend` generates against it. That is why `backend` runs first.

Generated code is excluded from Biome, and `noUnusedLocals` is deliberately off
in `tsconfig.json`: kubb emits unused type aliases, and tsc checks imported files
whether or not they are in `include`, so that flag would fail the build on code
we do not own. Biome's `noUnusedVariables` still covers our own source, and it
*can* exclude a directory.

Feature hooks wrap the generated ones rather than calling them from components —
`useProjects()` reads better than `useGetApiProjects()`, and it is where the
polling and cache-invalidation policy lives.

## Production

`bun run build` emits `dist/`, and `server.ts` serves it — not `vite preview`,
which Vite explicitly says is not a production server. The Bun server does three
things `preview` does not guarantee: correct SPA fallback, `immutable` caching
for fingerprinted assets with `no-cache` on `index.html`, and it refuses paths
that escape the document root.

nginx proxies `/` to it on `FRONTEND_PORT`, and `/api/` to the backend.
