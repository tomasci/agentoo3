#!/usr/bin/env bash
# Bring every installed package up to date.
# Deliberately does NOT reboot; it only reports when one is required.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "System update & full-upgrade"
require_root

apt_update

log_info "Running full-upgrade (this can take a while on a fresh host)"
apt_wait_for_lock
as_root apt-get full-upgrade "${APT_OPTS[@]}"

log_info "Removing obsolete packages"
apt_wait_for_lock
as_root apt-get autoremove "${APT_OPTS[@]}" --purge
as_root apt-get autoclean -y

if [[ -f /var/run/reboot-required ]]; then
  step_mark_done "reboot-required"
  log_warn "A reboot is required to finish applying updates."
  [[ -r /var/run/reboot-required.pkgs ]] &&
    log_warn "Triggered by: $(tr '\n' ' ' </var/run/reboot-required.pkgs)"
else
  rm -f "$(step_marker reboot-required)" 2>/dev/null || true
  log_ok "No reboot required"
fi

log_ok "System is up to date"
