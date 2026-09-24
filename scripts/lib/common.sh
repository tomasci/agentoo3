#!/usr/bin/env bash
# Shared helpers for every installer script.
# Source this file; do not execute it.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ -n "${_AGENTOO_COMMON_LOADED:-}" ]] && return 0
_AGENTOO_COMMON_LOADED=1

set -Eeuo pipefail

# ---------------------------------------------------------------- paths ------

_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd -- "$_common_dir/../.." && pwd)}"
# shellcheck disable=SC2034  # consumed by install.sh
SCRIPTS_DIR="$REPO_ROOT/scripts"
LOG_DIR="${LOG_DIR:-$REPO_ROOT/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/install.log}"
STATE_DIR="${STATE_DIR:-$REPO_ROOT/.state}"
# Absolute, because the operator's shell is rarely inside the install directory
# — bootstrap.sh clones to /opt/agentoo and they stay in their home dir.
INSTALL_SH="${INSTALL_SH:-$REPO_ROOT/install.sh}"
# Operator choices that must survive a later plain re-run.
SETTINGS_FILE="${SETTINGS_FILE:-$STATE_DIR/settings.env}"

mkdir -p "$LOG_DIR" "$STATE_DIR" 2>/dev/null || true

# --------------------------------------------------------------- colours ----

