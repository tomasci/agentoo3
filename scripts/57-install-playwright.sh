#!/usr/bin/env bash
# Playwright MCP server — backs the browser skill.
#
# @playwright/mcp is not a backend dependency: nothing in backend/src imports
# it. It is a host capability an agent reaches for, the same shape as `docker`
# (65-install-docker.sh) and `claude` (55-install-claude-code.sh) — installed
# once, system-wide, at a pinned version, from a numbered step. Deliberately
# NOT `bunx @playwright/mcp@latest` at connect time, for two reasons:
#
#   1. Version drift. Project convention is pin-exact-versions (see
#      NODE_MAJOR / BUN_VERSION / CLAUDE_CODE_VERSION in scripts/lib/config.sh)
#      — `@latest` resolves to whatever shipped today, silently, and a build
#      that resolves differently tomorrow is a bug nobody can reproduce.
#   2. Even a *pinned* `bunx @playwright/mcp@x.y.z` still fetches on a cold
#      cache, and it does that inside the MCP connect window. A slow or
#      blocked fetch there does not surface as a slow install; it surfaces as
#      "server not connected", with nothing pointing at why.
#
# Runs between claude (55) and postgres (60): no ordering dependency on
# either, it just belongs with the other host-capability installs rather than
# after the data-layer steps.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Playwright MCP"

have npm || die "npm is not installed. Run: $INSTALL_SH --only node"

require_root

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log_info "[dry-run] would install @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} globally"
  log_info "[dry-run] would resolve the matching Playwright CLI from that install's own deps"
  log_info "[dry-run] would run 'install-deps chromium' as root and 'install chromium' as $APP_USER"
  exit 0
fi

# --- the MCP server itself ----------------------------------------------------
current="$(npm -g list @playwright/mcp --depth=0 2>/dev/null \
  | sed -n 's/.*@playwright\/mcp@\([0-9][0-9A-Za-z.+-]*\).*/\1/p')"
if [[ "$current" == "$PLAYWRIGHT_MCP_VERSION" ]]; then
  log_ok "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION} already installed"
else
  log_info "Installing @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} globally (was: ${current:-none})"
  as_root npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    || die "npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} failed."
fi

# --- verify it landed where PATH expects it -----------------------------------
# Verified rather than assumed. NODE_PREFIX/npm's global prefix is /usr on this
# box (set by 40-install-node.sh via the NodeSource package), so the bin lands
# at /usr/bin/playwright-mcp — but that is a fact about this box, not a
# guarantee, so read it back instead of hardcoding it. systemd units here do
# not set Environment=PATH=, so they inherit the default PATH, and a bin that
# lands outside it is a silent failure that would only surface the first time
# an agent's session tries to connect to the browser skill.
npm_prefix="$(npm -g config get prefix 2>/dev/null)"
[[ -n "$npm_prefix" ]] || die "Could not read the npm global prefix (npm -g config get prefix)."
mcp_pkg_dir="$npm_prefix/lib/node_modules/@playwright/mcp"
[[ -d "$mcp_pkg_dir" ]] || die "@playwright/mcp did not install into $mcp_pkg_dir as expected."

hash -r
if have playwright-mcp; then
  log_ok "'playwright-mcp' resolves on PATH: $(command -v playwright-mcp)"
else
  die "'playwright-mcp' is not on PATH after install (npm prefix: $npm_prefix). systemd units here do not set Environment=PATH=, so a bin outside the default PATH fails silently at MCP-connect time rather than here — put $npm_prefix/bin on PATH or fix the npm prefix and re-run."
fi

# --- resolve the Playwright CLI from THIS package's own dependency tree ------
# Not a separately-installed `playwright`: @playwright/mcp pins its own
# `playwright` version, and the browser revision that gets downloaded is tied
# to that pinned version, not to whatever `playwright` happens to be on the
# box. This host already has a browser cache at ~agentoo/.cache/ms-playwright
# left behind by a stray `npx playwright@1.62.1 install` — the wrong revision
# for whatever @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} actually depends on —
# which is exactly the mismatch resolving from the package's own node_modules
# prevents.
#
# Resolving 'playwright/package.json' rather than 'playwright/cli.js' directly:
# the version of `playwright` that @playwright/mcp pins publishes an `exports`
# map that does not list `./cli.js` at all (only `.`, `./package.json`,
# `./lib/...`, `./jsx-runtime`, `./types/...`, `./test` are exported), so
# `require.resolve('playwright/cli.js', ...)` throws
# ERR_PACKAGE_PATH_NOT_EXPORTED on every run — it is not a transient failure.
# `./package.json` is always exported by every package (Node special-cases
# it), so resolve that instead and derive cli.js from its directory, which
# sits next to package.json in every published playwright release.
pkg_json="$(node -e "
try {
  process.stdout.write(require.resolve('playwright/package.json', { paths: ['$mcp_pkg_dir'] }))
} catch (e) {
  process.exit(1)
}
")" || die "Could not resolve playwright/package.json from ${mcp_pkg_dir}'s own dependencies."
playwright_cli="$(dirname -- "$pkg_json")/cli.js"
[[ -f "$playwright_cli" ]] || die "Derived Playwright CLI path does not exist: $playwright_cli (resolved playwright/package.json at $pkg_json)."
log_ok "Using Playwright CLI at $playwright_cli (resolved from @playwright/mcp's own deps)"

# --- chromium only -------------------------------------------------------------
# No firefox/webkit: nothing on this box drives them, and each is another few
# hundred MB plus its own apt-deps surface for no user.
log_info "Installing chromium's apt dependencies (as root)"
as_root node "$playwright_cli" install-deps chromium \
  || die "playwright install-deps chromium failed."

# The browser binary goes into whichever account launches it, not root's
# cache — mirrors the root/APP_USER split 55-install-claude-code.sh already
# uses for the same reason: a root-owned cache is invisible to the service
# account that actually runs sessions. No PLAYWRIGHT_BROWSERS_PATH override:
# the default (~/.cache/ms-playwright) already resolves correctly once HOME is
# set for that account, and a second path to keep in sync is not worth adding.
ensure_service_user "$APP_USER" "/home/$APP_USER"
app_home="$(getent passwd "$APP_USER" | cut -d: -f6)"
[[ -n "$app_home" ]] || die "No home directory for '$APP_USER'."

log_info "Installing the chromium browser as '$APP_USER'"
as_user "$APP_USER" env HOME="$app_home" node "$playwright_cli" install chromium \
  || die "playwright install chromium failed."

log_ok "Playwright MCP ready: @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}, chromium installed for $APP_USER"
