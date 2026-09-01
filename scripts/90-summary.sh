#!/usr/bin/env bash
# Verify what actually landed and print a report.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Summary"

missing_count=0

# Tools print their version in wildly different formats ("jq-1.8.1",
# "git version 2.53.0", and curl's single enormous line), so pull out the first
# version-shaped token rather than trying to parse each one.
short_version() {
  "$1" --version 2>&1 | head -1 \
    | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true
}

report() {
  local label="$1" bin="$2" ver
  if have "$bin"; then
    ver="$(short_version "$bin")"
    printf '  %s%-10s%s %-10s %s\n' \
      "$C_GRN" "$label" "$C_RESET" "${ver:-?}" "$(command -v "$bin")" >&2
  else
    printf '  %s%-10s%s %s\n' "$C_RED" "$label" "$C_RESET" "missing" >&2
    missing_count=$(( missing_count + 1 ))
  fi
}

printf '\n' >&2
report python3 python3
report pip      pip3
report uv       uv
report node     node
report npm      npm
report bun      bun
report claude   claude
report git      git
report curl     curl
report wget     wget
report gcc      gcc
report jq       jq
report nginx    nginx
report psql     psql
report redis    redis-cli
report ufw      ufw
report tailscale tailscale
printf '\n' >&2

# --- services -----------------------------------------------------------------
svc_report() {
  local label="$1" svc="$2"
  if ! has_systemd; then
    printf '  %s%-10s%s %s\n' "$C_YLW" "$label" "$C_RESET" "no systemd" >&2
  elif svc_is_active "$svc"; then
    printf '  %s%-10s%s %s\n' "$C_GRN" "$label" "$C_RESET" "active$(svc_is_enabled "$svc" && printf ', enabled at boot' || printf ', NOT enabled at boot')" >&2
  elif svc_is_enabled "$svc" || pkg_installed "${svc%%.*}" 2>/dev/null; then
    printf '  %s%-10s%s %s\n' "$C_RED" "$label" "$C_RESET" "installed but not running" >&2
    missing_count=$(( missing_count + 1 ))
  else
    printf '  %s%-10s%s %s\n' "$C_DIM" "$label" "$C_RESET" "not installed" >&2
  fi
}

svc_report postgres postgresql
svc_report redis    redis-server
svc_report nginx    nginx
svc_report tailscale tailscaled
printf '\n' >&2

# --- network ------------------------------------------------------------------
if have ufw; then
  if ${_SUDO[@]+"${_SUDO[@]}"} ufw status 2>/dev/null | head -1 | grep -q active; then
    log_ok "Firewall active. Open ports:"
    ${_SUDO[@]+"${_SUDO[@]}"} ufw status 2>/dev/null | awk 'NR>3 && NF {printf "    %s\n", $0}' >&2
  else
    log_warn "ufw is installed but INACTIVE. Run: $INSTALL_SH --only ufw"
  fi
fi

if have tailscale; then
  if ts_ip="$(tailscale ip -4 2>/dev/null | head -1)" && [[ -n "$ts_ip" ]]; then
    log_ok "Tailscale IPv4: $ts_ip  ->  http://${ts_ip}/"
  else
    log_warn "Tailscale is installed but this node has not joined a tailnet."
    log_warn "Run: sudo tailscale up"
  fi
fi

if [[ -f "$SETTINGS_FILE" ]]; then
  log_ok "Remembered installer settings ($SETTINGS_FILE):"
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf '    %s\n' "$line" >&2
  done <"$SETTINGS_FILE"
fi

if [[ -f "$ENV_FILE" ]]; then
  log_ok "Generated credentials are in $ENV_FILE (mode $(stat -c %a "$ENV_FILE" 2>/dev/null))"
else
  log_warn "No $ENV_FILE yet — the postgres/redis steps have not run."
fi

if (( missing_count > 0 )); then
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_warn "$missing_count tool(s) missing — expected, nothing was installed (--dry-run)."
  else
    die "$missing_count expected tool(s) missing. See $LOG_FILE"
  fi
fi

if [[ -f /var/run/reboot-required ]]; then
  log_warn "A reboot is required to finish applying updates:  sudo reboot"
fi

printf '\n' >&2
log_ok "Installed at: $REPO_ROOT"
log_info "Re-run any step from anywhere, e.g.:"
log_info "  sudo $INSTALL_SH --only nginx"
log_ok "Install complete. Log: $LOG_FILE"