if [[ -t 2 && "${NO_COLOR:-}" == "" && "${TERM:-dumb}" != "dumb" ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m';  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m';  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'
  C_BLU=$'\033[34m';  C_CYN=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""
  C_RED="";   C_GRN=""; C_YLW=""
  C_BLU="";   C_CYN=""
fi

# --------------------------------------------------------------- logging ----

# Everything goes to stderr so a script can still `echo` a real value on stdout.
_log() {
  local tag="$1" colour="$2"; shift 2
  printf '%s%-5s%s %s\n' "$colour" "$tag" "$C_RESET" "$*" >&2
  printf '%s [%-5s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$tag" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

log_info()  { _log "INFO"  "$C_BLU" "$@"; }
log_ok()    { _log "OK"    "$C_GRN" "$@"; }
log_warn()  { _log "WARN"  "$C_YLW" "$@"; }
log_error() { _log "ERROR" "$C_RED" "$@"; }
log_debug() { [[ "${VERBOSE:-0}" == "1" ]] && _log "DEBUG" "$C_DIM" "$@"; return 0; }

log_step() {
  printf '\n%s==>%s %s%s%s\n' "$C_CYN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2
  printf '\n=== %s === %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

die() { log_error "$@"; exit 1; }

# ------------------------------------------------------------ execution -----

# Run a command, honouring DRY_RUN. Logs the command line at DEBUG.
run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*" >&2
    return 0
  fi
  log_debug "\$ $*"
  "$@"
}

# Root privileges: no-op when already root, otherwise prefix with sudo.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  _SUDO=()
else
  _SUDO=(sudo)
fi

as_root() { run ${_SUDO[@]+"${_SUDO[@]}"} "$@"; }

# Run a command as some other account (e.g. `postgres`). Not expressible with
# as_root: `sudo -u X` has no meaning once _SUDO is empty because we are root.
as_user() {
  local u="$1"; shift
  if [[ "$(id -un)" == "$u" ]]; then
    run "$@"
  elif have sudo && [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    run sudo -u "$u" "$@"
  elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    run runuser -u "$u" -- "$@"      # util-linux; always present
  else
    die "Cannot run as '$u': need root or sudo."
  fi
}

# True when we can obtain root without an interactive prompt.
can_sudo() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] && return 0
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n true >/dev/null 2>&1
}

require_root() {
  can_sudo && return 0
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_warn "No passwordless root; continuing anyway because --dry-run."
    return 0
  fi
  # An interactive password is acceptable when a human is running this.
  if have sudo && [[ -t 0 || -e /dev/tty ]] && sudo -v 2>/dev/null; then
    return 0
  fi
  die "This step needs root. Re-run as root, or grant passwordless sudo to '$(id -un)'."
}

have() { command -v "$1" >/dev/null 2>&1; }

# A whole number, or the fallback — with a warning when the value was not empty.
#
# Guards arithmetic. `set -u` is on, and inside (( )) bash resolves a bare word
# as a variable name, so `(( x < SWAP_MAX_MB ))` with SWAP_MAX_MB=abc dies with
# "abc: unbound variable" and takes the whole installer down with it. Every knob
# an operator can set from the environment and we then do arithmetic on has to
# come through here.
#
#   SWAP_MAX_MB="$(num_or SWAP_MAX_MB "${SWAP_MAX_MB:-}" 8192)"
num_or() {
  local name="$1" value="${2:-}" fallback="$3"
  if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; return 0; fi
  [[ -n "$value" ]] && log_warn "$name='$value' is not a whole number; using $fallback."
  printf '%s' "$fallback"
}

# True when the current user can read/write this path without escalating.
writable_by_me() {
  local f="$1"
  if [[ -e "$f" ]]; then
    [[ -r "$f" && -w "$f" ]]
  else
    [[ -w "$(dirname -- "$f")" ]]
  fi
}

confirm() {
  [[ "${ASSUME_YES:-0}" == "1" ]] && return 0
  local reply
  printf '%s?%s %s [y/N] ' "$C_YLW" "$C_RESET" "$*" >&2
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ------------------------------------------------------- interactive I/O -----
#
# Separate from confirm() above (which is a plain y/N gate): these read actual
# values, so several can be asked in a row, and a test can feed multiple
# answers from one fixture file instead of a real terminal.

PROMPT_TTY="${PROMPT_TTY:-/dev/tty}"      # test seam

# True when a prompt can be shown and answered right now: not --yes, not a dry
# run, and PROMPT_TTY actually opens. Opens it ONCE into _PROMPT_FD — reused by
# every ask()/ask_secret() call this run, rather than reopened (and, for a
# plain file, rewound) per question.
can_prompt() {
  [[ "${ASSUME_YES:-0}" == "1" ]] && return 1
  [[ "${DRY_RUN:-0}" == "1" ]] && return 1
  if [[ -n "${_PROMPT_FD:-}" ]]; then
    [[ "$_PROMPT_FD" != "-1" ]]
    return
  fi
  # Braced, not a bare `exec ... 2>/dev/null`: a bare exec with no command
  # applies every trailing redirection to the shell itself, permanently — it
  # would silence this script's own stderr (every log_* line) for the rest of
  # the run the moment PROMPT_TTY fails to open. Wrapping it in `{ ; }` scopes
  # the redirect to just this group, so fd 2 is restored right after.
  if { exec {_PROMPT_FD}<"$PROMPT_TTY"; } 2>/dev/null; then
    return 0
  fi
  _PROMPT_FD=-1
  return 1
}

# ask NAME "Question" [default] — printf -v's NAME with the answer. The
# question goes to stderr, like every other log line, so stdout stays free for
# a real return value; the answer itself is read from _PROMPT_FD, which
# can_prompt must have opened first.
ask() {
  local name="$1" question="$2" default="${3:-}" reply prompt="$2"
  [[ -n "$default" ]] && prompt="$prompt [$default]"
  printf '%s?%s %s: ' "$C_YLW" "$C_RESET" "$prompt" >&2
  read -r -u "$_PROMPT_FD" reply || reply=""
  [[ -z "$reply" ]] && reply="$default"
  printf -v "$name" '%s' "$reply"
}

# Like ask(), but the answer is never echoed back and never logged — for
# secrets. `read -s` suppresses the echo only when _PROMPT_FD is a real
# terminal; reading from a plain file (a test fixture) has nothing to echo
# anyway, so this is safe either way.
ask_secret() {
  local name="$1" question="$2" reply
  printf '%s?%s %s: ' "$C_YLW" "$C_RESET" "$question" >&2
  read -rs -u "$_PROMPT_FD" reply || reply=""
  printf '\n' >&2
  printf -v "$name" '%s' "$reply"
}

# ------------------------------------------------------------------- apt -----

export DEBIAN_FRONTEND=noninteractive
# Stops `needrestart` from opening a full-screen prompt mid-upgrade on servers.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Keep existing config files on upgrade instead of asking.
APT_OPTS=(
  -y
  -o Dpkg::Options::=--force-confdef
  -o Dpkg::Options::=--force-confold
)

# True while something else holds the dpkg/apt lock.
#
# `fuser` (psmisc) is the accurate test but is not guaranteed to be installed
# before the utils step, so fall back to looking for the processes themselves.
# Note that dpkg takes fcntl locks, which `flock` cannot observe.
_apt_locked() {
  if have fuser; then
    ${_SUDO[@]+"${_SUDO[@]}"} fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 && return 0
    ${_SUDO[@]+"${_SUDO[@]}"} fuser /var/lib/apt/lists/lock    >/dev/null 2>&1 && return 0
    return 1
  fi
  pgrep -x 'apt|apt-get|dpkg|aptitude|unattended-upgr' >/dev/null 2>&1
}

# A freshly booted VPS is often still running cloud-init or unattended-upgrades,
# which hold the dpkg lock. Wait it out rather than failing.
apt_wait_for_lock() {
  [[ "${DRY_RUN:-0}" == "1" ]] && return 0
  local waited=0 max="${APT_LOCK_TIMEOUT:-300}"
  while _apt_locked; do
    if (( waited == 0 )); then
      log_warn "Another package manager holds the apt lock; waiting up to ${max}s..."
    fi
    (( waited >= max )) && die "apt lock still held after ${max}s. Try again shortly."
    sleep 5; waited=$(( waited + 5 ))
  done
  (( waited > 0 )) && log_ok "apt lock released after ${waited}s"
  return 0
}

pkg_installed() {
  dpkg-query -W -f='${db:Status-Status}\n' "$1" 2>/dev/null | grep -qx installed
}

apt_update() {
  apt_wait_for_lock
  log_info "Refreshing package lists"
  as_root apt-get update -qq
}

# Install only the packages that are actually missing.
apt_install() {
  local missing=()
  local p
  for p in "$@"; do
    if pkg_installed "$p"; then
      log_debug "already installed: $p"
    else
      missing+=("$p")
    fi
  done

  if (( ${#missing[@]} == 0 )); then
    log_ok "nothing to install (${#@} package(s) already present)"
    return 0
  fi

  log_info "Installing: ${missing[*]}"
  apt_wait_for_lock
  as_root apt-get install "${APT_OPTS[@]}" "${missing[@]}"
}

# ------------------------------------------------------------ versions ------

# major_of v24.20.0 -> 24
major_of() { local v="${1#v}"; printf '%s' "${v%%.*}"; }

# version_gte 1.4.0 1.2.0 -> true
version_gte() {
  [[ "$1" == "$2" ]] && return 0
  local lowest
  lowest="$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | head -n1)"
  [[ "$lowest" == "${2#v}" ]]
}

# ----------------------------------------------------------- step state -----

step_marker()      { printf '%s/step-%s.done' "$STATE_DIR" "$1"; }
step_is_done()     { [[ -f "$(step_marker "$1")" ]]; }
step_mark_done()   { date -Is >"$(step_marker "$1")" 2>/dev/null || true; }

# ------------------------------------------------------------- secrets ------

# Random alphanumeric string. Alnum-only on purpose: these values end up inside
# SQL literals, URLs and env files, where quoting mistakes are easy to make.
gen_secret() {
  local n="${1:-32}"
  # `head -c` closes the pipe as soon as it has enough bytes, so the producer
  # takes SIGPIPE; that is expected, not an error.
  if have openssl; then
    openssl rand -base64 $(( n * 2 )) 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c "$n" || true
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$n" || true
  fi
  printf '\n'
}

# ------------------------------------------------------------ env files -----

# env_get FILE KEY -> value on stdout, non-zero when absent.
env_get() {
  local file="$1" key="$2" val
  [[ -r "$file" ]] || return 1
  val="$(sed -n "s/^[[:space:]]*${key}=//p" "$file" | tail -1)"
  [[ -n "$val" ]] || return 1
  printf '%s\n' "$val"
}

# env_set FILE KEY VALUE — idempotently set KEY=VALUE, creating FILE at 0600.
# Values are passed through the environment rather than `awk -v`, which would
# interpret backslash escapes.
env_set() {
  local file="$1" key="$2" val="$3" tmp
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_info "[dry-run] would set ${key} in ${file}"
    return 0
  fi
  if [[ ! -f "$file" ]]; then
    install -m 600 /dev/null "$file"
  fi
  tmp="$(mktemp)"
  ENV_KEY="$key" ENV_VAL="$val" awk '
    BEGIN { k = ENVIRON["ENV_KEY"]; v = ENVIRON["ENV_VAL"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"          # preserve the original inode, mode and owner
  rm -f "$tmp"
  chmod 600 "$file" 2>/dev/null || true
}

# Give the env file back to the human who ran the installer under sudo.
env_fix_owner() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || return 0
  local owner="${SUDO_USER:-}"
  [[ -n "$owner" ]] || return 0
  chown "$owner" "$file" 2>/dev/null || true
}

# ------------------------------------------------------ sticky settings -----
#
# Some choices must not evaporate between runs. Without this, a deliberate
#   UFW_TAILSCALE_ONLY=1 ./install.sh --only ufw
# would be undone by a later plain `bootstrap.sh | sudo bash`, silently
# re-opening public SSH. Same for a hand-set NGINX_DOMAIN, which a later run
# would otherwise replace with the auto-detected tailnet name.
#
# config.sh records "<NAME>_EXPLICIT" before applying its default, so we can
# tell "the operator asked for this" apart from "this is just the default".

setting_remember() {
  local name="$1" value="$2"
  env_set "$SETTINGS_FILE" "$name" "$value"
  log_debug "remembered $name=$value in $SETTINGS_FILE"
}

setting_recall() { env_get "$SETTINGS_FILE" "$1"; }

# If the operator did not set NAME this run, restore what an earlier run stored.
sticky_recall() {
  local name="$1" explicit="${1}_EXPLICIT" remembered
  if [[ -n "${!explicit:-}" ]]; then
    log_debug "$name set explicitly this run; not recalling"
    return 0
  fi
  remembered="$(setting_recall "$name" || true)"
  [[ -n "$remembered" ]] || return 0
  printf -v "$name" '%s' "$remembered"
  log_info "Using remembered $name=$remembered (set on an earlier run)"
}

# ------------------------------------------------------- managed blocks -----

# Insert or replace a delimited block in a system config file. Content on stdin.
# Re-running replaces the previous block instead of appending a second copy.
#
#   managed_block /etc/redis/redis.conf 0640 <<'EOF'
#   requirepass secret
#   EOF
managed_block() {
  local file="$1" mode="${2:-0644}"
  local tag="${MANAGED_TAG:-$APP_NAME}"
  local begin="# >>> ${tag} managed >>>"
  local end="# <<< ${tag} managed <<<"
  local content tmp
  content="$(cat)"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_info "[dry-run] would update the managed block in $file"
    return 0
  fi

  # Only escalate when the target genuinely needs it, so this stays usable on
  # files the invoking user already owns.
  local -a SU=()
  writable_by_me "$file" || SU=(${_SUDO[@]+"${_SUDO[@]}"})

  tmp="$(mktemp)"
  if ${SU[@]+"${SU[@]}"} test -f "$file"; then
    ${SU[@]+"${SU[@]}"} cat "$file" \
      | BEGIN_M="$begin" END_M="$end" awk '
          BEGIN { b = ENVIRON["BEGIN_M"]; e = ENVIRON["END_M"]; skip = 0 }
          $0 == b { skip = 1; next }
          $0 == e { skip = 0; next }
          skip == 0 { print }
        ' >"$tmp"
  fi
  {
    printf '%s\n' "$begin"
    printf '%s\n' "$content"
    printf '%s\n' "$end"
  } >>"$tmp"

  run ${SU[@]+"${SU[@]}"} install -m "$mode" "$tmp" "$file"
  rm -f "$tmp"
}

# ------------------------------------------------------------------ https ---
#
# Backs the optional custom-domain HTTPS in scripts/85-configure-https.sh, and
# the TLS-or-not decision scripts/66-install-nginx.sh makes on every run.
# LETSENCRYPT_DIR comes from lib/config.sh, sourced after this file everywhere
# it matters — same deferred-lookup pattern managed_block() above already
# relies on for $APP_NAME.

# A domain this installer will attempt to get a Let's Encrypt certificate for:
# a lowercase FQDN, at most 253 characters, at least two labels, each label
# [a-z0-9-] and never starting or ending with '-'. Rejects '*.' wildcards,
# '*.ts.net' (Tailscale's own name space has its own certificate story), bare
# IPv4 literals, and anything non-ASCII — an internationalised name has to
# arrive already punycoded (xn--...), not as raw UTF-8.
https_domain_valid() {
  local d="$1" label
  (( ${#d} >= 1 && ${#d} <= 253 )) || return 1
  [[ "$d" == "${d,,}" ]] || return 1
  # No [[:ascii:]] bracket class in glibc's regex, so check byte range
  # directly in the C locale instead: anything outside printable ASCII
  # (space through tilde) is rejected.
  LC_ALL=C grep -q '[^ -~]' <<<"$d" && return 1
  case "$d" in
    *'*'*)    return 1 ;;
    *.ts.net) return 1 ;;
  esac
  [[ "$d" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && return 1   # bare IPv4 literal
  local IFS=.
  local -a labels=($d)
  (( ${#labels[@]} >= 2 )) || return 1
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  done
  return 0
}

# True when a live certificate (not just a renewal placeholder) exists for
# DOMAIN. Deliberately never through run() — this has to answer truthfully
# even under DRY_RUN=1, which is exactly when callers most need to know
# whether they may claim "would render TLS". `sudo -n` rather than as_root
# when not root: certbot's certs are root-only, but this must never itself
# prompt for a password just to decide what a dry run would print.
https_cert_present() {
  local d="$1"
  local dir="${LETSENCRYPT_DIR}/live/$d"
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    [[ -s "$dir/fullchain.pem" && -s "$dir/privkey.pem" ]]
    return
  fi
  have sudo || return 1
  sudo -n test -s "$dir/fullchain.pem" 2>/dev/null && sudo -n test -s "$dir/privkey.pem" 2>/dev/null
}

# 0 on any HTTP reply at all, including an error status — this only proves
# nginx is listening and terminating TLS for DOMAIN, not that the app behind
# it is healthy. --resolve pins the connection to this host regardless of what
# DNS says right now, so it works before the Cloudflare A record has
# propagated, or when it deliberately points elsewhere.
https_probe() {
  local d="$1"
  curl -sS -o /dev/null --max-time 5 --resolve "${d}:443:127.0.0.1" "https://${d}/"
}

# ------------------------------------------------------------ tailscale -----

# The node's MagicDNS name (host.tailnet-xxxx.ts.net), with the trailing dot
# Tailscale reports stripped. Non-zero when Tailscale is down or MagicDNS is off.
tailscale_dns_name() {
  have tailscale || return 1
  local json name
  json="$(tailscale status --json 2>/dev/null)" || return 1
  [[ -n "$json" ]] || return 1
  if have jq; then
    name="$(printf '%s' "$json" | jq -r '.Self.DNSName // empty' 2>/dev/null)"
  fi
  # jq is installed by the utils step, but do not depend on it having run.
  if [[ -z "${name:-}" ]]; then
    name="$(printf '%s' "$json" | tr ',' '\n' | grep -m1 '"DNSName"' \
            | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  fi
  name="${name%.}"
  [[ -n "$name" ]] || return 1
  printf '%s\n' "$name"
}

# Every address this node answers on: MagicDNS name first, then IPs.
tailscale_endpoints() {
  local name ip
  name="$(tailscale_dns_name || true)"
  [[ -n "$name" ]] && printf '%s\n' "$name"
  while read -r ip; do
    [[ -n "$ip" ]] && printf '%s\n' "$ip"
  done < <(tailscale ip 2>/dev/null || true)
}

# Format one endpoint as a URL, bracketing IPv6 as the syntax requires.
tailscale_url() {
  local host="$1" scheme="${2:-http}"
  case "$host" in
    *:*) printf '%s://[%s]/\n' "$scheme" "$host" ;;
    *)   printf '%s://%s/\n' "$scheme" "$host" ;;
  esac
}

# ------------------------------------------------------------- services -----

# systemd is absent in most containers; degrade to a warning rather than dying,
# so the rest of the install still completes.
has_systemd() { [[ -d /run/systemd/system ]]; }

svc_is_active()  { has_systemd && systemctl is-active  --quiet "$1"; }
svc_is_enabled() { has_systemd && systemctl is-enabled --quiet "$1" 2>/dev/null; }

svc_enable_now() {
  local svc="$1"
  if ! has_systemd; then
    log_warn "systemd unavailable; cannot enable '$svc'. Start it manually."
    return 0
  fi
  as_root systemctl enable --now "$svc"
}

svc_start() {
  local svc="$1"
  has_systemd || { log_warn "systemd unavailable; cannot start '$svc'."; return 0; }
  as_root systemctl start "$svc"
}

svc_restart() {
  local svc="$1"
  has_systemd || { log_warn "systemd unavailable; cannot restart '$svc'."; return 0; }
  as_root systemctl restart "$svc"
}

svc_reload() {
  local svc="$1"
  has_systemd || { log_warn "systemd unavailable; cannot reload '$svc'."; return 0; }
  as_root systemctl reload "$svc"
}

# -------------------------------------------------------------- tracing -----

_on_err() {
  local code=$? line=${BASH_LINENO[0]:-?} src=${BASH_SOURCE[1]:-?}
  log_error "failed with exit $code at ${src##*/}:${line}"
  log_error "full log: $LOG_FILE"
  exit "$code"
}
trap _on_err ERR

# ---------------------------------------------------------- service account ---

# Make sure the account the services run as exists, with a home directory.
#
# Needed because APP_USER falls back to a dedicated account when the installer
# would otherwise run everything as root, and that account will not exist on a
# fresh box. A system account: no login shell, no password, nothing to log in
# with. The home directory is not optional — bun, git and the Claude CLI all
# write under $HOME, and a service with a home it cannot write to fails in
# confusing ways much later.
ensure_service_user() {
  local user="$1" home="${2:-/home/$1}"

  if id -u "$user" >/dev/null 2>&1; then
    local existing
    existing="$(getent passwd "$user" | cut -d: -f6)"
    if [[ -z "$existing" || ! -d "$existing" ]]; then
      as_root install -d -o "$user" -g "$user" -m 0755 "$home"
      as_root usermod -d "$home" "$user"
      log_ok "Gave $user a home directory at $home"
    fi
    return 0
  fi

  as_root useradd --system --create-home --home-dir "$home" \
    --shell /usr/sbin/nologin --user-group "$user" \
    || die "Could not create the service account '$user'."
  log_ok "Created the service account $user ($home)"
}

# Hand directories to the account the services run as.
#
# Must happen *before* anything runs as that account. An install that used to run
# as root leaves a root-owned node_modules behind, and bun cannot then replace
# the symlinks in node_modules/.bin — it reports "Failed to link <pkg>: EEXIST",
# because the symlink exists and removing it is denied. Missing directories are
# skipped: they are created with the right owner later.
#
# The top-level check below only ever caught a directory that bootstrap.sh (or
# an earlier root run) left wholesale-owned by root. It missed the case a
# `sudo -u agentoo git switch <branch>` in /opt/agentoo just hit in the wild:
# bootstrap.sh updates an existing clone by running `git fetch`/`checkout` as
# root (see its clone/update block), and git only ever rewrites the files and
# directories a fetch or checkout actually touches — it never re-owns the
# directory it was invoked in. So REPO_ROOT itself stayed agentoo-owned from
# an earlier chown while everything an update touched underneath, including
# `.git/objects`, was left root-owned. The top-level-only check above sees
# REPO_ROOT and declares the tree fine, so it never repaired any of that, and
# the next `git switch` run as the app user could not replace files inside
# those root-owned directories.
#
# So REPO_ROOT additionally gets a deep check: `find ... -print -quit` stops
# at the first path not owned by $user, which is cheap when the tree is
# broken — the case this exists for — but on a tree that is already fully
# correct there is no shortcut: proving "nothing is wrong" means visiting
# every entry. That cost is deliberately paid only for REPO_ROOT, not for
# every directory this may be called with. PROJECTS_DIR (and SOURCES_DIR,
# LIBRARY_DIR, ATTACHMENTS_DIR, SSH_KEYS_DIR) can hold many project worktrees
# with their own node_modules, files written by project containers, and the
# editor feature's PROJECTS_DIR/.editor runtime directory — a full walk there
# on every install run would be slow, and something other than $user owning a
# file in there is routine, not a bug: a project's compose stack can bind-
# mount a Postgres data directory owned by uid 999 or 70, or leave files a
# container wrote as root. They are also gitignored (see .gitignore), so
# bootstrap.sh's root-run git commands never write inside them — the failure
# this exists for cannot occur there. Even though they default to living
# physically inside REPO_ROOT, the deep check prunes them out by path for
# that same reason.
#
# The repair has to honour that exact same prune list, not just the
# detection — an earlier version of this found the mismatch correctly and
# then repaired it with a plain `chown -R "$dir"`, which, having ignored the
# prune list, re-owned every project's runtime data underneath REPO_ROOT
# anyway: precisely the hazard the prune exists to avoid. So the pruning
# `find` expression is built once and shared verbatim by both: detection
# stops at the first hit (`-print -quit`), so it stays cheap; repair instead
# walks to completion and re-owns every hit in place (`-exec chown -h ... {}
# +`), never touching a path the prune excluded. `-h` so a symlink under
# REPO_ROOT that happens to point at a pruned directory, or outside the tree
# entirely, has its own ownership fixed rather than whatever it points to.
#
# The top-level fast path below is unrelated and unchanged: it only fires
# when REPO_ROOT *itself* is not owned by $user — a tree left wholesale-root,
# e.g. a fresh clone never handed to the app user at all — and a plain
# recursive chown of the whole directory is correct there: nothing under it
# is project data yet, since install.sh has not had a chance to create any.
reconcile_ownership() {
  local user="$1"; shift
  local dir
  for dir in "$@"; do
    [[ -d "$dir" ]] || continue

    if [[ "$(stat -c '%U' "$dir" 2>/dev/null)" != "$user" ]]; then
      log_info "Reassigning $dir to $user"
      as_root chown -R "$user:$user" "$dir"
      log_ok "Reassigned $dir"
      continue
    fi

    # Deep check: REPO_ROOT only — see the comment above this function.
    [[ "$dir" == "${REPO_ROOT:-}" ]] || continue

    local -a prune_expr=()
    local sibling first=1
    for sibling in "${PROJECTS_DIR:-}" "${SOURCES_DIR:-}" "${LIBRARY_DIR:-}" \
                   "${ATTACHMENTS_DIR:-}" "${SSH_KEYS_DIR:-}"; do
      [[ -n "$sibling" ]] || continue
      if (( first )); then
        prune_expr+=( "(" -path "$sibling" ); first=0
      else
        prune_expr+=( -o -path "$sibling" )
      fi
    done
    (( first )) || prune_expr+=( ")" -prune -o )

    local offender
    offender="$(find "$dir" "${prune_expr[@]}" "!" -user "$user" -print -quit 2>/dev/null)" || true
    if [[ -n "$offender" ]]; then
      log_info "Found paths under $dir not owned by $user (e.g. $offender); reassigning"
      as_root find "$dir" "${prune_expr[@]}" "!" -user "$user" -exec chown -h "$user:$user" {} +
      log_ok "Reassigned mismatched paths under $dir"
    fi
  done
}
