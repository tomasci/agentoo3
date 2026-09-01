# frontend

React SPA, built with Vite and run by Bun. Currently a placeholder: the stack is
wired end to end, the app itself is two small features.

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
bun run codegen     # kubb generate (needs a backend OpenAPI spec)
bun run hooks       # install lefthook git hooks
```

## Structure

```
src/
  app/                 shell: providers, root component
  features/            one directory per feature, self-contained
    status/            api/ model/ hooks/ components/ index.ts
    greeting/          model/ components/ index.ts
  shared/              cross-feature only
    api/               axios instance (+ generated/ from kubb)
    config/            parsed env
    i18n/              i18next setup + locales
    lib/               logger
    store/             jotai atoms
    ui/                styled Ark primitives
  styles/              global.scss + variables
```

A feature owns its own `api/`, `model/`, `hooks/` and `components/`, and exposes
a single `index.ts`. Import across features through that barrel, never by
reaching into another feature's internals. Anything genuinely shared moves to
`shared/`.

## Production

`bun run build` emits `dist/`, and `server.ts` serves it — not `vite preview`,
which Vite explicitly says is not a production server. The Bun server does three
things `preview` does not guarantee: correct SPA fallback, `immutable` caching
for fingerprinted assets with `no-cache` on `index.html`, and it refuses paths
that escape the document root.

nginx proxies `/` to it on `FRONTEND_PORT`, and `/api/` to the backend.
