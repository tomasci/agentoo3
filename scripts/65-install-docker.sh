#!/usr/bin/env bash
# Docker Engine + Compose v2 — the daemon and CLI that
# backend/src/features/docker/ shells out to (`docker compose config
# --format json`, `up -d`, `inspect`, `logs --follow`, `ps --filter label=`).
# Without this step that feature is dead on a fresh host: nothing installs
# Docker, so every request 503s.
#
# Also installs a DOCKER-USER iptables block. Docker inserts its own NAT and
# filter rules ahead of ufw's, in a chain ufw does not manage
# (/etc/default/ufw has MANAGE_BUILTINS=no), so a published container port is
# otherwise reachable from every interface — the public one included. This
# project's posture (see 80-configure-ufw.sh) is that nothing is public except
# a way in; installing Docker as-is would quietly break that promise.
#
# Runs as step 65 — after tailscale (64), so tailscale0 exists when the
# firewall rules below are written, and before backend (68), so the `docker`
# group exists before the systemd units that run as APP_USER first start.
#
#   DOCKER_ENABLE=0 ./install.sh --only docker   # skip; never uninstalls
#   DOCKER_FIREWALL=0 ./install.sh --only docker # install Docker, skip DOCKER-USER (not sticky)

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Docker"

KEYRING=/etc/apt/keyrings/docker.asc
APT_LIST=/etc/apt/sources.list.d/docker.list
DOCKER_DIR=/etc/docker
DAEMON_JSON="$DOCKER_DIR/daemon.json"
FIREWALL_SCRIPT="/usr/local/sbin/${APP_NAME}-docker-firewall"
DROPIN_DIR=/etc/systemd/system/docker.service.d
DROPIN="$DROPIN_DIR/10-${APP_NAME}-firewall.conf"

# DOCKER_ENABLE decides whether *this host* gets Docker at all; DOCKER_ENABLED
# (written to .env below) is the separate, app-level kill switch the feature
# checks on every request. Sticky like UFW_TAILSCALE_ONLY: without this, a
# deliberate DOCKER_ENABLE=0 would be undone by a later plain re-run.
sticky_recall DOCKER_ENABLE

if [[ "$DOCKER_ENABLE" != "1" ]]; then
  log_info "DOCKER_ENABLE=$DOCKER_ENABLE — skipping. Never uninstalls Docker that is already there."
  env_set "$ENV_FILE" DOCKER_ENABLED false
  env_fix_owner "$ENV_FILE"
  setting_remember DOCKER_ENABLE "$DOCKER_ENABLE"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_info "[dry-run] would write DOCKER_ENABLED=false to $ENV_FILE"
  else
    log_ok "Wrote DOCKER_ENABLED=false to $ENV_FILE"
  fi
  exit 0
fi

# DOCKER_TRUSTED_SOURCES(6) guard the one property this whole firewall design
# exists to hold; losing either on a later plain re-run would silently widen
# who can reach a published container port, so both are sticky.
sticky_recall DOCKER_TRUSTED_SOURCES
sticky_recall DOCKER_TRUSTED_SOURCES6

# Whitespace-only must mean the same thing as unset: config.sh's
# ${VAR:-default} only substitutes on an empty string, so a value of all
# spaces slips through as "set" and silently produces zero trusted sources
# instead of the four wide defaults — the opposite outcome from the same
# "trust nothing extra" intent an operator clearing the list would expect,
# which is indefensible for a sticky, security-relevant value. This does not
# change what an empty string means (still the defaults, config.sh's own
# convention throughout); it just makes whitespace-only agree with it rather
# than disagree.
if [[ "$DOCKER_TRUSTED_SOURCES" =~ ^[[:space:]]*$ ]]; then
  DOCKER_TRUSTED_SOURCES="$DOCKER_TRUSTED_SOURCES_DEFAULT"
fi
if [[ "$DOCKER_TRUSTED_SOURCES6" =~ ^[[:space:]]*$ ]]; then
  DOCKER_TRUSTED_SOURCES6="$DOCKER_TRUSTED_SOURCES6_DEFAULT"
fi

# Never silent, either way: an empty/whitespace value reverting to the wide
# defaults, or an operator's own narrower list taking effect, are both worth
# a line in the log rather than something to notice only by inspecting
# DOCKER-USER afterward.
log_info "Trusted sources for DOCKER-USER: $DOCKER_TRUSTED_SOURCES"
log_info "Trusted sources for DOCKER-USER (IPv6): $DOCKER_TRUSTED_SOURCES6"

# A loud warning, not a refusal: an operator may have a real reason to trust
# everything (e.g. this host is meant to be public), and the malformed-value
# guard inside the firewall script (is_trusted_value) already rejects
# anything that is not CIDR/IP-shaped. This just makes an easy typo/copy-paste
# of "the whole internet" impossible to miss in the log.
for _src in $DOCKER_TRUSTED_SOURCES; do
  case "$_src" in
    0.0.0.0/0|0.0.0.0/1) log_warn "DOCKER_TRUSTED_SOURCES contains '$_src' — every published container port would be reachable from the public internet." ;;
  esac
done
for _src in $DOCKER_TRUSTED_SOURCES6; do
  case "$_src" in
    ::/0) log_warn "DOCKER_TRUSTED_SOURCES6 contains '$_src' — every published container port would be reachable from the public internet over IPv6." ;;
  esac
done

require_root

