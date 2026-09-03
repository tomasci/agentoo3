#!/usr/bin/env bash
# Render the OpenAPI document from the backend, then generate the frontend's
# typed client from it.
#
# Both outputs are deliberately git-ignored (see backend/.gitignore and
# frontend/.gitignore): a client snapshot committed from one developer's
# checkout can silently disagree with the backend actually running. The cost of
# that choice is that any checkout which has not been through install.sh has no
# generated/ at all — and `tsc`, `vite build` and the frontend tests all fail
# with a wall of "Cannot find module @/shared/api/generated/...".
#
# A fresh checkout is not the rare case here. Every session gets its own git
# worktree, so every session starts without generated/. This script is what the
# hooks run to close that gap, and it is the same two commands the installer
# uses in scripts/68-setup-backend.sh and scripts/70-setup-frontend.sh.
#
# Regenerating is unconditional and takes about a second. That is deliberate:
# staleness detection against "did any route change" is the kind of cache that
# is wrong exactly when it matters, and a stale client is the failure this
# whole arrangement exists to prevent.

#
# --if-missing regenerates only when there is nothing there at all. pre-commit
# uses it: paying ~3s on every commit is against that hook's whole design, but a
# session's fresh worktree still has to be rescued before `tsc` runs. Staleness
# is safe under that flag because pre-push regenerates unconditionally before
# anything typechecks or builds.

set -Eeuo pipefail

cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

SPEC=backend/openapi.json
CLIENT=frontend/src/shared/api/generated

if [[ "${1:-}" == "--if-missing" ]]; then
  if [[ -f "$SPEC" && -d "$CLIENT" ]]; then
    exit 0
  fi
  printf 'No generated API client in this checkout; generating it once.\n' >&2
elif [[ -n "${1:-}" ]]; then
  printf 'Unknown argument: %s (expected --if-missing or nothing)\n' "$1" >&2
  exit 2
fi

command -v bun >/dev/null 2>&1 || {
  printf 'bun is not on PATH; cannot generate the API client.\n' >&2
  exit 1
}

# openapi.ts boots the Hono app, which validates env and constructs the BullMQ
# queue. Neither Postgres nor Redis is contacted to render the document, so
# placeholders are enough — but never clobber a real value if one is present.
# A checkout that has not been installed has no node_modules either, and then
# codegen fails with "kubb: command not found" rather than anything that points
# at the cause. Lockfiles are committed, so --frozen-lockfile is the right
# install here for the same reason the installer uses it.
for pkg in backend frontend; do
  [[ -d "$pkg/node_modules" ]] && continue
  printf 'Installing %s dependencies (no node_modules yet)\n' "$pkg" >&2
  (cd "$pkg" && bun install --frozen-lockfile >/dev/null) || {
    printf 'bun install failed in %s.\n' "$pkg" >&2
    exit 1
  }
done

# Subshells rather than `bun --cwd`: that flag does not select a package
# directory, it silently lists the scripts instead of running the one asked for.
(
  cd backend
  DATABASE_URL="${DATABASE_URL:-unused}" \
  REDIS_URL="${REDIS_URL:-unused}" \
    bun run openapi >/dev/null
)

[[ -f "$SPEC" ]] || {
  printf 'bun run openapi reported success but backend/openapi.json is missing.\n' >&2
  exit 1
}

(
  cd frontend
  KUBB_DISABLE_TELEMETRY=1 bun run codegen >/dev/null
)

[[ -d "$CLIENT" ]] || {
  printf 'bun run codegen reported success but frontend/src/shared/api/generated is missing.\n' >&2
  exit 1
}

printf 'API client generated from %s paths\n' \
  "$(grep -c '"/api/' backend/openapi.json 2>/dev/null || echo '?')"
