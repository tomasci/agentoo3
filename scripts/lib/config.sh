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
# Under sudo this is the human who invoked the installer, not root.
APP_USER="${APP_USER:-${SUDO_USER:-$(id -un)}}"

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
# Each Claude Code instance wants ~4GB, so concurrency is deliberately low.
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-1}"
# Generated credentials and connection strings are written here.
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# ------------------------------------------------------- supported hosts ----

MIN_UBUNTU_VERSION="${MIN_UBUNTU_VERSION:-22.04}"
SUPPORTED_ARCHS="${SUPPORTED_ARCHS:-x86_64 aarch64}"
MIN_DISK_FREE_GB="${MIN_DISK_FREE_GB:-5}"
MIN_RAM_MB="${MIN_RAM_MB:-1024}"

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
