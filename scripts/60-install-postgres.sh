#!/usr/bin/env bash
# PostgreSQL: server, an application role and database, and (optionally)
# pgvector for embeddings.
#
# Listens on localhost only — nothing here opens a public database port.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "PostgreSQL"
require_root

apt_install "${PKGS_POSTGRES[@]}"
svc_enable_now postgresql

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would create role '$POSTGRES_USER' and database '$POSTGRES_DB'"
  log_info "[dry-run] would write DATABASE_URL to $ENV_FILE"
  exit 0
fi

svc_is_active postgresql || die "postgresql is not running; check: systemctl status postgresql"

# Run SQL as the postgres superuser. -X ignores ~/.psqlrc, -q keeps output clean.
psql_super() { as_user postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }

# --- credentials --------------------------------------------------------------
# Reuse whatever is already in .env so re-running does not invalidate the
# password the application is currently using.
pw="$POSTGRES_PASSWORD"
[[ -z "$pw" ]] && pw="$(env_get "$ENV_FILE" POSTGRES_PASSWORD || true)"
if [[ -z "$pw" ]]; then
  pw="$(gen_secret 32)"
  log_info "Generated a new PostgreSQL password"
else
  log_info "Reusing the existing PostgreSQL password"
fi

# --- role ---------------------------------------------------------------------
# CREATE or ALTER, so the role always ends up matching what we write to .env.
if psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$POSTGRES_USER'" | grep -q 1; then
  log_info "Role '$POSTGRES_USER' exists; synchronising its password"
  psql_super -c "ALTER ROLE \"$POSTGRES_USER\" WITH LOGIN PASSWORD '$pw';"
else
  log_info "Creating role '$POSTGRES_USER'"
  psql_super -c "CREATE ROLE \"$POSTGRES_USER\" WITH LOGIN PASSWORD '$pw';"
fi

# --- database -----------------------------------------------------------------
if psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q 1; then
  log_ok "Database '$POSTGRES_DB' already exists"
else
  log_info "Creating database '$POSTGRES_DB'"
  # CREATE DATABASE cannot run inside the transaction psql_super would use.
  as_user postgres createdb -O "$POSTGRES_USER" "$POSTGRES_DB"
fi
psql_super -c "GRANT ALL PRIVILEGES ON DATABASE \"$POSTGRES_DB\" TO \"$POSTGRES_USER\";"
# Postgres 15+ revoked the implicit CREATE on the public schema.
psql_super -d "$POSTGRES_DB" -c "GRANT ALL ON SCHEMA public TO \"$POSTGRES_USER\";"

# --- pgvector -----------------------------------------------------------------
if [[ "$POSTGRES_INSTALL_PGVECTOR" == "1" ]]; then
  pg_major="$(psql_super -tAc 'SHOW server_version_num' | cut -c1-2 | sed 's/^0*//')"
  pkg="postgresql-${pg_major}-pgvector"
  if pkg_installed "$pkg"; then
    log_ok "$pkg already installed"
  elif apt-cache show "$pkg" >/dev/null 2>&1; then
    apt_install "$pkg"
  else
    log_warn "No '$pkg' package for this distro; skipping pgvector."
    log_warn "Build it from source if you need it: https://github.com/pgvector/pgvector"
  fi
  if pkg_installed "$pkg"; then
    psql_super -d "$POSTGRES_DB" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
    log_ok "pgvector enabled on '$POSTGRES_DB'"
  fi
fi

# --- record the connection details -------------------------------------------
env_set "$ENV_FILE" POSTGRES_HOST     "$POSTGRES_HOST"
env_set "$ENV_FILE" POSTGRES_PORT     "$POSTGRES_PORT"
env_set "$ENV_FILE" POSTGRES_DB       "$POSTGRES_DB"
env_set "$ENV_FILE" POSTGRES_USER     "$POSTGRES_USER"
env_set "$ENV_FILE" POSTGRES_PASSWORD "$pw"
env_set "$ENV_FILE" DATABASE_URL \
  "postgresql://${POSTGRES_USER}:${pw}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
env_fix_owner "$ENV_FILE"

# Prove the credentials actually work rather than assuming they do.
if PGPASSWORD="$pw" psql -X -q -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT 1' >/dev/null 2>&1; then
  log_ok "Verified login as '$POSTGRES_USER' to '$POSTGRES_DB'"
else
  die "Could not connect as '$POSTGRES_USER'. Check /etc/postgresql/*/main/pg_hba.conf"
fi

log_ok "PostgreSQL ready (credentials in $ENV_FILE)"
