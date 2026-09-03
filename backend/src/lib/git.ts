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

/**
 * Run git without ever prompting.
 *
 * A clone of a private repo must fail fast rather than block a worker forever
 * waiting on a passphrase that nobody is there to type. GIT_TERMINAL_PROMPT=0
 * and BatchMode=yes turn every credential prompt into an immediate error, which
 * is what lets us hand the user recovery commands instead of hanging.
 */
export async function git(
  args: string[],
  cwd?: string,
  options: { sshCommand?: string } = {},
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
      GIT_SSH_COMMAND:
        options.sshCommand ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  logger.debug(`git ${args.join(' ')} -> ${exitCode}`)
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

export async function isGitRepo(path: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], path)
  return result.ok && result.stdout === 'true'
}

export async function currentBranch(path: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
  return result.ok ? result.stdout : undefined
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

/** Create a worktree on a new branch. Requires the repo to have at least one commit. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<GitResult> {
  return git(['worktree', 'add', '-b', branch, worktreePath], repoPath)
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
