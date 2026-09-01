#!/usr/bin/env bash
# Claude Code CLI.
#
# Installed from Anthropic's signed apt repository rather than the
# `curl https://claude.ai/install.sh | bash` native installer, because on a
# server the apt package is system-wide (so a systemd service can exec it),
# while the native installer is per-user and lands in ~/.local/bin — which
# would strand the binary in /root when provisioning runs as root.
#
# Trade-off: apt installs do not self-update. They upgrade with the rest of the
# system, so `install.sh --only upgrade` keeps Claude Code current too.
#
# Docs: https://code.claude.com/docs/en/setup

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Claude Code"

# Validate configuration before asking for privileges — a typo should fail
# immediately, not after a sudo prompt.
case "$CLAUDE_CODE_CHANNEL" in
  stable|latest) ;;
  *) die "CLAUDE_CODE_CHANNEL must be 'stable' or 'latest' (got '$CLAUDE_CODE_CHANNEL')." ;;
esac
case "$CLAUDE_CODE_INSTALL_METHOD" in
  apt|native) ;;
  *) die "CLAUDE_CODE_INSTALL_METHOD must be 'apt' or 'native' (got '$CLAUDE_CODE_INSTALL_METHOD')." ;;
esac

require_root

# Claude Code asks for 4 GB. Warn rather than fail — it will still run, just
# less comfortably, and the operator may be sizing the box deliberately.
ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
if (( ram_mb < CLAUDE_CODE_MIN_RAM_MB )); then
  log_warn "Claude Code recommends ${CLAUDE_CODE_MIN_RAM_MB}MB RAM; this host has ${ram_mb}MB."
fi

# --- apt (preferred) ----------------------------------------------------------
install_claude_apt() {
  local keyring=/etc/apt/keyrings/claude-code.asc
  local list=/etc/apt/sources.list.d/claude-code.list
  local ch="$CLAUDE_CODE_CHANNEL"

  as_root install -d -m 0755 /etc/apt/keyrings || return 1

  local tmpkey; tmpkey="$(mktemp)"
  if ! curl -fsSL --max-time 30 https://downloads.claude.ai/keys/claude-code.asc -o "$tmpkey"; then
    rm -f "$tmpkey"; return 1
  fi

  # Verify the key before trusting it. A wrong or truncated download here would
  # otherwise become an apt source we blindly install packages from.
  local fp
  fp="$(gpg --show-keys --with-colons "$tmpkey" 2>/dev/null \
        | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [[ "$fp" != "$CLAUDE_CODE_GPG_FINGERPRINT" ]]; then
    rm -f "$tmpkey"
    log_error "Claude Code signing key fingerprint mismatch — refusing to add the repo."
    log_error "  expected: $CLAUDE_CODE_GPG_FINGERPRINT"
    log_error "  got:      ${fp:-<no OpenPGP data>}"
    return 1
  fi
  log_ok "Verified signing key ${fp:0:16}..."

  as_root install -m 0644 "$tmpkey" "$keyring" || { rm -f "$tmpkey"; return 1; }
  rm -f "$tmpkey"

  # Both the URL path and the suite carry the channel name.
  printf 'deb [signed-by=%s] https://downloads.claude.ai/claude-code/apt/%s %s main\n' \
    "$keyring" "$ch" "$ch" | as_root tee "$list" >/dev/null || return 1
  log_info "Registered the Claude Code apt repo (${ch} channel)"

  apt_update || return 1
  apt_wait_for_lock
  as_root apt-get install "${APT_OPTS[@]}" claude-code
}

# --- native installer (fallback) ---------------------------------------------
install_claude_native() {
  local home
  home="$(getent passwd "$APP_USER" | cut -d: -f6)"
  [[ -n "$home" ]] || { log_error "No home directory for '$APP_USER'."; return 1; }

  local tmp; tmp="$(mktemp)"
  if ! curl -fsSL --max-time 60 https://claude.ai/install.sh -o "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  as_root chmod 0755 "$tmp"

  local arg="$CLAUDE_CODE_CHANNEL"
  [[ -n "$CLAUDE_CODE_VERSION" ]] && arg="$CLAUDE_CODE_VERSION"

  # Run as the deploy user with HOME set explicitly: neither `sudo -u` nor
  # `runuser` (without -l) resets HOME, so without this the binary would be
  # installed into root's home.
  log_info "Running the native installer as '$APP_USER' (channel/version: $arg)"
  as_user "$APP_USER" env HOME="$home" bash "$tmp" "$arg"
  local rc=$?
  rm -f "$tmp"

  if (( rc == 0 )); then
    log_warn "Installed per-user at ${home}/.local/bin/claude — NOT system-wide."
    log_warn "systemd units must set PATH or call the absolute path."
  fi
  return $rc
}

# --- authentication -----------------------------------------------------------
report_auth() {
  local auth_var="" auth_where="" v
  # Claude Code reads its credential from the environment, in this precedence
  # order. .env is only a file: nothing sources it automatically, so a credential
  # recorded there still has to be exported, or referenced by EnvironmentFile= in
  # the systemd unit that runs the app.
  for v in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
    if [[ -n "${!v:-}" ]]; then
      auth_var="$v"; auth_where="environment"; break
    fi
    if env_get "$ENV_FILE" "$v" >/dev/null 2>&1; then
      auth_var="$v"; auth_where="$ENV_FILE"; break
    fi
  done

  if [[ -n "$auth_var" ]]; then
    log_ok "Credential found: $auth_var (from $auth_where)"
    if [[ "$auth_where" != "environment" ]]; then
      log_warn "$ENV_FILE is not loaded automatically. To use it in a shell:"
      log_warn "    set -a; . $ENV_FILE; set +a"
      log_warn "For a service, add to the unit:  EnvironmentFile=$ENV_FILE"
    fi
  else
    log_warn "Claude Code is installed but has NO credential — it cannot make requests yet."
    log_warn ""
    log_warn "  Subscription (Pro/Max/Team/Enterprise) — one-year token."
    log_warn "  'claude setup-token' needs a browser, so run it on your laptop:"
    log_warn "      claude setup-token"
    log_warn "  then here:"
    log_warn "      echo 'CLAUDE_CODE_OAUTH_TOKEN=<paste>' | sudo tee -a $ENV_FILE >/dev/null"
    log_warn ""
    log_warn "  Or a Console API key (pay-as-you-go) from https://platform.claude.com:"
    log_warn "      echo 'ANTHROPIC_API_KEY=sk-ant-...' | sudo tee -a $ENV_FILE >/dev/null"
  fi

}

# --- already present? ---------------------------------------------------------
if have claude; then
  log_ok "claude $(claude --version 2>/dev/null | head -1) already installed at $(command -v claude)"
  installed_already=1
else
  installed_already=0
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would install claude-code via '$CLAUDE_CODE_INSTALL_METHOD' (${CLAUDE_CODE_CHANNEL} channel)"
  report_auth
  exit 0
fi

if (( ! installed_already )); then
  case "$CLAUDE_CODE_INSTALL_METHOD" in
    apt)
      if ! install_claude_apt; then
        log_warn "apt install failed; falling back to the native installer."
        install_claude_native || die "Could not install Claude Code."
      fi
      ;;
    native)
      install_claude_native || die "Could not install Claude Code."
      ;;
  esac
  hash -r
fi

have claude || die "claude is not on PATH after install."
log_ok "claude $(claude --version 2>/dev/null | head -1)"

report_auth

log_info "Diagnose the install any time with: claude doctor"
log_ok "Claude Code ready"
