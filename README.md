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

Installed with Anthropic's native installer, which keeps itself updated in the
background. Claude Code ships often, so that matters more here than the
alternative's tidiness.

The native install is per-user (`~/.local/bin/claude`), so the step runs it as
the deploy user rather than root — provisioning runs as root, and a root-owned
install would sit in `/root` where the account running the app cannot see it.
If a systemd unit needs it, either set `Environment=PATH=...` in the unit or
symlink it once (the link survives auto-updates, which replace the target):

```
sudo ln -sfn /home/<user>/.local/bin/claude /usr/local/bin/claude
```

```
CLAUDE_CODE_CHANNEL=latest ...        # every release, instead of ~1-week-old stable
CLAUDE_CODE_INSTALL_METHOD=apt ...    # system-wide from Anthropic's signed apt repo
CLAUDE_CODE_VERSION=2.1.89 ...        # pin a version
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

## Serving over Tailscale

There is no certbot and no Let's Encrypt. The system is reached over Tailscale,
and WireGuard already encrypts every byte between client and host, so plain HTTP
on `tailscale0` is not traffic in the clear.

nginx runs after Tailscale so it can pick up the node's identity, and the site's
`server_name` is filled in automatically:

```
OK    Detected tailnet identity: agentoo.tailnet-abc.ts.net 100.79.119.5 fd7a:...
```

Reach it at `http://<magicdns-name>/` or `http://<tailnet-ip>/`. If Tailscale
has not joined yet, the site is a catch-all — re-run `--only nginx` afterwards
and it fixes itself.

For a browser padlock, `tailscale serve` publishes nginx over HTTPS on the
MagicDNS name with a certificate Tailscale provisions and renews. It is on by
default (`TAILSCALE_SERVE=0` disables it) and needs **HTTPS Certificates**
enabled for the tailnet in the admin console under DNS. If that is off, the step
says so and leaves nginx serving plain HTTP.

Set `NGINX_DOMAIN` only to override the detected name with a domain of your own.

## What gets exposed

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

# override the auto-detected tailnet server_name
NGINX_DOMAIN=ai.example.com /opt/agentoo/install.sh --only nginx

# non-standard SSH port, if detection ever gets it wrong
SSH_PORT=2222 /opt/agentoo/install.sh --only ufw
```

Adding a package means appending to `PKGS_UTILS` in that file — nothing else.

## Adding a step

1. Write `scripts/NN-thing.sh`, sourcing `lib/common.sh` and `lib/config.sh`.
2. Add one line to the `STEPS` array in `install.sh`.

Numbers leave gaps on purpose: `68` app setup (venv, `bun install`), `72`
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
