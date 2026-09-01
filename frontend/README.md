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
  app/                 shell: providers, root component
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
