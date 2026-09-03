# agentoo

An AI system that installs onto a bare Ubuntu server with one command.

Targets **Ubuntu 22.04+** (developed on 26.04), `x86_64` / `aarch64`, headless.
No desktop and no interactive prompts required.

## Install

### One command, from a bare server

Host `bootstrap.sh` in the repo and run:

```
curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh | sudo bash
```

It installs git, clones the repo to `/opt/agentoo`, and runs `install.sh`.

**Your shell is not left in that directory.** Everything afterwards takes an
absolute path — the installer prints these for you, so you can copy them
straight out of its output:

```
sudo /opt/agentoo/install.sh --only ufw
```

Optional, if you would rather type less:

```
sudo ln -sfn /opt/agentoo/install.sh /usr/local/bin/agentoo
sudo agentoo --only ufw
```

The repo URL is baked into `DEFAULT_REPO_URL` at the top of `bootstrap.sh`;
override it with `--repo` or `REPO_URL` to install from a fork.

To pass arguments through, the script has to arrive on stdin via `bash -s --`:

```
curl -fsSL .../bootstrap.sh | sudo bash -s -- --branch dev --dir /srv/agentoo --skip upgrade
```

**Preferred on a machine you care about** — fetch, read, then run. Piping a
remote script straight into a root shell means trusting the network and the host
at that instant:

```
curl -fsSLO https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh
less bootstrap.sh
sudo bash bootstrap.sh
```

`bootstrap.sh` options: `--repo`, `--branch`, `--dir`, `--force` (discard local
changes), `--no-install` (clone only). Private repos: set `GITHUB_TOKEN` — it is
passed per-invocation so it never lands in `.git/config`.

### From an existing clone

```
git clone https://github.com/tomasci/agentoo3.git && cd agentoo3
./install.sh
```

Run as root, or as a user with `sudo` — it authenticates once up front rather
than stalling halfway through an upgrade. It is **idempotent**: re-running skips
whatever is already in place, and re-uses already-generated passwords.

## Layout

```
bootstrap.sh            curl-able entry point: installs git, clones, runs install.sh
install.sh              orchestrator — parses flags, runs the steps in order
scripts/
  lib/common.sh         logging, dry-run, sudo, apt, env-file, service helpers
  lib/config.sh         every version, package list and path (all overridable)
  00-preflight.sh       OS / arch / privileges / network / disk / RAM checks
  10-system-upgrade.sh  apt update && full-upgrade && autoremove
  20-install-utils.sh   curl, wget, git, build-essential, jq, unzip, ...
  30-install-python.sh  python3 + venv + uv
  40-install-node.sh    Node.js LTS + npm
  50-install-bun.sh     Bun (latest stable)
  55-install-claude-code.sh  Claude Code CLI (signed apt repo)
  60-install-postgres.sh  PostgreSQL + role + database + pgvector
  62-install-redis.sh   Redis, localhost-only, password-protected
  64-install-tailscale.sh Tailscale VPN
  66-install-nginx.sh   nginx on the tailnet (+ tailscale serve for HTTPS)
  68-setup-backend.sh   bun install, OpenAPI spec, migrations, API + worker
  70-setup-frontend.sh  bun install, generate API client, build, service
  80-configure-ufw.sh   firewall — runs last, once all ports are known
  90-summary.sh         verify everything and report
backend/                Hono API + worker driving the Claude Agent SDK
frontend/               React + Vite SPA, served by Bun — see frontend/README.md
library.example/        seed agents/skills/prompts, copied to LIBRARY_DIR on first install
config/  docs/
logs/                   install.log (gitignored)
.state/                 step markers + remembered settings (gitignored)
.env                    generated credentials, mode 0600 (gitignored)
```

Every step script is standalone — `sudo scripts/64-install-nginx.sh` works on
its own, because each sources the shared library itself.

## Usage

From inside the install directory. After a bootstrap install, prefix with
`/opt/agentoo/` — or `cd /opt/agentoo` first.

```
./install.sh --list             # show the steps
./install.sh --dry-run          # print what would happen, change nothing
./install.sh --skip upgrade     # skip the slow full-upgrade
./install.sh --only nginx,ufw   # run just those steps
./install.sh --from postgres    # resume from a step onwards
./install.sh --resume           # skip steps already recorded complete
./install.sh -v                 # echo every command
```

If a step fails the script stops, names the step, and prints the exact command
to resume with. Full transcript in `logs/install.log`.

## Backend