# --- disk (warning only; MIN_DISK_FREE_GB in preflight stays the hard gate) ---
# Docker images and container logs live under /var/lib/docker; check that
# filesystem specifically; /var/lib/docker not existing yet just means a fresh
# install, so fall back to /.
check_disk_free() {
  local target=/var/lib/docker
  [[ -d "$target" ]] || target=/
  local free_kb free_gb
  free_kb="$(df -Pk "$target" 2>/dev/null | awk 'NR==2 {print $4}')"
  free_gb=$(( ${free_kb:-0} / 1024 / 1024 ))
  if (( free_gb < DOCKER_MIN_DISK_FREE_GB )); then
    log_warn "Only ${free_gb}GB free on the filesystem holding $target (want >= ${DOCKER_MIN_DISK_FREE_GB}GB)."
    log_warn "Free some disk, lower DOCKER_MIN_DISK_FREE_GB, or skip with DOCKER_ENABLE=0."
  else
    log_ok "disk ${free_gb}GB free on the filesystem holding $target"
  fi
}
check_disk_free

# --- detection helpers (read-only; safe to call under --dry-run as non-root) --

os_codename() {
  ( . /etc/os-release 2>/dev/null && printf '%s' "${VERSION_CODENAME:-}" )
}

# `deb [arch=... signed-by=...] <url> <codename> stable` — no trailing
# newline, so callers can compare it byte-for-byte against a file's contents.
rendered_list_line() {
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/ubuntu %s stable' \
    "$(dpkg --print-architecture)" "$KEYRING" "$1"
}

current_keyring_fpr() {
  [[ -s "$KEYRING" ]] || return 1
  # `|| true`: awk's early `exit` can SIGPIPE gpg before it finishes writing the
  # rest of the key's output; under pipefail that reads as a real failure.
  gpg --show-keys --with-colons "$KEYRING" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}' || true
}

# True when the keyring's fingerprint and docker.list's content already match
# what this step would render for $1 — the case that must do nothing at all,
# not even an apt_update.
apt_source_already_correct() {
  local codename="$1" fpr expected current
  [[ -s "$KEYRING" && -s "$APT_LIST" ]] || return 1
  fpr="$(current_keyring_fpr || true)"
  [[ "$fpr" == "$DOCKER_GPG_FINGERPRINT" ]] || return 1
  expected="$(rendered_list_line "$codename")"
  current="$(cat "$APT_LIST" 2>/dev/null)"
  [[ "$current" == "$expected" ]]
}

distro_pkgs_available() {
  local cand
  # `|| true`: awk's early `exit` closes the pipe before apt-cache is done
  # writing the rest of its output, and the resulting SIGPIPE would otherwise
  # read as a real failure under `set -o pipefail` and take the whole script
  # down with it (see backend_units_exist's comment above for the same trap).
  cand="$(apt-cache policy docker-compose-v2 2>/dev/null | awk '/Candidate:/{print $2; exit}' || true)"
  [[ -n "$cand" && "$cand" != "(none)" ]]
}

# Captures full output before grepping it, rather than piping straight into
# `grep -q`. `systemctl list-unit-files` can print hundreds of lines, and
# `grep -q` closes its end of the pipe the instant it finds a match — before
# the producer is done writing. Under `set -o pipefail` (on for this whole
# script) that SIGPIPE shows up as a non-zero pipeline status even though the
# match *was* found, which silently flips the `if` below to its else branch.
# A one-shot capture has no live pipe for an early exit to break.
backend_units_exist() {
  local unit_files=""
  has_systemd && unit_files="$(systemctl list-unit-files 2>/dev/null || true)"
  grep -q "^${APP_NAME}-api\.service" <<<"$unit_files"
}

# Same reasoning as backend_units_exist: capture, then grep, never pipe.
docker_user_has_drop() {
  local rules
  rules="$(as_root iptables -w 5 -S DOCKER-USER 2>/dev/null || true)"
  grep -q -- '-j DROP' <<<"$rules"
}

# --- dry-run: print the plan, touch nothing ------------------------------------
print_plan() {
  local codename line
  codename="$(os_codename)"
  [[ -z "$codename" ]] && codename="$DOCKER_CODENAME_FALLBACK"
  line="$(rendered_list_line "$codename")"

  log_info "[dry-run] Docker apt source: $line"
  log_info "[dry-run]   falls back to codename '$DOCKER_CODENAME_FALLBACK', then to distro packages"
  log_info "[dry-run]   (docker.io + docker-compose-v2) if download.docker.com has no '$codename' repo"
  log_info "[dry-run] Would fetch and verify the signing key from https://download.docker.com/linux/ubuntu/gpg"
  log_info "[dry-run]   against fingerprint $DOCKER_GPG_FINGERPRINT (not fetched during a dry run)"
  log_info "[dry-run] Packages: ${PKGS_DOCKER[*]}"
  log_info "[dry-run]   (or, on the distro fallback: ${PKGS_DOCKER_DISTRO[*]})"

  local -a targets=("$APP_USER")
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" && "$SUDO_USER" != "$APP_USER" ]]; then
    targets+=("$SUDO_USER")
  fi
  local u
  for u in $DOCKER_GROUP_USERS; do targets+=("$u"); done
  log_info "[dry-run] Would add to the 'docker' group: ${targets[*]}"

  if [[ "$DOCKER_FIREWALL" == "1" ]]; then
    log_info "[dry-run] Would install $FIREWALL_SCRIPT and apply, in order, in DOCKER-USER:"
    log_info "[dry-run]   1 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
    local iface src
    for iface in $DOCKER_TRUSTED_IFACES; do
      log_info "[dry-run]   -i $iface -j RETURN"
    done
    for src in $DOCKER_TRUSTED_SOURCES; do
      log_info "[dry-run]   -s $src -j RETURN"
    done
    log_info "[dry-run]   (terminal) -j DROP"
    log_info "[dry-run] Would install $DROPIN (ExecStartPost) so it re-applies on every docker.service (re)start"
  else
    log_info "[dry-run] DOCKER_FIREWALL=0 — would NOT touch DOCKER-USER. Published container ports"
    log_info "[dry-run]   would be reachable from the public interface; see README's firewall section."
  fi

  if have docker; then
    log_info "[dry-run] docker already present ($(docker --version 2>/dev/null | head -1 || true))"
    log_info "[dry-run] Would restart docker only if $DAEMON_JSON needs to change (log rotation / iptables=true)"
  else
    log_info "[dry-run] docker not installed yet; would install and start it fresh (no restart needed)"
  fi

  if backend_units_exist; then
    log_info "[dry-run] Would restart ${APP_NAME}-api / ${APP_NAME}-worker only if group membership changed"
  else
    log_info "[dry-run] ${APP_NAME}-api/-worker do not exist yet; the backend step starts them with"
    log_info "[dry-run]   the docker group already in place — no restart needed here"
  fi

  log_info "[dry-run] Would write DOCKER_ENABLED=true to $ENV_FILE"
}

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  print_plan
  exit 0
