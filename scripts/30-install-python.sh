#!/usr/bin/env bash
# Python toolchain.
#
# Ubuntu 24.04+ marks the system interpreter as "externally managed" (PEP 668),
# so `pip install` outside a venv is refused. We install the interpreter plus
# venv support system-wide, and `uv` to create/manage project environments.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Python toolchain"
require_root

apt_install "${PKGS_PYTHON[@]}"

py_version="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
version_gte "$py_version" "$MIN_PYTHON_VERSION" \
  || die "python3 is $py_version but >= $MIN_PYTHON_VERSION is required."
log_ok "python3 $py_version"

if python3 -c 'import venv' 2>/dev/null; then
  log_ok "venv module available"
else
  die "python3-venv did not install correctly."
fi

# --- uv -----------------------------------------------------------------------
# Installed system-wide so both the deploy user and systemd units can see it.
if [[ "$INSTALL_UV" == "1" ]]; then
  if have uv; then
    log_ok "uv $(uv --version 2>/dev/null | awk '{print $2}') already installed"
  elif [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_info "[dry-run] would install uv into /usr/local/bin"
  else
    log_info "Installing uv"
    tmp="$(mktemp)"
    curl -fsSL https://astral.sh/uv/install.sh -o "$tmp" \
      || { rm -f "$tmp"; die "Could not download the uv installer."; }
    as_root env UV_INSTALL_DIR=/usr/local/bin sh "$tmp" >/dev/null \
      || { rm -f "$tmp"; die "uv installer failed."; }
    rm -f "$tmp"
    have uv || hash -r
    log_ok "uv $(uv --version 2>/dev/null | awk '{print $2}') installed"
  fi
else
  log_info "uv install disabled (INSTALL_UV=0)"
fi

log_ok "Python toolchain ready"
