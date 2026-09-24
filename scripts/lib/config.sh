#!/usr/bin/env bash
# shellcheck disable=SC2034  # every value here is consumed by the step scripts
# Single source of truth for versions, package lists and paths.
# Every value can be overridden from the environment:
#
#   NODE_MAJOR=22 ./install.sh
#
# Source this file; do not execute it.
#
# The policy every step is expected to follow: converge the box to the
# version its own configuration declares, on every run, not just the first.
# An exact pin (a version number) converges exactly; a declared channel (e.g.
# CLAUDE_CODE_CHANNEL=stable) converges to whatever that channel resolves to
# right now. "Already present" is never by itself a reason to skip — that was
# the bug in 55-install-claude-code.sh that left the CLI at 2.1.236 for three
# weeks on a box that was re-provisioned constantly.
#
# Two steps do not yet follow this and are known, deliberate exceptions rather
# than oversights: 50-install-bun.sh (skips whenever the installed bun is >=
# MIN_BUN_VERSION, so it never moves once past that floor) and
# 30-install-python.sh's uv install (`have uv` skips forever). Both are left
# alone here on purpose — bun runs both live services, and changing when it
# upgrades in the same change that changes when the CLI upgrades would make a
# bad outcome un-bisectable. apt-installed steps already converge on their own,
# via 10-system-upgrade.sh's full-upgrade, so they need no equivalent change.

[[ -n "${_AGENTOO_CONFIG_LOADED:-}" ]] && return 0
_AGENTOO_CONFIG_LOADED=1

# ------------------------------------------------------------ identity ------

APP_NAME="${APP_NAME:-agentoo}"

# The account the services run as. Under sudo this is normally the human who
# invoked the installer.
#
# It must not be root. Claude Code refuses to run with bypassed permissions as
# uid 0 — "--dangerously-skip-permissions cannot be used with root/sudo
# privileges" — and every session would fail at startup. The one-command install
# is run as root on a fresh VPS, where both SUDO_USER and `id -un` are root, so
# that is the common case rather than an edge one. There is an IS_SANDBOX=1
# escape hatch in the CLI, but setting it on a real box only disables the check
# that is protecting the box.
APP_USER="${APP_USER:-${SUDO_USER:-$(id -un)}}"
if [[ "$APP_USER" == "root" ]]; then
  APP_USER="$APP_NAME"
fi

# --------------------------------------------------------------- services ---
# Both bind to loopback; nginx is the only thing listening publicly.
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

# ---------------------------------------------------------------- paths -----

BACKEND_DIR="${BACKEND_DIR:-$REPO_ROOT/backend}"
FRONTEND_DIR="${FRONTEND_DIR:-$REPO_ROOT/frontend}"
# Where cloned/adopted projects and the shared agent+skill library live.
PROJECTS_DIR="${PROJECTS_DIR:-$REPO_ROOT/projects}"
LIBRARY_DIR="${LIBRARY_DIR:-$REPO_ROOT/library}"
# Drop a folder here to adopt it as a project. Separate from PROJECTS_DIR, which
# holds managed project roots — listing our own scaffolding as adoptable would
# be nonsense.
SOURCES_DIR="${SOURCES_DIR:-$REPO_ROOT/sources}"

# Session-scoped file attachments (uploads), sharded on disk by session id.
# Pinned here like the other data directories rather than left to a backend
# default, so ownership and permissions are the installer's to set — 0700, not
# 0755 like the dirs above: see the data-directories section of
# 68-setup-backend.sh for why.
ATTACHMENTS_DIR="${ATTACHMENTS_DIR:-$REPO_ROOT/attachments}"

# Generated ssh keys. Beside the other data directories rather than under a
# home directory: the backend's fallback is ~/.ssh/agentoo, and ~ depends on who
# is running — keys written while the services ran as root landed in
# /root/.ssh/agentoo, which the service account cannot read. That surfaces as
# "Identity file not accessible: Permission denied" followed by "Permission
# denied (publickey)", which looks like a rejected key rather than an unreadable
# one. Pinned here and written into .env so it never depends on $HOME again.
SSH_KEYS_DIR="${SSH_KEYS_DIR:-$REPO_ROOT/keys}"