fi

# ============================================================================
# Everything below here mutates the host.
# ============================================================================

# --- apt source: keyring + docker.list -----------------------------------------

fetch_and_verify_key() {
  local tmp="$1"
  if ! curl -fsSL --max-time 30 https://download.docker.com/linux/ubuntu/gpg -o "$tmp"; then
    log_warn "Could not download the Docker signing key from https://download.docker.com/linux/ubuntu/gpg"
    return 1
  fi
  local fp
  # `|| true`: same SIGPIPE trap as distro_pkgs_available above — gpg has more
  # to say after the "fpr" line and awk stops reading right after it matches.
  fp="$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}' || true)"
  if [[ "$fp" != "$DOCKER_GPG_FINGERPRINT" ]]; then
    log_error "Docker signing key fingerprint mismatch — refusing to trust it."
    log_error "  expected: $DOCKER_GPG_FINGERPRINT"
    log_error "  got:      ${fp:-<no OpenPGP data>}"
    rm -f "$tmp"
    # A mismatch is a possible attack, not a "this codename has no repo yet"
    # condition. die() here, immediately: a caller that instead returned 1
    # would be treated identically to a missing repo, retry the fallback
    # codename (same key, same mismatch), and eventually fall through to
    # installing Docker from an unverified source anyway — which is exactly
    # what happened before this fix (ERROR ... refusing to trust it, followed
    # a few lines later by OK Docker ready (distro source)).
    die "Refusing to trust the Docker apt repo: signing key fingerprint mismatch (see above). If the key was legitimately rotated, update DOCKER_GPG_FINGERPRINT deliberately; otherwise investigate before retrying."
  fi
  log_ok "Verified Docker signing key ${fp:0:16}..."
  return 0
}

# Return codes matter here, not just truthy/falsy: 0 = configured, 1 = this
# codename has no repo (worth trying another codename, or distro packages),
# 2 = could not even reach the key (a network problem, not a codename
# problem — see the rc==2 handling in choose_and_configure_source).
try_official_codename() {
  local codename="$1" tmpkey tmplist

  if [[ -e /etc/apt/sources.list.d/docker.sources ]] && [[ ! -e "$APT_LIST" ]]; then
    # Docker's newer deb822 format. Adding our one-line-style docker.list
    # alongside it makes apt warn the same repo is configured twice; leave
    # whatever manages docker.sources alone and just make sure packages are
    # in place.
    log_warn "/etc/apt/sources.list.d/docker.sources exists (Docker's deb822 format)."
    log_warn "Not adding $APT_LIST alongside it — leaving that source in place."
    return 0
  fi

  tmpkey="$(mktemp)"
  if ! fetch_and_verify_key "$tmpkey"; then
    rm -f "$tmpkey"
    return 2
  fi
  as_root install -d -m 0755 /etc/apt/keyrings
  as_root install -m 0644 "$tmpkey" "$KEYRING"
  rm -f "$tmpkey"

  tmplist="$(mktemp)"
  printf '%s\n' "$(rendered_list_line "$codename")" >"$tmplist"
  as_root install -m 0644 "$tmplist" "$APT_LIST"
  rm -f "$tmplist"

  if ! apt_update; then
    log_warn "No usable Docker apt repo for '$codename'."
    return 1
  fi
  return 0
}

