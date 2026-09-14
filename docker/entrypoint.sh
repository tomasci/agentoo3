#!/usr/bin/env bash
# Root entrypoint for every service built from this image (init/backend/
# worker/frontend, see compose.yaml's x-app-build). The base oven/bun image
# has no non-root user, so every one of these containers starts as root; this
# script's only job is to stop being root before the service's real command
# ever touches the bind-mounted repo, so nothing it writes through /app lands
# on the host owned by root.
#
# The stack is started by agentoo itself, spawning `docker compose` from its
# own API/worker process — no shell, no `export UID`, no env var it injects
# today. So the uid/gid to become cannot be configured; it is read straight
# off the bind mount that is the entire reason this matters: /app *is* the
# host checkout (see compose.yaml's x-app-volumes), so whichever uid/gid the
# host already made its owner is, by definition, the right one to write as.
# See docker/README.md's "Container user" section.
set -Eeuo pipefail

target_uid="$(stat -c %u /app)"
target_gid="$(stat -c %g /app)"

# gosu (invoked at the bottom) accepts a numeric uid:gid directly, but that
# only ever sets the *primary* group — no supplementary groups, which the
# opt-in docker-socket mount below needs group access through. Giving the
# derived ids a real passwd/group entry lets gosu resolve them by name
# instead, which does pick up every group usermod adds. A fresh container
# filesystem is created on every `up`/`run`, so there is never a stale entry
# left over from a previous run for these lookups to collide with — the
# getent guards below are only for a uid/gid that happens to already be a
# *built-in* system account in the base image.
# -K overrides: /etc/login.defs reserves low uids/gids (typically below
# 1000) for system accounts and warns when asked to hand one to a regular
# user — noise here, not a problem, since the derived id is whatever the
# *host* already uses for its own regular user (999 on the box this was
# built against) and Debian's system range is not that host's business.
group_name="$(getent group "$target_gid" | cut -d: -f1 || true)"
if [[ -z "$group_name" ]]; then
  group_name=appgroup
  groupadd -K GID_MIN=0 -K GID_MAX=2147483647 -g "$target_gid" "$group_name"
fi

user_name="$(getent passwd "$target_uid" | cut -d: -f1 || true)"
if [[ -z "$user_name" ]]; then
  user_name=appuser
  # -M: no home directory (nothing should ever write under one — see the
  # HOME export below). -g: primary group is the one derived above, not a
  # new same-named group. -s nologin: this account is never logged into.
  useradd -M -K UID_MIN=0 -K UID_MAX=2147483647 -g "$group_name" -u "$target_uid" \
    -s /usr/sbin/nologin "$user_name"
fi

# The named volumes shadowing backend/node_modules and frontend/node_modules
# (compose.yaml's x-app-volumes) are not bind mounts, so /app's ownership
# says nothing about them: the docker engine creates each one root:root on
# its very first use, before this entrypoint ever runs. Reconcile once — the
# uid check below makes every run after the first a no-op rather than a full
# recursive chown of an already-populated node_modules tree.
for dir in /app/backend/node_modules /app/frontend/node_modules; do
  if [[ -d "$dir" ]] && [[ "$(stat -c %u "$dir")" != "$target_uid" ]]; then
    chown -R "$target_uid:$target_gid" "$dir"
  fi
done

# Opt-in docker-socket mount (compose.yaml's commented-out volumes override
# on backend/worker): the *host* decides that socket's group, not this
# image, so join it by whatever gid it actually has — never a hardcoded
# "docker" name or gid, which would only ever be right by accident.
if [[ -S /var/run/docker.sock ]]; then
  sock_gid="$(stat -c %g /var/run/docker.sock)"
  sock_group="$(getent group "$sock_gid" | cut -d: -f1 || true)"
  if [[ -z "$sock_group" ]]; then
    sock_group=dockersock
    groupadd -K GID_MIN=0 -K GID_MAX=2147483647 -g "$sock_gid" "$sock_group"
  fi
  usermod -aG "$sock_group" "$user_name"
fi

# $user_name has no home directory (-M above) and nothing else in /etc/passwd
# points HOME anywhere; left unset it would leak in from root's own
# environment, and both bun (install cache) and git (global config search)
# fall back to writing under it. /tmp is world-writable in every base image
# and never needs to survive a restart — anything that does is already one
# of the named volumes.
export HOME=/tmp

exec gosu "$user_name" "$@"
