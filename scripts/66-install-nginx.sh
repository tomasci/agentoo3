#!/usr/bin/env bash
# nginx, serving on the tailnet — and, optionally, on a domain of your own.
#
# The tailnet path needs no certificate at all: the system is reached over
# Tailscale, and WireGuard already encrypts every byte between client and
# host, so plain HTTP on tailscale0 is not sent in the clear. If a browser
# padlock is wanted there, `tailscale serve` publishes this over HTTPS on the
# node's MagicDNS name with a certificate Tailscale provisions and renews.
# Set up at the end of this step, because it has to point at an nginx that is
# already listening.
#
# A real domain is the other, independent option: scripts/85-configure-https.sh
# owns the prompts, the Let's Encrypt certificate and the two sticky HTTPS_*
# settings; this step only ever *reads* HTTPS_DOMAIN and, when a certificate
# already exists for it, renders a 443 server and turns the tailnet HTTPS
# listener above off — tailscaled and nginx cannot both hold :443. Re-invoked
# by step 85 itself (as a child) once it has finished, so a `--only https`
# run's changes take effect without asking the operator to also run `--only
# nginx`.
#
# Runs after Tailscale so the MagicDNS name is known when the site is rendered.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "nginx"
require_root

apt_install "${PKGS_NGINX[@]}"

# An explicitly set domain wins and is remembered; otherwise the tailnet
# identity is re-detected on every run, so this fixes itself once Tailscale
# comes up. HTTPS_DOMAIN is read-only here — 85-configure-https.sh is the only
# writer of it.
sticky_recall NGINX_DOMAIN
sticky_recall HTTPS_DOMAIN

SITE_AVAILABLE="$NGINX_CONF_DIR/sites-available/$NGINX_SITE_NAME"
SITE_ENABLED="$NGINX_CONF_DIR/sites-enabled/$NGINX_SITE_NAME"
UPGRADE_MAP="$NGINX_CONF_DIR/conf.d/upgrade-map.conf"
DEFAULT_SITE="$NGINX_CONF_DIR/sites-enabled/default"

# --- who are we on the tailnet? ----------------------------------------------
ts_names=()
ts_dns=""
if have tailscale && tailscale status >/dev/null 2>&1; then
  ts_dns="$(tailscale_dns_name || true)"
  while read -r endpoint; do
    [[ -n "$endpoint" ]] && ts_names+=("$endpoint")
  done < <(tailscale_endpoints)
fi

if [[ -n "$NGINX_DOMAIN" ]]; then
  server_name="$NGINX_DOMAIN"
  log_info "Using the configured server_name: $server_name"
