import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from './logger'
import { readBounded, sleep } from './spawn'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Environment variables that tell git which repository to act on, overriding
 * `cwd` entirely.
 *
 * These must never be inherited. Git exports them to hook processes, so a
 * command run from a hook — `bun test` in pre-push, say — inherits an absolute
 * GIT_DIR pointing at the repository being pushed. Every `git()` call below then
 * targets that repository no matter what `cwd` it was handed, because GIT_DIR
 * wins over cwd. That is not hypothetical: it re-inited this project's own
 * checkout, committed a test fixture over `main`, and registered a /tmp worktree
 * in it, twice. Stripping them makes `cwd` the only thing that selects a repo.
 */
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
] as const

// readBounded (lib/spawn.ts) is what makes the reads below survive an ssh
// grandchild that outlives the git process we actually spawned — see that
// module's own comment for why `new Response(stream).text()` is not safe here.

/**
 * Run git without ever prompting.
 *
 * A clone of a private repo must fail fast rather than block a worker forever
 * waiting on a passphrase that nobody is there to type. GIT_TERMINAL_PROMPT=0
 * and BatchMode=yes turn every credential prompt into an immediate error, which
 * is what lets us hand the user recovery commands instead of hanging.
 *
 * `timeoutMs` covers a different failure mode: a TCP connect to a host that
 * silently drops packets never produces a prompt, an error, or an exit — it
 * just never returns. That is not something GIT_TERMINAL_PROMPT or BatchMode
 * touches, since there is nothing waiting on input; the fix is Bun's own
 * spawn timeout, which kills the process outright once it runs long. Session
 * creation is synchronous, so a caller reaching the network (fetchBranch) must
 * set this, or a black-holed connection holds the HTTP request open for as
 * long as the peer stays silent.
 *
 * That kill alone is not sufficient over ssh: see `readBounded` above for why
 * the stdout/stderr reads need their own, separate bound, and the default
 * `ConnectTimeout=10` below for why ssh is also asked to give up on its own —
 * two different failure windows (before a TCP connection exists, and after),
 * neither of which covers the other.
 */
export async function git(
  args: string[],
  cwd?: string,
  options: { sshCommand?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const inherited = { ...process.env }
  for (const key of REPO_LOCATION_VARS) delete inherited[key]

  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...inherited,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      // A project with an ssh key clones with that one key and nothing else.
      // ConnectTimeout only bounds the TCP connect itself — a peer that
      // accepts and then goes silent is a different, longer-lived hang, which
      // is what `readBounded` and `timeoutMs` above are actually for — but a
      // peer that is simply unreachable should not wait on the OS's own TCP
      // timeout (minutes) to find that out.
      GIT_SSH_COMMAND:
        options.sshCommand ??
        'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    // Bun.spawn only applies a timeout when one is given, so a call with none
    // keeps today's unbounded behaviour — right for a local, disk-only
    // command, which cannot black-hole the way a network one can.
    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs, killSignal: 'SIGKILL' }),
  })

  const [stdout, stderr] = await Promise.all([
    readBounded(proc.stdout, proc.exited),
    readBounded(proc.stderr, proc.exited),
    // Included here too, not just inside readBounded: this is what guarantees
    // proc.exitCode below is populated rather than still null, in the (legal,
    // unordered) case where both reads reach natural EOF before Bun's own
    // wait() on the process has resolved.
    proc.exited,
  ])

  // A process killed for running past the timeout dies by signal, not by a
  // normal exit, so `exitCode` reads back null rather than a nonzero code —
  // and it is killed before it gets a chance to write anything to stderr of
  // its own. Left alone, that surfaces as a git failure with no explanation
  // attached, which is worse than the hang it replaced.
  const timedOut = proc.exitCode === null
  const stderrText = stderr.trim()
  const reason = timedOut
    ? stderrText ||
      (options.timeoutMs !== undefined
        ? `git ${args[0]} timed out after ${options.timeoutMs}ms`
        : `git ${args[0]} was killed by signal ${proc.signalCode ?? 'unknown'}`)
    : stderrText

  logger.debug(`git ${args.join(' ')} -> ${timedOut ? 'timeout' : proc.exitCode}`)
  return {
    ok: proc.exitCode === 0,
    stdout: stdout.trim(),
    stderr: reason,
    exitCode: proc.exitCode ?? -1,
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], path)
  return result.ok && result.stdout === 'true'
}

