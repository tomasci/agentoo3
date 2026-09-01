#!/usr/bin/env bash
#
#   install.sh — prepare an Ubuntu server to run this system.
#
# Idempotent: safe to re-run. Each step is a standalone script under scripts/
# and can also be invoked on its own.
#
#   ./install.sh                    # everything
#   ./install.sh --list             # show the steps
#   ./install.sh --dry-run          # print what would happen
#   ./install.sh --skip upgrade     # skip the (slow) full-upgrade
#   ./install.sh --only node,bun    # just those steps
#   ./install.sh --from python      # resume from a step onwards

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT

# shellcheck source=scripts/lib/common.sh
. "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$REPO_ROOT/scripts/lib/config.sh"

# ------------------------------------------------------------------ steps ----
# name : script : description
STEPS=(
  "preflight:00-preflight.sh:Validate the host"
  "upgrade:10-system-upgrade.sh:apt update && full-upgrade"
  "utils:20-install-utils.sh:Base utilities (curl, wget, git, build tools...)"
  "python:30-install-python.sh:Python 3 + venv + uv"
  "node:40-install-node.sh:Node.js LTS + npm"
  "bun:50-install-bun.sh:Bun (latest stable)"
  "claude:55-install-claude-code.sh:Claude Code CLI"
  "postgres:60-install-postgres.sh:PostgreSQL + role/database (+ pgvector)"
  "redis:62-install-redis.sh:Redis, localhost-only, password-protected"
  "tailscale:64-install-tailscale.sh:Tailscale VPN"
  "nginx:66-install-nginx.sh:nginx reverse proxy on the tailnet"
  "backend:68-setup-backend.sh:Backend API + worker (Hono, Agent SDK)"
  "frontend:70-setup-frontend.sh:Generate the API client, build, run as a service"
  "ufw:80-configure-ufw.sh:Firewall rules (runs last)"
  "summary:90-summary.sh:Verify and report"
)

step_name()  { printf '%s' "${1%%:*}"; }
step_file()  { local r="${1#*:}"; printf '%s' "${r%%:*}"; }
step_descr() { printf '%s' "${1##*:}"; }

# ------------------------------------------------------------------- args ----
DRY_RUN=0; VERBOSE=0; ASSUME_YES=0; RESUME=0
ONLY=""; SKIP=""; FROM=""

usage() {
  cat >&2 <<TXT
${C_BOLD}install.sh${C_RESET} — prepare an Ubuntu server for ${APP_NAME}

${C_BOLD}Usage:${C_RESET}
  $INSTALL_SH [options]

${C_BOLD}Options:${C_RESET}
  -l, --list              List the steps and exit
  -n, --dry-run           Show what would run without changing anything
  -y, --yes               Never prompt
  -v, --verbose           Echo every command
      --only  a,b         Run only these steps
      --skip  a,b         Run everything except these steps
      --from  step        Start at this step and run the rest
      --resume            Skip steps already recorded as complete
      --no-upgrade        Shorthand for --skip upgrade
  -h, --help              This text

${C_BOLD}Environment overrides${C_RESET} (see scripts/lib/config.sh):
  NODE_MAJOR=22           Pin the Node major version
  BUN_VERSION=1.1.38      Pin Bun instead of tracking latest
  INSTALL_UV=0            Skip the uv install
  CLAUDE_CODE_CHANNEL=latest  Track every Claude Code release
  TAILSCALE_AUTHKEY=...   Join the tailnet unattended
  NGINX_DOMAIN=x.com      Override the auto-detected MagicDNS server_name
  UFW_TAILSCALE_ONLY=1    Move SSH behind the VPN (Tailscale must be up)
TXT
}

list_steps() {
  printf '\n%sSteps:%s\n' "$C_BOLD" "$C_RESET" >&2
  local s
  for s in "${STEPS[@]}"; do
    printf '  %s%-10s%s %s\n' "$C_CYN" "$(step_name "$s")" "$C_RESET" "$(step_descr "$s")" >&2
  done
  printf '\n' >&2
}

