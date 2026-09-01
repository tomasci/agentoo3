#!/usr/bin/env bash
# Install the base utilities every later step assumes are present.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Base utilities"
require_root

# Core first: the rest of the installer needs curl/gnupg/ca-certificates to add
# third-party apt repositories.
apt_install "${PKGS_CORE[@]}"
as_root update-ca-certificates >/dev/null 2>&1 || true

apt_install "${PKGS_UTILS[@]}"

log_ok "Base utilities installed"