/**
 * Whether `path` is itself the top level of a work tree — not merely
 * somewhere *inside* one.
 *
 * `isGitRepo`'s `--is-inside-work-tree` is also true for a plain, ordinary
 * folder that simply sits *inside* a larger, enclosing repository — and
 * PROJECTS_DIR itself commonly does, since a real install's PROJECTS_DIR
 * lives inside agentoo's own checkout. A project whose `repo/` is not a git
 * repository at all would then read back as "available", with an identity
 * write landing in the *enclosing* repository's config instead of failing —
 * not a hypothetical, see this function's own test fixtures for the exact
 * nesting that was found on a real box. Comparing `path`'s own realpath
 * against `--show-toplevel`'s (also realpath'd, so a resolved path and git's
 * own answer are compared on the same terms) is what tells "is the root"
 * apart from "is merely somewhere inside one".
 *
 * Returns false rather than throwing for a path that does not exist (a
 * `repo/` the setup worker never created) or a symlink whose target was
 * removed (an adopted folder deleted out from under a project) — both are
 * ordinary "not a repo root" answers a caller can act on, not failures to
 * propagate. A subdirectory of a real repo also reads false here, on purpose:
 * an adopted folder that turns out to be a subfolder of a bigger repository
 * is not a case this feature supports, rather than one it gets wrong.
 */
export async function isRepoRoot(path: string): Promise<boolean> {
  try {
    const real = await realpath(path)
    const top = await git(['rev-parse', '--show-toplevel'], real)
    if (!top.ok) return false
    const topReal = await realpath(top.stdout)
    return topReal === real
  } catch {
    return false
  }
}

export async function currentBranch(path: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
  return result.ok ? result.stdout : undefined
}

/**
 * `currentBranch`, filtered down to an actual branch.
 *
 * `git rev-parse --abbrev-ref HEAD` prints the literal string "HEAD" on a
 * detached checkout — it is not a branch called HEAD, it is what git prints
 * when there is no branch to name. A caller that skipped this check would
 * cut a session's worktree from "origin/HEAD" or persist "HEAD" as a
 * project's default branch: a start point that resolves to nothing, on a
 * project where a human happened to check out a tag or a commit by hand.
 */
export async function checkedOutBranch(path: string): Promise<string | undefined> {
  const branch = await currentBranch(path)
  return branch && branch !== 'HEAD' ? branch : undefined
}

export async function remoteUrl(path: string): Promise<string | undefined> {
  const result = await git(['remote', 'get-url', 'origin'], path)
  return result.ok && result.stdout ? result.stdout : undefined
}

export async function isEmptyDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch {
    return false
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * Bring `refs/remotes/<remote>/<branch>` up to date, without touching the
 * working tree or any local branch.
 *
 * The refspec is written out in full — `+refs/heads/<branch>:refs/remotes/
 * <remote>/<branch>` — rather than a bare `git fetch <remote> <branch>`, for
 * three reasons that all matter for a project this tool did not set up
 * itself: it does not depend on the remote having a wildcard fetch refspec
 * configured (an adopted repository may not); the leading `+` makes the
 * update non-fast-forward-safe, so a force-push upstream still lands here
 * instead of failing the fetch; and the branch name is embedded inside the
 * refspec string, where git cannot mistake it for a command-line option, an
 * argument-injection route a bare positional argument would leave open.
 *
 * Never `git pull` here: this repository is the one live checkout a
 * non-isolated session may still be running an agent in (see
 * `isGitRepo`/`worktreePath` — a session without a worktree shares it), and
 * `pull` moves the working tree and index in ways that would race that agent.
 * `fetch` only ever writes to `refs/remotes/...`, which nothing else reads
 * from until a worktree is deliberately started there.
 *
 * `options.sshCommand` is not optional in practice for a private repo with a
 * project-specific deploy key: `git()`'s own default `GIT_SSH_COMMAND` takes
 * precedence over the `core.sshCommand` that `configureRepoSsh` already wrote
 * into this repository's config (`GIT_SSH_COMMAND` outranks `core.sshCommand`
 * whenever both are set), so leaving it unset here would silently authenticate
 * with no key at all and this fetch would fail every single time on exactly
 * the projects that most need it. The caller is expected to resolve the
 * project's key the same way `queue/project-setup.worker.ts` does and pass it
 * through explicitly, rather than this function reaching for `core.sshCommand`
 * itself — explicit beats ambient, and it is one code path instead of two.
 */
export async function fetchBranch(
  repoPath: string,
  remote: string,
  branch: string,
  options: { timeoutMs?: number; sshCommand?: string } = {},
): Promise<GitResult> {
  return git(
    ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    repoPath,
    { timeoutMs: options.timeoutMs ?? 20_000, sshCommand: options.sshCommand },
  )
}

