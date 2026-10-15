#!/usr/bin/env bash
# PostgreSQL: server, an application role and database, and (optionally)
# pgvector for embeddings.
#
# Listens on localhost only — nothing here opens a public database port. Over
# the unix socket, the app's role has to give its password too (see "unix-socket
# auth" below).

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
  log_info "[dry-run] would require a password for unix-socket logins as '$POSTGRES_USER' (pg_hba.conf) and reload PostgreSQL"
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
#
# Hashed as SCRAM-SHA-256 explicitly, whatever password_encryption says: the
# unix-socket rule below is scram-sha-256, which an md5 hash cannot satisfy.
# Setting the password again on every run is also what moves a role created
# back when md5 was the default over to SCRAM. The SQL goes in on stdin, so
# the password never sits on a command line where `ps` would show it.
if psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$POSTGRES_USER'" | grep -q 1; then
  log_info "Role '$POSTGRES_USER' exists; synchronising its password"
  role_verb=ALTER
else
  log_info "Creating role '$POSTGRES_USER'"
  role_verb=CREATE
fi
pw_sql="${pw//\'/\'\'}"   # a ' in an operator-chosen POSTGRES_PASSWORD, doubled for SQL
psql_super <<SQL
SET password_encryption = 'scram-sha-256';
$role_verb ROLE "$POSTGRES_USER" WITH LOGIN PASSWORD '$pw_sql';
SQL
if [[ "$(psql_super -tAc "SELECT rolpassword LIKE 'SCRAM-SHA-256\$%' FROM pg_authid WHERE rolname = '$POSTGRES_USER'")" != "t" ]]; then
  die "Role '$POSTGRES_USER' still has no SCRAM-SHA-256 password after setting one."
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

# --- unix-socket auth ----------------------------------------------------------
# Ubuntu's pg_hba.conf has `local all all peer`, and the services, so every
# agent session, run as an OS account named like the app's role. A psql,
# pg_dump or driver a session starts with no host would reach this database
# over the default socket as that role with no password at all, DATABASE_URL
# or not. The managed rule makes those logins give the password instead (see
# pg_hba_require_socket_password in lib/common.sh). Nothing of ours logs in
# that way: the app, its migrations and its backups use DATABASE_URL over TCP,
# and this script's own SQL runs as postgres, whose peer line is untouched.
hba_file="$(psql_super -tAc 'SHOW hba_file')"
[[ -n "$hba_file" ]] || die "Could not ask PostgreSQL where its pg_hba.conf is."
# pg_hba_file_rules parses the file as it is on disk right now: what the server
# would make of it on the next reload or restart.
hba_errors() {
  psql_super -tAc "SELECT string_agg(format('line %s: %s', line_number, error), '; ')
                   FROM pg_hba_file_rules WHERE error IS NOT NULL"
}
errors="$(hba_errors)"
[[ -z "$errors" ]] || die "$hba_file has errors PostgreSQL cannot load ($errors). Fix them, then re-run: $INSTALL_SH --only postgres"
pg_hba_require_socket_password "$hba_file" "$POSTGRES_USER"
errors="$(hba_errors)"
if [[ -n "$errors" ]]; then
  if (( PG_HBA_CHANGED )); then
    as_root cp -p "$PG_HBA_BACKUP" "$hba_file"
    die "$hba_file did not parse with the socket rule added ($errors); the previous version is back in place."
  fi
  die "$hba_file has errors PostgreSQL cannot load ($errors)."
fi
# Every run, not only when the file changed: a run that died between writing
# the file and this line would otherwise leave the rule on disk but not loaded.
psql_super -tAc 'SELECT pg_reload_conf()' >/dev/null

# Whether psql's stderr ($1), from a socket login made with no password,
# shows it refused for want of one: libpq's "no password supplied" (psql -w,
# and the server asked for a password), the server's "password
# authentication failed", or a server ending the SCRAM exchange. Any other
# failure (no socket, connection refused, no such database, peer or a
# `reject` rule) proves nothing about the rule, so it must not pass the check.
pg_login_refused_for_password() {
  case "$1" in
    *"no password supplied"* | *"password authentication failed"* | \
    *"error received from server in SCRAM exchange"*) return 0 ;;
  esac
  return 1
}

# And prove it is live, both ways.
sock_dir="$(psql_super -tAc 'SHOW unix_socket_directories' | cut -d, -f1 | tr -d '[:space:]')"
pg_port="$(psql_super -tAc 'SHOW port')"
# A ~/.pgpass could answer for the password. This path can never exist
# (/dev/null is not a directory); /dev/null itself makes libpq warn.
no_pgpass=/dev/null/no-pgpass
if [[ -z "$sock_dir" ]]; then
  log_ok "PostgreSQL listens on no unix socket; nothing to check there"
else
  # With the password, a socket login as the role has to work. That shows the
  # rule is loaded (pg_reload_conf only signals the server, hence the retries)
  # and that the stored hash is one scram-sha-256 accepts. As root, whom peer
  # would never have let in as this role anyway.
  socket_ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if PGPASSWORD="$pw" PGPASSFILE="$no_pgpass" psql -X -q -w -h "$sock_dir" -p "$pg_port" \
         -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT 1' >/dev/null 2>&1; then
      socket_ok=1
      break
    fi
    sleep 0.5
  done
  (( socket_ok )) || die "Could not log in as '$POSTGRES_USER' over $sock_dir with its password. Check $hba_file."
  # Without it, as the OS account of the same name (exactly what peer let in),
  # it has to fail, and fail on authentication. That account is the service
  # account, which the backend step creates, so on a first install there is
  # nobody to try it as yet. LC_ALL=C keeps libpq's messages in the English
  # pg_login_refused_for_password looks for.
  if id -u "$POSTGRES_USER" >/dev/null 2>&1; then
    if nopw_stderr="$(as_user "$POSTGRES_USER" env -u PGPASSWORD LC_ALL=C PGPASSFILE="$no_pgpass" \
         psql -X -q -w -h "$sock_dir" -p "$pg_port" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
         -tAc 'SELECT 1' 2>&1 >/dev/null)"; then
      die "OS user '$POSTGRES_USER' can still log in over $sock_dir without a password. Check $hba_file."
    fi
    if ! pg_login_refused_for_password "$nopw_stderr"; then
      die "Could not confirm that unix-socket logins as '$POSTGRES_USER' need its password: the login without one failed, but not on authentication: ${nopw_stderr:-(no output)}"
    fi
    log_ok "Unix-socket logins as '$POSTGRES_USER' need its password"
  else
    log_ok "Unix-socket logins as '$POSTGRES_USER' need its password (no OS user '$POSTGRES_USER' yet to try without it)"
  fi
fi

log_ok "PostgreSQL ready (credentials in $ENV_FILE)"
