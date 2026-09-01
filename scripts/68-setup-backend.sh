#!/usr/bin/env bash
# Backend: install dependencies, run migrations, and start the API and worker.
#
# Two services on purpose. A Claude session runs for minutes and must survive
# past any HTTP request, so the worker owns sessions and the API only talks to
# it through Redis. Restarting the API never kills a running agent.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Backend"

[[ -f "$BACKEND_DIR/package.json" ]] || die "No package.json in $BACKEND_DIR."
have bun || die "bun is not installed. Run: $INSTALL_SH --only bun"

require_root

# Services must not run as root: Claude Code refuses to bypass permissions as
# uid 0, so every session would fail. config.sh picks a dedicated account in
# that case; create it here if it is not there yet.
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  ensure_service_user "$APP_USER" "/home/$APP_USER"
fi

app_home="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)"
[[ -n "$app_home" ]] || die "No home directory for '$APP_USER'."

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would ensure the service account '$APP_USER' exists"
  log_info "[dry-run] would run 'bun install' and migrations in $BACKEND_DIR"
  log_info "[dry-run] would create $PROJECTS_DIR, $SOURCES_DIR and $LIBRARY_DIR"
  log_info "[dry-run] would install ${APP_NAME}-api and ${APP_NAME}-worker services"
  exit 0
fi

run_as_app() { as_user "$APP_USER" env HOME="$app_home" PATH="/usr/local/bin:/usr/bin:/bin" "$@"; }

# --- dependencies -------------------------------------------------------------
log_info "Installing dependencies (bun install)"
if [[ -f "$BACKEND_DIR/bun.lock" ]]; then
  # Never --omit optional deps here: the Agent SDK ships its Claude Code binary
  # as a per-platform optional dependency, and without it the SDK has no runtime.
  run_as_app bash -c "cd '$BACKEND_DIR' && bun install --frozen-lockfile" \
    || die "bun install failed. If dependencies changed, commit the updated lockfile."
else
  log_warn "No lockfile; installing without --frozen-lockfile."
  run_as_app bash -c "cd '$BACKEND_DIR' && bun install" || die "bun install failed."
fi
log_ok "Dependencies installed"

# --- OpenAPI document ---------------------------------------------------------
# Rendered from this machine's Hono app, so the frontend's generated client
# matches the backend actually running here rather than a committed snapshot.
log_info "Rendering the OpenAPI document"
run_as_app bash -c "cd '$BACKEND_DIR' && DATABASE_URL=unused REDIS_URL=unused bun run openapi" \
  || die "Could not render openapi.json. The frontend step needs it to generate its client."
[[ -f "$BACKEND_DIR/openapi.json" ]] || die "openapi.json was not written."
log_ok "Wrote $BACKEND_DIR/openapi.json ($(jq -r '.paths | keys | length' "$BACKEND_DIR/openapi.json" 2>/dev/null || echo '?') paths)"

# --- data directories ---------------------------------------------------------
for dir in "$PROJECTS_DIR" "$SOURCES_DIR" "$LIBRARY_DIR/agents" "$LIBRARY_DIR/skills"; do
  if [[ ! -d "$dir" ]]; then
    as_root install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$dir"
    log_ok "Created $dir"
  fi
done

# Ownership is reconciled every run, not just at creation. An install that used
# to run as root leaves root-owned checkouts, worktrees and a root-owned
# node_modules behind; after switching to a service account the services could
# read them but not write, which surfaces as permission errors deep inside git
# or bun rather than anywhere useful.
for dir in "$PROJECTS_DIR" "$SOURCES_DIR" "$LIBRARY_DIR" "$REPO_ROOT"; do
  [[ -d "$dir" ]] || continue
  if [[ "$(stat -c '%U' "$dir" 2>/dev/null)" != "$APP_USER" ]]; then
    log_info "Reassigning $dir to $APP_USER"
    as_root chown -R "$APP_USER:$APP_USER" "$dir"
    log_ok "Reassigned $dir"
  fi
done

# Seed example agents and skills, but only into an empty library — never
# overwrite prompts the operator has written.
if [[ -d "$REPO_ROOT/library.example" ]] \
   && [[ -z "$(ls -A "$LIBRARY_DIR/agents" 2>/dev/null)" ]] \
   && [[ -z "$(ls -A "$LIBRARY_DIR/skills" 2>/dev/null)" ]]; then
  as_root cp -r "$REPO_ROOT/library.example/agents/." "$LIBRARY_DIR/agents/"
  as_root cp -r "$REPO_ROOT/library.example/skills/." "$LIBRARY_DIR/skills/"
  as_root chown -R "$APP_USER:$APP_USER" "$LIBRARY_DIR"
  log_ok "Seeded $LIBRARY_DIR with example agents and skills"
