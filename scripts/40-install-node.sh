#!/usr/bin/env bash
# Node.js LTS.
#
# Primary path is the NodeSource apt repo (its `nodistro` suite is codename
# independent, so it works on brand-new Ubuntu releases). Falls back to the
# official binary tarball from nodejs.org.

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "Node.js LTS"
require_root

NODE_DIST_INDEX="https://nodejs.org/dist/index.json"

# Newest LTS release, e.g. "v24.20.0". Empty on failure.
resolve_node_lts() {
  local json
  json="$(curl -fsSL --max-time 20 "$NODE_DIST_INDEX" 2>/dev/null)" || return 1
  if have jq; then
    printf '%s' "$json" | jq -r 'map(select(.lts != false)) | .[0].version' 2>/dev/null
  else
    # One release object per line, then take the first with a named LTS.
    printf '%s' "$json" | tr '{' '\n' | grep -m1 '"lts":"' \
      | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p'
  fi
}

# --- decide which major we want ----------------------------------------------
node_lts_full=""
if [[ -n "$NODE_MAJOR" ]]; then
  log_info "Using pinned Node major $NODE_MAJOR"
else
  node_lts_full="$(resolve_node_lts || true)"
  if [[ -n "$node_lts_full" ]]; then
    NODE_MAJOR="$(major_of "$node_lts_full")"
    log_info "Current Node LTS is $node_lts_full (major $NODE_MAJOR)"
  else
    NODE_MAJOR="$NODE_MAJOR_FALLBACK"
    log_warn "Could not reach nodejs.org; falling back to Node major $NODE_MAJOR"
  fi
fi

# --- already satisfied? -------------------------------------------------------
if have node; then
  cur="$(node --version)"
  if (( $(major_of "$cur") >= NODE_MAJOR )); then
    log_ok "node $cur already satisfies >= v${NODE_MAJOR} — skipping"
    have npm && log_ok "npm $(npm --version)"
    exit 0
  fi
  log_info "node $cur is older than v${NODE_MAJOR}; upgrading"
fi

# --- install via NodeSource ---------------------------------------------------
install_node_nodesource() {
  local keyring=/etc/apt/keyrings/nodesource.gpg
  local list=/etc/apt/sources.list.d/nodesource.list

  as_root install -m 0755 -d /etc/apt/keyrings || return 1

  local tmpkey; tmpkey="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmpkey" || {
    rm -f "$tmpkey"; return 1; }
  as_root rm -f "$keyring"
  if ! { gpg --dearmor <"$tmpkey" >"$tmpkey.gpg" \
      && as_root install -m 0644 "$tmpkey.gpg" "$keyring"; }; then
    rm -f "$tmpkey" "$tmpkey.gpg"; return 1
  fi
  rm -f "$tmpkey" "$tmpkey.gpg"

  printf 'deb [signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$keyring" "$NODE_MAJOR" | as_root tee "$list" >/dev/null || return 1

  apt_update || return 1
  apt_wait_for_lock
  as_root apt-get install "${APT_OPTS[@]}" nodejs
}

# --- install via official tarball --------------------------------------------
install_node_tarball() {
  local arch
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) log_error "No official Node tarball for $(uname -m)"; return 1 ;;
  esac

  [[ -n "$node_lts_full" ]] || node_lts_full="$(resolve_node_lts || true)"
  [[ -n "$node_lts_full" ]] || { log_error "Cannot resolve a Node version to download."; return 1; }

  local name="node-${node_lts_full}-linux-${arch}"
  local url="https://nodejs.org/dist/${node_lts_full}/${name}.tar.xz"
  local tmpd; tmpd="$(mktemp -d)"

  log_info "Downloading $url"
  curl -fsSL --max-time 300 "$url" -o "$tmpd/node.tar.xz" || { rm -rf "$tmpd"; return 1; }

  # Verify against the release SHASUMS when we can fetch them.
  if curl -fsSL --max-time 30 "https://nodejs.org/dist/${node_lts_full}/SHASUMS256.txt" \
       -o "$tmpd/SHASUMS256.txt" 2>/dev/null; then
    local want got
    want="$(awk -v f="${name}.tar.xz" '$2 == f {print $1}' "$tmpd/SHASUMS256.txt")"
    got="$(sha256sum "$tmpd/node.tar.xz" | awk '{print $1}')"
    if [[ -n "$want" && "$want" != "$got" ]]; then
      rm -rf "$tmpd"
      log_error "Checksum mismatch for ${name}.tar.xz"
      return 1
    fi
    log_ok "checksum verified"
  else
    log_warn "Could not fetch SHASUMS256.txt; skipping checksum verification."
  fi

  if ! as_root tar -xJf "$tmpd/node.tar.xz" -C "$NODE_PREFIX" --strip-components=1 \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; then
    rm -rf "$tmpd"; return 1
  fi
  rm -rf "$tmpd"
  hash -r
}

case "$NODE_INSTALL_METHOD" in
  nodesource)
    if ! install_node_nodesource; then
      log_warn "NodeSource install failed; falling back to the official tarball."
      install_node_tarball || die "Could not install Node.js."
    fi
    ;;
  tarball)
    install_node_tarball || die "Could not install Node.js."
    ;;
  *)
    die "Unknown NODE_INSTALL_METHOD '$NODE_INSTALL_METHOD' (expected: nodesource|tarball)."
    ;;
esac

hash -r
have node || die "node is still not on PATH after install."
log_ok "node $(node --version)"
have npm && log_ok "npm $(npm --version)"
