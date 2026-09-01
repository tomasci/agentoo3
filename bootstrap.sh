#!/usr/bin/env bash
#
#   bootstrap.sh — one-command install on a bare Ubuntu server.
#
# Host this file anywhere it can be fetched over HTTPS (raw.githubusercontent.com
# works). It installs git, clones the repository, and hands off to install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh | sudo bash
#
# Passing arguments through requires `bash -s --`, because the script arrives on
# stdin rather than as a file:
#
#   curl -fsSL .../bootstrap.sh | sudo bash -s -- --branch dev --skip upgrade
#
# SAFER, and what you should prefer on a machine you care about — fetch, read,
# then run:
#
#   curl -fsSLO https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh
#   less bootstrap.sh
#   sudo bash bootstrap.sh
#
# ---------------------------------------------------------------------------
# The repository this bootstrap clones. Override with --repo or REPO_URL.
# HTTPS rather than SSH: a fresh VPS has no deploy key.
DEFAULT_REPO_URL="https://github.com/tomasci/agentoo3.git"
# ---------------------------------------------------------------------------

# Runs before anything else, in POSIX syntax: this file may have been piped into
# `sh`, which cannot parse the rest of it.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bootstrap.sh needs bash, not sh." >&2
  echo "Use:  curl -fsSL <url> | sudo bash" >&2
  exit 1
fi