elif (( ${#ts_names[@]} )); then
  server_name="${ts_names[*]}"
  log_ok "Detected tailnet identity: $server_name"
else
  server_name="_"
  log_warn "Tailscale is not up, so no MagicDNS name is known yet."
  log_warn "Serving as a catch-all; re-run this step once the node has joined:"
  log_warn "    sudo $INSTALL_SH --only nginx"
fi

# --- is there a custom-domain certificate to terminate TLS with? -------------
# The decision has to be made before the dry-run exit below, so a dry run can
# say what it would do, and again after (B) further down, because freeing
# :443 from tailscale can itself fail and turn this back off.
https_on=0
if [[ -n "$HTTPS_DOMAIN" && "$HTTPS_DOMAIN" != "none" ]]; then
  if https_cert_present "$HTTPS_DOMAIN"; then
    https_on=1
  else
    log_warn "HTTPS_DOMAIN=$HTTPS_DOMAIN is set, but no certificate exists yet for it."
    log_warn "Serving HTTP only until one does. Run:"
    log_warn "    sudo $INSTALL_SH --only https"
  fi
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would write $SITE_AVAILABLE (server_name $server_name)"
  log_info "[dry-run] would disable the default site and reload nginx"
  if (( https_on )); then
    log_info "[dry-run] would also render a 301 redirect + TLS server for https://$HTTPS_DOMAIN/"
    log_info "[dry-run] would free tailscale's hold on :443 (serve reset/off) and skip 'tailscale serve --bg'"
  fi
  exit 0
fi

# --- (B) free :443 from tailscale before nginx tries to bind it --------------
#
# tailscaled holds a real socket on the tailnet IPs' :443 while `tailscale
# serve` is publishing HTTPS, and nginx cannot bind 443 while that socket
# exists. `nginx -t` only validates syntax, so this is invisible there — it
# would otherwise only surface as nginx failing to start or reload.
if (( https_on )); then
  if ! have tailscale; then
    log_debug "tailscale is not installed; nothing holds :443 on its behalf."
  elif ! have jq; then
    log_warn "jq is not installed; cannot inspect 'tailscale serve' state."
    log_warn "Leaving HTTPS on — if tailscale still holds :443, nginx will fail to bind it below."
  else
    serve_json="$(tailscale serve status --json 2>/dev/null)" || serve_json=""
    if [[ -z "$serve_json" ]]; then
      log_warn "Could not read 'tailscale serve status --json'."
      log_warn "Leaving HTTPS on — if tailscale still holds :443, nginx will fail to bind it below."
    else
      tcp_443="$(jq -r '.TCP."443" // empty' <<<"$serve_json" 2>/dev/null || true)"
      if [[ -z "$tcp_443" ]]; then
        log_debug "tailscale serve is not holding :443."
      else
        is_ours="$(jq -r --arg want "http://127.0.0.1:${TAILSCALE_SERVE_PORT}" '
          (.TCP // {} | keys) as $tk
          | (.Web // {} | to_entries
              | map(.value.Handlers // {} | to_entries | map(.value.Proxy // ""))
              | add // []) as $proxies
          | (($tk == ["443"]) and (($proxies | length) > 0) and (all($proxies[]; . == $want)))
        ' <<<"$serve_json" 2>/dev/null || true)"
        if [[ "$is_ours" == "true" ]]; then
          log_info "Resetting 'tailscale serve' — it was only ever serving this nginx over HTTPS."
          as_root tailscale serve reset
        else
          log_info "Turning off tailscale's HTTPS listener on :443 (it is serving more than just this nginx)."
          as_root tailscale serve --https=443 off || true
          serve_json2="$(tailscale serve status --json 2>/dev/null)" || serve_json2=""
          tcp_443_after="$(jq -r '.TCP."443" // empty' <<<"$serve_json2" 2>/dev/null || true)"
          if [[ -n "$tcp_443_after" ]]; then
            https_on=0
            log_warn "tailscale is still holding :443 after 'serve --https=443 off'. Serving HTTP only this run."
            log_warn "Investigate with 'tailscale serve status', then re-run:  sudo $INSTALL_SH --only https"
          fi
        fi
      fi
    fi
  fi
fi

# --- nginx version: 1.25.1 made `http2 on;` its own directive ----------------
http2_native=0
if (( https_on )); then
  nginx_ver="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
  if [[ -n "$nginx_ver" ]] && version_gte "$nginx_ver" "1.25.1"; then
    http2_native=1
  fi
fi

# --- server_name for the :80 default server -----------------------------------
# When TLS is on, the custom domain gets its own dedicated :80 (redirect) and
# :443 pair below, so it must not also sit in the default server's name list —
# nginx treats the same name on two server blocks bound to the same
# address:port as a conflict and keeps only the first one defined.
compute_default_server_name() {
  default_server_name="$server_name"
  (( https_on )) || return 0
  [[ " $server_name " == *" $HTTPS_DOMAIN "* ]] || return 0
  local n remaining=()
  for n in $server_name; do
    [[ "$n" == "$HTTPS_DOMAIN" ]] || remaining+=("$n")
  done
  if (( ${#remaining[@]} )); then
    default_server_name="${remaining[*]}"
  elif (( ${#ts_names[@]} )); then
    default_server_name="${ts_names[*]}"
    log_info "Default server has no name left once $HTTPS_DOMAIN is excluded; falling back to the tailnet identity ($default_server_name)."
  else
    default_server_name="_"
    log_info "Default server has no name left once $HTTPS_DOMAIN is excluded; falling back to '_' (catch-all)."
  fi
}

# --- shared location blocks — used by BOTH the :80 and :443 app servers ------
# Factored out so the two can never drift apart. Headers kept exactly as
# backend/src/features/editor/proxy.ts expects them (Host, X-Forwarded-Proto...).
render_locations() {
  cat <<LOCS
    location /api/ {
        proxy_pass http://${APP_NAME}_backend;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;

        # Token-by-token streaming (SSE / chunked) breaks if nginx buffers.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout ${NGINX_PROXY_READ_TIMEOUT};
        proxy_send_timeout ${NGINX_PROXY_READ_TIMEOUT};
        chunked_transfer_encoding on;
    }

    location / {
        proxy_pass http://${APP_NAME}_frontend;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;

        proxy_read_timeout ${NGINX_PROXY_READ_TIMEOUT};
    }
LOCS
}

# Everything shared between the :80 default server and the :443 TLS server:
# body-size/tokens, security headers, access/error logs, then the locations.
render_site_body() {
  cat <<BODY
    client_max_body_size ${NGINX_CLIENT_MAX_BODY_SIZE};
    server_tokens off;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    access_log /var/log/nginx/${NGINX_SITE_NAME}.access.log;
    error_log  /var/log/nginx/${NGINX_SITE_NAME}.error.log;

$(render_locations)
BODY
}

render_tls_listen() {
  if (( http2_native )); then
    cat <<LISTEN
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
LISTEN
  else
    cat <<LISTEN
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
LISTEN
  fi
}

# Renders the whole site file to stdout for the CURRENT value of $https_on —
# call compute_default_server_name first. Kept byte-for-byte identical to what
# this step has always rendered when HTTPS_DOMAIN is unset/none/uncertified:
# no boxes running only over the tailnet should see their config change.
render_site() {
  cat <<HEADER
# Managed by ${APP_NAME}'s installer. Regenerated by scripts/66-install-nginx.sh
# — edit config in scripts/lib/config.sh, not here.
#
# Reached over Tailscale. Traffic on tailscale0 is WireGuard-encrypted, so this
# listens on plain HTTP; \`tailscale serve\` adds HTTPS on the MagicDNS name.
HEADER

  if (( https_on )); then
    cat <<EXTRA
#
# HTTPS_DOMAIN=${HTTPS_DOMAIN} also terminates TLS below with a Let's Encrypt
# certificate (see scripts/85-configure-https.sh) — tailscale's own HTTPS
# listener is turned off while this is active, so https://<name>.ts.net/
# stops answering; the plain http:// tailnet URLs keep working.
EXTRA
  fi

  cat <<UPSTREAMS

upstream ${APP_NAME}_backend {
    server 127.0.0.1:${BACKEND_PORT} fail_timeout=0;
}

upstream ${APP_NAME}_frontend {
    server 127.0.0.1:${FRONTEND_PORT} fail_timeout=0;
}

UPSTREAMS

  if (( https_on )); then
    cat <<REDIRECT
server {
    listen 80;
    listen [::]:80;
    server_name ${HTTPS_DOMAIN};
    return 301 https://${HTTPS_DOMAIN}\$request_uri;
}

REDIRECT
  fi

  cat <<DEFAULT_OPEN
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${default_server_name};

DEFAULT_OPEN
  render_site_body
  printf '}\n'

  if (( https_on )); then
    printf '\n'
    printf 'server {\n'
    render_tls_listen
    cat <<TLS_MID
    server_name ${HTTPS_DOMAIN};

    ssl_certificate     ${LETSENCRYPT_DIR}/live/${HTTPS_DOMAIN}/fullchain.pem;
    ssl_certificate_key ${LETSENCRYPT_DIR}/live/${HTTPS_DOMAIN}/privkey.pem;

TLS_MID
    render_site_body
    printf '}\n'
  fi
}

render_and_install() {
  local tmp; tmp="$(mktemp)"
  render_site >"$tmp"
  as_root install -m 0644 "$tmp" "$SITE_AVAILABLE"
  rm -f "$tmp"
}

# --- (C) render + test ---------------------------------------------------------
site_backup=""
if [[ -f "$SITE_AVAILABLE" ]]; then
  site_backup="$(mktemp)"
  as_root cat "$SITE_AVAILABLE" >"$site_backup" 2>/dev/null || site_backup=""
fi

compute_default_server_name
render_and_install
log_ok "Wrote $SITE_AVAILABLE"

# `Connection: upgrade` must only be sent when the client asked for an upgrade,
# otherwise plain keep-alive requests break. This map belongs at http level.
managed_block "$UPGRADE_MAP" 0644 <<'CONF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
CONF

as_root ln -sfn "$SITE_AVAILABLE" "$SITE_ENABLED"
if [[ -e "$DEFAULT_SITE" ]]; then
  as_root rm -f "$DEFAULT_SITE"
  log_info "Disabled the default nginx site (kept in sites-available)"
fi

restore_site_backup_and_die() {
  # Restores the file's *content* only — the enabled symlink itself was
  # already pointed at $SITE_AVAILABLE before this ever ran (or just created
  # pointing there), and that path does not change here, so putting the old
  # bytes back under it is enough to leave sites-enabled exactly as it was.
  [[ -n "$site_backup" ]] && as_root install -m 0644 "$site_backup" "$SITE_AVAILABLE"
  rm -f "$site_backup"
  die "nginx rejected the generated config; nothing was reloaded. See the error above."
}

if ! as_root nginx -t; then
  if (( https_on )); then
    log_warn "nginx rejected the config with HTTPS_DOMAIN=$HTTPS_DOMAIN active; retrying HTTP-only."
    https_on=0
    compute_default_server_name
    render_and_install
    if ! as_root nginx -t; then
      restore_site_backup_and_die
    fi
    log_warn "Falling back to HTTP-only for this run. Investigate, then:  sudo $INSTALL_SH --only https"
  else
    restore_site_backup_and_die
  fi
fi
rm -f "$site_backup"
log_ok "nginx config valid"

svc_enable_now nginx
svc_reload nginx

setting_remember NGINX_DOMAIN "$NGINX_DOMAIN"

# --- how to reach it ----------------------------------------------------------
log_ok "nginx ready — / -> :$FRONTEND_PORT, /api/ -> :$BACKEND_PORT"

# --- (E) publish over HTTPS on the tailnet — ONLY when the custom domain ------
# is not already holding 443. TAILSCALE_SERVE is not sticky, specifically so
# that a later plain re-run cannot retake :443 out from under a custom domain
# just because some earlier run happened to ask for tailscale serve.
served=0
if (( ! https_on )) && [[ "$TAILSCALE_SERVE" == "1" ]]; then
  if ! have tailscale || ! tailscale status >/dev/null 2>&1; then
    log_info "Tailscale is not connected; skipping 'tailscale serve'."
    log_info "Once the node joins, re-run:  sudo $INSTALL_SH --only nginx"
  else
    log_info "Publishing nginx over HTTPS with 'tailscale serve'"
    if serve_out="$(as_root tailscale serve --bg "$TAILSCALE_SERVE_PORT" 2>&1)"; then
      served=1
      log_ok "Tailscale is terminating HTTPS; it manages and renews the certificate."
    else
      log_warn "'tailscale serve' failed — nginx still serves plain HTTP on the tailnet:"
      printf '%s\n' "$serve_out" | sed 's/^/    /' >&2
      log_warn "Most often this means HTTPS certificates are not enabled for the tailnet."
      log_warn "Enable them in the admin console (DNS -> HTTPS Certificates), then:"
      log_warn "    sudo tailscale serve --bg $TAILSCALE_SERVE_PORT"
    fi
  fi
fi

# --- how to reach it ----------------------------------------------------------
if (( https_on )) || (( ${#ts_names[@]} )); then
  log_info "Reachable at:"
  if (( https_on )); then
    log_info "    https://${HTTPS_DOMAIN}/"
  fi
  if (( served )) && [[ -n "${ts_dns:-}" ]]; then
    log_info "    https://${ts_dns}/"
  fi
  for n in "${ts_names[@]}"; do
    log_info "    $(tailscale_url "$n")"
  done
fi
