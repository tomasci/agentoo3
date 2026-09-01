#!/usr/bin/env bash
# Fail if any file under a source directory is git-ignored.
#
# This exists because a directory of hand-written source was once ignored by a
# leftover .gitignore rule: every local build passed, because the files were
# present but untracked, and the server's clean checkout failed with a wall of
# "Cannot find module" errors.
#
# A build against a working tree cannot catch that. This can, in milliseconds.
# Genuinely generated output is allowlisted below rather than tracked.

set -Eeuo pipefail

cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

SOURCE_DIRS=(frontend/src backend/src)

# Output that is generated at install time and ignored on purpose. Anything else
# under a source directory being ignored is the bug this script exists for.
ALLOWED_IGNORED_RE='^frontend/src/shared/api/generated/'

ignored="$(
  git ls-files --others --ignored --exclude-standard -- "${SOURCE_DIRS[@]}" 2>/dev/null \
    | grep -v '/node_modules/' \
    | grep -vE "$ALLOWED_IGNORED_RE" || true
)"

if [[ -n "$ignored" ]]; then
  printf 'Source files are git-ignored and would be missing from a clean checkout:\n\n' >&2
  printf '%s\n' "$ignored" | sed 's/^/  /' >&2
  printf '\nEither commit them, or stop importing them. Check the nearest .gitignore.\n' >&2
  exit 1
fi

# The check above only sees ignored files that are also UNTRACKED, which is the
# state the original bug was in. Once a file is tracked, a later .gitignore entry
# does not untrack it and the scan goes quiet — so assert outright that the
# generated artifacts a clean checkout needs are in the index.
REQUIRED_TRACKED=(
  frontend/bun.lock
  backend/bun.lock
  frontend/kubb.config.ts
  backend/src/openapi.ts
)

missing=()
for path in "${REQUIRED_TRACKED[@]}"; do
  git ls-files --error-unmatch "$path" >/dev/null 2>&1 || missing+=("$path")
done

if (( ${#missing[@]} > 0 )); then
  printf 'Files a clean checkout needs are not tracked:\n\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  printf '\nRun codegen and commit the result, or fix the .gitignore hiding them.\n' >&2
  exit 1
fi

echo "OK: no ignored sources, and ${#REQUIRED_TRACKED[@]} required artifacts tracked"
