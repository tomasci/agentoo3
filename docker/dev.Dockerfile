# Runtime image for agentoo's own dev/test compose stack.
#
# Deliberately image-only: no application source is ever COPYed in here. The
# repo is bind-mounted at /app by compose.yaml so the running stack always
# reflects whatever worktree it was launched from, hot-reload included. This
# file only has to provide the interpreter and the CLIs the backend shells out
# to (git, ssh, the docker CLI) — see backend/src/env.ts and
# backend/src/features/docker/cli.ts for why each one is here.
#
# Deliberately NOT installing a Postgres server for backend/tests/pg-cluster.ts
# (its initdb-backed throwaway clusters): initdb refuses outright to run as
# root ("cannot be run as root"). entrypoint.sh does drop every service's own
# command to a non-root uid before it runs (see that file), but `docker
# compose exec` — how these test suites are actually invoked, per this
# file's own README — attaches to the already-running container and so
# bypasses the entrypoint entirely, landing back on root. Installing the
# package would not make those tests pass under that workflow — it would
# only turn their current graceful `test.skip` (no server binaries found,
# see hasPostgres in those files) into a hard failure (server binaries
# found, cluster start refused). See docker/README.md's "Known caveats" for
# exactly which test files that affects and how to run them instead.
#
# Build context is ./docker (see compose.yaml's `context:`), not the repo
# root, so editing application code never invalidates this image's layers and
# never ships the repo as build context.

# Pinned to the exact bun version this box's native install currently runs
# (`bun --version`), matching the project's "exact versions, never ranges"
# convention. Bump deliberately, not on every `docker compose build`.
FROM oven/bun:1.4.0-slim

# oven/bun's -slim tag is Debian; TARGETARCH is set by BuildKit and lets one
# Dockerfile serve both archs the installer supports (scripts/lib/config.sh's
# SUPPORTED_ARCHS="x86_64 aarch64").
ARG TARGETARCH
# Exact Docker CLI release — the "static" bundle from download.docker.com
# ships dockerd/containerd/runc alongside the client; only `docker` itself is
# kept; this container never runs a daemon; the socket, if mounted at all, is
# the host's (see compose.yaml's commented-out socket mount).
ARG DOCKER_CLI_VERSION=27.5.1

# gosu drops root to the bind mount's actual owner before any service command
# runs — see entrypoint.sh's own header for why that owner is read from /app
# rather than configured.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      curl \
      gosu \
    ; \
    rm -rf /var/lib/apt/lists/*; \
    case "$TARGETARCH" in \
      amd64) docker_arch=x86_64 ;; \
      arm64) docker_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      -o /tmp/docker-cli.tgz; \
    tar -xzf /tmp/docker-cli.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    rm -f /tmp/docker-cli.tgz; \
    chmod +x /usr/local/bin/docker; \
    docker --version; \
    git --version; \
    ssh -V; \
    gosu --version

COPY entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app

# Stays root here on purpose — no USER instruction. The uid/gid every
# service actually runs as is not known until the bind mount exists at
# container start (see entrypoint.sh), so it cannot be baked in at build
# time; the entrypoint itself does the drop, per service, every start.
ENTRYPOINT ["docker-entrypoint.sh"]