Two services, because a Claude session outlives any HTTP request: `agentoo-api`
(Hono, REST + SSE) and `agentoo-worker` (project setup, Claude sessions).
Restarting the API never kills a running agent.

Agents and skills are markdown in `LIBRARY_DIR`, marked `role: orchestrator` or
`role: subagent` so you can see which drive a session and which are only reached
by delegation. Every orchestrator is composed against the shared method in
`prompts/orchestration-method.md` — how to plan, split, brief and verify — so an
agent file only has to say what is true of its project. Two guarantees get the
last word: delegate the work rather than do it, and run to completion without
stopping to ask. Claude Code's own delegation safeguard never applies to a
custom system prompt, so without this an orchestrator has no policy at all.

Projects live one-per-directory under `PROJECTS_DIR`, each session on its own git
worktree and branch. Details and the private-repo recovery flow:
`backend/README.md`.

## Sessions

Open a project to manage its sessions. Each session takes its own git worktree
and branch, so two can run against one project without colliding — a project
that is not a git repository falls back to a shared checkout, which the UI
labels rather than hiding.

**Nothing runs in a session yet.** Creating one reserves a worktree, a branch,
an orchestrator and a spend cap. Driving the Agent SDK in it and streaming the
output back is the next piece of work.

## SSH keys

Generate ed25519 deploy keys for private repositories from the UI, copy the
public half, test it against the host, and select it when adding a project — or
change it later on the project card, since the key is the thing you most often
discover you got wrong.

Worth knowing: **SSH is never anonymous.** GitHub and GitLab require a key even
for a *public* repository, so an ssh remote fails without one regardless. When a
clone fails, the recovery panel offers three routes — attach a key, switch the
remote to https (which needs no credential for a public repo), or clone it by
hand and press check again. Keys
are passphraseless and there is no ssh-agent — `backend/README.md` explains why
neither is an oversight. The private key never leaves the server: no API response
contains it.

## Frontend

Built and run as a service by step `frontend`: `bun install --frozen-lockfile`,
`bun run build`, then a systemd unit (`agentoo-frontend`) serving `dist/` with
Bun on `FRONTEND_PORT`. Production build, not a dev server.

nginx proxies `/` to it, so a fresh install stops returning 502. `/api/` still
502s until the backend exists — that is expected, and the placeholder UI says so
rather than looking broken.

The projects page is live. A project starts by cloning a repository, adopting a
folder from the sources directory, or as a new empty git repository. Folders are
picked from a list rather than typed — adoption is restricted to `SOURCES_DIR`,
and ones already in use are shown as taken — with the path to copy into shown
alongside for anyone placing a project there by hand.

The API client is generated from the backend's OpenAPI document with kubb —
neither the spec nor the generated client is committed, so the client always
matches the backend running on that machine. The installer generates it, and so
do the git hooks via `scripts/gen-api-client.sh`, since a session's fresh
worktree starts without one. Stack and layout: `frontend/README.md`.

## Claude Code

Installed with Anthropic's native installer, which keeps itself updated in the
background. Claude Code ships often, so that matters more here than the
alternative's tidiness.

The native install is per-user (`~/.local/bin/claude`), so the step runs it as
the deploy user rather than root — provisioning runs as root, and a root-owned
install would sit in `/root` where the account running the app cannot see it.
Because a home directory is on nobody's PATH but its owner's login shell, the
step also symlinks the launcher into `/usr/local/bin` — which *is* on systemd's
default PATH — and adds `~/.local/bin` to the user's `.bashrc`. The link points
at the launcher rather than the versioned binary, so auto-updates keep working.
`CLAUDE_CODE_SYMLINK=0` disables it.

Note that installing as `root` puts the binary under `/root`, which is mode
`0700` — reachable by root, but not by a service running as another user.

```
CLAUDE_CODE_CHANNEL=latest ...        # every release, instead of ~1-week-old stable
CLAUDE_CODE_INSTALL_METHOD=apt ...    # system-wide from Anthropic's signed apt repo
CLAUDE_CODE_VERSION=2.1.89 ...        # pin a version
```

### The service account

The API and worker run as a dedicated non-root account, `agentoo`, created by
the installer. This is not tidiness — Claude Code **refuses to run with
permissions bypassed as root**:

```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```

Every session would fail at startup. The one-command install runs as root on a
fresh VPS, so this is the normal case rather than an edge one, and the installer
picks a service account whenever it would otherwise have used root. Set
`APP_USER=someone` to choose a different one.

