#!/usr/bin/env bash
#
#   bootstrap.sh — one-command install on a bare Ubuntu server.
#
# Host this file anywhere it can be fetched over HTTPS (raw.githubusercontent.com
# works). It installs git, clones (or updates) the repository, and hands off to
# install.sh — the same command works for a fresh install and for updating an
# existing one.
#
# RECOMMENDED — runs with a real terminal on stdin, so install.sh's own
# questions (e.g. HTTPS on a domain of your own) can actually be answered:
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh)"
#
# Arguments go after the downloaded script text; the first one becomes that
# `bash -c`'s own $0, so name it anything (`bootstrap` below is as good as any):
#
#   sudo bash -c "$(curl -fsSL .../bootstrap.sh)" bootstrap --branch dev --skip upgrade
#
# Still supported, and shorter to type, but CANNOT ask questions: sudo runs a
# piped command inside its own pty and never forwards your keystrokes into it,
# so any prompt bootstrap.sh or install.sh would show is skipped instead —
# both print what to run afterwards to finish it:
#
#   curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh | sudo bash
#
# Passing arguments through that form requires `bash -s --`, because the script
# arrives on stdin rather than as a file:
#
#   curl -fsSL .../bootstrap.sh | sudo bash -s -- --branch dev --skip upgrade
#
# SAFEST, and worth it on a machine you care about — fetch, read, then run:
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
  echo "Use:" >&2
  echo "  sudo bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh)\"" >&2
  echo "or (works, but cannot ask questions):  curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh | sudo bash" >&2
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

  # A `curl | sudo bash` (or any invocation with no real terminal on stdin,
  # run under sudo) leaves nothing for install.sh's own prompts to read —
  # sudo runs the piped command inside its own pty and never forwards
  # keystrokes into it. Said once, up front, rather than leaving the operator
  # to notice only when the one question at the end silently skips itself.
  if [[ ! -t 0 && -n "${SUDO_USER:-}" ]]; then
    # Only the default repo/branch has a known raw URL to re-fetch from; a
    # custom --repo or --branch (not parsed yet at this point) means we
    # cannot know what to print, so fall back to a placeholder.
    _custom_source=0
    for _a in "$@"; do
      case "$_a" in
        --repo|--branch) _custom_source=1 ;;
      esac
    done
    if [[ "$REPO_URL" == "$DEFAULT_REPO_URL" && "$BRANCH" == "main" && "$_custom_source" -eq 0 ]]; then
      _rerun_cmd='sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh)"'
    else
      _rerun_cmd='sudo bash -c "$(curl -fsSL <url of bootstrap.sh>)"'
    fi
    # --dir isn't parsed yet either (that happens below), but the "finish
    # later" line names $TARGET_DIR — so pre-scan for it here too, the same
    # way, rather than print /opt/agentoo for an operator who passed --dir.
    # The real parser below only ever takes --dir as its own next argument
    # (never --dir=PATH), so that is the only form to look for here too.
    _notice_target_dir="$TARGET_DIR"
    _prev_arg=""
    for _a in "$@"; do
      [[ "$_prev_arg" == "--dir" ]] && _notice_target_dir="$_a"
      _prev_arg="$_a"
    done
    info "No keyboard input available; questions at the end (e.g. HTTPS on your own domain) will be skipped."
    info "To answer them, use:  $_rerun_cmd"
    info "Or finish later:      sudo $_notice_target_dir/install.sh --only https,summary"
  fi

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

  # Updating an existing clone as root is what leaves files inside it root-
  # owned: git only rewrites whatever a fetch/checkout actually touches, so
  # TARGET_DIR's own top level stays owned by whoever it was handed to, while
  # everything an update touches underneath does not. So when this is already
  # root and TARGET_DIR was already handed to a real, non-root account, run
  # git itself AS that account instead — nothing it writes comes back root-
  # owned, and no chown is needed afterwards at all. `runuser` (util-linux) is
  # always present, unlike plain `su`, and unlike `${SUDO[@]}` it still means
  # something once we already are root. GITHUB_TOKEN never depends on this:
  # it reaches git as a literal `-c http...extraheader=` argument (see
  # GIT_AUTH above), not through a credential file or the environment, so it
  # works identically no matter which account runs the command.
  #
  # Everywhere else this changes nothing: a non-root invoker who does not
  # already own TARGET_DIR gets here through `need_root` above and keeps using
  # `${SUDO[@]}` exactly as before; one who already owns it needed no
  # escalation in the first place and was never wrapped in anything.
  declare -a GIT_RUN=("${SUDO[@]+${SUDO[@]}}")
  _ran_git_as_owner=0
  if [[ -d "$TARGET_DIR/.git" && "${EUID:-$(id -u)}" -eq 0 ]]; then
    _existing_owner="$(stat -c '%U' "$TARGET_DIR" 2>/dev/null || true)"
    if [[ -n "$_existing_owner" && "$_existing_owner" != "root" ]] \
       && id -u "$_existing_owner" >/dev/null 2>&1; then
      GIT_RUN=(runuser -u "$_existing_owner" --)
      _ran_git_as_owner=1
    fi
  fi

  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "Existing clone found; updating"
    "${GIT_RUN[@]+${GIT_RUN[@]}}" git "${GIT_AUTH[@]+${GIT_AUTH[@]}}" -C "$TARGET_DIR" \
      fetch --prune origin 2>&1 | redact
    if (( FORCE )); then
      warn "--force: discarding local changes"
      "${GIT_RUN[@]+${GIT_RUN[@]}}" git -C "$TARGET_DIR" checkout -f "$BRANCH" 2>&1 | redact
      "${GIT_RUN[@]+${GIT_RUN[@]}}" git -C "$TARGET_DIR" reset --hard "origin/$BRANCH" 2>&1 | redact
    else
      "${GIT_RUN[@]+${GIT_RUN[@]}}" git -C "$TARGET_DIR" checkout "$BRANCH" 2>&1 | redact
      if ! "${GIT_RUN[@]+${GIT_RUN[@]}}" git -C "$TARGET_DIR" merge --ff-only "origin/$BRANCH" 2>&1 | redact; then
        die "Cannot fast-forward $TARGET_DIR (local commits or changes). Re-run with --force to discard them."
      fi
    fi
  else
    if [[ -e "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
      die "$TARGET_DIR exists and is not empty, but is not a git clone. Move it aside or pass --dir."
    fi
    info "Cloning into $TARGET_DIR"
    # Always the escalation path, never GIT_RUN: there is no existing owner to
    # run as yet, which is exactly what the ownership block below handles.
    "${SUDO[@]+${SUDO[@]}}" install -d -m 0755 "$(dirname "$TARGET_DIR")"
    "${SUDO[@]+${SUDO[@]}}" git "${GIT_AUTH[@]+${GIT_AUTH[@]}}" \
      clone --branch "$BRANCH" --single-branch "$REPO_URL" "$TARGET_DIR" 2>&1 | redact
  fi

  cd "$TARGET_DIR"
  ok "At $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

  # ------------------------------------------------------------ ownership ----
  # Hand the tree to whoever will actually work in it. Prefer the human behind
  # sudo, so they can keep working in it by hand; fall back to the app account
  # install.sh runs everything as when there is no such human — SUDO_USER is
  # empty or "root", which is exactly what an automated re-provision, or a
  # `sudo bash` invoked from an already-root shell, looks like. config.sh
  # (scripts/lib/config.sh) is not sourced yet — it lives inside the very
  # clone this is updating — so "agentoo" mirrors its default (APP_USER falls
  # back to APP_NAME, which defaults to "agentoo") rather than importing it;
  # keep the two in sync if that default ever moves.
  #
  # Skipped entirely when the update above already ran git AS the existing
  # owner (_ran_git_as_owner): nothing came back root-owned in that case, so
  # there is nothing to repair, and a recursive chown here would be actively
  # harmful — TARGET_DIR by then usually holds project data underneath it
  # (installed by `install.sh`, e.g. PROJECTS_DIR, ATTACHMENTS_DIR), and a
  # blanket `chown -R` would re-own a project's bind-mounted Postgres data
  # directory or files its containers wrote as some other uid. That hazard is
  # exactly why this used to only run on the original escalated-sudo path
  # (freshly cloning, or updating without a resolvable owner to run git as):
  # neither of those leaves that kind of data behind to damage. It still runs
  # whenever this process has root right now, not only when it had to
  # escalate to get it — updating an existing, already-owned TARGET_DIR as
  # root never calls need_root() at all (root can already write anywhere, so
  # the `-w` check above it never fails), so `_escalated` alone would miss
  # that case.
  owner="${SUDO_USER:-}"
  [[ -n "$owner" && "$owner" != "root" ]] || owner="agentoo"
  if (( ! _ran_git_as_owner )) \
     && { (( _escalated )) || [[ "${EUID:-$(id -u)}" -eq 0 ]]; }; then
    if "${SUDO[@]+${SUDO[@]}}" chown -R "$owner:$owner" "$TARGET_DIR" 2>/dev/null; then
      ok "Owner set to $owner"
    else
      # Most likely "$owner" (a fallback guess, not a real human) does not
      # exist yet on a brand-new box — install.sh's backend step creates it
      # and reconciles ownership right after this hands off, so this is not
      # fatal.
      warn "Could not chown $TARGET_DIR to '$owner'; install.sh will reconcile ownership"
    fi
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
