#!/usr/bin/env bash
# Frontend: install dependencies, build, and run the built output as a service.
#
# Deliberately not `vite preview` — Vite says that is not a production server.
# The build is served by a small Bun static server (frontend/server.ts) behind
# nginx, which is what makes http://<tailnet-ip>/ stop returning 502.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Frontend"

[[ -f "$FRONTEND_DIR/package.json" ]] || die "No package.json in $FRONTEND_DIR."
have bun || die "bun is not installed. Run: $INSTALL_SH --only bun"

require_root

app_home="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)"
[[ -n "$app_home" ]] || die "No home directory for '$APP_USER'."

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would run 'bun install' and 'bun run build' in $FRONTEND_DIR"
  log_info "[dry-run] would install and start the ${APP_NAME}-frontend service"
  exit 0
fi

# --- dependencies -------------------------------------------------------------
# As APP_USER with HOME set, so node_modules and bun's cache are not left
# root-owned in a tree the service user has to write to later.
log_info "Installing dependencies (bun install)"
run_as_app() { as_user "$APP_USER" env HOME="$app_home" PATH="/usr/local/bin:/usr/bin:/bin" "$@"; }

if [[ -f "$FRONTEND_DIR/bun.lock" || -f "$FRONTEND_DIR/bun.lockb" ]]; then
  # Fail rather than silently resolving different versions than were tested.
  run_as_app bash -c "cd '$FRONTEND_DIR' && bun install --frozen-lockfile" \
    || die "bun install failed. If dependencies changed intentionally, commit the updated lockfile."
else
  log_warn "No lockfile found; installing without --frozen-lockfile."
  run_as_app bash -c "cd '$FRONTEND_DIR' && bun install" || die "bun install failed."
fi
log_ok "Dependencies installed"

# --- build --------------------------------------------------------------------
log_info "Building for production (bun run build)"
run_as_app bash -c "cd '$FRONTEND_DIR' && bun run build" || die "Frontend build failed."
[[ -f "$FRONTEND_DIR/dist/index.html" ]] || die "Build reported success but $FRONTEND_DIR/dist/index.html is missing."
log_ok "Built $(du -sh "$FRONTEND_DIR/dist" 2>/dev/null | cut -f1) into $FRONTEND_DIR/dist"

# --- record the ports the app and nginx must agree on -------------------------
env_set "$ENV_FILE" FRONTEND_HOST "$FRONTEND_HOST"
env_set "$ENV_FILE" FRONTEND_PORT "$FRONTEND_PORT"
env_fix_owner "$ENV_FILE"

# --- service ------------------------------------------------------------------
if ! has_systemd; then
  log_warn "systemd unavailable; not installing a service."
  log_warn "Start it yourself:  cd $FRONTEND_DIR && bun run start"
  exit 0
fi

unit="/etc/systemd/system/${APP_NAME}-frontend.service"
tmp_unit="$(mktemp)"
cat >"$tmp_unit" <<UNIT
# Managed by ${APP_NAME}'s installer (scripts/68-setup-frontend.sh).
[Unit]
Description=${APP_NAME} frontend (static build served by Bun)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${FRONTEND_DIR}
# '-' so a missing .env does not stop the unit from starting.
EnvironmentFile=-${ENV_FILE}
Environment=NODE_ENV=production
Environment=FRONTEND_HOST=${FRONTEND_HOST}
Environment=FRONTEND_PORT=${FRONTEND_PORT}
ExecStart=$(command -v bun) run server.ts
Restart=always
RestartSec=3

# It only needs to read its own build and answer on a loopback port.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}-frontend

[Install]
WantedBy=multi-user.target
UNIT

as_root install -m 0644 "$tmp_unit" "$unit"
rm -f "$tmp_unit"
log_ok "Wrote $unit"

as_root systemctl daemon-reload
svc_enable_now "${APP_NAME}-frontend"
svc_restart "${APP_NAME}-frontend"

# --- verify it actually answers ----------------------------------------------
for _ in $(seq 1 25); do
  if curl -fsS -o /dev/null --max-time 2 "http://${FRONTEND_HOST}:${FRONTEND_PORT}/" 2>/dev/null; then
    log_ok "Frontend responding on http://${FRONTEND_HOST}:${FRONTEND_PORT}/"
    log_ok "Frontend ready"
    exit 0
  fi
  sleep 0.4
done

log_error "Service started but nothing answered on ${FRONTEND_HOST}:${FRONTEND_PORT}."
log_error "Check: journalctl -u ${APP_NAME}-frontend -n 50 --no-pager"
die "Frontend is not serving."
