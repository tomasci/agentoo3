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

A project starts one of three ways: cloned from a remote, adopted from a folder
in `SOURCES_DIR`, or created as an empty git repository.

**Adoption is restricted to `SOURCES_DIR`, and takes a folder *name*, not a
path.** That turns what was a denylist of dangerous roots into an allowlist:
there is no list of system directories to keep current, and a project cannot be
pointed at `/etc` by construction. Symlinks are resolved before the check, so a
link inside that directory pointing out of it is refused. `SOURCES_DIR` is kept
separate from `PROJECTS_DIR` because the latter holds our own managed project
roots — listing those as adoptable would be nonsense.

One project per folder: two projects sharing a directory would have their agents
writing over each other, so an adopted folder is reported as taken.

A project is one directory under `PROJECTS_DIR` however it started:

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

## Sessions

A session is a unit of work on a project, and each gets **its own git worktree
on branch `agentoo/s-<id>`**. That is what lets two sessions run against the same
project at once without fighting over the working tree.

The worktree is attempted whenever the project is a git repository, *including*
one with no commits: git 2.48+ infers `--orphan` there and produces a perfectly
usable checkout, so refusing on an unborn HEAD would deny isolation to a new
project for no reason. Older git does fail that case, which is why the result is
checked rather than assumed. The fallback is to share the project checkout,
reported as `isolated: false`, because it changes whether concurrent sessions are
safe and should not be hidden.

Deleting a session removes its worktree but **keeps the branch**: it holds
whatever the session did, and deleting a session should not silently discard
work.

### Running a turn

A **turn** is the unit of work, not a session. `POST /sessions/{id}/messages`
records the prompt and, if nothing is already running, moves the session to
`queued` and enqueues one job. The worker claims it with a conditional
`UPDATE ... WHERE status = 'queued'` — that update is the mutex, so a duplicate
delivery finds nothing to do — runs `query()` to completion, and persists every
SDK message as it arrives.

The SDK's `resume` carries the conversation across turns, so the worker holds no
state between them and a restart costs at most the turn in flight. A turn is
never retried: by the time it can fail it has already edited files and spent
tokens.

A message sent while a turn is running is not rejected. It is stored `pending`,
and the running turn drains whatever accumulated behind it when it finishes. On
failure the queue is deliberately *not* drained — replaying the same failure
against every waiting message helps nobody — so those stay pending until the
next send.

Two SDK options do most of the work in the UI:

- `forwardSubagentText: true` forwards a subagent's whole conversation with
  `parent_tool_use_id` set. Without it only tool_use blocks come back and
  delegated work is invisible.
- `task_started` carries `subagent_type`, `description` and the `prompt` the
  orchestrator wrote. That is where the row headings and the visible delegation
  prompts come from — they are read off the stream, not generated.

### Streaming it out

Every message is persisted, then published to `agentoo:session:<id>`. The API
and the worker are separate processes, so Redis bridges them.

Delivery is best-effort on purpose. Each event carries its `seq`, and
`GET /sessions/{id}/events?after=<seq>` replays from the database before going
live, so a client that misses events recovers by asking for what it lacks. The
pub/sub connections are **not** BullMQ's: BullMQ needs
`maxRetriesPerRequest: null` because it blocks waiting for jobs, and that exact
setting means a publish to a Redis that is down never rejects — it waits, inside
the turn that called it. These use a bounded retry instead.

## SSH keys

Generated as ed25519 **with no passphrase**, and there is no ssh-agent. Both are
deliberate:

- A server clones unattended, so nobody is there to type a passphrase.
- `eval "$(ssh-agent -s)"` exports variables into one shell. A long-running
  systemd worker never sees them, and the agent dies on reboot. An agent's only
  job is caching the passphrase of an encrypted key — which is exactly what we
  do not have.

Instead each clone points ssh at one specific key through `GIT_SSH_COMMAND`, so
nothing global is mutated, `~/.ssh/config` is untouched, and a project's key is
explicit. `IdentitiesOnly=yes` is set because otherwise ssh offers every default
identity and a host with a low `MaxAuthTries` answers "Too many authentication
failures".

**The private key is unreachable through the API.** It lives at 0600 under
`SSH_KEYS_DIR` (default `~/.ssh/agentoo`), only its path is in the database, and
no response schema contains it. This service has no authentication, so the only
safe design is for the secret to have no route out.

**SSH is never anonymous.** GitHub, GitLab and Bitbucket all require a key on
their ssh endpoint even for a *public* repository — anonymous access is
HTTPS-only. So `git@github.com:user/public-repo.git` fails without a key exactly
like a private one would, which is why the recovery UI offers switching the
remote to https as well as attaching a key: for a public repo, https needs no
credential at all.

`POST /ssh-keys/{id}/test` runs `ssh -T` against a host. GitHub and GitLab refuse
a shell and **exit non-zero even on success**, so the exit code is useless — the
greeting on stderr is what gets inspected.

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
