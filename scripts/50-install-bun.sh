#!/usr/bin/env bash
# Bun, installed system-wide (default /usr/local/bin/bun) so services and every
# user share one binary instead of a per-home ~/.bun.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Bun"
require_root

if have bun; then
  cur="$(bun --version 2>/dev/null)"
  if [[ "$BUN_VERSION" == "latest" ]] && version_gte "$cur" "$MIN_BUN_VERSION"; then
    log_ok "bun $cur already installed (>= $MIN_BUN_VERSION) — skipping"
    exit 0
  fi
  if [[ "$BUN_VERSION" != "latest" && "$cur" == "$BUN_VERSION" ]]; then
    log_ok "bun $cur matches the pinned version — skipping"
    exit 0
  fi
  log_info "bun $cur installed; installing ${BUN_VERSION}"
fi

# `unzip` is required by the official installer.
have unzip || apt_install unzip

install_bun_official() {
  local tmp; tmp="$(mktemp)"
  curl -fsSL https://bun.sh/install -o "$tmp" || { rm -f "$tmp"; return 1; }

  local args=()
  [[ "$BUN_VERSION" != "latest" ]] && args=("bun-v${BUN_VERSION#v}")

  as_root install -d "$BUN_INSTALL_DIR/bin"
  as_root env "BUN_INSTALL=$BUN_INSTALL_DIR" bash "$tmp" ${args[@]+"${args[@]}"}
  local rc=$?
  rm -f "$tmp"
  return $rc
}

install_bun_npm() {
  have npm || { log_error "npm unavailable, cannot use the npm fallback."; return 1; }
  as_root npm install -g bun
}

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would install bun ($BUN_VERSION) into $BUN_INSTALL_DIR/bin"
  exit 0
fi

if ! install_bun_official; then
  log_warn "Official bun installer failed; trying 'npm install -g bun'."
  install_bun_npm || die "Could not install bun."
fi

hash -r
have bun || die "bun is not on PATH. Expected $BUN_INSTALL_DIR/bin/bun."
log_ok "bun $(bun --version)"