/**
 * Resolve `ref` to a commit sha, or undefined when it does not exist.
 *
 * `--verify` is what turns "no such ref" into a plain failed result instead of
 * git's usual ambiguous-revision essay on stderr — the callers here only ever
 * want to know whether the ref is there, or what it points at when it is.
 */
export async function revParse(repoPath: string, ref: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', ref], repoPath)
  return result.ok ? result.stdout : undefined
}

/**
 * Create a worktree on a new branch. Requires the repo to have at least one
 * commit, unless `startPoint` names one that exists — see below.
 *
 * `startPoint` pins what the new branch is cut from: a remote-tracking ref, a
 * local branch, or a bare sha. Omitted, git uses HEAD, which for a repo with
 * no commits yet is unborn — git 2.48+ infers `--orphan` there and produces a
 * usable checkout anyway, which is the path a brand new project relies on.
 */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  startPoint?: string,
): Promise<GitResult> {
  const args = ['worktree', 'add', '-b', branch, worktreePath]
  if (startPoint) args.push(startPoint)
  return git(args, repoPath)
}

/**
 * Give a session branch an upstream, so `git pull` has somewhere to pull from.
 *
 * Without this the branch has no tracking ref and `git pull` stops with "no
 * tracking information for the current branch" — which an agent asked to "pull
 * and check again" cannot get past. The upstream is the branch the worktree was
 * cut from, so pulling brings in what moved there.
 *
 * `git push` stays safe: push.default is `simple`, which refuses to push a
 * branch whose upstream has a different name rather than quietly pushing a
 * session's work onto main.
 */
export async function trackUpstream(
  worktreePath: string,
  remote: string,
  branch: string,
): Promise<GitResult> {
  return git(['branch', `--set-upstream-to=${remote}/${branch}`], worktreePath)
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<GitResult> {
  return git(['worktree', 'remove', '--force', worktreePath], repoPath)
}

/**
 * Record the project's ssh key in the repository's own config.
 *
 * Injecting GIT_SSH_COMMAND per call (above) only covers git commands *we*
 * spawn. A session's whole point is that an agent runs its own commands, and a
 * bare `git fetch` in a worktree has no key handed to it — it fails with "Host
 * key verification failed", which reads like a missing known_hosts entry rather
 * than a missing credential. The service account deliberately has no ~/.ssh, so
 * there is no ambient key to fall back on either.
 *
 * `core.sshCommand` lives in the repository config, which worktrees share, so
 * every git invocation in the project picks it up: ours, the agent's, and a
 * human's over SSH. Reconciled rather than written once, since a project's key
 * can be changed or removed later.
 */
export async function configureRepoSsh(
  repoPath: string,
  sshCommand: string | undefined,
): Promise<GitResult> {
  if (!sshCommand) {
    const result = await git(['config', '--local', '--unset-all', 'core.sshCommand'], repoPath)
    // Exit 5 is "nothing to unset", which is the normal case for an https or
    // adopted project and not a failure.
    return result.exitCode === 5 ? { ...result, ok: true } : result
  }
  return git(['config', '--local', 'core.sshCommand', sshCommand], repoPath)
}

/** One `user.name`/`user.email` pair, as read back from git config. Unset
 * reads as null, never as '' — `git config --get` exits 1 for "not set",
 * which is the ordinary state of a project nobody has configured, not an
 * error. */
export interface GitIdentity {
  name: string | null
  email: string | null
}

export interface RepoIdentity {
  local: GitIdentity
  effective: GitIdentity
  configPath: string
}

async function readIdentityValue(
  repoPath: string,
  key: 'user.name' | 'user.email',
  scope: 'local' | 'effective',
): Promise<string | null> {
  const args = scope === 'local' ? ['config', '--local', '--get', key] : ['config', '--get', key]
  const result = await git(args, repoPath)
  // `--get` already resolves a hand-edited, multi-valued key (two `user.name`
  // lines left over from an earlier edit) to its *last* line, the identical
  // rule git itself applies the moment it actually commits — so there is
  // nothing extra to do here for that case.
  return result.ok ? result.stdout : null
}

/**
 * The identity a plain `git commit` in `repoPath` would actually carry, read
 * two ways: `local` is only what this repository's own config holds — the
 * exact thing the Settings UI edits, and the exact thing a hand-edit of
 * `.git/config` already shows up as, since both read and write the same file.
 * `effective` additionally resolves global/system config, so the UI can say
 * "nothing set here, but your global config still supplies one" instead of
 * reporting a flat, misleading "unset".
 *
 * `configPath` is resolved through `--git-common-dir`, never
 * `join(repoPath, '.git', 'config')`: an adopted project's `repo/` is a
 * symlink to the operator's own folder (see paths.ts), and a session
 * worktree's `.git` is a *file* pointing elsewhere entirely — `--git-common-dir`
 * is the one query that resolves to the real, shared config path regardless
 * of which of those `repoPath` happens to be, which is what lets the UI show
 * a path the operator could actually go edit by hand.
 */
export async function readRepoIdentity(repoPath: string): Promise<RepoIdentity> {
  const [localName, localEmail, effectiveName, effectiveEmail, commonDir] = await Promise.all([
    readIdentityValue(repoPath, 'user.name', 'local'),
    readIdentityValue(repoPath, 'user.email', 'local'),
    readIdentityValue(repoPath, 'user.name', 'effective'),
    readIdentityValue(repoPath, 'user.email', 'effective'),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath),
  ])

  return {
    local: { name: localName, email: localEmail },
    effective: { name: effectiveName, email: effectiveEmail },
    // Falling back to `repoPath`/.git is only reachable if `repoPath` is not a
    // git repo at all, which every caller already checks before getting here;
    // it exists so this function degrades rather than throws if that check
    // is ever skipped.
    configPath: join(commonDir.ok ? commonDir.stdout : join(repoPath, '.git'), 'config'),
  }
}