# A machine-wide cap on how many session turns run at once, across every
# project on the box — not the rule that keeps one session's own turns from
# overlapping. That rule is a conditional UPDATE in the database and does not
# read this value at all. Pinning this at 1 conflated the two: it also
# serialised every *other* project's sessions behind whichever one happened to
# be running, so a second project's session sat at "1 message waiting" with no
# visible cause until the first one's turn finished.
#
# Empty means "decide from RAM", the same shape SWAP_SIZE_MB uses below:
# derived in scripts/68-setup-backend.sh from CLAUDE_CODE_MIN_RAM_MB, floored
# at 2 and capped at 8 — see that script for why those particular bounds.
WORKER_CONCURRENCY_EXPLICIT="${WORKER_CONCURRENCY+1}"   # set by the operator this run?
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-}"

# Soft memory ceiling for the worker's cgroup — the worker, its agents and
# every command they run. Accepts systemd's syntax: '3G', '80%', 'infinity'.
#
# Used to be optional (empty = no ceiling, systemd's own default) back when
# WORKER_CONCURRENCY was pinned at 1: one session at a time left headroom by
# construction, so the bytes guard had nothing urgent to do. Now that the count
# guard is derived and can go as high as 8, the bytes guard can no longer sit
# out — '80%' needs no arithmetic, scales with whatever box this lands on, and
# still leaves room for postgres, redis, nginx and the frontend, none of which
# live inside the worker's cgroup and all of which have to survive an agent's
# test suite. MemoryHigh only throttles and reclaims — it never kills — so the
# worst this does on a small box is slow an agent down.
WORKER_MEMORY_HIGH_EXPLICIT="${WORKER_MEMORY_HIGH+1}"   # set by the operator this run?
WORKER_MEMORY_HIGH="${WORKER_MEMORY_HIGH:-80%}"
# Generated credentials and connection strings are written here.
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# ------------------------------------------------------- supported hosts ----

MIN_UBUNTU_VERSION="${MIN_UBUNTU_VERSION:-22.04}"
SUPPORTED_ARCHS="${SUPPORTED_ARCHS:-x86_64 aarch64}"
MIN_DISK_FREE_GB="${MIN_DISK_FREE_GB:-5}"
MIN_RAM_MB="${MIN_RAM_MB:-1024}"

# ------------------------------------------------------------------ swap -----
#
# An agent runs whatever the work needs — a test suite, a bundler, a type
# checker — and those spike. Without swap there is no slack at all between "this
# is heavy" and the kernel OOM-killing something, and what it kills is not
# necessarily the greedy process: sessions on a 4GB box died because the OOM
# killer fired while a frontend test suite ran, and took the agent with it.
#
# Swap is the slack. It is a safety valve, not storage: SWAP_SWAPPINESS is low
# on purpose, so pages only go out under real pressure.
SWAP_ENABLE="${SWAP_ENABLE:-1}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"
# Every size below goes through num_or: these are read straight from the
# environment and then used in arithmetic, where under `set -u` a typo is not a
# bad value but an "unbound variable" that kills the step — and SWAP_ENOUGH_MB
# is read by the preflight, so a typo there would end the install at step zero.
#
# Empty SWAP_SIZE_MB means "decide from RAM": twice memory, floored at 2GB and
# capped at 8GB. Twice, because the peak this covers is one Claude Code process
# (~4GB) landing on a machine that was already busy.
SWAP_SIZE_MB="${SWAP_SIZE_MB:-}"
SWAP_MIN_MB="$(num_or SWAP_MIN_MB "${SWAP_MIN_MB:-}" 2048)"
SWAP_MAX_MB="$(num_or SWAP_MAX_MB "${SWAP_MAX_MB:-}" 8192)"
if (( SWAP_MIN_MB > SWAP_MAX_MB )); then
  log_warn "SWAP_MIN_MB=$SWAP_MIN_MB is above SWAP_MAX_MB=$SWAP_MAX_MB; the cap wins."
fi
# 10, not the default 60: swap here exists to stop an OOM kill, not to page out
# a working set that fits. Above zero because zero would defeat the point.
SWAP_SWAPPINESS="$(num_or SWAP_SWAPPINESS "${SWAP_SWAPPINESS:-}" 10)"
# Below this, existing swap is treated as too small to count as a safety valve.
SWAP_ENOUGH_MB="$(num_or SWAP_ENOUGH_MB "${SWAP_ENOUGH_MB:-}" 1024)"
# The smallest swapfile the step will make. Also what tells a leftover of ours
# apart from a file SWAP_FILE was pointed at by mistake, which must not be
# deleted: nothing this step writes is ever smaller than this.
SWAP_FLOOR_MB="$(num_or SWAP_FLOOR_MB "${SWAP_FLOOR_MB:-}" 64)"