# Sets SOURCE_KIND (official|distro), CHOSEN_CODENAME, REPO_LINE, PKGS_TO_INSTALL.
choose_and_configure_source() {
  local codename rc
  codename="$(os_codename)"
  if [[ -z "$codename" ]]; then
    log_warn "Could not read VERSION_CODENAME from /etc/os-release; trying DOCKER_CODENAME_FALLBACK=$DOCKER_CODENAME_FALLBACK"
    codename="$DOCKER_CODENAME_FALLBACK"
  fi

  # Distro packages already in place from an earlier run's fallback. Tracked
  # so the branches below can keep re-probing the official repo on every run
  # — a network blip that pinned a host to docker.io once must not pin it
  # forever — without ever auto-migrating: removing docker.io out from under
  # running containers is destructive, so PKGS_TO_INSTALL stays the distro
  # set regardless of what the re-probe finds, and a migration is something
  # the operator does deliberately, by hand.
  local was_on_distro_pkgs=0
  pkg_installed docker.io && ! pkg_installed docker-ce && was_on_distro_pkgs=1

  warn_still_on_distro() {
    log_warn "docker.io + docker-compose-v2 (distro packages) are still what's installed here, not"
    log_warn "docker-ce + the official Compose v2 plugin. docker-compose-v2 here trails upstream"
    log_warn "Compose releases and can miss newer compose.yaml features. To migrate deliberately"
    log_warn "once the official repo is reachable (this step does not do this automatically,"
    log_warn "because pulling docker.io out from under running containers is destructive):"
    log_warn "    sudo apt-get remove docker.io docker-compose-v2"
    log_warn "    sudo $INSTALL_SH --only docker"
  }

  if apt_source_already_correct "$codename"; then
    log_ok "Docker apt source already configured correctly (codename '$codename'); leaving it alone"
    SOURCE_KIND=official; CHOSEN_CODENAME="$codename"; REPO_LINE="$(rendered_list_line "$codename")"
    if (( was_on_distro_pkgs )); then
      PKGS_TO_INSTALL=("${PKGS_DOCKER_DISTRO[@]}")
      warn_still_on_distro
    else
      PKGS_TO_INSTALL=("${PKGS_DOCKER[@]}")
    fi
    return 0
  fi

  log_info "Configuring the official Docker apt repo for '$codename'"
  # `cmd || rc=$?`, not `cmd; rc=$?` -- common.sh sets errexit, and a plain
  # `cmd; rc=$?` statement dies on cmd's own non-zero exit before rc=$? ever
  # runs, exactly like a bare command anywhere else under -e. `|| rc=$?`
  # puts the command on the left of a tested `||`, which -e exempts, and
  # only runs the assignment (capturing $?, still cmd's own code) when cmd
  # actually failed -- the same shape 64-install-tailscale.sh's
  # `if install_tailscale_apt "$codename"; then` uses to stay errexit-safe.
  rc=0
  try_official_codename "$codename" || rc=$?
  if (( rc == 0 )); then
    SOURCE_KIND=official; CHOSEN_CODENAME="$codename"; REPO_LINE="$(rendered_list_line "$codename")"
    if (( was_on_distro_pkgs )); then
      PKGS_TO_INSTALL=("${PKGS_DOCKER_DISTRO[@]}")
      log_ok "The official Docker apt repo is reachable and its source is now configured."
      warn_still_on_distro
    else
      PKGS_TO_INSTALL=("${PKGS_DOCKER[@]}")
    fi
    return 0
  elif (( rc == 2 )); then
    die "Could not reach download.docker.com to fetch the Docker signing key. This looks like a network problem (DNS, connectivity, a proxy) rather than a missing repo for this codename, so it is not safe to silently fall back to distro packages. Check connectivity and re-run: $INSTALL_SH --only docker"
  fi

  if [[ "$codename" != "$DOCKER_CODENAME_FALLBACK" ]]; then
    log_warn "Trying DOCKER_CODENAME_FALLBACK='$DOCKER_CODENAME_FALLBACK' instead"
    rc=0
    try_official_codename "$DOCKER_CODENAME_FALLBACK" || rc=$?
    if (( rc == 0 )); then
      log_warn "Used the '$DOCKER_CODENAME_FALLBACK' repo; '$codename' has none yet."
      SOURCE_KIND=official; CHOSEN_CODENAME="$DOCKER_CODENAME_FALLBACK"
      REPO_LINE="$(rendered_list_line "$DOCKER_CODENAME_FALLBACK")"
      if (( was_on_distro_pkgs )); then
        PKGS_TO_INSTALL=("${PKGS_DOCKER_DISTRO[@]}")
        warn_still_on_distro
      else
        PKGS_TO_INSTALL=("${PKGS_DOCKER[@]}")
      fi
      return 0
    elif (( rc == 2 )); then
      die "Could not reach download.docker.com to fetch the Docker signing key. This looks like a network problem (DNS, connectivity, a proxy) rather than a missing repo for this codename, so it is not safe to silently fall back to distro packages. Check connectivity and re-run: $INSTALL_SH --only docker"
    fi
  fi

  log_warn "No usable Docker apt repo for this host — falling back to Ubuntu's own docker.io + docker-compose-v2."
  # A broken source left in sources.list.d would poison every later apt_update
  # on this host, project-wide, not just this step.
  as_root rm -f "$KEYRING" "$APT_LIST"

  if ! distro_pkgs_available; then
    die "Neither the official Docker repo nor Ubuntu's docker-compose-v2 is available for this host. Set DOCKER_CODENAME_FALLBACK to a codename download.docker.com publishes (see https://download.docker.com/linux/ubuntu/dists/), or install Docker manually."
  fi
  SOURCE_KIND=distro; CHOSEN_CODENAME=""
  REPO_LINE="(distro packages: docker.io + docker-compose-v2, no apt source)"
  PKGS_TO_INSTALL=("${PKGS_DOCKER_DISTRO[@]}")
  warn_still_on_distro
}

declare -a PKGS_TO_INSTALL=()
SOURCE_KIND="" CHOSEN_CODENAME="" REPO_LINE=""
choose_and_configure_source
log_info "Source: $REPO_LINE"

apt_install "${PKGS_TO_INSTALL[@]}"
hash -r

have jq || die "jq is required by this step (daemon.json merge). Run: $INSTALL_SH --only utils"

# --- docker group + accounts ---------------------------------------------------

getent group docker >/dev/null 2>&1 || as_root groupadd docker

