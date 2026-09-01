#!/usr/bin/env bash
# Validate that this machine can actually be installed onto.
# Fails fast and loudly rather than half-installing.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Preflight checks"

# --- shell ---
if (( BASH_VERSINFO[0] < 4 )); then
  die "bash >= 4 required (found ${BASH_VERSION})."
fi
log_ok "bash ${BASH_VERSION%%(*}"

# --- distro ---
have apt-get || die "apt-get not found. This installer targets Debian/Ubuntu."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  log_ok "distro ${PRETTY_NAME:-$ID $VERSION_ID}"

  if [[ "${ID:-}" != "ubuntu" ]]; then
    log_warn "Tested on Ubuntu; '${ID:-unknown}' may need adjustments."
  elif ! version_gte "${VERSION_ID:-0}" "$MIN_UBUNTU_VERSION"; then
    die "Ubuntu >= $MIN_UBUNTU_VERSION required (found ${VERSION_ID:-unknown})."
  fi
else
  log_warn "/etc/os-release unreadable; skipping distro check."
fi

# --- architecture ---
arch="$(uname -m)"
if [[ " $SUPPORTED_ARCHS " == *" $arch "* ]]; then
  log_ok "architecture $arch"
else
  die "Unsupported architecture '$arch' (supported: $SUPPORTED_ARCHS)."
fi

# --- privileges ---
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  log_ok "running as root"
elif can_sudo; then
  log_ok "passwordless sudo available for $(id -un)"
elif [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_warn "No passwordless root; continuing anyway because --dry-run."
elif have sudo; then
  # An interactive password is fine when a human is at the keyboard; prime the
  # sudo timestamp now so later steps do not stall in the middle of an upgrade.
  log_info "sudo needs a password; authenticating up front"
  sudo -v || die "Could not obtain root via sudo."
  log_ok "sudo authenticated"
else
  die "Neither root nor sudo. Run as root or install sudo first."
fi

# --- network ---
if run curl -fsS --max-time 10 -o /dev/null https://deb.debian.org 2>/dev/null \
|| run curl -fsS --max-time 10 -o /dev/null https://archive.ubuntu.com 2>/dev/null; then
  log_ok "outbound HTTPS reachable"
else
  die "No outbound HTTPS. Check DNS, firewall and proxy settings."
fi

# --- disk ---
free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
free_gb=$(( free_kb / 1024 / 1024 ))
if (( free_gb < MIN_DISK_FREE_GB )); then
  die "Only ${free_gb}GB free on / (need >= ${MIN_DISK_FREE_GB}GB)."
fi
log_ok "disk ${free_gb}GB free on /"

# --- memory ---
ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
swap_mb=$(( $(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024 ))
if (( ram_mb < MIN_RAM_MB )); then
  log_warn "Only ${ram_mb}MB RAM (recommended >= ${MIN_RAM_MB}MB)."
  (( swap_mb < 512 )) && log_warn "Swap is ${swap_mb}MB; consider adding swap before building."
else
  log_ok "memory ${ram_mb}MB RAM, ${swap_mb}MB swap"
fi

log_ok "Preflight passed"
