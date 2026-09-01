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

## Updating an existing install

Re-running the bootstrap updates the clone and installs whatever is new — steps
are idempotent, so anything already in place is skipped. Generated Postgres and
Redis passwords are reused, not regenerated.

Run just the step you added:

```
curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh \
  | sudo bash -s -- --only claude
```

Or the whole thing, which also re-runs the (slow) `full-upgrade`:

```
curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh | sudo bash
```

From the server itself, without going through the bootstrap:

```
cd /opt/agentoo && sudo git pull && sudo ./install.sh --only claude
```

One thing to know before a **full** re-run: local edits under `/opt/agentoo`
block the update. The bootstrap uses a fast-forward-only merge and refuses
rather than clobbering your changes — pass `--force` to discard them. `.env` is
gitignored, so credentials never conflict.

### Remembered settings

Choices that a plain re-run would otherwise silently undo are persisted to
`.state/settings.env` and restored automatically:

| Setting | Undoing it would... |
|---|---|
| `UFW_TAILSCALE_ONLY` | re-open public SSH after you moved it behind the VPN |
| `NGINX_DOMAIN` | rewrite the site as a catch-all `server_name _` |
| `NGINX_ENABLE_TLS`, `NGINX_TLS_EMAIL` | drop the TLS block certbot added, taking the site back to HTTP |

So this, once:

```
sudo UFW_TAILSCALE_ONLY=1 /opt/agentoo/install.sh --only ufw
```

survives every later `bootstrap.sh | sudo bash`. The installer says so when it
happens:

```
INFO  Using remembered UFW_TAILSCALE_ONLY=1 (set on an earlier run)
```

To change one, set it explicitly — an explicit value always wins and replaces
what was stored:

```
sudo UFW_TAILSCALE_ONLY=0 /opt/agentoo/install.sh --only ufw
```

A value is stored only after the step it belongs to succeeds, so a failed run
remembers nothing. `install.sh --only summary` prints the whole file. Deleting
`.state/` forgets everything and returns to the defaults in
`scripts/lib/config.sh`.

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
  64-install-nginx.sh   nginx reverse proxy (+ optional Let's Encrypt)
  70-install-tailscale.sh Tailscale VPN
  80-configure-ufw.sh   firewall — runs last, once all ports are known
  90-summary.sh         verify everything and report
backend/                Python service
frontend/               web UI (Bun)
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

## Claude Code

Installed from Anthropic's **signed apt repository**, not the
`curl https://claude.ai/install.sh | bash` native installer. On a server the
apt package is system-wide, so a systemd unit can exec `claude`; the native
installer is per-user and would strand the binary in `/root` when provisioning
runs as root. The signing key fingerprint is verified against
`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` before the repo is trusted — a
truncated or wrong download is refused rather than silently becoming a package
source.

Trade-off: apt installs do not self-update the way native installs do. They
upgrade with everything else, so `install.sh --only upgrade` keeps Claude Code
current.

```
CLAUDE_CODE_CHANNEL=latest ...        # every release, instead of ~1-week-old stable
CLAUDE_CODE_INSTALL_METHOD=native ... # per-user ~/.local/bin, self-updating
CLAUDE_CODE_VERSION=2.1.89 ...        # pin (native method only)
```

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

## What gets exposed

The firewall runs **last**, deliberately, so every port is known by then.

| Port                         | Reachable from       | Why                                     |
|------------------------------|----------------------|-----------------------------------------|
| SSH (detected, usually 22)   | anywhere, rate-limited | `ufw limit` blunts brute-force attempts |
| 80/tcp                       | anywhere             | ACME HTTP-01 validation, HTTP→HTTPS redirect |
| 443/tcp                      | anywhere             | the app, once TLS is issued             |
| 8000 backend, 3000 frontend  | **`tailscale0` only** | nginx already fronts them; no reason to publish them |
| 41641/udp                    | anywhere             | Tailscale WireGuard                     |

PostgreSQL and Redis bind to `127.0.0.1` and are never opened. Redis also gets a
generated password — that stops a local process, or an SSRF bug in the app, from
talking to it unauthenticated.

### Moving SSH behind the VPN

Once Tailscale is confirmed working:

```
sudo UFW_TAILSCALE_ONLY=1 /opt/agentoo/install.sh --only ufw
```

This restricts SSH to `tailscale0`. It **refuses to apply** unless Tailscale is
actually connected, and warns before cutting a session that arrived over a public
address — getting this wrong on a remote VPS is unrecoverable without console
access.

Rules are additive. Trimming `UFW_PUBLIC_PORTS` later does not delete existing
rules; inspect with `ufw status numbered` and `ufw delete <n>`.

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

# TLS, once DNS already points at this host
NGINX_DOMAIN=ai.example.com NGINX_ENABLE_TLS=1 NGINX_TLS_EMAIL=me@example.com \
  /opt/agentoo/install.sh --only nginx

# non-standard SSH port, if detection ever gets it wrong
SSH_PORT=2222 /opt/agentoo/install.sh --only ufw
```

Adding a package means appending to `PKGS_UTILS` in that file — nothing else.

## Adding a step

1. Write `scripts/NN-thing.sh`, sourcing `lib/common.sh` and `lib/config.sh`.
2. Add one line to the `STEPS` array in `install.sh`.

Numbers leave gaps on purpose: `66` app setup (venv, `bun install`), `68`
systemd units for the backend and frontend.

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