# The account may not exist yet: `--only docker` can run before the backend
# step that would otherwise create it, and APP_USER is a dedicated account
# whenever the installer runs as root.
ensure_service_user "$APP_USER" "/home/$APP_USER"

groups_changed=0
ensure_group_member() {
  local user="$1" current_groups
  id -u "$user" >/dev/null 2>&1 || { log_warn "User '$user' does not exist; not adding to docker group."; return 0; }
  current_groups="$(id -nG "$user" 2>/dev/null || true)"
  if grep -qx docker <<<"$(tr ' ' '\n' <<<"$current_groups")"; then
    log_debug "$user is already in the docker group"
    return 0
  fi
  as_root usermod -aG docker "$user"
  # Group membership only affects processes started *after* this point: the
  # kernel reads a process's group list at exec time, not on every syscall. A
  # shell the operator already has open, or a service already running, keeps
  # running under its old groups until it restarts — which is exactly why the
  # unit restarts below exist, and why the end-of-step check uses `as_user`
  # (a fresh process) rather than trusting a group list read earlier in this
  # script.
  log_ok "Added $user to the docker group (effective for processes started from now on)"
  groups_changed=1
}

ensure_group_member "$APP_USER"
# Adding the operator's own login is what stops "permission denied on
# /var/run/docker.sock" the moment they try `docker ps` right after a
# successful install. Not root and not APP_USER: root already has this via
# sudo, and APP_USER is handled above regardless of who invoked us.
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" && "$SUDO_USER" != "$APP_USER" ]]; then
  ensure_group_member "$SUDO_USER"
fi
for extra_user in $DOCKER_GROUP_USERS; do
  ensure_group_member "$extra_user"
done

# --- daemon.json: log rotation + the iptables backend the firewall needs -------
#
# Rotation is not cosmetic: json-file (the default log driver) has none of its
# own, this box runs arbitrary user containers, the feature streams them with
# `--follow`, and a chatty container with no cap can fill the disk — taking
# postgres down with it, since nothing here gives docker its own volume.
#
# `iptables: true` is written explicitly because the DOCKER-USER design below
# depends on the iptables backend; `firewall-backend` is deliberately left
# unset so a future Docker default change does not silently swap it out from
# under that design. `live-restore` is deliberately NOT set either — a
# container this dashboard started must not silently outlive a reboot the
# operator never asked it to survive (see args.ts's comment on `runArgs`).
desired_daemon_json="$(jq -n \
  --arg size "$DOCKER_LOG_MAX_SIZE" \
  --arg maxfile "$DOCKER_LOG_MAX_FILE" \
  '{"log-driver":"json-file","log-opts":{"max-size":$size,"max-file":$maxfile},"iptables":true}')"

current_daemon_json="{}"
if [[ -s "$DAEMON_JSON" ]]; then
  if jq -e . "$DAEMON_JSON" >/dev/null 2>&1; then
    current_daemon_json="$(cat "$DAEMON_JSON")"
  else
    log_warn "$DAEMON_JSON is not valid JSON; the merge below replaces it."
  fi
fi

merged_daemon_json="$(jq -s '.[0] * .[1]' <(printf '%s' "$current_daemon_json") <(printf '%s' "$desired_daemon_json"))"

daemon_json_changed=0
if [[ "$(jq -S . <<<"$current_daemon_json")" == "$(jq -S . <<<"$merged_daemon_json")" ]]; then
  log_ok "$DAEMON_JSON already has the settings this step wants"
else
  as_root install -d -m 0755 "$DOCKER_DIR"
  tmp_daemon="$(mktemp)"
  jq -S . <<<"$merged_daemon_json" >"$tmp_daemon"
  as_root install -m 0644 "$tmp_daemon" "$DAEMON_JSON"
  rm -f "$tmp_daemon"
  log_ok "Wrote $DAEMON_JSON"
  daemon_json_changed=1
fi

# --- enable / start / restart docker.service, in that literal order -----------
# `docker_was_active` is captured before anything below touches the service:
# it is what tells "the config changed under a daemon that was already
# running, so it needs an explicit restart" apart from "the daemon is coming
# up fresh and will read the new file on its own" — restarting right after a
# fresh start would just be a second, pointless interruption.
docker_was_active=0
svc_is_active docker && docker_was_active=1

svc_is_enabled docker || svc_enable_now docker
svc_is_active docker || svc_start docker

if (( daemon_json_changed )) && (( docker_was_active )); then
  log_warn "Restarting docker to apply $DAEMON_JSON — every running container stops and is recreated."
  log_warn "(live-restore is deliberately unset, so this is a real interruption, not a no-op.)"
  svc_restart docker
fi

svc_is_active docker || die "docker.service did not start. Check: journalctl -u docker -n 50 --no-pager"

# --- restart the backend units if group membership changed --------------------
if (( groups_changed )); then
  if backend_units_exist; then
    log_warn "Restarting ${APP_NAME}-api and ${APP_NAME}-worker so they pick up the docker group now —"
    log_warn "a running service keeps its old group list until it restarts."
    svc_restart "${APP_NAME}-api"
    svc_restart "${APP_NAME}-worker"
  else
    log_info "${APP_NAME}-api/-worker do not exist yet; the backend step will start them with the"
    log_info "docker group already in place — no restart needed here."
  fi
fi

