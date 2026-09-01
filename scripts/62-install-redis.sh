#!/usr/bin/env bash
# Redis, bound to localhost and password-protected.
#
# The password matters even on 127.0.0.1: it stops any local process, or an
# SSRF bug in the app, from talking to Redis unauthenticated.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Redis"
require_root

apt_install "${PKGS_REDIS[@]}"

REDIS_CONF=/etc/redis/redis.conf

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would configure $REDIS_CONF and write REDIS_URL to $ENV_FILE"
  exit 0
fi

[[ -f "$REDIS_CONF" ]] || die "$REDIS_CONF not found; unexpected redis-server layout."

# --- credentials --------------------------------------------------------------
pw="$REDIS_PASSWORD"
[[ -z "$pw" ]] && pw="$(env_get "$ENV_FILE" REDIS_PASSWORD || true)"
if [[ -z "$pw" ]]; then
  pw="$(gen_secret 32)"
  log_info "Generated a new Redis password"
else
  log_info "Reusing the existing Redis password"
fi

# --- configuration ------------------------------------------------------------
# Appended as a managed block: in redis.conf the last occurrence of a directive
# wins, so this overrides the shipped defaults without editing them in place.
{
  printf 'bind %s -::1\n' "$REDIS_HOST"
  printf 'port %s\n' "$REDIS_PORT"
  printf 'protected-mode yes\n'
  printf 'requirepass %s\n' "$pw"
  printf 'supervised systemd\n'
  if [[ -n "$REDIS_MAXMEMORY" ]]; then
    printf 'maxmemory %s\n' "$REDIS_MAXMEMORY"
    printf 'maxmemory-policy %s\n' "$REDIS_MAXMEMORY_POLICY"
  fi
} | managed_block "$REDIS_CONF" 0640

# The package ships this file as root:redis 0640; installing it back must not
# change that or redis-server loses read access and refuses to start.
as_root chown root:redis "$REDIS_CONF" 2>/dev/null || true

svc_enable_now redis-server
svc_restart redis-server

# --- verify -------------------------------------------------------------------
if ! svc_is_active redis-server; then
  die "redis-server failed to start. Check: journalctl -u redis-server -n 50"
fi

if [[ "$(REDISCLI_AUTH="$pw" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null)" == "PONG" ]]; then
  log_ok "Verified authenticated connection to Redis"
else
  die "Redis is running but did not answer an authenticated PING."
fi

# An unauthenticated ping must now be refused.
if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>&1 | grep -qi 'NOAUTH\|Authentication'; then
  log_ok "Unauthenticated access is refused"
else
  log_warn "Redis answered without a password — check $REDIS_CONF"
fi

env_set "$ENV_FILE" REDIS_HOST     "$REDIS_HOST"
env_set "$ENV_FILE" REDIS_PORT     "$REDIS_PORT"
env_set "$ENV_FILE" REDIS_PASSWORD "$pw"
env_set "$ENV_FILE" REDIS_URL      "redis://:${pw}@${REDIS_HOST}:${REDIS_PORT}/0"
env_fix_owner "$ENV_FILE"

log_ok "Redis ready (credentials in $ENV_FILE)"
