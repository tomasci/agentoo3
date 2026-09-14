# Dev/test stack (Docker Compose)

A compose stack that runs agentoo itself — postgres, redis, the backend API,
the backend worker and the Vite frontend — for local development or CI-style
testing, hot-reloading against whichever git worktree it is started from.

This is **not** the per-project stack agentoo can start on behalf of a
project it manages (that one is detected and driven by
`backend/src/features/docker/detect.ts` from a project's own `compose.yaml`).
It happens to use the same detector, on purpose: this repo's own root
`compose.yaml` is exactly what that detector looks for, so agentoo can
discover and drive its own dev stack too.

## What runs

| Service | Image / build | Purpose |
|---|---|---|
| `postgres` | `postgres:16.4` | Application database |
| `redis` | `redis:7.4.11` | BullMQ queues, password-protected |
| `init` | `docker/dev.Dockerfile` | One-shot: `bun install` (both packages) + render `openapi.json` + generate the frontend's typed client + apply migrations |
| `backend` | `docker/dev.Dockerfile` | `bun --watch src/index.ts` — the API |
| `worker` | `docker/dev.Dockerfile` | `bun --watch src/worker.ts` — sessions, project setup, queues |
| `frontend` | `docker/dev.Dockerfile` | `vite` dev server |

All four application services build from the same image
(`docker/dev.Dockerfile`): bun, git, openssh-client, ca-certificates and the
`docker` CLI — nothing else, and no application code. The repo is bind-mounted
at `/app` in every one of them; nothing is ever `COPY`'d in. That is the whole
point — edit a file in your checkout and the running stack picks it up.

## Start / stop

From the repo root (`compose.yaml` must be run from the directory it lives in
so its `.env` auto-load and relative build context resolve correctly):

```
docker compose up --build          # first run: builds the image, then starts everything
docker compose up -d               # subsequent runs, detached
docker compose logs -f backend     # follow one service's logs
docker compose down                # stop and remove containers (keeps volumes)
docker compose down -v             # also drop node_modules/postgres/redis volumes — a full reset
```

You do not need to run the `init` service yourself — `backend`, `worker` and
`frontend` all wait on it (`condition: service_completed_successfully`), and it
waits on `postgres`/`redis` being healthy first. First boot takes a couple of
minutes (dependency install + codegen); after that, `init` reruns on every
`up` but finishes in a few seconds (`bun install --frozen-lockfile` and
`drizzle-kit migrate` are both no-ops when there is nothing new to do).

Once up:

- API: `http://localhost:8100/api/health`
- Frontend: `http://localhost:3100/` (proxies `/api` to the backend itself)

## Container user

Every service built from `docker/dev.Dockerfile` starts as root — the base
`oven/bun` image has no other user — but `docker/entrypoint.sh` drops to a
non-root uid/gid before the service's real command (`bun install`, `bun
--watch`, `vite`, …) ever runs, so nothing that command writes through the
bind-mounted `/app` lands on the host owned by root.

That uid/gid is derived, never configured. It cannot be configured: this
stack is started by agentoo itself, spawning `docker compose` from its own
API/worker process — no shell, no `export UID`, nothing it injects today
that this file could read. A `user: "${AGENTOO_UID:-1000}:${AGENTOO_GID:-1000}"`
in `compose.yaml` would be a guess, and a wrong one on any host whose
checkout isn't owned 1000:1000 (999:983 on the box this was built against).
Instead, `entrypoint.sh` reads `stat -c %u /app` / `%g` at container start:
`/app` *is* the bind-mounted checkout, so whichever uid/gid the host already
made its owner is, by definition, the one this container has to write as —
no env var, no default to get wrong. It then:

- Creates a matching passwd/group entry for that id (there is usually none —
  it's whatever the host happens to use, not a Debian system account).
- Chowns the two named `node_modules` volumes to it. Those are not bind
  mounts (see `x-app-volumes` in `compose.yaml`), so `/app`'s ownership says
  nothing about them — the docker engine creates each one root:root on its
  first use, before the entrypoint ever runs.
- `exec`s the service's actual command as that user, via `gosu`.
- If the opt-in docker-socket mount is enabled (see "Opting into the docker
  socket" below), joins whatever group actually owns
  `/var/run/docker.sock` — read with `stat`, the same way, never a
  hardcoded `docker` gid, which differs per host too.

One consequence worth knowing: this only covers a container's own startup.
`docker compose exec` attaches to an already-running container and so
bypasses the entrypoint entirely, landing on root regardless — see "Running
the test suites inside the stack" below for where that matters.

**If you already hit this before the fix** and have root-owned files in your
checkout (`ls -la` shows `root root` where your own user should be), repair
them from a throwaway container:

```
docker run --rm -v "$(pwd)":/work alpine chown -R "$(id -u):$(id -g)" /work
```

Run that from the repo root. `chown -R` is idempotent, so it's safe to
re-run, and it only touches what you bind-mounted in (the checkout), never
anything else on the host.

## Ports and overrides

Every published host port is a compose variable with a default, chosen to
avoid this same machine's own bare-metal install (which occupies
8000/3000/5432/6379):

| Variable | Default | Maps to |
|---|---|---|
| `AGENTOO_API_PORT` | 8100 | backend :8000 |
| `AGENTOO_FRONTEND_PORT` | 3100 | frontend :3000 |
| `AGENTOO_POSTGRES_PORT` | 55432 | postgres :5432 |
| `AGENTOO_REDIS_PORT` | 56379 | redis :6379 |

Override per-invocation (`AGENTOO_API_PORT=8200 docker compose up`) or,
because compose auto-loads a `.env` from the directory it runs in, durably
per-worktree: `cp docker/.env.example .env` at the repo root and edit it.
That root `.env` is the same file the bare-metal installer writes
`BACKEND_PORT`/`DATABASE_URL`/etc into — the two coexist because every
variable this stack reads is named distinctly (`AGENTOO_*_PORT`, never
`BACKEND_PORT`), except `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, which
are deliberately the *same* names, so credentials already in a root `.env`
are picked up here with nothing to duplicate.

Compose variable substitution has no arithmetic — every default above is a
whole port, not an offset from anything.

## Hot reload — how it works, and its limits

- **Backend / worker**: `bun --watch` restarts the process when a file it has
  imported changes. Bind-mounted `/app`, so a host edit is a container-visible
  edit; no rebuild, no restart-the-container.
- **Frontend**: Vite's own dev server + HMR, same bind mount.
- **`node_modules` is not part of the hot reload path.** `/app/backend/node_modules`
  and `/app/frontend/node_modules` are named volumes, not bind mounts — see
  the comment on `x-app-volumes` in `compose.yaml`. Two reasons: a fresh
  worktree usually has no `node_modules` at all, and if it does, the
  `@anthropic-ai/claude-agent-sdk`'s per-platform optional dependency may not
  match the container's platform. Consequence: **adding or updating a
  dependency needs an explicit re-run of `init`** —
  `docker compose up init` (or `docker compose run --rm init`) — hot reload
  alone will not see a `package.json` change.
- Editing `docker/dev.Dockerfile` needs `docker compose build` (or
  `up --build`); nothing about it is watched.
- Editing `backend/openapi.json` inputs (any route/schema) needs the frontend
  client regenerated — again, rerun `init`; a stale generated client is not
  detected automatically inside the running frontend container, the same way
  it is not on a bare checkout (see `scripts/gen-api-client.sh`'s own header).

## Running the test suites inside the stack

```
docker compose exec backend bun test tests/
docker compose exec frontend bun test tests/
```

(or `docker compose run --rm backend bun test tests/` if the service is not
already up.)

The two forms differ in who they run as (see "Container user" above):
`exec` attaches to the already-running container and lands on root, same as
before this stack dropped privileges anywhere; `run --rm` starts a fresh
one-off container through the entrypoint and so runs as the same derived
non-root user the long-running services do. Neither writes through the
bind mount either way — everything under `tests/` that touches disk uses
`node:os`'s `tmpdir()`, not a path under `/app` — so it makes no difference
to file ownership on the host. It does change what the process *is
allowed* to do, which is what "Known caveats" below is about.

## Opting into the docker socket

By default nothing here can see the host's Docker daemon: the `docker` CLI is
installed in the image (so agentoo's own Docker feature has something real to
shell out to), but there is no socket to talk to, so every call the backend or
worker makes returns "no such file or directory" the same way it would on a
box with no Docker installed at all — a deliberate, safe default, not a bug.

To let this stack's `backend`/`worker` actually drive the *host's* Docker
daemon (e.g. to exercise the per-project Docker feature end to end against a
real project), uncomment the `volumes:` override in each of those two
services in `compose.yaml`:

```yaml
    volumes:
      - .:/app
      - backend_node_modules:/app/backend/node_modules
      - frontend_node_modules:/app/frontend/node_modules
      - /var/run/docker.sock:/var/run/docker.sock
```

What that costs: any process able to write to that socket has the same
control over the host as whoever can run `docker` there directly — it can
start a privileged container, bind-mount `/`, and read or change anything the
host's Docker daemon can. That is a real privilege escalation, not a
sandboxed one. Only do this on a host you already trust for that, and never
as a default for a shared or CI box.

## Known caveats

- **First-run cost.** The very first `up` builds the image (a couple of
  minutes for the docker CLI download alone) and `init` does a real
  `bun install` for both packages plus a full `kubb` codegen — expect a
  few minutes before `backend`/`worker`/`frontend` report ready. Every run
  after that is seconds, because the named volumes and `init`'s own
  idempotence carry over.
- **`docker compose exec` runs as root** even though the long-running
  services themselves do not (see "Container user" above — `exec` attaches
  to a container already started by the entrypoint, bypassing it). One
  known, deterministic consequence for `bun test tests/` run that way inside
  `backend` — not a bug this stack introduces, and not something to fix by
  adding packages here:
  - `tests/ssh-keys.test.ts`'s "an unreadable key says so rather than looking
    like a rejection" fails under `exec`: it simulates an unreadable file
    with `chmod 0o000`, which root ignores. It passes under
    `docker compose run --rm backend bun test tests/ssh-keys.test.ts`
    instead, since `run` starts a fresh container through the entrypoint and
    so runs as the same derived non-root user as `backend` itself.
  - `tests/idea-loop.test.ts` (all of it) and one summary test in
    `tests/idea-handoff-recovery.test.ts` fail regardless of `exec` vs.
    `run`: both spin up a throwaway Postgres cluster via `initdb`, and there
    is no Postgres server in this image at all (see dev.Dockerfile's own
    comment on why installing one would not help — the two files' failure
    mode would just change, not go away). Run those two files natively, on
    the host, if you need them exercised.
  Everything else in `bun test tests/` (both packages) passes the same as it
  does outside the container, either way.
- **Claude credentials.** No `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
  is ever baked into the image or the compose file. The API boots and reports
  `claudeCredential: false` in `/api/health` without one; agents simply
  cannot run until you set one (shell env or the root `.env` — see "Ports and
  overrides" above).
- **Tailscale is absent**, same as on a box that never installed it — the
  backend's own hosts/detection code already handles that gracefully
  (`backend/src/features/docker/hosts.ts`); nothing here needs to change for
  it.
- **`/proc/meminfo` and `/proc/stat`** (`features/system/service.ts`) read
  whatever cgroup limits the container itself sees, not the host's — expected
  inside any container, not specific to this stack.