while (( $# )); do
  case "$1" in
    -l|--list)    list_steps; exit 0 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    --only)       ONLY="${2:?--only needs a comma-separated list}"; shift ;;
    --skip)       SKIP="${2:?--skip needs a comma-separated list}"; shift ;;
    --from)       FROM="${2:?--from needs a step name}"; shift ;;
    --resume)     RESUME=1 ;;
    --no-upgrade) SKIP="${SKIP:+$SKIP,}upgrade" ;;
    -h|--help)    usage; exit 0 ;;
    *)            log_error "Unknown option: $1"; usage; exit 2 ;;
  esac
  shift
done

export DRY_RUN VERBOSE ASSUME_YES LOG_FILE LOG_DIR STATE_DIR

# Validate the step names the user gave us, so a typo fails immediately
# instead of silently running nothing.
known_step() {
  local s
  for s in "${STEPS[@]}"; do [[ "$(step_name "$s")" == "$1" ]] && return 0; done
  return 1
}
for n in ${ONLY//,/ } ${SKIP//,/ } $FROM; do
  known_step "$n" || die "Unknown step '$n'. Try --list."
done

in_csv() { [[ ",$1," == *",$2,"* ]]; }

# ------------------------------------------------------------------- run -----
banner() {
  printf '\n%s%s%s\n' "$C_BOLD" "  ${APP_NAME} installer" "$C_RESET" >&2
  printf '  %shost%s %s   %sroot%s %s   %slog%s %s\n' \
    "$C_DIM" "$C_RESET" "$(hostname)" \
    "$C_DIM" "$C_RESET" "$REPO_ROOT" \
    "$C_DIM" "$C_RESET" "$LOG_FILE" >&2
  (( DRY_RUN )) && printf '  %sDRY RUN — nothing will be changed%s\n' "$C_YLW" "$C_RESET" >&2
  printf '\n' >&2
}

banner
started_at=$SECONDS
ran=0 skipped=0
reached_from=0
[[ -z "$FROM" ]] && reached_from=1

for entry in "${STEPS[@]}"; do
  name="$(step_name "$entry")"
  file="$(step_file "$entry")"
  descr="$(step_descr "$entry")"
  path="$SCRIPTS_DIR/$file"

  [[ "$name" == "$FROM" ]] && reached_from=1

  if (( ! reached_from )); then
    log_debug "skip $name (before --from $FROM)"; skipped=$(( skipped + 1 )); continue
  fi
  if [[ -n "$ONLY" ]] && ! in_csv "$ONLY" "$name"; then
    log_debug "skip $name (not in --only)"; skipped=$(( skipped + 1 )); continue
  fi
  if [[ -n "$SKIP" ]] && in_csv "$SKIP" "$name"; then
    log_info "Skipping '$name' (--skip)"; skipped=$(( skipped + 1 )); continue
  fi
  if (( RESUME )) && step_is_done "$name"; then
    log_info "Skipping '$name' (already completed; --resume)"; skipped=$(( skipped + 1 )); continue
  fi

  [[ -f "$path" ]] || die "Missing step script: $path"

  step_started=$SECONDS
  if bash "$path"; then
    (( DRY_RUN )) || step_mark_done "$name"
    ran=$(( ran + 1 ))
    log_debug "step '$name' took $(( SECONDS - step_started ))s"
  else
    rc=$?
    log_error "Step '$name' ($descr) failed with exit $rc."
    log_error "Fix the cause, then resume with:  $INSTALL_SH --from $name"
    log_error "Full log: $LOG_FILE"
    exit "$rc"
  fi
done

elapsed=$(( SECONDS - started_at ))
printf '\n' >&2
log_ok "Done in ${elapsed}s — $ran step(s) run, $skipped skipped."
(( DRY_RUN )) && log_info "This was a dry run; re-run without --dry-run to apply."
exit 0
