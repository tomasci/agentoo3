# frontend

React SPA, built with Vite and run by Bun. The projects page is real; sessions
come next.

## Stack

| Concern | Choice |
|---|---|
| UI | React 19, Ark UI primitives (unstyled) |
| Build | Vite 8, Bun as runtime and package manager |
| Styling | SCSS modules + CSS custom properties for theming |
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
bun run codegen     # kubb: regenerate the API client from the committed spec
bun run hooks       # install lefthook git hooks
```

## Structure

```
src/
  app/                 router, root layout, providers
  features/            one directory per feature, self-contained
    projects/          hooks/ components/ model/ lib/ index.ts
    health/            hooks/ components/ index.ts
  shared/
    api/               client config + generated/ (kubb output, committed)
    config/            parsed env
    i18n/              i18next setup + locales (en, ru)
    lib/               logger
    store/             jotai atoms
    ui/                styled Ark primitives
  styles/              global.scss + variables
```

A feature owns its own `api/`, `model/`, `hooks/` and `components/`, and exposes
a single `index.ts`. Import across features through that barrel, never by
reaching into another feature's internals. Anything genuinely shared moves to
`shared/`.

## Layout

An IDE-style shell rather than a centred column:

```
┌──────────┬───────────────────────┐
│ sidebar  │ page body (scrolls)   │
│  logo    │                       │
│  nav     │                       │
│  lang/   │                       │
│  theme   │                       │
├──────────┴───────────────────────┤
│ status bar                       │
└──────────────────────────────────┘
```

One CSS grid owns the viewport (`height: 100dvh`), so only the body scrolls and
the sidebar and status bar stay put **without `position: fixed`** — which avoids
the overlap and scroll-locking bugs fixed positioning brings. Language and theme
sit at the foot of the sidebar because they are preferences, not navigation.

The status bar answers "is this working": backend reachable, whether a Claude
credential is present, project and key counts, version. A reader should not have
to open a page to discover the backend is down.

Pages are full width. Card lists use `auto-fill` with a minimum track, so they
fill a wide monitor in columns instead of stretching one card across it.

Below 40rem the sidebar becomes a strip across the top rather than eating half
the width.

## Routing

TanStack Router, defined in code rather than by file convention
(`src/app/router.tsx`):

| URL | Page |
|---|---|
| `/` | redirects to `/projects` |
| `/projects` | project list |
| `/projects/$projectId` | one project and its sessions |
| `/ssh-keys` | SSH keys |

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

The installer does this for you: step `backend` renders the spec, step
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
