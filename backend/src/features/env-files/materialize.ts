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

import {
  open as fsOpen,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
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

/** Whether `candidateReal` — already resolved with `realpath` — sits inside
 * `worktreeReal`, the one test every materialized path has to pass, both
 * before and after anything is created on disk (see the two call sites in
 * `materializeOne` below). */
function isInsideWorktree(candidateReal: string, worktreeReal: string): boolean {
  return candidateReal === worktreeReal || candidateReal.startsWith(worktreeReal + sep)
}

/**
 * Walk up from `dir` to the deepest ancestor that already exists on disk —
 * `lstat`, so a symlinked directory counts as "exists" at the exact component
 * it is planted at, which is the component whose realpath actually matters.
 * Never throws ENOENT itself; any other error (permissions, a component that
 * is not a directory) is left to surface from wherever it actually matters.
 */
async function deepestExistingAncestor(dir: string): Promise<string> {
  let current = dir
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return current // filesystem root; nothing above it
      current = parent
    }
  }
}

/** Whether something — file, directory or symlink, tracked by the branch or
 * not — already sits at `target`. `lstat`, never `stat`: the branch wins
 * unconditionally, even when what it tracks at this exact path is a
 * (possibly dangling) symlink, which `stat` would otherwise follow and
 * misreport as "nothing here". */
async function targetAlreadyExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    const code = errnoCode(error)
    // ENOTDIR: some earlier path segment is a regular file where a directory
    // was expected (the branch tracks a plain file at, say, "server" while
    // the store needs "server/.env"). That is not "the target already
    // exists" — it is a real conflict, left for `mkdir` below to raise.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
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
 * iteration isolated by its own try/catch there.
 *
 * Ordered deliberately so that nothing is created, written, or excluded from
 * git until every reason to skip has already been ruled out:
 *   1. the path shape itself
 *   2. containment (is the target even inside the worktree, given what
 *      already exists on disk right now)
 *   3. the branch's own claim on this exact path (it always wins)
 *   4. can the stored bytes even be read
 *   5. can the copy be kept out of git
 * Only once all five hold does anything get `mkdir`'d or written — which is
 * also what keeps a skip at any of these steps from leaving so much as an
 * empty directory behind (see this function's own tests for the unreadable-
 * file and unwritable-exclude cases this was built against).
 */
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

  // Containment, checked against what already exists — BEFORE anything is
  // created. A recursive mkdir would otherwise happily create directories
  // *through* a symlink the branch itself tracks (e.g. `server -> /etc`),
  // writing outside the worktree before any check ever ran; walking up to
  // the deepest ancestor that already exists and resolving *that* real path
  // is the only check still valid pre-create. The branch's own content is
  // not fully trusted here, which is the entire reason a worktree is
  // isolated per session in the first place.
  const existingAncestor = await deepestExistingAncestor(targetDir)
  const existingAncestorReal = await realpath(existingAncestor)
  if (!isInsideWorktree(existingAncestorReal, worktreeReal)) {
    return { status: 'skipped', reason: 'Target directory resolves outside the worktree' }
  }

  // Exclusive create below is the real guard against a *race*, but a plain
  // `lstat` here is what keeps a file the branch already tracks from costing
  // anything beyond this one stat — no wasted read of the store, no wasted
  // git check-ignore/exclude write for a path that was never going to be
  // touched. The branch wins unconditionally, with no "which is newer"
  // comparison — and a (possibly dangling) symlink at the final component
  // counts as "already present" too, since `wx` would never follow one
  // anyway.
  if (await targetAlreadyExists(target)) {
    return {
      status: 'skipped',
      reason: 'Already present in the worktree (tracked by the branch)',
    }
  }

  // Read the stored bytes before anything is created: an unreadable stored
  // file (wrong owner, mode 000 — disk state can be hand-edited, or left
  // behind by an earlier version of this feature) must skip cleanly, not
  // leave a 0-byte file sitting untracked in the worktree. Letting this
  // throw (rather than catching it here) is deliberate — materializeEnvFiles'
  // own per-file catch below both skips *and* logs it, which is what proves
  // the failure actually happened rather than silently vanishing.
  const data = await readFile(join(storeRoot, relPath))

  // Exclude *before* writing: if this copy cannot be kept out of git, writing
  // it at all would put a secret one `git add -A` away from being committed.
  // `check-ignore` works against a path that does not exist on disk yet, so
  // this never needs the file (or even its directory) to exist first —
  // nothing below this line has run yet.
  const ignored = await git(['check-ignore', '-q', '--', relPath], worktreeReal)
  if (!ignored.ok) await excludeFromGit(worktreeReal, relPath)

  // Only now does anything actually get created. Normal mode, deliberately:
  // these are ordinary repo directories (`server/`, `.devcontainer/`, ...),
  // not the store's own 0700 tree, so they get whatever the branch and this
  // process's umask would otherwise produce.
  await mkdir(targetDir, { recursive: true })

  // Defence in depth, re-run after mkdir: a pathological concurrent writer
  // could in principle swap a directory for a symlink in the window between
  // the pre-create check above and this mkdir finishing.
  const targetDirReal = await realpath(targetDir)
  if (!isInsideWorktree(targetDirReal, worktreeReal)) {
    return { status: 'skipped', reason: 'Target directory resolves outside the worktree' }
  }

  let handle: Awaited<ReturnType<typeof fsOpen>> | undefined
  try {
    // Exclusive create: if the branch already tracks a file at this path
    // despite the lstat check above having missed it (a concurrent checkout,
    // in principle), the branch still wins — and the symlink-at-the-final-
    // component case is refused the same way an existing regular file is,
    // since `wx` never follows one.
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
    await handle.writeFile(data)
  } catch (error) {
    // A half-written secret sitting in the worktree is worse than none at
    // all — clean up the partial file before letting the error propagate to
    // the per-file catch above, the same "never leave a placeholder behind"
    // invariant the unreadable-store-file case above is built on.
    await unlink(target).catch(() => {})
    throw error
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
