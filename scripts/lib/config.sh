#!/usr/bin/env bash
# shellcheck disable=SC2034  # every value here is consumed by the step scripts
# Single source of truth for versions, package lists and paths.
# Every value can be overridden from the environment:
#
#   NODE_MAJOR=22 ./install.sh
#
# Source this file; do not execute it.

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

# Generated ssh keys. Beside the other data directories rather than under a
# home directory: the backend's fallback is ~/.ssh/agentoo, and ~ depends on who
# is running — keys written while the services ran as root landed in
# /root/.ssh/agentoo, which the service account cannot read. That surfaces as
# "Identity file not accessible: Permission denied" followed by "Permission
# denied (publickey)", which looks like a rejected key rather than an unreadable
# one. Pinned here and written into .env so it never depends on $HOME again.
SSH_KEYS_DIR="${SSH_KEYS_DIR:-$REPO_ROOT/keys}"
# Each Claude Code instance wants ~4GB, so concurrency is deliberately low.
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-1}"

# Optional soft memory ceiling for the worker's cgroup — the worker, its agents
# and every command they run. Empty means no ceiling, which is systemd's own
# default. Accepts systemd's syntax: '3G', '80%'.
#
# MemoryHigh throttles and reclaims rather than killing, so the worst it can do
# is make an agent slow. Worth setting on a small box, where the alternative is
# the kernel picking an OOM victim across the whole machine and possibly landing
# on postgres.
WORKER_MEMORY_HIGH="${WORKER_MEMORY_HIGH:-}"
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
MIN_BUN_VERSION="${MIN_BUN_VERSION:-1.1.0}"

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
# with a certificate Tailscale provisions and renews. Replaces certbot entirely.
TAILSCALE_SERVE="${TAILSCALE_SERVE:-1}"
TAILSCALE_SERVE_PORT="${TAILSCALE_SERVE_PORT:-80}"   # local port to publish (nginx)
# Tailscale publishes per-codename apt repos; a brand-new Ubuntu may not have one
# yet, so fall back to the newest LTS. The packages are static binaries.
TAILSCALE_CODENAME_FALLBACK="${TAILSCALE_CODENAME_FALLBACK:-noble}"

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
# native: per-user in ~/.local/bin, and updates itself in the background —
# which matters, because Claude Code ships often.
# apt: system-wide and signed, but only moves on a system upgrade.
CLAUDE_CODE_INSTALL_METHOD="${CLAUDE_CODE_INSTALL_METHOD:-native}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-}"                # native only, e.g. 2.1.89
# Anthropic's release signing key, from https://code.claude.com/docs/en/setup.
# Checked before the keyring is installed.
CLAUDE_CODE_GPG_FINGERPRINT="${CLAUDE_CODE_GPG_FINGERPRINT:-31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE}"
CLAUDE_CODE_MIN_RAM_MB="${CLAUDE_CODE_MIN_RAM_MB:-4096}"
# A native install lands in the user's home, which is not on the PATH of cron,
# systemd, or a non-login shell. /usr/local/bin is on all of them, and linking
# the launcher (rather than the versioned binary) survives auto-updates.
CLAUDE_CODE_SYMLINK="${CLAUDE_CODE_SYMLINK:-1}"
CLAUDE_CODE_SYMLINK_PATH="${CLAUDE_CODE_SYMLINK_PATH:-/usr/local/bin/claude}"