# --- firewall: narrow DOCKER-USER by source address, not by interface ---------
#
# assembleHosts() in backend/src/features/docker/hosts.ts advertises every
# non-internal IPv4 of every non-bridge interface, which on a single-NIC VPS
# includes the public IP on the same interface LAN traffic arrives on —
# filtering by interface would either drop the LAN promise or fail to close
# the actual hole. Source address is the only axis that keeps both promises.
install_firewall_script() {
  local tmp
  tmp="$(mktemp)"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Managed by %s'"'"'s installer (scripts/65-install-docker.sh).\n' "$APP_NAME"
    printf '# Regenerated on every docker step run — edit that script, not this file.\n'
    printf '#\n'
    printf '# Docker inserts iptables rules ahead of ufw'"'"'s, in DOCKER-USER, a chain ufw\n'
    printf '# does not manage. This narrows it to RELATED/ESTABLISHED replies, a fixed set\n'
    printf '# of trusted interfaces and source networks, then drops everything else that\n'
    printf '# reaches a published container port — by source address, not interface, so a\n'
    printf '# single public+LAN NIC can keep the LAN promise without reopening the public one.\n'
    printf '#\n'
    printf '# RETURN, never ACCEPT, on every allow rule: ACCEPT in DOCKER-USER short-circuits\n'
    printf '# DOCKER-ISOLATION-STAGE-1 and would silently merge networks Docker means to keep\n'
    printf '# apart. Host-local traffic never traverses FORWARD, so this never affects it.\n'
    printf '#\n'
    printf '# %s apply   (re)install our rules at the head of DOCKER-USER, in order.\n' "$FIREWALL_SCRIPT"
    printf '# %s show    print the current DOCKER-USER (and IPv6) rule set.\n' "$FIREWALL_SCRIPT"
    printf '#\n'
    printf '# A container using network_mode: host bypasses Docker'"'"'s NAT entirely and is\n'
    printf '# governed by ufw like any other host process — this script has nothing to do\n'
    printf '# with it.\n'
    printf '\n'
    printf 'set -Eeuo pipefail\n\n'
    printf 'COMMENT=%q\n' "${APP_NAME}-docker"
    printf 'TRUSTED_IFACES=%q\n' "$DOCKER_TRUSTED_IFACES"
    printf 'TRUSTED_SOURCES=%q\n' "$DOCKER_TRUSTED_SOURCES"
    printf 'TRUSTED_SOURCES6=%q\n' "$DOCKER_TRUSTED_SOURCES6"
    printf '\n'
    # Everything below is fixed logic with no installer-time values to
    # interpolate, so it is a quoted heredoc: nothing in it is expanded while
    # *this* script (65-install-docker.sh) writes the file out.
    cat <<'FWSCRIPT'
IPT4=(iptables -w 5)
IPT6=(ip6tables -w 5)

usage() { printf 'Usage: %s apply|teardown|show\n' "$0" >&2; }

# A missing chain is a skip, not an error: DOCKER-USER only exists once
# dockerd has created it, and ip6tables may have no such chain at all when
# IPv6 is disabled or Docker's IPv6 support is off.
chain_present() {
  local -n _cmd="$1"
  "${_cmd[@]}" -S DOCKER-USER >/dev/null 2>&1
}

# A deliberately loose shape check -- real validation is iptables' own job --
# just enough to keep an obviously wrong value (a flag, a hostname, a stray
# token from bad word-splitting) from ever reaching `-I`, where it would
# abort the whole insert partway and leave the chain without a DROP.
is_trusted_value() {
  local v="$1"
  [[ "$v" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] && return 0
  [[ "$v" == *:* && "$v" =~ ^[0-9A-Fa-f:]+(/[0-9]{1,3})?$ ]] && return 0
  return 1
}

# Deletes only OLD managed rules -- everything past the first $2 positions,
# which is where a just-completed insert_block put its own fresh block (0
# skips none, for a full teardown). Matched on the exact comment VALUE via
# `-S`'s argv-shaped output, never a substring of the whole line: an
# operator's own rule commented e.g. "ops-agentoo-docker-exception" must
# never be mistaken for one of ours and silently removed just because our
# tag appears inside a longer comment. Highest line number first: deleting a
# rule renumbers every rule below it, so working top-down would delete the
# wrong line on the second iteration.
remove_managed_below() {
  local -n _cmd="$1"
  local skip="${2:-0}"
  chain_present "$1" || return 0
  local rules_out nums n
  rules_out="$("${_cmd[@]}" -S DOCKER-USER 2>/dev/null || true)"
  nums="$(awk -v c="$COMMENT" -v skip="$skip" '
    /^-A / {
      n++
      if (n <= skip) next
      matched = 0
      for (i = 1; i <= NF; i++) {
        if ($i == "--comment") {
          v = $(i+1)
          gsub(/^"|"$/, "", v)
          if (v == c) { matched = 1; break }
        }
      }
      if (matched) print n
    }
  ' <<<"$rules_out" | sort -rn)"
  for n in $nums; do
    [[ -n "$n" ]] && "${_cmd[@]}" -D DOCKER-USER "$n"
  done
}

# Inserts the new block at positions 1..N (allows, then the terminal DROP),
# BEFORE anything old is deleted -- never the other way around. Deleting the
# old block first (even briefly) would leave DOCKER-USER with the old allows
# and NO DROP at all the moment anything below fails: a bad CIDR, an xtables
# lock timeout, a killed process. Inserting first means the new DROP shadows
# whatever old block still sits below it (unreachable, since DROP is
# terminal) the instant it lands -- only then is the old block redundant
# enough to remove. Leaves its results in the globals _LAST_INSERT_COUNT (how
# many rules were just placed, DROP included) and _LAST_INSERT_HAD_INVALID
# (whether any requested source was skipped) -- set as a plain function call,
# not a $(...) substitution, so apply() can read them straight back.
insert_block() {
  local -n _cmd="$1"
  local -a sources
  # Deliberate word-splitting on $2 (a space-separated list of CIDRs), via
  # read -a rather than an unquoted assignment shellcheck would flag.
  IFS=' ' read -r -a sources <<<"$2"
  local pos=1
  _LAST_INSERT_HAD_INVALID=0

  # Replies to a container-initiated connection. Load-bearing: without this a
  # container's outbound connection still works but the reply (arriving from
  # a public source address) falls through to the terminal DROP below, and
  # every apt-get inside a user container hangs.
  "${_cmd[@]}" -I DOCKER-USER "$pos" -m conntrack --ctstate RELATED,ESTABLISHED \
    -m comment --comment "$COMMENT" -j RETURN
  pos=$((pos + 1))

  local iface
  for iface in $TRUSTED_IFACES; do
    "${_cmd[@]}" -I DOCKER-USER "$pos" -i "$iface" -m comment --comment "$COMMENT" -j RETURN
    pos=$((pos + 1))
  done

  local src
  for src in "${sources[@]}"; do
    if ! is_trusted_value "$src"; then
      echo "Skipping trusted source '$src': not a CIDR or IP address." >&2
      _LAST_INSERT_HAD_INVALID=1
      continue
    fi
    "${_cmd[@]}" -I DOCKER-USER "$pos" -s "$src" -m comment --comment "$COMMENT" -j RETURN
    pos=$((pos + 1))
  done

  "${_cmd[@]}" -I DOCKER-USER "$pos" -m comment --comment "$COMMENT" -j DROP
  _LAST_INSERT_COUNT=$pos
}

apply() {
  local had_invalid=0 acted_v4=0

  if chain_present IPT4; then
    acted_v4=1
    insert_block IPT4 "$TRUSTED_SOURCES"
    (( _LAST_INSERT_HAD_INVALID )) && had_invalid=1
    remove_managed_below IPT4 "$_LAST_INSERT_COUNT"
  else
    echo "DOCKER-USER (IPv4) not present — is docker running? skipping." >&2
  fi

  if chain_present IPT6; then
    insert_block IPT6 "$TRUSTED_SOURCES6"
    (( _LAST_INSERT_HAD_INVALID )) && had_invalid=1
    remove_managed_below IPT6 "$_LAST_INSERT_COUNT"
  else
    echo "DOCKER-USER (IPv6) not present; skipping (not an error — IPv6 may be off)." >&2
  fi

  # Fail loudly here too, not only from the install path's own check (which
  # only covers the very first `apply`) -- the ufw step's self-heal call and
  # dockerd's own ExecStartPost both run this apply directly and have no
  # verification of their own, so whoever called `apply` needs to hear from
  # `apply` itself if the chain did not end up safe.
  local failed=0
  if (( acted_v4 )); then
    local final
    final="$("${IPT4[@]}" -S DOCKER-USER 2>/dev/null || true)"
    if ! grep -q -- '-j DROP' <<<"$final"; then
      echo "DOCKER-USER did not end up with our managed DROP rule after 'apply' -- a published container port may be reachable from the public internet. Run: $0 show" >&2
      failed=1
    fi
  fi

  if (( had_invalid )); then
    echo "One or more trusted-source values were not a recognisable CIDR/IP and were skipped -- DOCKER-USER is still closed, but not exactly as configured. Fix DOCKER_TRUSTED_SOURCES / DOCKER_TRUSTED_SOURCES6 and re-run." >&2
    failed=1
  fi

  (( failed )) && exit 1
  return 0
}

# The other half of DOCKER_FIREWALL=0: actually remove what apply installed,
# rather than just warning that DOCKER-USER is unmanaged from here on.
teardown() {
  if chain_present IPT4; then
    remove_managed_below IPT4 0
  fi
  if chain_present IPT6; then
    remove_managed_below IPT6 0
  fi
}

show() {
  echo "--- iptables -S DOCKER-USER ---"
  "${IPT4[@]}" -S DOCKER-USER 2>&1 || echo "(chain not present)"
  echo "--- ip6tables -S DOCKER-USER ---"
  "${IPT6[@]}" -S DOCKER-USER 2>&1 || echo "(chain not present)"
}

case "${1:-}" in
  apply)    apply ;;
  teardown) teardown ;;
  show)     show ;;
  *) usage; exit 2 ;;
