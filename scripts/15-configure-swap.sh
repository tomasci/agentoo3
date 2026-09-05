#!/usr/bin/env bash
# Swap, so that a memory spike is slow rather than fatal.
#
# This box runs agents, and an agent runs whatever the work needs: a test suite,
# a bundler, a type checker, a dev server. Those spike, and with no swap there
# is no slack between "this is heavy" and the kernel OOM-killing something.
#
# The kill does not stay local either. Everything an agent starts lives in the
# worker's cgroup, and systemd's OOMPolicy defaults to `stop` — so one OOM-killed
# `bun test` used to terminate the whole worker unit, the running `claude` with
# it, and four sessions in one hour came back as "Claude Code process exited with
# code 143". `scripts/68-setup-backend.sh` sets `OOMPolicy=continue` so the kill
# can no longer spread; this step is the other half, and stops most of them
# happening at all.
#
# Deliberately not a hard requirement: plenty of hosts cannot have swap (LXC and
# most container runtimes forbid swapon outright), and an install must still
# finish there. Every failure below is a warning.
#
#   SWAP_ENABLE=0 ./install.sh          # skip entirely
#   SWAP_SIZE_MB=4096 ./install.sh      # pin the size

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Swap"

if [[ "$SWAP_ENABLE" != "1" ]]; then
  log_info "SWAP_ENABLE=$SWAP_ENABLE — skipping."
  exit 0
