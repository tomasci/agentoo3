// Copies one project's stored env files into a brand-new session worktree, at
// the same relative paths they have in the store — the thing that makes
// `docker compose`'s `env_file: ./server/.env` (etc.) work in a worktree that
// otherwise starts with none at all, since `.env` files are git-ignored by
// convention.
//
// Called exactly once per session, from features/sessions/service.ts's
// createSession, right after `addWorktree` succeeds. Never for a session
// sharing the project's own repo/ checkout (there is no worktree to copy
// into) and never to sync an existing, already-running session — both out of
// scope for this feature; see its own design brief.

import { open as fsOpen, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { git } from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectEnvDir } from '@/lib/paths'
import { checkEnvFilePath } from './path-rules'
import { listStoredPaths } from './service'

export interface MaterializeSummary {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

/** `code` on a Node fs error, without `any`. */
function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Append `/<relPath>` to this repository's *own* `info/exclude` — never
 * `.gitignore`, which the branch tracks and which an agent could therefore
 * commit a change to (or simply not have, on a project that never gitignored
 * its env files to begin with). `info/exclude` lives under the common git
 * directory every worktree of one repository shares (resolved via
 * `git rev-parse --git-common-dir`, run *in* the worktree, since that is the
 * only cwd this function has), so one line here keeps every current and
 * future worktree of the project from ever `git add -A`-ing this file —
 * local-only, and never itself committed.
 */
async function excludeFromGit(worktreePath: string, relPath: string): Promise<void> {
  const commonDir = await git(['rev-parse', '--git-common-dir'], worktreePath)
  if (!commonDir.ok || !commonDir.stdout) {
    throw new Error(`git rev-parse --git-common-dir failed: ${commonDir.stderr}`)
  }
  // rev-parse prints a path relative to cwd unless GIT_COMMON_DIR was already
  // set in the environment — git()'s own REPO_LOCATION_VARS strips that
  // before every call it makes, so this always resolves against the worktree
  // path actually passed in, never this process's own cwd.
  const gitCommonDir = resolve(worktreePath, commonDir.stdout)

  const infoDir = join(gitCommonDir, 'info')
  await mkdir(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')

  const line = `/${relPath}`
  const existing = await readFile(excludePath, 'utf8').catch(() => '')
  if (existing.split('\n').includes(line)) return // already excluded; no duplicate lines

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await writeFile(excludePath, `${existing}${separator}${line}\n`, 'utf8')
}

/** One stored file, copied into `worktreePath` at the same relative path —
 * the per-file body `materializeEnvFiles` below runs in a loop, each
 * iteration isolated by its own try/catch there. */
async function materializeOne(
  storeRoot: string,
  worktreeReal: string,
  relPath: string,
): Promise<{ status: 'copied' } | { status: 'skipped'; reason: string }> {
  // The store is meant to hold only what checkEnvFilePath allows, but this
  // reads disk state that may have been written at some earlier time — by an
  // earlier version of this feature, or by hand — so it is never trusted
  // without the identical check a write goes through today.
  const check = checkEnvFilePath(relPath)
  if (!check.ok) return { status: 'skipped', reason: check.reason }

  const target = join(worktreeReal, relPath)
  const targetDir = dirname(target)
  // Normal mode, deliberately: these are ordinary repo directories (`server/`,
  // `.devcontainer/`, ...), not the store's own 0700 tree, so they get
  // whatever the branch and this process's umask would otherwise produce.
  await mkdir(targetDir, { recursive: true })

  // Defends against a symlinked directory somewhere in the checked-out branch
  // pointing outside the worktree — the branch's own content is not fully
  // trusted here, which is the entire reason a worktree is isolated per
  // session in the first place.
  const targetDirReal = await realpath(targetDir)
  if (targetDirReal !== worktreeReal && !targetDirReal.startsWith(worktreeReal + sep)) {
    return { status: 'skipped', reason: 'Target directory resolves outside the worktree' }
  }

  let handle: Awaited<ReturnType<typeof fsOpen>> | undefined
  try {
    // Exclusive create: if the branch already tracks a file at this path, the
    // branch wins — unconditionally, with no "which is newer" comparison —
    // and the symlink-at-the-final-component case is refused the same way an
    // existing regular file is, since `wx` never follows one.
    handle = await fsOpen(target, 'wx')
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') {
      return {
        status: 'skipped',
        reason: 'Already present in the worktree (tracked by the branch)',
      }
    }
    throw error
  }

  try {
    // `chmod` after `open`, not a mode on `open` itself: `open`'s own mode is
    // masked by umask the same way `mkdir`'s is (see
    // features/attachments/storage.ts's `writeBlob` for the identical
    // open-then-chmod pattern), and this is a copy of a secret.
    await handle.chmod(0o600)
    const data = await readFile(join(storeRoot, relPath))
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }

  return { status: 'copied' }
}

/**
 * Copy every stored env file into `worktreePath`, at the same relative paths.
 *
 * Best-effort end to end: one file's failure (a bad stored path, a directory
 * the branch tracks where a file was expected, a `git` call that errors) is
 * logged and skipped, never thrown — this is called from createSession,
 * synchronously, and a bug here must never turn into a session that failed to
 * create. `listStoredPaths` itself answers an empty list rather than throwing
 * when the project has no env store at all (see service.ts's own `walk`), so
 * even that case needs no special handling here.
 */
export async function materializeEnvFiles(
  slug: string,
  worktreePath: string,
): Promise<MaterializeSummary> {
  const copied: string[] = []
  const skipped: { path: string; reason: string }[] = []

  try {
    const storeRoot = projectEnvDir(slug)
    const relPaths = await listStoredPaths(slug)
    const worktreeReal = await realpath(worktreePath)

    for (const relPath of relPaths) {
      try {
        const result = await materializeOne(storeRoot, worktreeReal, relPath)
        if (result.status === 'skipped') {
          skipped.push({ path: relPath, reason: result.reason })
          continue
        }
        copied.push(relPath)

        // Keep the copy out of git: an agent's `git add -A` must never commit
        // a secret materialized here. Anything check-ignore does not confirm
        // as already ignored — including a `git` call that itself errored —
        // is excluded, which is the conservative direction to fail in.
        const ignored = await git(['check-ignore', '-q', '--', relPath], worktreeReal)
        if (!ignored.ok) await excludeFromGit(worktreeReal, relPath)
      } catch (error) {
        const reason = reasonFor(error)
        skipped.push({ path: relPath, reason })
        logger.warn(`Could not materialize env file "${relPath}" into ${worktreePath}: ${reason}`)
      }
    }
  } catch (error) {
    // Something failed before the per-file loop even started (resolving the
    // worktree's own realpath, most plausibly) — still never thrown.
    logger.warn(`Could not materialize env files into ${worktreePath}: ${reasonFor(error)}`)
  }

  logger.info(
    `Materialized ${copied.length} env file(s) into ${worktreePath}` +
      (skipped.length > 0 ? ` (${skipped.length} skipped)` : ''),
  )
  return { copied, skipped }
}