esac
FWSCRIPT
  } >"$tmp"
  # Same cmp -s guard as install_firewall_dropin below: this is regenerated
  # on every run, and rewriting a byte-identical file (plus its log line)
  # every time is noise a real change should not have to compete with.
  if [[ -f "$FIREWALL_SCRIPT" ]] && cmp -s "$tmp" "$FIREWALL_SCRIPT"; then
    log_debug "$FIREWALL_SCRIPT already up to date"
  else
    as_root install -m 0755 "$tmp" "$FIREWALL_SCRIPT"
    log_ok "Wrote $FIREWALL_SCRIPT"
  fi
  rm -f "$tmp"
}

install_firewall_dropin() {
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<CONF
# Managed by ${APP_NAME}'s installer (scripts/65-install-docker.sh).
#
# Escape hatch: if this ever keeps docker.service from starting at boot,
# delete this file and run 'systemctl daemon-reload' — ExecStartPost failing
# fails the whole unit, which is exactly why 65-install-docker.sh verifies the
# firewall applied cleanly before this drop-in is ever installed.
[Service]
ExecStartPost=${FIREWALL_SCRIPT} apply
CONF
  as_root install -d -m 0755 "$DROPIN_DIR"
  if [[ -f "$DROPIN" ]] && cmp -s "$tmp" "$DROPIN"; then
    log_debug "docker.service drop-in already up to date"
  else
    as_root install -m 0644 "$tmp" "$DROPIN"
    as_root systemctl daemon-reload
    log_ok "Installed $DROPIN — re-applies the firewall after every docker.service (re)start"
  fi
  rm -f "$tmp"
}

