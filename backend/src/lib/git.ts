import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from './logger'

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

/** `setTimeout` as a promise, for racing against a read that may never settle. */
function sleep(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long to keep draining a pipe after the process that owned it has
 * already been reaped. Small on purpose: everything worth reading in this
 * window is already sitting in the OS pipe buffer (the process is dead, so
 * nothing new is coming from it), the only question is whether a surviving
 * grandchild happens to still be holding the write end open. This is not
 * "wait for ssh to notice it should give up" — that can take up to its own
 * ConnectTimeout, or forever — it is "stop pretending we will ever see EOF".
 */
const DRAIN_GRACE_MS = 300

/**
 * Read a spawned process's stream to EOF — except once the process itself has
 * exited, from which point whatever is left in the OS pipe buffer is drained
 * for at most `graceMs` longer and then abandoned.
 *
 * This exists because `Bun.spawn`'s `timeout` SIGKILLs only the process it
 * directly spawned. When the transport is ssh, `git` forks and execs an `ssh`
 * child of its own — a grandchild from this process's point of view — and
 * that grandchild inherits git's stdout/stderr file descriptors. Killing git
 * does not touch it: if ssh is stuck (mid handshake against a peer that
 * accepted the connection and never sent a byte, say), it keeps the pipe's
 * write end open indefinitely, and `new Response(stream).text()` — which only
 * resolves on EOF — waits right along with it. `exited` still resolves on
 * schedule regardless, because Bun reaps the process it actually spawned no
 * matter what that process forked, which is what makes it a reliable clock
 * here and not just another thing that might hang.
 *
 * Reading starts immediately and unconditionally — not only once the process
 * has exited — because a command that writes more than one pipe buffer's
 * worth of output would otherwise block forever on a full buffer while this
 * function waited for it to finish first. That is a deadlock this rewrite
 * must not reintroduce, not a timeout.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  graceMs = DRAIN_GRACE_MS,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''

  // Resolves graceMs after the process is reaped — not a moment before, which
  // is what lets a legitimately slow command with no timeoutMs at all read to
  // completion undisturbed. Built once, as a single promise, and raced against
  // every read below rather than checked-then-awaited per iteration: a read
  // already in flight when the process dies is exactly the read that needs to
  // be interrupted, and a check made only at the top of the loop is too late
  // for a read that started before the deadline existed and is still pending
  // when it arrives. Once this resolves, every subsequent race against it also
  // resolves immediately, which is what ends the loop.
  const drainDeadline = exited.then(() => sleep(graceMs))

  while (true) {
    // Caught here, not left to reject: cancelling the reader below can reject
    // a read that is still in flight, and that must not become an unhandled
    // rejection just because this specific attempt lost the race it is in.
    const read = reader.read().catch(() => ({ done: true as const, value: undefined }))
    const chunk = await Promise.race([read, drainDeadline])
    if (chunk === undefined || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }

  // Releases our side of the stream. The underlying fd may still be held open
  // by a grandchild we never had a handle on — that is a leak in the orphaned
  // process, not in this process, and outside what a pipe reader can fix.
  reader.cancel().catch(noop)
  return text
}

function noop() {}

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
