---
name: docker
description: Use whenever you need to bring up, stop, restart, or tear down a project's Docker stack, or find the address a running container answers on. Use before running `docker compose` or `docker` by hand in a project's checkout or worktree — this is how those actions stay visible and reversible from the app's own Docker page.
---

# Docker

This skill is a thin wrapper over the app's own Docker feature — it never
calls `docker` or `docker compose` itself. Every command below goes through
this app's API instead, so it shows up on the app's Docker page as a real,
named operation with its own log, not an invisible process only you can see.

## Never run `docker compose` by hand in the worktree

This is the one rule that justifies this skill existing at all: do not run
`docker compose up` (or `stop`/`down`) directly in a project's checkout or
session worktree, even though you technically can. This feature names its
compose project with `docker compose -p agentoo-<slug>_s-<hex12>`; a
hand-run `docker compose` uses the directory's own name instead, so it starts
a *different* stack that the app can only ever see as a "foreign stack" — one
it can list but neither stop nor tear down. Going through this skill instead
of `docker` directly is what keeps the action something the app, and the next
agent who looks at its Docker page, can actually see and undo.

## Commands

```
bun "${CLAUDE_SKILL_DIR}/docker.ts" status
bun "${CLAUDE_SKILL_DIR}/docker.ts" addresses
bun "${CLAUDE_SKILL_DIR}/docker.ts" up [--build] [--force-recreate] [--remove-orphans] [service...]
bun "${CLAUDE_SKILL_DIR}/docker.ts" stop [service...]
bun "${CLAUDE_SKILL_DIR}/docker.ts" restart [service...]
bun "${CLAUDE_SKILL_DIR}/docker.ts" down [--remove-volumes] [--remove-images] [service...]
```

`status` reads the daemon, the compose/Dockerfile detection, every service
and container with its state and health, and any operation already running.
`addresses` reads the same state and prints just the published ports against
every host this box answers on (Tailscale, LAN, loopback) — that is the
address to hand to the `agentoo:browser` skill, never one you remember or
guess from a previous run.

A worked example — bring the stack up, then read where it landed:

```
bun "${CLAUDE_SKILL_DIR}/docker.ts" up --build
bun "${CLAUDE_SKILL_DIR}/docker.ts" addresses
```

`up` already prints its published addresses itself once it succeeds, so the
second command above is usually redundant — it is here to show that
`addresses` is always safe to re-run on its own, any time you just need the
URL again without touching the stack.

## `up` is asynchronous, and "running" is not "ready"

Every mutating command here (`up`, `stop`, `restart`, `down`) POSTs the
request and then follows the operation's own log until it finishes — you see
build output as it happens, and the command's exit code is 0 only if the
operation actually succeeded. That is deliberate: a `--build` that fails is
exactly the moment you most need to see the log, not a status you have to go
poll for separately.

Once `up` reports success, the container is *running* — that is not the same
claim as *ready to answer requests*. A web server can take a few seconds to
bind its port after the process starts. Poll the published address (plain
`fetch`/`curl`, or the `agentoo:browser` skill if what you actually need is to
load the page) until it answers, rather than treating "the operation
succeeded" as "the app is up."

If a mutation is still running after about 15 minutes, this script stops
waiting and prints the operation id rather than hanging forever — re-check
with `status` at that point instead of assuming either outcome.

## When to stop and report instead of improvising

If `status` shows `daemon.available: false`, or both
`detection.hasCompose` and `detection.hasDockerfile` are false, this project
has nothing for this skill to run — no daemon reachable, or no compose file
and no Dockerfile to build from. That is an operator/setup problem, not
something to route around with a raw `docker` command or a guess at a
Dockerfile that isn't there. Report exactly what `status` showed and stop.
