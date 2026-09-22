#!/usr/bin/env bash
# Claude Code CLI — the SYSTEM install, used only for `claude setup-token` and
# `claude doctor`. The agent runtime never touches this: it runs the CLI
# bundled inside @anthropic-ai/claude-agent-sdk under node_modules, so
# upgrading this install changes nothing about which Claude Code a session
# actually runs.
#
# Anthropic's native installer updates itself in the background — on a laptop
# where something runs `claude` regularly. Nothing on this server ever
# invokes the system CLI, so that background update never fires here; this
# step is what moves the version forward instead, and — per the convergence
# policy in lib/config.sh — it now does that on every run, not just the first.
#
# The native install is per-user (~/.local/bin/claude), so it runs as APP_USER,
# not root: provisioning runs as root, and a root-owned install would sit in
# /root where the account that actually runs the app cannot see it.
#
# CLAUDE_CODE_INSTALL_METHOD=apt switches to Anthropic's signed apt repository:
# system-wide and GPG-verified, and converges through 10-system-upgrade.sh's
# full-upgrade like any other apt package, so it needs no re-run logic of its
# own.
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
  # The account may not exist yet: `--only claude` skips the step that creates
  # it, and APP_USER is a dedicated account whenever the installer runs as root.
  ensure_service_user "$APP_USER" "/home/$APP_USER" || return 1
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
  # The install location wins over PATH, not the other way round. Once the
  # symlink below exists, /usr/local/bin is on root's PATH, `have claude` is
  # true and `command -v claude` returns the symlink itself — so checking PATH
  # first turns the `ln -sfn` further down into
  # `ln -sfn /usr/local/bin/claude /usr/local/bin/claude`, a symlink pointing
  # at itself that `readlink -f` cannot resolve. That is what broke this box.
  # An empty app_home (the getent above swallows its own failure with
  # `|| true`) must not fall through to the PATH branch either — for the apt
  # method there is no per-user path and this is a no-op, but for native it
  # would silently reopen the same loop.
  if [[ -n "$app_home" && -x "$app_home/.local/bin/claude" ]]; then
    printf '%s' "$app_home/.local/bin/claude"; return 0
  fi
  if have claude; then command -v claude; return 0; fi
  return 1
}

before_version=""
if claude_bin="$(claude_path)"; then
  before_version="$("$claude_bin" --version 2>/dev/null | head -1)"
  log_ok "claude $before_version already installed at $claude_bin"
  installed_already=1
else
  installed_already=0
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would install claude-code via '$CLAUDE_CODE_INSTALL_METHOD' (${CLAUDE_CODE_CHANNEL} channel)"
  report_auth
  exit 0
fi

# Runs every time, installed or not — installed_already only picks the log
# wording below. Both branches are already upgrade mechanisms on their own:
# the native installer's own install.sh has no already-installed check, so
# re-running it against 'stable'/'latest' moves to whatever that channel
# currently resolves to; `apt-get install` on an already-installed package
# upgrades it. The guard that used to wrap this case statement is the reason
# a re-run never moved the version at all.
if (( installed_already )); then
  log_info "Upgrading claude-code via '$CLAUDE_CODE_INSTALL_METHOD' (${CLAUDE_CODE_CHANNEL} channel)"
else
  log_info "Installing claude-code via '$CLAUDE_CODE_INSTALL_METHOD' (${CLAUDE_CODE_CHANNEL} channel)"
fi
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

claude_bin="$(claude_path)" || die "claude not found after install (looked on PATH and in $app_home/.local/bin)."
after_version="$("$claude_bin" --version 2>/dev/null | head -1)"
if [[ -z "$before_version" ]]; then
  log_ok "claude installed: $after_version at $claude_bin"
elif [[ "$before_version" == "$after_version" ]]; then
  log_ok "claude already current ($after_version) at $claude_bin"
else
  log_ok "claude upgraded: $before_version -> $after_version at $claude_bin"
fi

# --- make it reachable --------------------------------------------------------
# ~/.local/bin/claude is not a launcher wrapping a separately-versioned binary
# — it is itself a symlink straight into ~/.local/share/claude/versions/<ver>,
# repointed in place whenever the CLI updates. That is fine for an interactive
# login shell, but cron, systemd and any non-login shell have their own PATH
# and will not find it there, so this links it into /usr/local/bin, which is
# on all of theirs.
if [[ "$CLAUDE_CODE_INSTALL_METHOD" == "native" && "$CLAUDE_CODE_SYMLINK" == "1" ]]; then
  # A broken link here — self-referential or merely dangling — is damage left
  # by a version of this script whose claude_path() checked PATH before the
  # install location: once /usr/local/bin/claude was on root's PATH, this step
  # pointed it at itself. `ln -sfn` below overwrites a broken symlink same as
  # any other file, so this repair is not load-bearing for the fix — that is
  # claude_path() above, which no longer resolves to this path — but a box
  # already carrying the damage should say so rather than heal silently, the
  # same way the unconditional "Linked" log below used to hide it.
  if [[ -L "$CLAUDE_CODE_SYMLINK_PATH" && ! -e "$CLAUDE_CODE_SYMLINK_PATH" ]]; then
    log_warn "$CLAUDE_CODE_SYMLINK_PATH is a broken symlink (self-referential or dangling) — removing it"
    as_root rm -f "$CLAUDE_CODE_SYMLINK_PATH"
    hash -r
    claude_bin="$(claude_path)" || die "claude not found after removing the broken symlink at $CLAUDE_CODE_SYMLINK_PATH."
  fi

  as_root ln -sfn "$claude_bin" "$CLAUDE_CODE_SYMLINK_PATH"
  hash -r

  # Verify rather than assume: an unconditional "Linked" log with no check
  # that the link actually resolves is exactly how the self-loop above went
  # unnoticed for three weeks.
  link_version="$("$CLAUDE_CODE_SYMLINK_PATH" --version 2>/dev/null | head -1)"
  [[ -n "$link_version" ]] || die "$CLAUDE_CODE_SYMLINK_PATH does not run after linking to $claude_bin."
  log_ok "Linked $CLAUDE_CODE_SYMLINK_PATH -> $claude_bin ($link_version)"

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