# ------------------------------------------------------------- packages -----

# Needed by the installer itself and by anything that compiles.
PKGS_CORE=(
  ca-certificates
  curl
  wget
  gnupg
  apt-transport-https
  software-properties-common
)

# Day-to-day tooling. Add to this list as the system grows.
PKGS_UTILS=(
  build-essential
  pkg-config
  git
  jq
  unzip
  zip
  tar
  rsync
  openssl
  htop
  tree
  nano
  vim
  less
  psmisc          # provides `fuser`, used for apt lock detection
  lsb-release
  tzdata
  file
  net-tools
  dnsutils
  iputils-ping
  ripgrep
)

PKGS_POSTGRES=(
  postgresql
  postgresql-contrib
  libpq-dev          # headers for building psycopg2 from source
)

PKGS_REDIS=(
  redis-server
  redis-tools
)

PKGS_NGINX=(
  nginx
)

PKGS_FIREWALL=(
  ufw
)

PKGS_PYTHON=(
  python3
  python3-venv
  python3-dev
  python3-pip
  python3-setuptools
  python3-wheel
)

# ---------------------------------------------------------------- python ----

MIN_PYTHON_VERSION="${MIN_PYTHON_VERSION:-3.11}"
INSTALL_UV="${INSTALL_UV:-1}"          # uv: fast, PEP 668-safe env/package manager

# ------------------------------------------------------------------ node ----

# Empty = resolve the current LTS major from nodejs.org at install time.
NODE_MAJOR="${NODE_MAJOR:-}"
NODE_MAJOR_FALLBACK="${NODE_MAJOR_FALLBACK:-24}"
NODE_INSTALL_METHOD="${NODE_INSTALL_METHOD:-nodesource}"   # nodesource | tarball
NODE_PREFIX="${NODE_PREFIX:-/usr/local}"                   # tarball method only

# ------------------------------------------------------------------- bun ----

BUN_VERSION="${BUN_VERSION:-latest}"
BUN_INSTALL_DIR="${BUN_INSTALL_DIR:-/usr/local}"           # binary -> $DIR/bin/bun
# 1.3.13 is the floor because the editor feature's proxy (backend/src/features/
# editor/proxy.ts) dials code-server over a unix socket with Bun's own `unix`
# fetch option and a `ws+unix://` WebSocket client — both are Bun-specific and
# only landed at that version. A host already past this floor is left alone
# (see this file's own header on why this is one of the two declared
# exceptions to "always converge").
MIN_BUN_VERSION="${MIN_BUN_VERSION:-1.3.13}"

# -------------------------------------------------------------- postgres ----

POSTGRES_DB="${POSTGRES_DB:-$APP_NAME}"
POSTGRES_USER="${POSTGRES_USER:-$APP_NAME}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"     # empty -> generated, stored in .env
POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
# pgvector: embeddings storage. Non-fatal when the distro has no matching package.
POSTGRES_INSTALL_PGVECTOR="${POSTGRES_INSTALL_PGVECTOR:-1}"

# ----------------------------------------------------------------- redis ----

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"           # empty -> generated, stored in .env
REDIS_MAXMEMORY="${REDIS_MAXMEMORY:-}"         # e.g. 512mb; empty -> no limit
# noeviction by default: silently dropping keys is the wrong failure mode for a
# queue or a session store. Switch to allkeys-lru only for a pure cache.
REDIS_MAXMEMORY_POLICY="${REDIS_MAXMEMORY_POLICY:-noeviction}"

# ----------------------------------------------------------------- nginx ----

# Test seam, same pattern as 80-configure-ufw.sh's SSHD_CONFIG: lets a test
# point every nginx path (sites-available/enabled, conf.d/) at a fixture tree
# instead of the real /etc/nginx.
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx}"

NGINX_DOMAIN_EXPLICIT="${NGINX_DOMAIN+1}"   # set by the operator this run?
# Empty -> auto-detected from Tailscale (MagicDNS name + tailnet IPs) at render
# time. Set this only to override with a domain of your own.
NGINX_DOMAIN="${NGINX_DOMAIN:-}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-$APP_NAME}"
NGINX_CLIENT_MAX_BODY_SIZE="${NGINX_CLIENT_MAX_BODY_SIZE:-50m}"
# Long timeouts: model responses routinely outlive nginx's 60s default.
NGINX_PROXY_READ_TIMEOUT="${NGINX_PROXY_READ_TIMEOUT:-300s}"

