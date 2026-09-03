// Install a session checkout's dependencies before an agent works in it.
//
// Every session gets its own git worktree, and a worktree is only tracked
// files: node_modules is git-ignored, so it starts empty. That is not a
// cosmetic gap. A project's own tooling assumes an installed checkout, and when
// it is missing the failures point nowhere near the cause:
//
//   - `lefthook` is a devDependency, and the generated .git/hooks script looks
//     for it under node_modules. Without it the hook prints one line —
//     "Can't find lefthook in PATH" — and then *commits anyway*, so a session
//     silently gets no typecheck, no tests and no version bump.
//   - codegen fails with "kubb: command not found".
//   - anything the agent runs itself fails on missing modules.
//
// So this runs once per worktree, before the first turn.
//
// Deliberately conservative about what it touches. agentoo manages arbitrary
// repositories, so this only acts where a package manifest actually is, picks
// the manager from the lockfile that is committed rather than guessing, and
// skips any directory that already has node_modules. A repository with no
// manifest gets nothing done to it at all.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '@/lib/logger'

/** How deep to look for manifests: the root, plus one level of subdirectory. */
const MAX_DIRS = 16

/**
 * Longest an install may take before it is abandoned.
 *
 * An install reaches the network, and a turn that hangs here would hang with no
 * output at all. Better to give up and let the agent run against an incomplete
 * checkout than to stall the session indefinitely.
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

interface Manager {
  /** Binary to invoke. */
  bin: string
  /** Lockfile that identifies this manager. */
  lockfile: string
  /** Arguments when the lockfile is present — reproducible where supported. */
  locked: string[]
  /** Arguments when there is no lockfile. */
  unlocked: string[]
}

// Ordered: the first lockfile found wins. bun before npm because this platform
// installs bun and the projects it hosts are bun-first, but a repo carrying a
// package-lock.json is still installed with npm rather than converted.
const MANAGERS: Manager[] = [
  {
    bin: 'bun',
    lockfile: 'bun.lock',
    locked: ['install', '--frozen-lockfile'],
    unlocked: ['install'],
  },
  {
    bin: 'bun',
    lockfile: 'bun.lockb',
    locked: ['install', '--frozen-lockfile'],
    unlocked: ['install'],
  },
  {
    bin: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    locked: ['install', '--frozen-lockfile'],
    unlocked: ['install'],
  },
  { bin: 'yarn', lockfile: 'yarn.lock', locked: ['install', '--immutable'], unlocked: ['install'] },
  { bin: 'npm', lockfile: 'package-lock.json', locked: ['ci'], unlocked: ['install'] },
]

/** No lockfile, but a manifest: install with bun, which this platform always has. */
const FALLBACK: Manager = MANAGERS[0] as Manager

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Directories that look like a JavaScript package: the root and its immediate
 * children. One level is enough for the common `backend/` + `frontend/` split
 * without walking a whole tree — and walking deeper would wander into vendored
 * copies and fixtures.
 */
export async function packageDirs(root: string): Promise<string[]> {
  const found: string[] = []
  if (await exists(join(root, 'package.json'))) found.push(root)

  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return found
  }

  for (const entry of entries.sort()) {
    if (found.length >= MAX_DIRS) break
    // Nothing to gain from descending into these, and node_modules would match
    // thousands of times.
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const dir = join(root, entry)
    if (!(await isDir(dir))) continue
    if (await exists(join(dir, 'package.json'))) found.push(dir)
  }

  return found
}

/** The manager whose lockfile is committed here, else the fallback. */
export async function managerFor(dir: string): Promise<Manager> {
  for (const manager of MANAGERS) {
    if (await exists(join(dir, manager.lockfile))) return manager
  }
  return FALLBACK
}

async function onPath(bin: string): Promise<boolean> {
  const proc = Bun.spawn(['sh', '-c', `command -v ${bin}`], { stdout: 'ignore', stderr: 'ignore' })
  return (await proc.exited) === 0
}

/**
 * Install dependencies for every package directory under `root` that has none.
 *
 * Never throws: a session whose install fails is still worth running, and the
 * agent can be told to sort it out. The warning names the directory and the
 * command, because "it did not install" on its own is not actionable.
 */
export async function installWorkspaceDeps(root: string): Promise<void> {
  const dirs = await packageDirs(root)
  if (dirs.length === 0) {
    logger.debug(`No package manifest under ${root}; nothing to install`)
    return
  }

  for (const dir of dirs) {
    if (await exists(join(dir, 'node_modules'))) {
      logger.debug(`${dir} already has node_modules`)
      continue
    }

    const manager = await managerFor(dir)
    if (!(await onPath(manager.bin))) {
      logger.warn(`${manager.bin} is not installed; cannot install dependencies in ${dir}`)
      continue
    }

    const hasLock = await exists(join(dir, manager.lockfile))
    const args = hasLock ? manager.locked : manager.unlocked
    const command = `${manager.bin} ${args.join(' ')}`

    logger.info(`Installing dependencies in ${dir} (${command})`)
    try {
      const proc = Bun.spawn([manager.bin, ...args], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
      })
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      if (exitCode === 0) {
        logger.info(`Dependencies installed in ${dir}`)
      } else {
        // A --frozen-lockfile install fails when the lockfile is out of date,
        // which is the project's problem to fix, not something to paper over by
        // silently installing something else.
        logger.warn(
          `\`${command}\` failed in ${dir} (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`,
        )
      }
    } catch (error) {
      logger.warn(`\`${command}\` could not run in ${dir}: ${String(error)}`)
    }
  }
}