if [[ "$DOCKER_FIREWALL" == "1" ]]; then
  install_firewall_script
  log_info "Applying the DOCKER-USER firewall block"
  as_root "$FIREWALL_SCRIPT" apply

  # Verified BEFORE the ExecStartPost drop-in is installed, deliberately: that
  # hook fails closed, so a buggy script would otherwise brick docker.service
  # at the next boot. Catching it here, once, turns that into a loud step
  # failure now instead of an unbootable daemon later.
  if ! docker_user_has_drop; then
    die "DOCKER-USER did not end up with our managed DROP rule after 'apply'. Not installing the boot-time hook. Inspect with: $FIREWALL_SCRIPT show"
  fi
  log_ok "Verified: DOCKER-USER ends in our managed DROP"

  install_firewall_dropin
else
  log_warn "DOCKER_FIREWALL=0 — DOCKER-USER is NOT being narrowed. A published container port"
  log_warn "is reachable from every interface, public included. Not sticky: the next run"
  log_warn "without DOCKER_FIREWALL=0 puts the block back."
  # Make the flag real rather than a one-way ratchet: a host that previously
  # ran with the firewall on must actually lose the block and the boot-time
  # hook when it is turned off, not just stop hearing about it. 80-configure-
  # ufw.sh's self-heal call respects this same flag, so nothing re-applies
  # the rules behind this step's back either.
  if [[ -x "$FIREWALL_SCRIPT" ]]; then
    log_info "Removing the existing DOCKER-USER firewall block (installed by an earlier run)"
    as_root "$FIREWALL_SCRIPT" teardown
  fi
  if [[ -f "$DROPIN" ]]; then
    as_root rm -f "$DROPIN"
    as_root systemctl daemon-reload
    log_info "Removed $DROPIN"
  fi
fi

# --- environment ----------------------------------------------------------------
env_set "$ENV_FILE" DOCKER_ENABLED true
env_fix_owner "$ENV_FILE"

# --- verify -----------------------------------------------------------------
# Mirrors 62-install-redis.sh's shape: prove the property this step exists
# for, and die loudly rather than leave a half-working feature behind.

docker --version >/dev/null 2>&1 || die "docker is installed but 'docker --version' failed."
log_ok "$(docker --version 2>/dev/null)"

compose_json="$(docker compose version --format json 2>/dev/null || true)"
compose_version="$(printf '%s' "$compose_json" | jq -r '.version // empty' 2>/dev/null | sed 's/^v//')"
if [[ -z "$compose_version" ]]; then
  # An old-but-present compose plugin can fail `--format json` (or omit
  # `.version`) without the plugin being missing at all — check the plain
  # subcommand too so the die message does not blame "missing" when "too old
  # to answer this way" is the more likely, and more useful, explanation.
  compose_plain="$(docker compose version 2>&1 || true)"
  if [[ -n "$compose_plain" ]]; then
    die "'docker compose version --format json' returned nothing usable, but 'docker compose version' says: ${compose_plain:0:200}. This plugin may simply be older than this check expects (floor: MIN_COMPOSE_VERSION=$MIN_COMPOSE_VERSION) rather than missing."
  fi
  die "'docker compose version' failed or returned nothing usable. Is docker-compose-plugin installed?"
fi
version_gte "$compose_version" "$MIN_COMPOSE_VERSION" \
  || die "docker compose $compose_version is older than MIN_COMPOSE_VERSION=$MIN_COMPOSE_VERSION."
log_ok "docker compose $compose_version"

# The exact call backend/src/features/docker/inspect.ts's getDaemonVersion
# makes. Proves three things the feature actually needs at once: the CLI is
# on PATH, the service account can reach the socket, and a daemon answers.
# as_user builds the invoked process's group list at exec time, so the
# membership added above is live immediately — no re-login, no reboot.
daemon_out="$(as_user "$APP_USER" docker version --format '{{json .}}' 2>&1 || true)"
if ! grep -q '"Server"' <<<"$daemon_out"; then
  log_error "$daemon_out"
  die "'$APP_USER' cannot reach the docker daemon (no \"Server\" in 'docker version --format {{json .}}'). Check group membership (id -nG $APP_USER) and 'systemctl status docker'."
fi
log_ok "Verified daemon access for $APP_USER (the account the backend runs as)"

if [[ "$DOCKER_FIREWALL" == "1" ]] && ! docker_user_has_drop; then
  die "DOCKER-USER lost its managed DROP rule during setup. Run: $FIREWALL_SCRIPT show"
fi

# Persist only what was actually applied, so a failed run remembers nothing.
setting_remember DOCKER_ENABLE "$DOCKER_ENABLE"
setting_remember DOCKER_TRUSTED_SOURCES "$DOCKER_TRUSTED_SOURCES"
setting_remember DOCKER_TRUSTED_SOURCES6 "$DOCKER_TRUSTED_SOURCES6"

log_ok "Docker ready ($SOURCE_KIND source${CHOSEN_CODENAME:+, codename $CHOSEN_CODENAME})"
