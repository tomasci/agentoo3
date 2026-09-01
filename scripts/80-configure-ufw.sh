#!/usr/bin/env bash
# Firewall. Runs last, once every port that needs to be open is known.
#
# The overriding concern here is not locking the operator out of their own
# server. Rules are always added BEFORE ufw is enabled, the live SSH port is
# detected rather than assumed, and the port of the current SSH session is
# always allowed even if it is not in any config file.
#
# Rules are additive. Changing UFW_PUBLIC_PORTS later does not remove the old
# rules — inspect with `ufw status numbered` and `ufw delete <n>`.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

# Overridable so the detection logic can be exercised against a fixture.
SSHD_CONFIG="${SSHD_CONFIG:-/etc/ssh/sshd_config}"
SSHD_CONFIG_D="${SSHD_CONFIG_D:-/etc/ssh/sshd_config.d}"

log_step "Firewall (ufw)"
require_root

apt_install "${PKGS_FIREWALL[@]}"

# A lockdown chosen on an earlier run must survive a later plain re-run.
sticky_recall UFW_TAILSCALE_ONLY

# ---------------------------------------------------------------- ssh port ---
# `sshd -T` is authoritative because it expands Include'd files; fall back to
# grepping the config, then to the default.
detect_ssh_ports() {
  local -a ports=()
  local sshd_bin=""
  if have sshd; then
    sshd_bin="$(command -v sshd)"
  elif [[ -x /usr/sbin/sshd ]]; then
    sshd_bin=/usr/sbin/sshd
  fi

  if [[ -n "$sshd_bin" ]]; then
    local out
    if out="$(${_SUDO[@]+"${_SUDO[@]}"} "$sshd_bin" -T 2>/dev/null)"; then
      mapfile -t ports < <(printf '%s\n' "$out" | awk '$1 == "port" { print $2 }')
    fi
  fi

  if (( ${#ports[@]} == 0 )); then
    mapfile -t ports < <(
      ${_SUDO[@]+"${_SUDO[@]}"} grep -rhiE '^[[:space:]]*Port[[:space:]]+[0-9]+' \
        "$SSHD_CONFIG" "$SSHD_CONFIG_D" 2>/dev/null \
        | awk '{ print $2 }' | sort -un || true
    )
  fi

  if (( ${#ports[@]} == 0 )); then
    ports=(22)
  fi
  printf '%s\n' "${ports[@]}"
}

declare -a ssh_ports=()
if [[ -n "$SSH_PORT" ]]; then
  ssh_ports=("$SSH_PORT")
  log_info "Using the configured SSH port $SSH_PORT"
else
  mapfile -t ssh_ports < <(detect_ssh_ports)
  log_info "Detected SSH port(s): ${ssh_ports[*]}"
fi

# The session we are running inside wins over anything a config file claims.
live_ssh_port=""
live_ssh_server_ip=""
if [[ -n "${SSH_CONNECTION:-}" ]]; then
  live_ssh_port="$(awk '{ print $4 }' <<<"$SSH_CONNECTION")"
  live_ssh_server_ip="$(awk '{ print $3 }' <<<"$SSH_CONNECTION")"
  log_info "This is an SSH session on port $live_ssh_port (to $live_ssh_server_ip)"
  if [[ -n "$live_ssh_port" ]] && [[ " ${ssh_ports[*]} " != *" $live_ssh_port "* ]]; then
    log_warn "Port $live_ssh_port is not in the detected set; adding it to avoid a lockout."
    ssh_ports+=("$live_ssh_port")
  fi
fi

# -------------------------------------------------------------- tailscale ----
tailscale_up=0
tailscale_ip=""
if have tailscale && tailscale status >/dev/null 2>&1; then
  tailscale_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [[ -n "$tailscale_ip" ]] && tailscale_up=1
fi

# ---------------------------------------------------- lockdown safety gate ---
if [[ "$UFW_TAILSCALE_ONLY" == "1" ]]; then
  log_warn "UFW_TAILSCALE_ONLY=1 — SSH will be reachable ONLY over the VPN."
  if (( ! tailscale_up )); then
    die "Refusing: Tailscale is not connected, so this would lock you out permanently.
    Bring the node up first ('sudo tailscale up'), then re-run:
      $INSTALL_SH --only ufw"
  fi
  log_ok "Tailscale is up ($tailscale_ip)"

  # Are we about to cut the cable we are sitting on?
  if [[ -n "${SSH_CONNECTION:-}" && "${live_ssh_server_ip:-}" != 100.* ]]; then
    log_warn "Your current SSH session arrived on ${live_ssh_server_ip:-a public address},"
    log_warn "NOT over Tailscale. Applying this will disconnect you."
    confirm "Continue anyway?" || die "Aborted. Reconnect over Tailscale ('ssh $tailscale_ip') and re-run."
  fi
fi

# --------------------------------------------------------------- defaults ----
log_info "Setting default policies: deny incoming, allow outgoing"
as_root ufw --force default deny incoming
as_root ufw --force default allow outgoing
[[ -n "$UFW_LOGGING" ]] && as_root ufw logging "$UFW_LOGGING"

# ------------------------------------------------------------------- rules ---
# SSH first, always, before anything can enable the firewall.
for port in "${ssh_ports[@]}"; do
  if [[ "$UFW_TAILSCALE_ONLY" == "1" ]]; then
    log_info "Allowing SSH on $port over tailscale0 only"
    as_root ufw allow in on tailscale0 to any port "$port" proto tcp
  elif [[ "$UFW_LIMIT_SSH" == "1" ]]; then
    log_info "Allowing SSH on $port (rate-limited)"
    as_root ufw limit "$port/tcp" comment "ssh (rate-limited)"
  else
    log_info "Allowing SSH on $port"
    as_root ufw allow "$port/tcp" comment "ssh"
  fi
done

# Public web ports.
for spec in $UFW_PUBLIC_PORTS; do
  log_info "Allowing public $spec"
  as_root ufw allow "$spec" comment "$APP_NAME public"
done

# Any extra ports the operator wants exposed directly.
for spec in $UFW_APP_PORTS; do
  log_info "Allowing public $spec (UFW_APP_PORTS)"
  as_root ufw allow "$spec" comment "$APP_NAME app"
done

# Everything over the VPN. This is what makes the backend and frontend ports
# reachable for administration without exposing them to the internet.
if [[ "$UFW_ALLOW_TAILSCALE" == "1" ]]; then
  log_info "Allowing all inbound traffic on tailscale0"
  as_root ufw allow in on tailscale0 comment "tailscale"
  # Tailscale's own WireGuard listener; harmless if it picks another port.
  as_root ufw allow 41641/udp comment "tailscale wireguard"
  (( tailscale_up )) || log_warn "tailscale0 rules added, but the node is not connected yet."
fi

# Remove the public SSH rules that lockdown mode supersedes.
if [[ "$UFW_TAILSCALE_ONLY" == "1" ]]; then
  for port in "${ssh_ports[@]}"; do
    log_info "Removing any public SSH rule for $port"
    as_root ufw delete limit "$port/tcp" >/dev/null 2>&1 || true
    as_root ufw delete allow "$port/tcp" >/dev/null 2>&1 || true
  done
fi

# ------------------------------------------------------------------ enable ---
# Final sanity check: never enable without a reachable way back in.
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  if ! as_root ufw show added | grep -qE 'ssh|tailscale0|22/tcp'; then
    die "No SSH or VPN rule was staged. Refusing to enable ufw."
  fi
fi

if as_root ufw status 2>/dev/null | head -1 | grep -q 'Status: active'; then
  log_info "ufw is already active; reloading"
  as_root ufw reload
else
  log_warn "Enabling ufw now."
  as_root ufw --force enable       # --force: skip the interactive confirmation
fi

# Persist only what was actually applied, so a failed run remembers nothing.
setting_remember UFW_TAILSCALE_ONLY "$UFW_TAILSCALE_ONLY"

log_ok "Firewall active"
as_root ufw status verbose 2>&1 | while IFS= read -r line; do
  printf '  %s\n' "$line" >&2
done

if [[ "$UFW_TAILSCALE_ONLY" != "1" ]]; then
  log_info "SSH is reachable publicly. To move it behind the VPN once Tailscale works:"
  log_info "  sudo UFW_TAILSCALE_ONLY=1 $INSTALL_SH --only ufw"
  log_info "That choice is remembered; later runs keep it unless you pass UFW_TAILSCALE_ONLY=0."
fi
