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
 * Run git without ever prompting.
 *
 * A clone of a private repo must fail fast rather than block a worker forever
 * waiting on a passphrase that nobody is there to type. GIT_TERMINAL_PROMPT=0
 * and BatchMode=yes turn every credential prompt into an immediate error, which
 * is what lets us hand the user recovery commands instead of hanging.
 */
export async function git(args: string[], cwd?: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
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

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<GitResult> {
  return git(['worktree', 'remove', '--force', worktreePath], repoPath)
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