fi

# The library is worth versioning: agent prompts are the part you iterate on.
if [[ ! -d "$LIBRARY_DIR/.git" ]]; then
  if run_as_app bash -c "cd '$LIBRARY_DIR' && git init -q -b main" 2>/dev/null; then
    log_ok "Initialised $LIBRARY_DIR as a git repo (your prompts get history)"
  else
    log_warn "Could not git-init $LIBRARY_DIR; not fatal."
  fi
fi

# --- environment --------------------------------------------------------------
env_set "$ENV_FILE" BACKEND_HOST "$BACKEND_HOST"
env_set "$ENV_FILE" BACKEND_PORT "$BACKEND_PORT"
env_set "$ENV_FILE" PROJECTS_DIR "$PROJECTS_DIR"
env_set "$ENV_FILE" LIBRARY_DIR  "$LIBRARY_DIR"
env_set "$ENV_FILE" SOURCES_DIR  "$SOURCES_DIR"
env_set "$ENV_FILE" WORKER_CONCURRENCY "$WORKER_CONCURRENCY"
env_fix_owner "$ENV_FILE"

# --- migrations ---------------------------------------------------------------
db_url="$(env_get "$ENV_FILE" DATABASE_URL || true)"
if [[ -z "$db_url" ]]; then
  die "No DATABASE_URL in $ENV_FILE. Run: $INSTALL_SH --only postgres"
fi

log_info "Applying database migrations"
run_as_app bash -c "cd '$BACKEND_DIR' && DATABASE_URL='$db_url' bun run db:migrate" \
  || die "Migrations failed. Check: journalctl -u ${APP_NAME}-api -n 50"
log_ok "Migrations applied"

# --- services -----------------------------------------------------------------
if ! has_systemd; then
  log_warn "systemd unavailable; not installing services."
  log_warn "Start them yourself:  cd $BACKEND_DIR && bun run start  /  bun run start:worker"
  exit 0
fi

write_unit() {
  local name="$1" description="$2" exec_cmd="$3"
  local unit="/etc/systemd/system/${name}.service"
  local tmp; tmp="$(mktemp)"
  cat >"$tmp" <<UNIT
# Managed by ${APP_NAME}'s installer (scripts/70-setup-backend.sh).
[Unit]
Description=${description}
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${exec_cmd}
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${name}

[Install]
WantedBy=multi-user.target
UNIT
  as_root install -m 0644 "$tmp" "$unit"
  rm -f "$tmp"
  log_ok "Wrote $unit"
}

bun_bin="$(command -v bun)"

write_unit "${APP_NAME}-api" "${APP_NAME} API (Hono)" "$bun_bin src/index.ts"

# The worker runs agents, which need a Claude credential and a writable home for
# ~/.claude. ProtectHome would break both, so it is deliberately not set here.
write_unit "${APP_NAME}-worker" "${APP_NAME} worker (Claude sessions, project setup)" \
  "$bun_bin src/worker.ts"

as_root systemctl daemon-reload
svc_enable_now "${APP_NAME}-api"
svc_enable_now "${APP_NAME}-worker"
svc_restart "${APP_NAME}-api"
svc_restart "${APP_NAME}-worker"

# --- verify -------------------------------------------------------------------
for _ in $(seq 1 25); do
  if curl -fsS -o /dev/null --max-time 2 "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" 2>/dev/null; then
    log_ok "API responding on http://${BACKEND_HOST}:${BACKEND_PORT}/api/health"
    if ! curl -fsS --max-time 2 "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" 2>/dev/null \
         | grep -q '"claudeCredential":true'; then
      log_warn "No Claude credential yet — the API runs but agents cannot."
      log_warn "See 'Authenticating on a headless server' in the README."
    fi
    log_ok "Backend ready"
    exit 0
  fi
  sleep 0.4
done

log_error "API started but did not answer on ${BACKEND_HOST}:${BACKEND_PORT}."
log_error "Check: journalctl -u ${APP_NAME}-api -n 50 --no-pager"
die "Backend is not serving."
