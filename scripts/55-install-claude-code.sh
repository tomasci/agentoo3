#!/usr/bin/env bash
# Claude Code CLI.
#
# Uses Anthropic's native installer, which updates itself in the background —
# worth having, because Claude Code ships often.
#
# The native install is per-user (~/.local/bin/claude), so it runs as APP_USER,
# not root: provisioning runs as root, and a root-owned install would sit in
# /root where the account that actually runs the app cannot see it.
#
# CLAUDE_CODE_INSTALL_METHOD=apt switches to Anthropic's signed apt repository:
# system-wide and GPG-verified, but it only moves on a system upgrade.
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

# --- locating the binary ------------------------------------------------------
# A native install lives in APP_USER's home, which is not on root's PATH, so
# `have claude` alone would miss it and report a fresh install as a failure.
app_home="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)"

claude_path() {
  if have claude; then command -v claude; return 0; fi
  if [[ -n "$app_home" && -x "$app_home/.local/bin/claude" ]]; then
    printf '%s' "$app_home/.local/bin/claude"; return 0
  fi
  return 1
}

if claude_bin="$(claude_path)"; then
  log_ok "claude $("$claude_bin" --version 2>/dev/null | head -1) already installed at $claude_bin"
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

claude_bin="$(claude_path)" || die "claude not found after install (looked on PATH and in $app_home/.local/bin)."
log_ok "claude $("$claude_bin" --version 2>/dev/null | head -1) at $claude_bin"

# --- make it reachable --------------------------------------------------------
# The native installer puts the launcher in the user's home. That is fine for an
# interactive login shell, but cron, systemd and any non-login shell have their
# own PATH and will not find it.
if [[ "$CLAUDE_CODE_INSTALL_METHOD" == "native" && "$CLAUDE_CODE_SYMLINK" == "1" ]]; then
  # Link the launcher, not the versioned binary: auto-updates replace what the
  # launcher points to, so this link keeps working.
  as_root ln -sfn "$claude_bin" "$CLAUDE_CODE_SYMLINK_PATH"
  log_ok "Linked $CLAUDE_CODE_SYMLINK_PATH -> $claude_bin"
  hash -r

  home_mode="$(stat -c '%a' "$app_home" 2>/dev/null || true)"
  case "$home_mode" in
    700|750)
      log_info "$app_home is mode $home_mode, so only $APP_USER and root can follow that link."
      log_info "A service running as some other user would need its own install."
      ;;
  esac

  # And for interactive shells, which read the profile rather than /usr/local/bin
  # first — this is the line the Claude installer itself suggests.
  rc_file="$app_home/.bashrc"
  if [[ -f "$rc_file" ]] && ! grep -q '\.local/bin' "$rc_file" 2>/dev/null; then
    # $HOME must stay literal — it is evaluated when the shell starts, not now.
    # shellcheck disable=SC2016
    printf '\n# Added by the %s installer — Claude Code installs here\nexport PATH="$HOME/.local/bin:$PATH"\n' \
      "$APP_NAME" | as_user "$APP_USER" tee -a "$rc_file" >/dev/null
    log_ok "Added ~/.local/bin to PATH in $rc_file"
  fi
fi

if have claude; then
  log_ok "'claude' resolves on PATH: $(command -v claude)"
else
  log_warn "'claude' is not on PATH — call it as $claude_bin, or in a systemd unit set"
  log_warn "    Environment=PATH=$app_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
fi

report_auth

log_info "Diagnose the install any time with: $claude_bin doctor"
log_ok "Claude Code ready"