/** True once git's own stderr names the one failure mode worth telling a
 * caller apart from every other: a concurrent write already holds the
 * `.git/config` lock. Everything else — a bad key, a permissions error — is
 * reported as-is; this one gets a "try again" instead, since the fix really is
 * just that. */
export function isConfigLockError(result: GitResult): boolean {
  return result.stderr.includes('could not lock config file')
}

/**
 * Attempts for one `git config` write that might lose a race for the
 * `.git/config` lock file against another writer — an agent committing, a
 * session's worktree being cut, another request for this same repo before
 * `withRepoLock` existed to rule that last one out in-process. Agents and
 * session creation only ever hold that lock for the length of a single git
 * command, so a handful of short waits is enough to ride out the contention
 * instead of handing the caller a 409 for a window measured in milliseconds.
 */
const CONFIG_LOCK_RETRY_BACKOFFS_MS = [20, 40, 80, 160]

async function gitConfigWrite(args: string[], repoPath: string): Promise<GitResult> {
  let result = await git(args, repoPath)
  for (const backoff of CONFIG_LOCK_RETRY_BACKOFFS_MS) {
    if (!isConfigLockError(result)) return result
    await sleep(backoff)
    result = await git(args, repoPath)
  }
  return result
}

/**
 * Put `user.name` back to what it was before this call started, best effort.
 *
 * Only reachable once `user.email`'s write has failed after `user.name`'s own
 * write already landed — the repo now has the *new* name paired with the
 * *old* email, which is not a pair this feature ever offers to set on
 * purpose. Restoring is attempted through the same retrying write as the
 * original calls, but its own result is never surfaced: the caller is about
 * to see the email failure that triggered this, and that is the one failure
 * worth reporting, not a second one about the cleanup attempt.
 */
async function restoreName(repoPath: string, previousName: string | null): Promise<void> {
  const args =
    previousName === null
      ? ['config', '--local', '--unset-all', 'user.name']
      : ['config', '--local', '--replace-all', 'user.name', previousName]
  await gitConfigWrite(args, repoPath)
}

/**
 * Record (or clear) `user.name`/`user.email` in the repository's own
 * config — the identity a plain `git commit`, with no `-c` flags, picks up in
 * this repo and every worktree of it, since worktrees share this file.
 * Mirrors `configureRepoSsh` above in every way that matters: `--local` so a
 * hand-written global identity is never touched or overwritten, `--replace-all`
 * so a key a human left with two lines (a stray hand-edit) collapses back to
 * one instead of growing a third, and exit 5 on clear ("nothing to unset") is
 * success, not failure — the normal state of a project nobody has configured.
 *
 * `identity: null` clears both keys. A non-null value always sets both
 * together: a name with no email, or vice versa, is not a usable git identity,
 * and the UI this backs only ever offers to set or clear the pair.
 *
 * Two git invocations apiece (name, then email) are never atomic on their
 * own — `withRepoLock` (features/projects/service.ts) is what rules out a
 * second *caller in this process* interleaving its own pair in between, but a
 * concurrent writer outside this process (a human, an agent's own `git
 * config`) can still land between them. `previousName`, captured before
 * either write below, is what lets this function put the pair back into a
 * consistent state — the one it had before this call — rather than leaving a
 * new name paired with a stale email, if the second write of the pair fails
 * after the first already landed.
 */
