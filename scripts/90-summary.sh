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
  local bin="$1" flag out
  # nginx has no --version (it wants -v), and prints to stderr. Try each until
  # one yields something version-shaped.
  for flag in --version -v -V; do
    out="$("$bin" "$flag" 2>&1 | head -1 \
           | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"
    [[ -n "$out" ]] && { printf '%s' "$out"; return 0; }
  done
  return 0
}

# A per-user native install is not on root's PATH; look where it actually lives
# before calling it missing.
extra_locations() {
  local bin="$1" home
  home="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)"
  [[ -n "$home" ]] && printf '%s\n' "$home/.local/bin/$bin"
  printf '%s\n' "/usr/local/bin/$bin" "/root/.local/bin/$bin"
}

resolve_bin() {
  local bin="$1" p
  if have "$bin"; then command -v "$bin"; return 0; fi
  while read -r p; do
    [[ -n "$p" && -x "$p" ]] && { printf '%s' "$p"; return 0; }
  done < <(extra_locations "$bin")
  return 1
}

report() {
  local label="$1" bin="$2" ver
  if bin="$(resolve_bin "$bin")"; then
    ver="$(short_version "$bin")"
    printf '  %s%-10s%s %-10s %s\n' \
      "$C_GRN" "$label" "$C_RESET" "${ver:-?}" "$bin" >&2
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
svc_report frontend "${APP_NAME}-frontend"
svc_report api      "${APP_NAME}-api"
svc_report worker   "${APP_NAME}-worker"
printf '\n' >&2

# --- docker (optional; outside report/svc_report on purpose) -------------------
# Both of those count toward missing_count, which this script treats as fatal
# by default (see the bottom of the file) — but Docker not being here is a
# supported choice (DOCKER_ENABLE=0), not a broken install, so it gets its own
# lines instead.
if have docker; then
  # `|| true` on both: short_version() above already ends the same way, for
  # the same reason -- a broken CLI or missing compose plugin must degrade to
  # "?" here, not abort the one step whose whole job is reporting that.
  docker_ver="$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  compose_ver="$(docker compose version --format json 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  printf '  %s%-10s%s %s\n' "$C_GRN" "docker" "$C_RESET" "${docker_ver:-?} (compose ${compose_ver:-?})" >&2
  if has_systemd; then
    if svc_is_active docker; then
      printf '  %s%-10s%s %s\n' "$C_GRN" "docker.service" "$C_RESET" \
        "active$(svc_is_enabled docker && printf ', enabled at boot' || printf ', NOT enabled at boot')" >&2
    else
      printf '  %s%-10s%s %s\n' "$C_RED" "docker.service" "$C_RESET" "installed but not running" >&2
    fi
  fi

  # The drift detector for the one property this whole design exists to hold:
  # DOCKER-USER narrowed by source address, not interface. A daemon restart
  # that happened before the ExecStartPost drop-in existed, a hand-run
  # `iptables -F`, or DOCKER_FIREWALL=0 on some later run would all show up
  # here rather than silently leaving a published container port reachable
  # from the public internet.
  # Captured before grepping, not piped straight into `grep -q`: a live pipe
  # into a tool that exits the instant it matches can SIGPIPE the producer,
  # which `set -o pipefail` (on for this whole script) turns into a spurious
  # non-zero status even though the match was genuinely found.
  docker_user_rules="$(${_SUDO[@]+"${_SUDO[@]}"} iptables -w 5 -S DOCKER-USER 2>/dev/null || true)"
  if grep -q -- '-j DROP' <<<"$docker_user_rules"; then
    log_ok "DOCKER-USER firewall block present (published container ports are not public)"
  else
    log_warn "docker is installed but DOCKER-USER has NO managed DROP rule."
    log_warn "A published container port may be reachable from the public internet. Run:"
    log_warn "    sudo $INSTALL_SH --only docker"
  fi
else
  printf '  %s%-10s%s %s\n' "$C_DIM" "docker" "$C_RESET" "not installed (DOCKER_ENABLE=0, or the step has not run)" >&2
fi
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

ts_endpoints=()
if have tailscale; then
  while read -r endpoint; do
    [[ -n "$endpoint" ]] && ts_endpoints+=("$endpoint")
  done < <(tailscale_endpoints)

  if (( ${#ts_endpoints[@]} )); then
    if ts_name="$(tailscale_dns_name)"; then
      log_ok "MagicDNS name: $ts_name"
    else
      log_warn "No MagicDNS name — enable MagicDNS in the tailnet admin console for a nicer URL."
    fi
    log_ok "Reachable on the tailnet at:"
    for endpoint in "${ts_endpoints[@]}"; do
      printf '    %s\n' "$(tailscale_url "$endpoint")" >&2
    done
  else
    log_warn "Tailscale is installed but this node has not joined a tailnet."
    log_warn "Run: sudo tailscale up"
  fi
fi

# --- custom-domain HTTPS (optional; outside report/svc_report, like Docker) ---
# setting_recall, not sticky_recall: this is read-only reporting, and
# sticky_recall logs "Using remembered ..." as though this run had just
# decided something, which it has not.
https_domain="$(setting_recall HTTPS_DOMAIN || true)"
if [[ -n "$https_domain" && "$https_domain" != "none" ]]; then
  if https_cert_present "$https_domain"; then
    if https_probe "$https_domain"; then
      log_ok "Custom domain: https://${https_domain}/"
      cert_end="$(sudo -n openssl x509 -enddate -noout \
        -in "$LETSENCRYPT_DIR/live/${https_domain}/fullchain.pem" 2>/dev/null | sed -n 's/^notAfter=//p')"
      [[ -n "$cert_end" ]] && log_info "    certificate expires $cert_end"
      log_ok "Reachable at:"
      printf '    https://%s/\n' "$https_domain" >&2
      for endpoint in "${ts_endpoints[@]}"; do
        printf '    %s\n' "$(tailscale_url "$endpoint")" >&2
      done
    else
      log_warn "HTTPS_DOMAIN=$https_domain has a certificate, but https://${https_domain}/ is not answering."
      log_warn "Run: sudo $INSTALL_SH --only nginx"
    fi
  else
    log_warn "HTTPS_DOMAIN=$https_domain is configured, but no certificate exists for it yet."
    log_warn "Run: sudo $INSTALL_SH --only https"
  fi
fi

if curl -fsS --max-time 3 "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
  log_ok "Backend answering on http://${BACKEND_HOST}:${BACKEND_PORT}/api/health"
  if ! curl -fsS --max-time 3 "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" 2>/dev/null \
       | grep -q '"claudeCredential":true'; then
    log_warn "Backend has NO Claude credential — agents cannot run. See the README."
  fi
else
  log_warn "Nothing answering on ${BACKEND_HOST}:${BACKEND_PORT} — /api/ will 502."
  log_warn "Run: sudo $INSTALL_SH --only backend"
fi

# The whole point of the frontend service is that this stops being a 502.
if curl -fsS -o /dev/null --max-time 3 "http://${FRONTEND_HOST}:${FRONTEND_PORT}/" 2>/dev/null; then
  log_ok "Frontend answering on http://${FRONTEND_HOST}:${FRONTEND_PORT}/"
else
  log_warn "Nothing answering on ${FRONTEND_HOST}:${FRONTEND_PORT} — nginx will return 502."
  log_warn "Run: sudo $INSTALL_SH --only frontend"
fi

# Headroom, not just size. An agent's builds and test runs spike, and a host
# with no swap has nothing between a spike and the OOM killer — which is how
# four sessions on a 4GB box died in an hour reporting "exited with code 143".
ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
swap_mb=$(( $(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024 ))
if (( swap_mb >= SWAP_ENOUGH_MB )); then
  log_ok "Memory ${ram_mb}MB RAM + ${swap_mb}MB swap"
else
  log_warn "Memory ${ram_mb}MB RAM and only ${swap_mb}MB swap — heavy work can be OOM-killed."
  log_warn "Run: sudo $INSTALL_SH --only swap"
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
