#!/usr/bin/env bash
# Tailscale — a private network path to this host that does not depend on any
# public port being open.
#
# With an auth key in the environment this is fully unattended. Without one the
# node is installed and left waiting, and we print the command to finish it.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Tailscale"
require_root

# --- install ------------------------------------------------------------------
# Manual apt repo first: it pins us to a known keyring and survives the official
# installer changing shape. Falls back to install.sh, then to an LTS codename,
# because Tailscale may not have published a repo for a brand-new Ubuntu yet.
install_tailscale_apt() {
  local codename="$1"
  local keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
  local list=/etc/apt/sources.list.d/tailscale.list
  local base="https://pkgs.tailscale.com/stable/ubuntu"

  log_info "Trying the Tailscale apt repo for '$codename'"
  local tmpkey; tmpkey="$(mktemp)"
  if ! curl -fsSL --max-time 30 "$base/${codename}.noarmor.gpg" -o "$tmpkey"; then
    rm -f "$tmpkey"; return 1
  fi
  # An HTML error page would also be a 200; make sure this is really a keyring.
  if ! [[ -s "$tmpkey" ]] || ! gpg --show-keys "$tmpkey" >/dev/null 2>&1; then
    rm -f "$tmpkey"
    log_warn "No usable signing key published for '$codename'"
    return 1
  fi
  as_root install -m 0644 "$tmpkey" "$keyring" || { rm -f "$tmpkey"; return 1; }
  rm -f "$tmpkey"

  local tmplist; tmplist="$(mktemp)"
  if ! curl -fsSL --max-time 30 "$base/${codename}.tailscale-keyring.list" -o "$tmplist"; then
    rm -f "$tmplist"; return 1
  fi
  as_root install -m 0644 "$tmplist" "$list" || { rm -f "$tmplist"; return 1; }
  rm -f "$tmplist"

  apt_update || return 1
  apt_wait_for_lock
  as_root apt-get install "${APT_OPTS[@]}" tailscale
}

install_tailscale_official() {
  log_info "Trying the official Tailscale installer"
  local tmp; tmp="$(mktemp)"
  if ! curl -fsSL --max-time 60 https://tailscale.com/install.sh -o "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  as_root sh "$tmp"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

if have tailscale; then
  log_ok "tailscale $(tailscale version 2>/dev/null | head -1) already installed"
elif [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would install tailscale and bring the node up"
  exit 0
else
  codename="$( . /etc/os-release 2>/dev/null && printf '%s' "${VERSION_CODENAME:-}" )"
  installed=0
  if [[ -n "$codename" ]] && install_tailscale_apt "$codename"; then
    installed=1
  elif install_tailscale_official; then
    installed=1
  elif [[ "$codename" != "$TAILSCALE_CODENAME_FALLBACK" ]] \
    && install_tailscale_apt "$TAILSCALE_CODENAME_FALLBACK"; then
    log_warn "Used the '$TAILSCALE_CODENAME_FALLBACK' repo; '$codename' has none yet."
    installed=1
  fi
  (( installed )) || die "Could not install tailscale."
  hash -r
fi

have tailscale || die "tailscale is not on PATH after install."
svc_enable_now tailscaled

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would run 'tailscale up'"
  exit 0
fi

# --- bring the node up --------------------------------------------------------
already_up=0
if tailscale status >/dev/null 2>&1; then
  already_up=1
fi

if (( already_up )); then
  log_ok "Node is already on the tailnet as $(tailscale ip -4 2>/dev/null | head -1)"
else
  up_args=(
    --hostname "$TAILSCALE_HOSTNAME"
    "--accept-dns=$TAILSCALE_ACCEPT_DNS"
    "--accept-routes=$TAILSCALE_ACCEPT_ROUTES"
  )
  [[ "$TAILSCALE_SSH" == "1" ]] && up_args+=(--ssh)
  # Deliberately word-split: this holds extra CLI flags.
  # shellcheck disable=SC2206
  [[ -n "$TAILSCALE_UP_EXTRA_ARGS" ]] && up_args+=($TAILSCALE_UP_EXTRA_ARGS)

  if [[ -n "$TAILSCALE_AUTHKEY" ]]; then
    log_info "Joining the tailnet with the supplied auth key"
    # The key is passed as an argument, so keep it out of the log.
    if as_root tailscale up --authkey "$TAILSCALE_AUTHKEY" "${up_args[@]}" 2>&1 \
         | sed 's/tskey-[A-Za-z0-9-]*/tskey-***REDACTED***/g'; then
      log_ok "Joined the tailnet"
    else
      die "'tailscale up' failed. Is the auth key valid and unexpired?"
    fi
  else
    log_warn "No TAILSCALE_AUTHKEY set — this node is installed but NOT connected."
    log_warn "Finish it by running, on this host:"
    log_warn "    sudo tailscale up --hostname $TAILSCALE_HOSTNAME --accept-dns=$TAILSCALE_ACCEPT_DNS"
    log_warn "Then open the printed URL to authorise the machine."
    log_warn "For unattended installs, create a reusable auth key and pass:"
    log_warn "    TAILSCALE_AUTHKEY=tskey-auth-... $INSTALL_SH --only tailscale"
  fi
fi

if ts_ip="$(tailscale ip -4 2>/dev/null | head -1)" && [[ -n "$ts_ip" ]]; then
  log_ok "Tailscale IPv4: $ts_ip"
  log_info "Reach the app privately at http://${ts_ip}/ once the services are running."
fi

log_ok "Tailscale step complete"