# Everything lives inside a function that is only called on the last line. If
# the download is truncated mid-transfer, bash reaches EOF without ever calling
# it, so a partial script does nothing instead of half-installing.
_bootstrap_main() {
  set -Eeuo pipefail

  REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
  BRANCH="${BRANCH:-main}"
  TARGET_DIR="${TARGET_DIR:-/opt/agentoo}"
  FORCE=0
  NO_INSTALL=0
  declare -a PASSTHRU=()

  # ------------------------------------------------------------- output ------
  if [ -t 2 ]; then
    c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'
    c_blu=$'\033[34m'; c_bold=$'\033[1m'; c_off=$'\033[0m'
  else
    c_red=""; c_grn=""; c_ylw=""; c_blu=""; c_bold=""; c_off=""
  fi
  info() { printf '%sINFO %s %s\n' "$c_blu" "$c_off" "$*" >&2; }
  ok()   { printf '%sOK   %s %s\n' "$c_grn" "$c_off" "$*" >&2; }
  warn() { printf '%sWARN %s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
  die()  { printf '%sERROR%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

  usage() {
    cat >&2 <<TXT
${c_bold}bootstrap.sh${c_off} — clone and install on a bare Ubuntu server

  --repo URL        Git repository to clone (default: baked into this file)
  --branch NAME     Branch or tag to check out (default: main)
  --dir PATH        Where to clone (default: /opt/agentoo)
  --force           Discard local changes in an existing clone (git reset --hard)
  --no-install      Clone only; do not run install.sh
  -h, --help        This text

Anything else is forwarded to install.sh, e.g. --dry-run, --skip upgrade.

Environment: REPO_URL, BRANCH, TARGET_DIR, GITHUB_TOKEN (for a private repo).
TXT
  }

  # --------------------------------------------------------------- args ------
  while (( $# )); do
    case "$1" in
      --repo)       REPO_URL="${2:?--repo needs a URL}"; shift ;;
      --branch)     BRANCH="${2:?--branch needs a name}"; shift ;;
      --dir)        TARGET_DIR="${2:?--dir needs a path}"; shift ;;
      --force)      FORCE=1 ;;
      --no-install) NO_INSTALL=1 ;;
      -h|--help)    usage; return 0 ;;
      *)            PASSTHRU+=("$1") ;;
    esac
    shift
  done

  [[ -n "$REPO_URL" ]] || die "No repository configured. Pass --repo <url>."

  # ---------------------------------------------------------- privileges -----
  # Escalate lazily — only for the things that genuinely need it (installing
  # prerequisites, writing outside a directory we own). install.sh does its own
  # escalation, so cloning into a user-owned path needs no root at all.
  declare -a SUDO=()
  _escalated=0
  need_root() {
    (( _escalated )) && return 0
    _escalated=1
    [[ "${EUID:-$(id -u)}" -eq 0 ]] && return 0
    command -v sudo >/dev/null 2>&1 || die "Run this as root, or install sudo first."
    sudo -n true 2>/dev/null || {
      info "sudo needs a password"
      sudo -v || die "Could not obtain root."
    }
    SUDO=(sudo)
  }

  printf '\n  %sbootstrap%s  %s (%s) -> %s\n\n' \
    "$c_bold" "$c_off" "$REPO_URL" "$BRANCH" "$TARGET_DIR" >&2

  # --------------------------------------------------------- prerequisites ---
  export DEBIAN_FRONTEND=noninteractive
  need=()
  command -v git  >/dev/null 2>&1 || need+=(git)
  command -v curl >/dev/null 2>&1 || need+=(curl ca-certificates)
  if (( ${#need[@]} )); then
    info "Installing prerequisites: ${need[*]}"
    command -v apt-get >/dev/null 2>&1 \
      || die "apt-get not found. This bootstrap targets Debian/Ubuntu."
    need_root
    "${SUDO[@]+${SUDO[@]}}" apt-get update -qq
    "${SUDO[@]+${SUDO[@]}}" apt-get install -y --no-install-recommends "${need[@]}"
  fi
  ok "git $(git --version | awk '{print $3}')"

  # --------------------------------------------------------- private repos ---
  # Passed per-invocation with `git -c`, so the token is never written into
  # .git/config the way a token embedded in the remote URL would be.
  declare -a GIT_AUTH=()
  if [[ -n "${GITHUB_TOKEN:-}" && "$REPO_URL" == https://github.com/* ]]; then
    info "Using GITHUB_TOKEN for authentication"
    GIT_AUTH=(-c "http.https://github.com/.extraheader=Authorization: Basic $(
      printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0
    )")
  fi

  # Never let a token reach the terminal or a log.
  redact() { sed -E 's#(://)[^@/]+@#\1***@#g; s#(tskey|ghp|gho|github_pat)_[A-Za-z0-9_]+#\1_***#g'; }

  # ---------------------------------------------------------------- clone ----
  # Decide up front whether the destination needs root, so we prompt once.
  _parent="$(dirname "$TARGET_DIR")"
  if [[ -d "$TARGET_DIR" ]]; then
    [[ -w "$TARGET_DIR" ]] || need_root
  elif [[ -d "$_parent" ]]; then
    [[ -w "$_parent" ]] || need_root
  else
    need_root
  fi

  # git refuses to operate on a tree owned by someone else ("detected dubious
  # ownership"). That is exactly the state here: the installer hands the tree to
  # the service account, and this runs as root. Marking it safe is what lets a
  # second run update the clone at all.
  if [[ -d "$TARGET_DIR/.git" ]]; then
    if ! "${SUDO[@]+${SUDO[@]}}" git config --global --get-all safe.directory 2>/dev/null \
         | grep -qxF "$TARGET_DIR"; then
      "${SUDO[@]+${SUDO[@]}}" git config --global --add safe.directory "$TARGET_DIR"
      info "Marked $TARGET_DIR as a safe git directory for root"
    fi
  fi

  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "Existing clone found; updating"
    "${SUDO[@]+${SUDO[@]}}" git "${GIT_AUTH[@]+${GIT_AUTH[@]}}" -C "$TARGET_DIR" \
      fetch --prune origin 2>&1 | redact
    if (( FORCE )); then
      warn "--force: discarding local changes"
      "${SUDO[@]+${SUDO[@]}}" git -C "$TARGET_DIR" checkout -f "$BRANCH" 2>&1 | redact
      "${SUDO[@]+${SUDO[@]}}" git -C "$TARGET_DIR" reset --hard "origin/$BRANCH" 2>&1 | redact
    else
      "${SUDO[@]+${SUDO[@]}}" git -C "$TARGET_DIR" checkout "$BRANCH" 2>&1 | redact
      if ! "${SUDO[@]+${SUDO[@]}}" git -C "$TARGET_DIR" merge --ff-only "origin/$BRANCH" 2>&1 | redact; then
        die "Cannot fast-forward $TARGET_DIR (local commits or changes). Re-run with --force to discard them."
      fi
    fi
  else
    if [[ -e "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
      die "$TARGET_DIR exists and is not empty, but is not a git clone. Move it aside or pass --dir."
    fi
    info "Cloning into $TARGET_DIR"
    "${SUDO[@]+${SUDO[@]}}" install -d -m 0755 "$(dirname "$TARGET_DIR")"
    "${SUDO[@]+${SUDO[@]}}" git "${GIT_AUTH[@]+${GIT_AUTH[@]}}" \
      clone --branch "$BRANCH" --single-branch "$REPO_URL" "$TARGET_DIR" 2>&1 | redact
  fi

  cd "$TARGET_DIR"
  ok "At $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

  # ------------------------------------------------------------ ownership ----
  # Hand the tree to whoever invoked sudo, so they can work in it afterwards.
  owner="${SUDO_USER:-}"
  if [[ -n "$owner" && "$owner" != "root" ]] && (( _escalated )); then
    "${SUDO[@]+${SUDO[@]}}" chown -R "$owner:$owner" "$TARGET_DIR"
    ok "Owner set to $owner"
  fi

  "${SUDO[@]+${SUDO[@]}}" chmod +x install.sh bootstrap.sh scripts/*.sh 2>/dev/null || true

  # -------------------------------------------------------------- install ----
  if (( NO_INSTALL )); then
    ok "Clone complete. Run it yourself:  cd $TARGET_DIR && sudo ./install.sh"
    return 0
  fi

  [[ -f install.sh ]] || die "No install.sh in $TARGET_DIR — wrong repository or branch?"

  info "Handing off to install.sh ${PASSTHRU[*]:-}"
  printf '\n' >&2
  # exec so install.sh owns the terminal and its exit status becomes ours.
  exec "${SUDO[@]+${SUDO[@]}}" ./install.sh ${PASSTHRU[@]+"${PASSTHRU[@]}"}
}

_bootstrap_main "$@"