# ------------------------------------------------------------- tailscale ----

TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-}"     # tskey-auth-...; empty -> print a login URL
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-$APP_NAME-$(hostname -s 2>/dev/null || echo host)}"
# Tailscale SSH replaces sshd auth for VPN clients. Off by default: changing how
# a server authenticates SSH should be a deliberate choice, not a side effect.
TAILSCALE_SSH="${TAILSCALE_SSH:-0}"
# Servers rarely want their resolv.conf rewritten by MagicDNS.
TAILSCALE_ACCEPT_DNS="${TAILSCALE_ACCEPT_DNS:-false}"
TAILSCALE_ACCEPT_ROUTES="${TAILSCALE_ACCEPT_ROUTES:-false}"
TAILSCALE_UP_EXTRA_ARGS="${TAILSCALE_UP_EXTRA_ARGS:-}"
# `tailscale serve` publishes nginx over HTTPS on the node's MagicDNS name,
# with a certificate Tailscale provisions and renews. Independent of, and
# turned off automatically by, the optional custom-domain HTTPS below (see the
# "https" section) once a certificate for that domain exists — tailscaled and
# nginx cannot both hold :443, and the custom domain wins.
TAILSCALE_SERVE="${TAILSCALE_SERVE:-1}"
TAILSCALE_SERVE_PORT="${TAILSCALE_SERVE_PORT:-80}"   # local port to publish (nginx)
# Tailscale publishes per-codename apt repos; a brand-new Ubuntu may not have one
# yet, so fall back to the newest LTS. The packages are static binaries.
TAILSCALE_CODENAME_FALLBACK="${TAILSCALE_CODENAME_FALLBACK:-noble}"

# ------------------------------------------------------------------ https ---
#
# Optional: terminate TLS on a domain of your own via Let's Encrypt, using
# certbot's Cloudflare DNS-01 plugin so nothing has to be exposed to the
# public internet to prove ownership. scripts/85-configure-https.sh owns the
# prompts, the Cloudflare calls, certbot itself, and is the ONLY writer of the
# two sticky settings below. The host stays tailnet-only either way — this
# just adds a second, public way to reach the same nginx over 443.

HTTPS_DOMAIN_EXPLICIT="${HTTPS_DOMAIN+1}"   # set by the operator this run?
# A lowercase FQDN to serve over HTTPS · "none" (disabled; asked once, do not
# ask again) · empty (never answered — 85-configure-https.sh will ask, if it
# can prompt).
HTTPS_DOMAIN="${HTTPS_DOMAIN:-}"
# Normalise rather than reject: a pasted "AI.Example.com." is obviously a
# domain, and DNS treats case and a trailing dot as irrelevant, so making the
# operator retype it exactly would be friction for nothing.
HTTPS_DOMAIN="${HTTPS_DOMAIN,,}"
HTTPS_DOMAIN="${HTTPS_DOMAIN%.}"

HTTPS_EMAIL_EXPLICIT="${HTTPS_EMAIL+1}"     # set by the operator this run?
HTTPS_EMAIL="${HTTPS_EMAIL:-}"              # Let's Encrypt account email

# How long certbot's Cloudflare plugin waits for the DNS-01 challenge record to
# propagate before asking Let's Encrypt to validate it.
HTTPS_DNS_PROPAGATION_SECONDS="$(num_or HTTPS_DNS_PROPAGATION_SECONDS "${HTTPS_DNS_PROPAGATION_SECONDS:-}" 30)"

# Test seam, like NGINX_CONF_DIR above. certbot itself is never told about
# this — it always uses its own compiled-in default (/etc/letsencrypt) — so
# this only affects our own reads of certificate files (https_cert_present in
# lib/common.sh) and the paths we build from it just below.
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt}"

# CLOUDFLARE_API_TOKEN is deliberately NOT declared here, and never made
# sticky like HTTPS_DOMAIN/HTTPS_EMAIL above: it is a secret, and
# $SETTINGS_FILE is printed in full by 90-summary.sh. It is read once, either
# from this environment variable or an interactive prompt, and from then on
# lives only in $HTTPS_CF_CREDENTIALS (root, 0600) — see
# scripts/85-configure-https.sh — because certbot's renewal timer needs it
# again later.
HTTPS_CF_CREDENTIALS="$LETSENCRYPT_DIR/${APP_NAME}-cloudflare.ini"
HTTPS_DEPLOY_HOOK="$LETSENCRYPT_DIR/renewal-hooks/deploy/${APP_NAME}-reload-nginx"