Re-running the installer on an existing root-owned install migrates it: it
creates the account, reassigns `projects/`, `sources/`, `library/` and the
checkout, rewrites the units and restarts.

The agent binary itself comes from the SDK, which ships a per-platform CLI in
`node_modules`, so the service account does not need its own Claude Code
install — verified by running the SDK with `claude` absent from `PATH`. The
system-wide install is still what you use for `claude setup-token`.

### Authenticating on a headless server

Claude Code has no credential after install and cannot make requests until you
give it one. Pick **one** of the two options below.

**Option A — Claude subscription** (Pro, Max, Team, or Enterprise).
`claude setup-token` mints a **one-year** OAuth token. It opens a browser, so
run it on your laptop, not the server:

```
claude setup-token
```

Copy the token it prints — it is not saved anywhere — then on the server:

```
echo 'CLAUDE_CODE_OAUTH_TOKEN=paste-token-here' | sudo tee -a /opt/agentoo/.env >/dev/null
```

This token can only make model requests: no Remote Control sessions and no
claude.ai connectors. Locally configured MCP servers still work. It is also not
read in [bare mode](https://code.claude.com/docs/en/headless) (`--bare`) — use
an API key there.

**Option B — Console API key** (pay-as-you-go API billing). Create one at
[platform.claude.com](https://platform.claude.com), then:

```
echo 'ANTHROPIC_API_KEY=sk-ant-...' | sudo tee -a /opt/agentoo/.env >/dev/null
```

**Then load it.** `.env` is only a file — nothing sources it automatically. For
an interactive shell:

```
set -a; . /opt/agentoo/.env; set +a
claude --version && claude doctor
```

For the service that will run the app, point the unit at it instead of exporting
anything:

```
EnvironmentFile=/opt/agentoo/.env
```

Confirm which credential is active at any time:

```
sudo /opt/agentoo/install.sh --only claude
```

It reports the variable it found and where it came from, without printing the
value. If both are set, precedence is `ANTHROPIC_AUTH_TOKEN` >
`ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN`.

Interactive login over SSH also works — run `claude` and paste the code from
your browser back into the terminal — but a token survives reboots and
redeploys, so prefer it on a server.

Claude Code asks for 4 GB RAM; the step warns below that but does not fail.

## Serving over Tailscale

There is no certbot and no Let's Encrypt. The system is reached over Tailscale,
and WireGuard already encrypts every byte between client and host, so plain HTTP
on `tailscale0` is not traffic in the clear.

nginx runs after Tailscale so it can pick up the node's identity, and the site's
`server_name` is filled in automatically:

```
OK    Detected tailnet identity: agentoo.tailnet-abc.ts.net 100.79.119.5 fd7a:...
```

Reach it at `http://<magicdns-name>/` or `http://<tailnet-ip>/`. The installer
prints both, from the tailscale step, the nginx step, and the final summary:

```
OK    MagicDNS name: agentoo.tailnet-abc.ts.net
OK    Reachable on the tailnet at:
    http://agentoo.tailnet-abc.ts.net/
    http://100.93.193.37/
```

If Tailscale has not joined yet, the site is a catch-all — re-run `--only nginx`
afterwards and it fixes itself. If no MagicDNS name appears, enable MagicDNS in
the tailnet admin console under DNS.

Plain HTTP is not a downgrade here: the tailnet is WireGuard, so the traffic is
already encrypted end to end. Do not point a public domain at a `100.x` address
expecting a CDN to proxy it — that range is CGNAT and unroutable from the
internet, so Cloudflare and friends physically cannot reach it.

For a browser padlock, `tailscale serve` publishes nginx over HTTPS on the
MagicDNS name with a certificate Tailscale provisions and renews. It is on by
default (`TAILSCALE_SERVE=0` disables it) and needs **HTTPS Certificates**
enabled for the tailnet in the admin console under DNS. If that is off, the step
says so and leaves nginx serving plain HTTP.

Set `NGINX_DOMAIN` only to override the detected name with a domain of your own.

## What gets exposed

The firewall runs **last**, deliberately, so every port is known by then.
Nothing is published on the public interface except a way in.

| Port | Reachable from | Why |
|---|---|---|
| SSH (detected, usually 22) | tailnet only, once Tailscale is up | rate-limited with `ufw limit` while still public |
| 41641/udp | anywhere | Tailscale WireGuard — this is what makes the rest reachable |
| 80 (nginx), backend 8000, frontend 3000 | **`tailscale0` only** | the app is served over the tailnet |
| PostgreSQL 5432, Redis 6379 | **nothing** — loopback only | never exposed |

80 and 443 are **closed** on the public interface. Set
`UFW_PUBLIC_PORTS="80/tcp 443/tcp"` to publish the site to the internet instead.

PostgreSQL and Redis bind to `127.0.0.1`. Redis also gets a generated password —
that stops a local process, or an SSRF bug in the app, from talking to it
unauthenticated.

### SSH and the VPN

`UFW_TAILSCALE_ONLY` decides whether SSH stays on the public interface. It
defaults to `auto`, which resolves against reality rather than intent:

| Value | Behaviour |
|---|---|
| `auto` (default) | Lock SSH to `tailscale0` **when Tailscale is verified connected**. When it is not, leave SSH public and say so — a half-provisioned host is never stranded. It locks down by itself on the next run. |
| `1` | Always. **Refuses** and fails the step while Tailscale is down, rather than risk a permanent lockout. |
| `0` | Never. SSH stays public, rate-limited. |

So on a fresh box with `TAILSCALE_AUTHKEY` set, everything ends up VPN-only in
one pass. Without a key, you keep a public SSH way in to finish joining the
tailnet, and the next run closes it.

Before cutting a session that arrived over a public address, the step warns and
asks. `--yes` accepts the disconnect; `UFW_TAILSCALE_ONLY=0` keeps SSH public.

Changing `UFW_PUBLIC_PORTS` is reconciled, not just added to: a port dropped
from the list is actually closed on the next run. Only rules the installer
created (tagged with its own comment) are ever removed, so anything you added by
hand with `ufw allow` survives untouched.

## Configuration

`scripts/lib/config.sh` holds every knob, and each one reads from the
environment first, so nothing needs editing to change a value:

Shown with the absolute path, since after a bootstrap install you will not be
inside the directory. Drop the prefix if you are.

```
NODE_MAJOR=22 /opt/agentoo/install.sh --only node
BUN_VERSION=1.1.38 /opt/agentoo/install.sh --only bun
INSTALL_UV=0 /opt/agentoo/install.sh

# unattended tailnet join (create a reusable auth key in the Tailscale admin)
TAILSCALE_AUTHKEY=tskey-auth-... /opt/agentoo/install.sh --only tailscale

# override the auto-detected tailnet server_name
NGINX_DOMAIN=ai.example.com /opt/agentoo/install.sh --only nginx

# non-standard SSH port, if detection ever gets it wrong
SSH_PORT=2222 /opt/agentoo/install.sh --only ufw

# publish the site to the internet as well as the tailnet
UFW_PUBLIC_PORTS="80/tcp 443/tcp" /opt/agentoo/install.sh --only ufw
```

Adding a package means appending to `PKGS_UTILS` in that file — nothing else.

## Adding a step

1. Write `scripts/NN-thing.sh`, sourcing `lib/common.sh` and `lib/config.sh`.
2. Add one line to the `STEPS` array in `install.sh`.

Numbers leave gaps on purpose: `70` backend setup (venv, `uv sync`) and its
systemd unit, once the backend exists.

## Notes

- **Credentials.** Postgres and Redis passwords are generated once and written
  to `.env` (mode 0600, owned by the invoking user, gitignored). Re-running a
  step reuses the existing value, so the app never breaks underneath itself.
  Roles are `CREATE`d or `ALTER`ed to match, so `.env` is always authoritative.
- **Reboots.** A `full-upgrade` can require one. The installer never reboots by
  itself; it reports it and `90-summary.sh` reminds you.
- **PEP 668.** Ubuntu 24.04+ marks the system Python as externally managed, so
  global `pip install` is refused. Use a venv, or `uv`, which the installer
  provides.
- **apt locks.** On a freshly booted VPS `cloud-init` and `unattended-upgrades`
  often hold the dpkg lock; the installer waits (up to `APT_LOCK_TIMEOUT`,
  default 300s) instead of failing.
- **Config prompts** are suppressed (`--force-confold`) and `needrestart` is put
  in automatic mode, so an upgrade never blocks on a full-screen dialog.
- **Streaming.** nginx has `proxy_buffering off` and a 300s read timeout on
  `/api/`, because token-by-token SSE responses break under default buffering
  and model generations outlive the default 60s timeout.
- **Tailscale SSH** (`TAILSCALE_SSH=1`) is off by default. It changes how the
  host authenticates SSH, which should be a deliberate choice.
