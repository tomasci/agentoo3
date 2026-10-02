// How a project's stored env files are copied into a brand-new session
// worktree, against a real git repo and a real filesystem.
//
// A child process because PROJECTS_DIR has to be a real scratch directory
// before `@/env` parses it, and the shared test process has already fixed it
// to a nonexistent path for everyone else (see setup-env.ts). Nothing here
// needs a database, Redis or bullmq at all — materializeEnvFiles touches only
// git and the filesystem — so, unlike plugin-atomicity-child.ts, nothing is
// mocked; this is the real module graph, started fresh in this process.
//
// The child gathers facts; every assertion lives in
// env-files-materialize.test.ts.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../src/env'
import { materializeEnvFiles } from '../src/features/env-files/materialize'
import { git } from '../src/lib/git'

const facts: Record<string, unknown> = {}

const commit = (cwd: string, message: string) =>
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', message], cwd)

async function commitFile(cwd: string, file: string, body: string, message: string) {
  await mkdir(join(cwd, file, '..'), { recursive: true })
  await writeFile(join(cwd, file), body)
  await git(['add', '-A'], cwd)
  const result = await commit(cwd, message)
  if (!result.ok) throw new Error(`fixture commit failed in ${cwd}: ${result.stderr}`)
}

/** `git worktree add`, laid out at `<PROJECTS_DIR>/<slug>/worktrees/<name>` —
 * the exact shape lib/paths.ts's projectWorktree produces. Each worktree gets
 * its own branch name, since `addWorktree` refuses to reuse one that is
 * already checked out elsewhere. */
async function addWorktree(repo: string, slug: string, worktreeName: string) {
  await mkdir(join(env.PROJECTS_DIR, slug, 'worktrees'), { recursive: true })
  const worktree = join(env.PROJECTS_DIR, slug, 'worktrees', worktreeName)
  const added = await git(
    ['worktree', 'add', '-q', '-b', `${slug}-${worktreeName}`, worktree],
    repo,
  )
  if (!added.ok) throw new Error(`worktree add failed: ${added.stderr}`)
  return worktree
}

/** Lays out `<PROJECTS_DIR>/<slug>/repo` — the exact shape lib/paths.ts's
 * projectRepo produces — with one commit on `main`, plus one worktree cut
 * from it: the same state createSession hands materializeEnvFiles right
 * after `addWorktree` succeeds. */
async function repoWithWorktree(slug: string, worktreeName = 'wt1') {
  const repo = join(env.PROJECTS_DIR, slug, 'repo')
  await git(['init', '-q', '-b', 'main', repo], env.PROJECTS_DIR)
  await commitFile(repo, 'a.txt', 'one\n', 'first')

  const worktree = await addWorktree(repo, slug, worktreeName)
  return { repo, worktree }
}

/** Writes directly into the store the way features/env-files/service.ts's
 * putEnvFile would — this file is about materialize.ts, not the store writer
 * it reads from, so it bypasses that module entirely rather than depending on
 * it. */
async function seedStore(slug: string, relPath: string, content: string) {
  const path = join(env.PROJECTS_DIR, slug, 'env', relPath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function main() {
  // --- a stored file lands at the same relative path, mode 0600 ------------
  {
    const slug = 'copy'
    const { worktree } = await repoWithWorktree(slug)
    await seedStore(slug, 'server/.env', 'SECRET=1\n')

    const summary = await materializeEnvFiles(slug, worktree)
    const content = await readFile(join(worktree, 'server', '.env'), 'utf8')
    const st = await Bun.file(join(worktree, 'server', '.env')).stat()

    facts.copy = {
      copied: summary.copied,
      skipped: summary.skipped,
      content,
      mode: st.mode & 0o777,
    }
  }

  // --- a project with no env store at all does not throw -------------------
  {
    const slug = 'empty'
    const { worktree } = await repoWithWorktree(slug)
    const summary = await materializeEnvFiles('no-such-slug-at-all', worktree)
    facts.empty = summary
  }

  // --- the branch always wins -----------------------------------------------
  {
    const slug = 'tracked'
    const { repo, worktree } = await repoWithWorktree(slug)
    await commitFile(repo, 'server/.env', 'TRACKED=1\n', 'add tracked env file')
    // The worktree was cut before that commit; lay down the same content
    // directly, the state a worktree cut *after* that commit would already be
    // in — this test is about materialize's own behaviour, not git plumbing.
    await mkdir(join(worktree, 'server'), { recursive: true })
    await writeFile(join(worktree, 'server', '.env'), 'TRACKED=1\n')

    await seedStore(slug, 'server/.env', 'FROM_STORE=1\n')

    const summary = await materializeEnvFiles(slug, worktree)
    const content = await readFile(join(worktree, 'server', '.env'), 'utf8')
    facts.tracked = { copied: summary.copied, skipped: summary.skipped, content }
  }

  // --- keeping the copy out of git, and never adding a duplicate line ------
  {
    const slug = 'exclude'
    const { repo, worktree } = await repoWithWorktree(slug)
    await seedStore(slug, '.env', 'A=1\n')
    await materializeEnvFiles(slug, worktree)

    const commonDir = (await git(['rev-parse', '--git-common-dir'], worktree)).stdout
    const excludePath = join(resolve(worktree, commonDir), 'info', 'exclude')
    const exclude1 = await readFile(excludePath, 'utf8').catch(() => '')
    const status = await git(['status', '--porcelain'], worktree)

    // A second session off the same project gets its own worktree, sharing
    // the same info/exclude (it lives in the common git dir, not per
    // worktree) — this is where the no-duplicate-lines rule actually matters,
    // since this second copy is a genuine fresh write, not a retry skipped by
    // the "already present" branch.
    const worktree2 = await addWorktree(repo, slug, 'wt2')
    const summary2 = await materializeEnvFiles(slug, worktree2)
    const exclude2 = await readFile(excludePath, 'utf8').catch(() => '')

    facts.exclude = {
      lines: exclude1.split('\n'),
      statusClean: status.stdout === '',
      secondWorktreeCopied: summary2.copied,
      linesAfterSecondWorktree: exclude2.split('\n').filter((l) => l === '/.env'),
    }
  }

  // --- a path already covered by the branch's own .gitignore ----------------
  {
    const slug = 'ignored'
    const { repo, worktree } = await repoWithWorktree(slug)
    await commitFile(repo, '.gitignore', '.env\n', 'ignore env files')
    // The worktree's own branch was cut before that commit; bring just that
    // one file in, so this worktree's `check-ignore` sees the same rule a
    // worktree cut after it would see from the start.
    await git(['checkout', '-q', 'main', '--', '.gitignore'], worktree)

    await seedStore(slug, '.env', 'A=1\n')
    await materializeEnvFiles(slug, worktree)

    const commonDir = (await git(['rev-parse', '--git-common-dir'], worktree)).stdout
    const exclude = await readFile(
      join(resolve(worktree, commonDir), 'info', 'exclude'),
      'utf8',
    ).catch(() => '')
    facts.ignored = { lines: exclude.split('\n') }
  }

  // --- a path the store should never have held in the first place ----------
  {
    const slug = 'badpath'
    const { worktree } = await repoWithWorktree(slug)
    // Written directly, bypassing checkEnvFilePath entirely — simulating disk
    // state from an earlier, less strict version of this feature.
    await seedStore(slug, 'secrets.txt', 'A=1\n')

    const summary = await materializeEnvFiles(slug, worktree)
    facts.badPath = summary
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    process.exit(1)
  })