# python3-certbot-nginx is deliberately never in this list: it would make
# certbot edit nginx's config directly, and scripts/66-install-nginx.sh is
# already the one and only writer of that file — two authors of the same
# config would fight each other on every renewal.
PKGS_HTTPS=(certbot python3-certbot-dns-cloudflare)

# ------------------------------------------------------------------ docker ---
#
# Backs the per-project Docker page (backend/src/features/docker/): compose
# up/down, plain `docker run`, log streaming. DOCKER_ENABLE gates whether
# *this host* gets Docker installed at all; DOCKER_ENABLED (written to .env by
# the step below) is the separate, app-level kill switch the feature itself
# checks — the two can disagree on purpose (host has Docker, app control
# disabled).

DOCKER_ENABLE_EXPLICIT="${DOCKER_ENABLE+1}"   # set by the operator this run?
DOCKER_ENABLE="${DOCKER_ENABLE:-1}"
# Ubuntu's own apt repo trails a brand-new release, same reasoning as
# TAILSCALE_CODENAME_FALLBACK: try the detected codename first, then this LTS.
DOCKER_CODENAME_FALLBACK="${DOCKER_CODENAME_FALLBACK:-noble}"
# Docker's release signing key, from https://docs.docker.com/engine/install/ubuntu/.
# Checked before the keyring is installed, the same shape as
# CLAUDE_CODE_GPG_FINGERPRINT above.
DOCKER_GPG_FINGERPRINT="${DOCKER_GPG_FINGERPRINT:-9DC858229FC7DD38854AE2D88D81803C0EBFCD88}"
# The plugin the feature actually shells out to (`docker compose ...`), not the
# old standalone `docker-compose` binary. Below this, flags the feature relies
# on (`config --format json`) may not exist.
MIN_COMPOSE_VERSION="${MIN_COMPOSE_VERSION:-2.0.0}"
# Extra accounts to add to the `docker` group, beyond APP_USER and (when set)
# SUDO_USER. Space-separated.
DOCKER_GROUP_USERS="${DOCKER_GROUP_USERS:-}"
# Docker inserts its own iptables rules ahead of ufw's, in a DOCKER-USER chain
# ufw does not manage, so a published container port is otherwise reachable
# from every interface — public included. Off (0) fails *open* and is
# deliberately NOT sticky: forgetting to pass it again on a later run must
# re-close the hole, not leave it open because some earlier run asked for 0.
DOCKER_FIREWALL="${DOCKER_FIREWALL:-1}"
# Losing this list re-opens the one thing DOCKER_FIREWALL exists to hold shut,
# so — unlike DOCKER_FIREWALL — both of these ARE sticky, the same reasoning
# as UFW_TAILSCALE_ONLY: a deliberate change here must survive a later plain
# re-run. The IPv6 twin gets the identical treatment for the identical
# reason — an asymmetry here would mean DOCKER_TRUSTED_SOURCES6="fd00::/8"
# quietly reverting on the next plain run while its IPv4 sibling survives.
#
# Defaults are named constants, not inlined into the ${VAR:-default} below,
# so 65-install-docker.sh can fall back to the exact same string when a
# whitespace-only value needs to be treated as "unset" too (see that step's
# own comment on this).
DOCKER_TRUSTED_SOURCES_DEFAULT="100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
DOCKER_TRUSTED_SOURCES6_DEFAULT="fc00::/7 fe80::/10"
DOCKER_TRUSTED_SOURCES_EXPLICIT="${DOCKER_TRUSTED_SOURCES+1}"
# The tailnet (100.64.0.0/10) plus the private ranges a LAN is drawn from.
DOCKER_TRUSTED_SOURCES="${DOCKER_TRUSTED_SOURCES:-$DOCKER_TRUSTED_SOURCES_DEFAULT}"
DOCKER_TRUSTED_SOURCES6_EXPLICIT="${DOCKER_TRUSTED_SOURCES6+1}"
DOCKER_TRUSTED_SOURCES6="${DOCKER_TRUSTED_SOURCES6:-$DOCKER_TRUSTED_SOURCES6_DEFAULT}"
DOCKER_TRUSTED_IFACES="${DOCKER_TRUSTED_IFACES:-lo tailscale0}"
# json-file (Docker's default log driver) does not rotate on its own. This box
# runs arbitrary user containers and the feature streams them with `--follow`;
# a chatty container with no cap can fill the disk, and postgres lives on the
# same one.
DOCKER_LOG_MAX_SIZE="${DOCKER_LOG_MAX_SIZE:-10m}"
DOCKER_LOG_MAX_FILE="$(num_or DOCKER_LOG_MAX_FILE "${DOCKER_LOG_MAX_FILE:-}" 3)"
DOCKER_MIN_DISK_FREE_GB="$(num_or DOCKER_MIN_DISK_FREE_GB "${DOCKER_MIN_DISK_FREE_GB:-}" 10)"