export async function configureRepoIdentity(
  repoPath: string,
  identity: { name: string; email: string } | null,
): Promise<GitResult> {
  const previousName = await readIdentityValue(repoPath, 'user.name', 'local')

  if (!identity) {
    const name = await gitConfigWrite(['config', '--local', '--unset-all', 'user.name'], repoPath)
    const email = await gitConfigWrite(['config', '--local', '--unset-all', 'user.email'], repoPath)
    const nameOk = name.ok || name.exitCode === 5
    const emailOk = email.ok || email.exitCode === 5
    if (nameOk && emailOk) return { ...email, ok: true }
    if (nameOk && !emailOk) {
      // user.name is already cleared and user.email is not — put the name
      // back rather than leave the pair half-cleared.
      await restoreName(repoPath, previousName)
    }
    // Whichever call actually failed is the one worth the caller seeing —
    // "nothing to unset" on one key must never hide a real failure on the other.
    return nameOk ? email : name
  }

  const name = await gitConfigWrite(
    ['config', '--local', '--replace-all', 'user.name', identity.name],
    repoPath,
  )
  if (!name.ok) return name

  const email = await gitConfigWrite(
    ['config', '--local', '--replace-all', 'user.email', identity.email],
    repoPath,
  )
  if (email.ok) return email

  await restoreName(repoPath, previousName)
  return email
}

/**
 * One chained promise per resolved repo path — every identity write
 * (`configureRepoIdentity`) runs inside this, via `writeIdentity` in
 * features/projects/service.ts, so two concurrent PUTs for the same project
 * can never interleave their own name-then-email pair of git invocations.
 *
 * Without this, two concurrent PUTs — one for Alice, one for Bob — each write
 * `user.name` then `user.email` as two separate, unsynchronized git
 * invocations; the four writes can land in any order, and "Bob's name,
 * Alice's email" is a perfectly legal interleaving of them, with both
 * requests then reporting 200 off whichever half of the pair they happened
 * to read back last. A `Map<string, Promise>` chain is enough: these writes
 * only ever happen inside the API process, never the worker.
 *
 * Keyed by `realpath(repoPath)`, not the path string a caller happened to
 * pass in — an adopted project's `repo/` is a symlink (see paths.ts), and
 * this lock only does its job if every caller that ends up writing the same
 * `.git/config` resolves to the same key, however each one spelled the path
 * that got them there. Falling back to the raw path when `realpath` fails
 * (the directory vanished between a caller's own availability check and this
 * call) still serializes every call hitting that same failure identically;
 * the write itself is what reports what actually happened.
 */
const repoLocks = new Map<string, Promise<void>>()

/**
 * Run `fn` only after every previously queued call for this repo has
 * finished, success or failure — a rejection must release the lock for the
 * next caller, not hold it forever.
 */
export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpath(repoPath).catch(() => repoPath)
  const previous = repoLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  // What the *next* caller for this key waits on — a plain signal, not `fn`'s
  // own result, so this call's success or failure never has to be observed by
  // anyone but its own caller.
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  repoLocks.set(key, next)

  await previous
  try {
    return await fn()
  } finally {
    release()
    // Drop the entry once nothing is queued behind this call — otherwise a
    // repo touched once would hold a resolved promise in this map for the
    // life of the process. Only safe to delete if we are still the most
    // recent link: a caller that queued up after us has already replaced it.
    if (repoLocks.get(key) === next) repoLocks.delete(key)
  }
}

/** True when the repo has a commit. `git worktree add` fails on an unborn HEAD. */
export async function hasCommits(path: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', 'HEAD'], path)).ok
}

/**
 * Commands to hand the user when a clone fails on authentication.
 *
 * They run it over SSH, git prompts them for the passphrase or key, and then
 * they press "check again" in the UI.
 */
export function recoveryCommandsFor(remote: string, targetDir: string): string[] {
  const parent = join(targetDir, '..')
  return [
    `sudo mkdir -p ${parent}`,
    `sudo git clone ${remote} ${targetDir}`,
    '# if it is a private HTTPS repo, git will ask for a username and token',
    '# if it is SSH, make sure the key is present:  ssh -T git@github.com',
  ]
}
