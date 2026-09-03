import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { addWorktree, git, isGitRepo } = await import('../src/lib/git')

/**
 * Git exports GIT_DIR (absolute) into every hook process. `bun test` runs from
 * the pre-push hook, so without scrubbing it the whole suite silently retargets
 * the repository being pushed: cwd is ignored, because GIT_DIR outranks it.
 *
 * That is not a stylistic worry. It re-inited this project's checkout, committed
 * a fixture over `main` and left a /tmp worktree registered in it. These tests
 * set the variables deliberately and assert that `git()` ignores them.
 */

let dir: string
let victim: string
let target: string

const commit = (cwd: string, message: string) =>
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', message], cwd)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-gitenv-'))
  victim = join(dir, 'victim')
  target = join(dir, 'target')

  for (const repo of [victim, target]) {
    await git(['init', '-q', '-b', 'main', repo], dir)
    // Distinct content, so the two repos cannot share a commit hash and "which
    // repository answered?" has an unambiguous answer.
    await writeFile(join(repo, 'keep.txt'), `${repo}\n`)
    await git(['add', '-A'], repo)
    await commit(repo, `seed ${repo}`)
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Restore the ambient environment whatever the assertions do. */
async function withGitDir(value: string, body: () => Promise<void>) {
  const previous = process.env.GIT_DIR
  process.env.GIT_DIR = value
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previous
  }
}

test('an inherited GIT_DIR does not redirect a command away from its cwd', async () => {
  await withGitDir(join(victim, '.git'), async () => {
    const head = await git(['rev-parse', 'HEAD'], target)
    const targetHead = await git(['rev-parse', 'HEAD'], target)
    expect(head.stdout).toBe(targetHead.stdout)

    // The decisive one: the victim and target have different commits, so a
    // hijacked command reports the victim's.
    const victimHead = await git(['rev-parse', 'HEAD'], victim)
    expect(head.stdout).not.toBe(victimHead.stdout)
  })
})

test('an inherited GIT_DIR does not let a worktree land in another repository', async () => {
  await withGitDir(join(victim, '.git'), async () => {
    const worktree = join(dir, 'wt')
    expect((await addWorktree(target, worktree, 'agentoo/s-envtest')).ok).toBe(true)

    // Registered in the repo we asked for, not the one GIT_DIR named.
    const inTarget = await git(['worktree', 'list'], target)
    expect(inTarget.stdout).toContain(worktree)

    const inVictim = await git(['worktree', 'list'], victim)
    expect(inVictim.stdout).not.toContain(worktree)
  })
})

test('an inherited GIT_DIR cannot re-init another repository', async () => {
  await withGitDir(join(victim, '.git'), async () => {
    // The shape of the old bug: `git init` with a path, run while GIT_DIR points
    // somewhere else, used to reinitialise the GIT_DIR repo instead.
    const fresh = join(dir, 'fresh')
    const result = await git(['init', '-q', '-b', 'main', fresh], dir)
    expect(result.stderr).not.toContain('re-init')

    // The victim keeps a working tree and stays non-bare.
    expect(await isGitRepo(victim)).toBe(true)
    expect((await git(['config', '--local', 'core.bare'], victim)).stdout).not.toBe('true')
  })
})

test('isGitRepo is false for a repository marked bare, which is what costs a session its worktree', async () => {
  const bare = join(dir, 'bare-marked')
  await git(['init', '-q', '-b', 'main', bare], dir)
  await writeFile(join(bare, 'keep.txt'), 'x\n')
  await git(['add', '-A'], bare)
  await commit(bare, 'seed')

  expect(await isGitRepo(bare)).toBe(true)
  await git(['config', '--local', 'core.bare', 'true'], bare)
  expect(await isGitRepo(bare)).toBe(false)
})
