# backend

Hono API plus a separate worker, driving the **Claude Agent SDK**.

## Why two processes

A Claude session runs for minutes. It cannot live inside an HTTP request, so the
worker owns sessions and the API only talks to it through Redis. Restarting the
API never kills a running agent.

```
API      (src/index.ts)   REST + SSE, owns Postgres reads/writes
worker   (src/worker.ts)  project setup now, Claude sessions next
Redis                     BullMQ queues + pub/sub for live output
Postgres                  projects, sessions, and every SDK message
```

## Why the Agent SDK, not the Messages API

Agents, Skills, per-project config and sessions are Claude Code features, not API
features. The Agent SDK *is* Claude Code as a library, and it loads a project's
config the same way the CLI does — which is what makes "run agents and skills per
project" work at all.

The SDK ships its Claude Code runtime as a per-platform **optional** dependency.
Never install with optional dependencies omitted, or the SDK has no runtime.

## Agents and skills

They are markdown in `LIBRARY_DIR`, not database rows — a 200-line orchestrator
prompt belongs in a file you can edit and diff, and the installer makes that
directory a git repo so your prompt iteration gets history.

```
library/
  agents/orchestrator.md      frontmatter + the prompt as the body
  skills/testing/SKILL.md
```

Agent frontmatter maps onto the SDK's `AgentDefinition`, plus one field of ours:

```yaml
---
role: orchestrator      # or subagent  <- ours
description: ...        # how Claude decides when to use it
tools: [Read, Edit]     # omit to inherit everything
model: opus
effort: xhigh
maxTurns: 40
---
The prompt body.
```

`role` is the mark that tells you, and the UI, which agents drive a session and
which are only reachable by delegation:

| role | meaning |
|---|---|
| `orchestrator` | may drive a session's main thread and delegate to subagents |
| `subagent` | only invoked by delegation, never drives a session |

Postgres stores which agents and skills a project uses, plus per-project
overrides — never the prompt body.

### Delegation guidance is injected automatically

Every `role: orchestrator` prompt gets Anthropic's documented delegation
instruction appended (`src/library/delegation.ts`), idempotently.

This is not optional polish. Claude Opus 5 delegates far more readily than
earlier models, and Claude Code adds a delegation instruction of its own **only**
when you use its `claude_code` system-prompt preset. An orchestrator's markdown
*is* a custom system prompt, so that safeguard never applies here — without the
injection, Opus 5's eagerness runs unchecked and small tasks get fanned out to
subagents at multiplied cost. Prompting only steers, so pair it with the
deterministic caps (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`,
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `maxBudgetUsd`).

## Projects

A project is one directory under `PROJECTS_DIR`, whether cloned or adopted:

```
projects/<slug>/
  repo/                    the clone, or a symlink to your existing folder
  worktrees/<session-id>/   git worktree per session, branch agentoo/s-<id>
  plugin/                   symlinks to the library agents/skills this project uses
    agents/  skills/
```

`plugin/` sits *beside* the repo, never inside it, so your working tree is never
dirtied and there is no `.git/info/exclude` to maintain per worktree.

Cloning happens on the worker, never inline. Git runs with prompts disabled
(`GIT_TERMINAL_PROMPT=0`, `BatchMode=yes`) so a private repo fails immediately
instead of blocking a worker forever on a passphrase nobody is there to type.
When the failure looks like an auth failure, the project moves to
`needs_manual` with the exact commands to run over SSH, and `POST
/projects/:id/retry` backs the "check again, I did the manual steps" button — if
the repo is now on disk it is adopted rather than re-cloned.

## Input that reaches a subprocess

The API has no authentication — by design, the tailnet is the perimeter. That
makes two inputs load-bearing, because a browser on the tailnet can reach the
API even from a page the operator merely visited.

**`remoteUrl` reaches `git clone`.** That is not a safe sink for an arbitrary
string: `ext::sh -c '<cmd>'` runs a shell command through git's ext transport, a
leading `-` is parsed as an option (`--upload-pack=<cmd>`), and `file://` reads
the local filesystem as a repo. So the URL is checked against an allowlist of
shapes (`https://`, `ssh://`, `user@host:path`) with whitespace, control
characters, `::` and leading dashes rejected — and git is *additionally* invoked
with `--` and `protocol.{ext,fd,file}.allow=never`, so a URL that somehow slipped
past validation still cannot execute anything. Validation runs at the API
boundary and again in the worker, because a queue payload is data.

**`existingPath` becomes a symlink Claude gets full tool access to.** Arbitrary
paths are the feature, so this is not an allowlist: it requires an absolute path,
rejects `..` and control characters, resolves symlinks with `realpath` before
judging the target, and refuses system roots (`/`, `/etc`, `/usr`, `/proc`, ...).

**CORS is off unless `CORS_ORIGINS` is set.** Reflecting the request origin would
let any page read this API's responses and drive its endpoints, since no
credential gates them.

## Commands

```
bun run dev          # API, watch mode
bun run dev:worker   # worker, watch mode
bun run typecheck
bun run lint
bun run db:generate  # after editing src/db/schema.ts
bun run db:migrate
bun run db:studio
```

OpenAPI is served at `/api/openapi.json`; the frontend generates its client from
it with kubb.