fi

ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
swap_mb=$(( $(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024 ))

# --- already sorted? ----------------------------------------------------------
# Any swap the host already has counts, wherever it came from: a partition, a
# cloud image's own swapfile, zram. Adding a second one on top would be noise.
if (( swap_mb >= SWAP_ENOUGH_MB )); then
  log_ok "swap ${swap_mb}MB already active — leaving it alone"
  exit 0
fi

# /etc/fstab is whitespace-separated and has no quoting, so a path with a space
# in it cannot be written there as one field: it would silently become a mount
# of "/var/tmp/swap" at "file", and the idempotency check below could never
# match it again, so every re-run would append another broken line.
if [[ "$SWAP_FILE" != /* || "$SWAP_FILE" =~ [[:space:]#] ]]; then
  log_warn "SWAP_FILE='$SWAP_FILE' must be an absolute path with no spaces or '#'; skipping."
  exit 0
fi

# Is the existing swap ours? It changes what happens next, and saying the wrong
# one is how a log comes to claim it added a swapfile "alongside" the 512MB one
# it was in fact about to delete.
swap_is_ours=0
if awk 'NR > 1 { print $1 }' /proc/swaps 2>/dev/null | grep -qxF "$SWAP_FILE"; then
  swap_is_ours=1
fi
if (( swap_mb > 0 )); then
  if (( swap_is_ours )); then
    log_warn "$SWAP_FILE is only ${swap_mb}MB (want >= ${SWAP_ENOUGH_MB}MB); replacing it"
  else
    log_warn "swap is only ${swap_mb}MB (want >= ${SWAP_ENOUGH_MB}MB); adding a swapfile alongside it"
  fi
fi

# --- is anything already at that path, and may we delete it? -------------------
# This runs as root and unlinks $SWAP_FILE before writing. The default is
# /swapfile, but an operator can point it anywhere, and silently deleting
# whatever happens to be there is not a risk worth taking for a convenience.
#
# Deleted without asking: a swap area (ours or otherwise), and a plain file left
# behind by a run that died between fallocate and mkswap. Anything else — a
# directory, a device, a symlink, a file with real content — is refused.
if [[ -e "$SWAP_FILE" || -L "$SWAP_FILE" ]]; then
  if [[ -L "$SWAP_FILE" || ! -f "$SWAP_FILE" ]]; then
    log_warn "$SWAP_FILE exists and is not a regular file; refusing to replace it."
    exit 0
  fi
  existing_type="$(as_root blkid -o value -s TYPE "$SWAP_FILE" 2>/dev/null || true)"
  existing_mb=$(( $(stat -c %s "$SWAP_FILE" 2>/dev/null || echo 0) / 1024 / 1024 ))
  if [[ -n "$existing_type" && "$existing_type" != "swap" ]]; then
    log_warn "$SWAP_FILE already holds a ${existing_type} filesystem; refusing to replace it."
    log_warn "Point SWAP_FILE somewhere else."
    exit 0
  fi
  # Anything this script has ever written is at least SWAP_FLOOR_MB, so a file
  # smaller than that is not a leftover of ours — it is somebody's document, and
  # SWAP_FILE was pointed at it by mistake.
  if [[ -z "$existing_type" ]] && (( existing_mb < SWAP_FLOOR_MB )); then
    log_warn "$SWAP_FILE is a ${existing_mb}MB file that is not a swap area; refusing to replace it."
    log_warn "Point SWAP_FILE somewhere else, or delete it yourself if it is a leftover."
    exit 0
  fi
fi

# --- size ---------------------------------------------------------------------
size_mb="$SWAP_SIZE_MB"
if [[ -z "$size_mb" ]]; then
  size_mb=$(( ram_mb * 2 ))
  (( size_mb < SWAP_MIN_MB )) && size_mb=$SWAP_MIN_MB
  (( size_mb > SWAP_MAX_MB )) && size_mb=$SWAP_MAX_MB
fi
if ! [[ "$size_mb" =~ ^[0-9]+$ ]] || (( size_mb < SWAP_FLOOR_MB )); then
  log_warn "SWAP_SIZE_MB='$SWAP_SIZE_MB' is not a usable size in MB (minimum ${SWAP_FLOOR_MB}); skipping."
  exit 0
fi

# --- can this filesystem hold one? --------------------------------------------
# A swapfile must be a plain file of contiguous, real blocks. btrfs needs a
# nodatacow file created a particular way, zfs cannot host one safely at all, and
# in an overlay or tmpfs root there is nothing durable underneath. Refusing here
# beats a half-made file and a confusing swapon error.
swap_dir="$(dirname -- "$SWAP_FILE")"
fstype="$(df -PT "$swap_dir" 2>/dev/null | awk 'NR==2 {print $2}')"
case "$fstype" in
  btrfs|zfs|overlay|overlayfs|tmpfs|aufs|"")
    log_warn "${swap_dir} is ${fstype:-an unknown filesystem}; not creating a swapfile there."
    log_warn "Add swap by hand if this host can take it, or set SWAP_FILE to a path that can."
    exit 0
    ;;
esac

# --- room for it? -------------------------------------------------------------
# An existing swapfile at this path is about to be deleted, so the space it
# occupies is space we have. Without this, a re-run after `swapoff -a` — or
# after a boot where swapon failed — refuses forever, citing disk its own file
# is holding.
free_mb=$(( $(df -Pk "$swap_dir" | awk 'NR==2 {print $4}') / 1024 ))
if [[ -f "$SWAP_FILE" ]]; then
  free_mb=$(( free_mb + $(stat -c %s "$SWAP_FILE" 2>/dev/null || echo 0) / 1024 / 1024 ))
fi
needed_mb=$(( size_mb + MIN_DISK_FREE_GB * 1024 ))
if (( free_mb < needed_mb )); then
  log_warn "Only ${free_mb}MB free on ${swap_dir}; a ${size_mb}MB swapfile would leave under ${MIN_DISK_FREE_GB}GB."
  log_warn "Set SWAP_SIZE_MB lower, or free some disk and re-run: $INSTALL_SH --only swap"
  exit 0
fi

require_root

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would create a ${size_mb}MB swapfile at $SWAP_FILE and enable it"
  log_info "[dry-run] would add it to /etc/fstab and set vm.swappiness=$SWAP_SWAPPINESS"
  exit 0
fi

# --- create -------------------------------------------------------------------
# Re-runnable: an earlier attempt may have left a file that is the wrong size,
# not formatted, or formatted but not enabled. Start from a known state.
#
# The swapoff is checked rather than ignored. It fails when there is not enough
# free RAM to page the area back in, and unlinking it anyway would leave the
# kernel using an inode with no name: the disk space never comes back, and the
# new file is created against space that is not really there.
if (( swap_is_ours )); then
  if ! as_root swapoff "$SWAP_FILE"; then
    log_warn "$SWAP_FILE is in use and could not be turned off (not enough free RAM to page it in)."
    log_warn "Leaving it alone. Free some memory and re-run: $INSTALL_SH --only swap"
    exit 0
  fi
fi
as_root rm -f "$SWAP_FILE"

# fallocate first because it is instant; dd as the fallback because fallocate
# leaves unwritten extents, which XFS refuses to swap on ("it appears to have
# holes"). Which of the two applies is a property of the filesystem, so it is
# cheaper to try and fall back than to enumerate the cases.
make_with_dd() {
  log_info "Writing ${size_mb}MB with dd (slower, but every block is real)"
  as_root dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$size_mb" status=none
}

enable_swapfile() {
  as_root chmod 0600 "$SWAP_FILE" || return 1
  as_root mkswap "$SWAP_FILE" >/dev/null 2>&1 || return 1
  as_root swapon "$SWAP_FILE" 2>/dev/null || return 1
  return 0
}

log_info "Creating a ${size_mb}MB swapfile at $SWAP_FILE (host has ${ram_mb}MB RAM)"
if ! as_root fallocate -l "${size_mb}M" "$SWAP_FILE" 2>/dev/null; then
  make_with_dd
fi

if ! enable_swapfile; then
  as_root rm -f "$SWAP_FILE"
  make_with_dd
  if ! enable_swapfile; then
    as_root rm -f "$SWAP_FILE"
    log_warn "Could not enable swap on this host — most container runtimes forbid it."
    log_warn "Not fatal, but the machine now has no headroom: a heavy test run or"
    log_warn "build can get OOM-killed. Give the box more RAM, or run fewer sessions"
    log_warn "at once (WORKER_CONCURRENCY)."
    exit 0
  fi
fi

# --- make it survive a reboot -------------------------------------------------
# Matched on this exact path in the first field, so a comment mentioning it, or
# some other swap entry, neither satisfies the check nor gets duplicated.
if awk -v f="$SWAP_FILE" '$1 == f' /etc/fstab 2>/dev/null | grep -q .; then
  log_debug "$SWAP_FILE is already in /etc/fstab"
else
  # A leading newline when the file does not end in one. Appending blind to an
  # /etc/fstab whose last line is unterminated joins our entry onto it and
  # destroys that mount — and if the mount was /, the box does not boot.
  lead=""
  if [[ -s /etc/fstab ]] && (( $(tail -c1 /etc/fstab | wc -l) == 0 )); then
    lead=$'\n'
    log_debug "/etc/fstab does not end in a newline; adding one"
  fi
  printf '%s%s none swap sw 0 0\n' "$lead" "$SWAP_FILE" | as_root tee -a /etc/fstab >/dev/null
  log_ok "Added $SWAP_FILE to /etc/fstab, so it survives a reboot"
fi

# --- swappiness ---------------------------------------------------------------
# Low on purpose. This swap is a safety valve, not a tier of memory: pages should
# only go out when the alternative is the OOM killer.
managed_block /etc/sysctl.d/60-"${APP_NAME}"-swap.conf 0644 <<CONF
# Swap here exists to absorb the spikes an agent's builds and test runs produce,
# not to page out a working set that already fits in RAM.
vm.swappiness = ${SWAP_SWAPPINESS}
CONF
as_root sysctl -q -w "vm.swappiness=${SWAP_SWAPPINESS}" 2>/dev/null || true

now_mb=$(( $(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024 ))
log_ok "swap ${now_mb}MB active (vm.swappiness=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo '?'))"
