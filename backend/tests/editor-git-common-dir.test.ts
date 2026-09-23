// gitCommonDir (features/editor/container.ts) — resolving and verifying a
// worktree's own `.git` pointer file before it is ever handed to
// `docker run --mount`, including the two cases the design doc calls out by
// name: a symlinked repo (adopted projects symlink `repo/` into SOURCES_DIR)
// and a realpath mismatch (a worktree whose registration does not actually
// belong to the project it claims to).

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { gitCommonDir } from '../src/features/editor/container'

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Lay out `<root>/repo/.git/worktrees/<id>/commondir` and
 * `<root>/worktree/.git` (the pointer file), the same shape a real
 * `git worktree add` produces. Returns { worktreePath, repoGitDir }. */
async function layout(root: string): Promise<{ worktreePath: string; repoGitDir: string }> {
  const repoGitDir = join(root, 'repo', '.git')
  const privateGitDir = join(repoGitDir, 'worktrees', 'wt1')
  await mkdir(privateGitDir, { recursive: true })
  await writeFile(join(privateGitDir, 'commondir'), '../..\n')

  const worktreePath = join(root, 'worktree')
  await mkdir(worktreePath, { recursive: true })
  await writeFile(join(worktreePath, '.git'), `gitdir: ${privateGitDir}\n`)

  return { worktreePath, repoGitDir }
}

test('resolves the common dir and verifies it matches the expected repo .git', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-')
  const { worktreePath, repoGitDir } = await layout(root)

  const resolved = await gitCommonDir(worktreePath, repoGitDir)
  expect(resolved).toBe(repoGitDir)
})

test('a trailing newline and surrounding whitespace in commondir/.git are tolerated', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-ws-')
  const { worktreePath, repoGitDir } = await layout(root)
  // Overwrite with extra whitespace, exactly the shape git itself writes
  // (a trailing newline on both files).
  await writeFile(join(worktreePath, '.git'), `gitdir: ${join(repoGitDir, 'worktrees', 'wt1')}  \n`)

  const resolved = await gitCommonDir(worktreePath, repoGitDir)
  expect(resolved).toBe(repoGitDir)
})

test('a worktree whose .git file is not a gitdir pointer is refused', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-bad-')
  const worktreePath = join(root, 'worktree')
  await mkdir(worktreePath, { recursive: true })
  await writeFile(join(worktreePath, '.git'), 'not a worktree pointer at all')

  await expect(gitCommonDir(worktreePath, join(root, 'repo', '.git'))).rejects.toThrow(
    /not a git worktree pointer file/,
  )
})

// --- symlinked repo: adopted projects symlink repo/ into SOURCES_DIR --------

test('a symlinked repo still verifies: the returned path is what the .git file references, not the symlink', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-symlink-')
  // The real location (imagine this is SOURCES_DIR/some-adopted-project).
  const real = await tempDir('agentoo-editor-gitcommon-real-')
  const { worktreePath, repoGitDir: realGitDir } = await layout(real)

  // projectRepo(slug) is a symlink pointing at the real checkout — the
  // adopted-project shape the design doc calls out.
  const symlinkedRepo = join(root, 'repo')
  await symlink(join(real, 'repo'), symlinkedRepo)
  const expectedGitDir = join(symlinkedRepo, '.git') // what resolveDockerScope/projectRepo() would pass

  const resolved = await gitCommonDir(worktreePath, expectedGitDir)
  // Mounted at the path the .git file itself references (the real, resolved
  // location) — not at the symlink path passed in as `expectedGitDir`.
  expect(resolved).toBe(realGitDir)
  expect(resolved).not.toBe(expectedGitDir)
})

// --- realpath mismatch: a worktree that does not belong to this repo -------

test('a common dir that does not resolve to the expected repo is refused', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-mismatch-')
  const { worktreePath } = await layout(root)
  const otherRoot = await tempDir('agentoo-editor-gitcommon-other-')
  await mkdir(join(otherRoot, 'repo', '.git'), { recursive: true })

  await expect(gitCommonDir(worktreePath, join(otherRoot, 'repo', '.git'))).rejects.toThrow(
    /does not resolve to this project's own repo/,
  )
})

test('a mismatch is refused even when the expected dir does not exist on disk at all', async () => {
  const root = await tempDir('agentoo-editor-gitcommon-missing-')
  const { worktreePath } = await layout(root)

  await expect(
    gitCommonDir(worktreePath, join(root, 'nonexistent', '.git')),
  ).rejects.toThrow(/does not resolve to this project's own repo/)
})