# The official repo is primary because Ubuntu 22.04's own docker.io ships only
# legacy Compose v1 and has no docker-compose-v2 package at all — the distro
# fallback below only exists for a codename download.docker.com has not
# published yet.
PKGS_DOCKER=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
PKGS_DOCKER_DISTRO=(docker.io docker-compose-v2)

# ------------------------------------------------------------------- ufw ----

SSH_PORT="${SSH_PORT:-}"                       # empty -> detected from sshd
# Nothing is published on the public interface. The app is reached over the
# tailnet, so 80/443 have no reason to be open. Set e.g. "80/tcp 443/tcp" to
# expose the site to the internet.
UFW_PUBLIC_PORTS="${UFW_PUBLIC_PORTS:-}"
UFW_APP_PORTS="${UFW_APP_PORTS:-}"             # extra public ports, e.g. "8080/tcp"
UFW_ALLOW_TAILSCALE="${UFW_ALLOW_TAILSCALE:-1}"  # allow all inbound on tailscale0
# Whether SSH is reachable only over the VPN.
#   auto - lock down when Tailscale is verified connected, otherwise leave SSH
#          public so the host stays reachable, and lock down on a later run.
#      1 - always. Refuses to apply while Tailscale is down rather than risk a
#          permanent lockout, which fails the step.
#      0 - never.
UFW_TAILSCALE_ONLY_EXPLICIT="${UFW_TAILSCALE_ONLY+1}"   # set by the operator this run?
UFW_TAILSCALE_ONLY="${UFW_TAILSCALE_ONLY:-auto}"
UFW_LIMIT_SSH="${UFW_LIMIT_SSH:-1}"            # rate-limit SSH against brute force
UFW_LOGGING="${UFW_LOGGING:-low}"

# ------------------------------------------------------------ claude code ---

# 'stable' trails 'latest' by about a week and skips releases with major
# regressions — the right default for a server that is not babysat.
CLAUDE_CODE_CHANNEL="${CLAUDE_CODE_CHANNEL:-stable}"          # stable | latest
# native: per-user in ~/.local/bin. Its own installer auto-updates in the
# background on a laptop where something runs `claude` regularly; nothing on
# a server does, so here it is 55-install-claude-code.sh re-running (on every
# install.sh invocation, per the convergence policy above) that keeps it
# current, not the installer's own background updater.
# apt: system-wide and signed; converges via 10-system-upgrade.sh's
# full-upgrade instead, like any other apt package.
CLAUDE_CODE_INSTALL_METHOD="${CLAUDE_CODE_INSTALL_METHOD:-native}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-}"                # native only, e.g. 2.1.89
# Anthropic's release signing key, from https://code.claude.com/docs/en/setup.
# Checked before the keyring is installed.
CLAUDE_CODE_GPG_FINGERPRINT="${CLAUDE_CODE_GPG_FINGERPRINT:-31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE}"
CLAUDE_CODE_MIN_RAM_MB="${CLAUDE_CODE_MIN_RAM_MB:-4096}"
# A native install lands in the user's home, which is not on the PATH of cron,
# systemd, or a non-login shell. /usr/local/bin is on all of them, so this
# gives it a stable path there, re-pointed at whatever the install location
# currently resolves to on every run — see 55-install-claude-code.sh's
# claude_path() for why that resolution has to start from the install
# location rather than from PATH.
CLAUDE_CODE_SYMLINK="${CLAUDE_CODE_SYMLINK:-1}"
CLAUDE_CODE_SYMLINK_PATH="${CLAUDE_CODE_SYMLINK_PATH:-/usr/local/bin/claude}"

# --------------------------------------------------------------- playwright --

# Backs the browser skill: the official Playwright MCP server, installed
# globally and pinned exactly like CLAUDE_CODE_VERSION above rather than
# resolved at connect time via `bunx @playwright/mcp@latest` — see
# scripts/57-install-playwright.sh for why that shortcut does not survive
# contact with this box.
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.80}"
