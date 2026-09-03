---
name: project-conventions
description: How this project is laid out and what the commands are. Read before making changes so edits match the surrounding code.
---

# Project conventions

Agents are written to be reusable and arrive knowing nothing about where they
have landed, so this is where a project describes itself: layout, commands, and
the handful of rules that are not obvious from reading one file. This copy
describes *this* repository — assign it to this project only, and write another
for the next one rather than stretching this one to fit.

## Layout

- `frontend/` — React + Vite, run by Bun. Features under `src/features/<name>/`,
  each owning its `api/`, `model/`, `hooks/` and `components/`, exposed through
  one `index.ts`. Cross-feature code lives in `src/shared/`.
- `backend/` — Hono API plus a separate worker process. Same feature layout.
- `scripts/` — installer steps, numbered and idempotent.

## Commands

Both `frontend/` and `backend/`:

```
bun run typecheck
bun run lint          # biome
bun run lint:fix
bun test tests/       # what pre-push runs
```

`frontend/`: `bun run build`. `backend/`: `bun run db:generate` after a schema
change, `bun run db:migrate` to apply.

## Conventions that matter

- Exact dependency versions, no ranges. Lockfiles are committed.
- Validate at the boundary with Zod and parse rather than cast, so a shape
  change fails where it happens instead of three layers deeper.
- Comments explain *why*, not *what*.
