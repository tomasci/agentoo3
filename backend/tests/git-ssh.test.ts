import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { addWorktree, configureRepoSsh, currentBranch, git, trackUpstream } = await import(
  '../src/lib/git'
)
const { gitSshCommand } = await import('../src/lib/ssh')

let dir: string
let repo: string
let worktree: string
let seed: string
const KEY = '/tmp/agentoo-test-key'

/**
 * A git command with nothing supplied to it: no GIT_SSH_COMMAND, no HOME, no
 * global config. This is the shape of the commands an agent runs inside a
 * session, and the reason the app injecting credentials per call was not enough.
 */
function bare(args: string[], cwd: string) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
  }
}

const commit = (cwd: string, message: string) =>
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', message], cwd)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-git-'))
  const origin = join(dir, 'origin.git')
  seed = join(dir, 'seed')
  repo = join(dir, 'repo')
  worktree = join(dir, 'wt')

  await git(['init', '-q', '--bare', origin])
  // A real remote advertises the branch its HEAD names. `git init --bare`
  // defaults to master, so without this the clone lands on an unborn branch and
  // every assertion below fails for reasons that have nothing to do with ssh.
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin)

  await git(['init', '-q', '-b', 'main', seed])
  await writeFile(join(seed, 'a.txt'), 'one\n')
  await git(['add', '-A'], seed)
  await commit(seed, 'first')
  await git(['remote', 'add', 'origin', origin], seed)
  await git(['push', '-q', 'origin', 'main'], seed)

  await git(['clone', '-q', origin, repo])
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('a worktree inherits the key from the repository config', async () => {
  expect((await configureRepoSsh(repo, gitSshCommand(KEY))).ok).toBe(true)

  const base = await currentBranch(repo)
  expect(base).toBe('main')
  expect((await addWorktree(repo, worktree, 'agentoo/s-abc123')).ok).toBe(true)

  // The point of core.sshCommand over a per-call GIT_SSH_COMMAND: a command we
  // did not spawn still gets the credential.
  const seen = bare(['config', '--get', 'core.sshCommand'], worktree)
  expect(seen.out).toContain(KEY)
  expect(seen.out).toContain('IdentitiesOnly=yes')
})

test('a session branch gets an upstream, so plain `git pull` works', async () => {
  const before = bare(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktree)
  expect(before.code).not.toBe(0)

  expect((await trackUpstream(worktree, 'origin', 'main')).ok).toBe(true)
  expect(bare(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktree).out).toBe(
    'origin/main',
  )

  // Move the remote on, then pull with nothing configured for us.
  await writeFile(join(seed, 'b.txt'), 'two\n')
  await git(['add', '-A'], seed)
  await commit(seed, 'second')
  await git(['push', '-q', 'origin', 'main'], seed)

  const pull = bare(['-c', 'user.email=a@b', '-c', 'user.name=a', 'pull', '--no-rebase'], worktree)
  expect(pull.code).toBe(0)
  expect(await Bun.file(join(worktree, 'b.txt')).exists()).toBe(true)
})

test('the upstream does not let a session push over the base branch', () => {
  // push.default=simple refuses a branch whose upstream is named differently,
  // so tracking origin/main cannot turn into pushing a session's work onto it.
  const head = bare(['rev-parse', 'origin/main'], worktree).out
  const push = bare(['push'], worktree)
  expect(push.code).not.toBe(0)
  expect(push.err).toContain('does not match')
  expect(bare(['rev-parse', 'origin/main'], worktree).out).toBe(head)
})

test('unsetting the key is clean, and repeating it is not an error', async () => {
  expect((await configureRepoSsh(repo, undefined)).ok).toBe(true)
  // git exits 5 for "nothing to unset", which is the normal state of an https
  // or adopted project and must not read as a failure.
  const again = await configureRepoSsh(repo, undefined)
  expect(again.ok).toBe(true)
  expect(again.exitCode).toBe(5)
  expect(bare(['config', '--get', 'core.sshCommand'], worktree).out).toBe('')
})
