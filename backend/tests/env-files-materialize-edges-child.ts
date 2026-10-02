// materializeEnvFiles against the cases env-files-materialize-child.ts does
// not reach: real branch-tracked files and .gitignore rules (present when the
// worktree is cut, not patched in afterwards), several sessions sharing one
// info/exclude, byte-exact copies of non-UTF-8 content, symlinks on both
// sides (the branch's and the store's), and every best-effort failure branch.
//
// Same shape as that file: a child process, because PROJECTS_DIR must be a
// real scratch directory before `@/env` parses it; it gathers facts and every
// assertion lives in env-files-materialize-edges.test.ts. Spawned under
// `umask 000`, so a 0600 seen here was forced by the code.

import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../src/env'
import { materializeEnvFiles } from '../src/features/env-files/materialize'
import { git } from '../src/lib/git'

export const SECRET = 'MATERIALIZE-SECRET-91b3'

const facts: Record<string, unknown> = {}
const outsideRoot = join(env.PROJECTS_DIR, '..', `${env.PROJECTS_DIR.split('/').pop()}-outside`)

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  )
const mode = async (p: string) => (await stat(p)).mode & 0o777
const hex = async (p: string) => (await readFile(p)).toString('hex')

async function run(args: string[], cwd: string) {
  const r = await git(args, cwd)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
  return r
}

/** `<PROJECTS_DIR>/<slug>/repo` with one commit holding `files` (a value of
 * `{ symlink }` commits a symlink), plus `worktrees` worktrees cut from it
 * *after* that commit — the real state createSession hands over. */
async function project(
  slug: string,
  files: Record<string, string | Buffer | { symlink: string }>,
  worktrees = 1,
) {
  const repo = join(env.PROJECTS_DIR, slug, 'repo')
  await run(['init', '-q', '-b', 'main', repo], env.PROJECTS_DIR)
  await writeFile(join(repo, 'README.md'), 'readme\n')
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    if (typeof body === 'object' && 'symlink' in body) await symlink(body.symlink, abs)
    else await writeFile(abs, body)
  }
  await run(['add', '-A', '-f'], repo)
  await run(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], repo)
  await mkdir(join(env.PROJECTS_DIR, slug, 'worktrees'), { recursive: true })
  const wts: string[] = []
  for (let i = 0; i < worktrees; i++) {
    const wt = join(env.PROJECTS_DIR, slug, 'worktrees', `wt${i}`)
    await run(['worktree', 'add', '-q', '-b', `${slug}-wt${i}`, wt], repo)
    wts.push(wt)
  }
  const commonDir = resolve(wts[0] as string, (await run(['rev-parse', '--git-common-dir'], wts[0] as string)).stdout)
  return { repo, wts, excludePath: join(commonDir, 'info', 'exclude') }
}

async function seed(slug: string, rel: string, body: string | Buffer) {
  const abs = join(env.PROJECTS_DIR, slug, 'env', rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, body)
}

const porcelain = async (wt: string) =>
  (await run(['status', '--porcelain', '--untracked-files=all'], wt)).stdout

const excludeLines = async (p: string) =>
  (await readFile(p, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '' && !l.startsWith('#'))

/** Never lets a throw escape: a throw is itself the fact being recorded. */
async function materialize(slug: string, wt: string) {
  try {
    return { threw: null as string | null, ...(await materializeEnvFiles(slug, wt)) }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), copied: [], skipped: [] }
  }
}

async function main() {
  await mkdir(outsideRoot, { recursive: true })

  // --- many files, nested, byte-exact, 0600, all kept out of git -------------
  {
    const slug = 'bytes'
    const { wts, excludePath } = await project(slug, {})
    const wt = wts[0] as string
    const binary = Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0d, 0x0a, 0x00, 0x41])
    const stored: Record<string, string | Buffer> = {
      '.env': `TOKEN=${SECRET}\n`,
      '.env.local': 'CRLF=1\r\nNO_TRAILING_NEWLINE=é',
      'a/b/c/.env': binary,
      '.devcontainer/.env': '',
      'docker/db.env': 'PG=1\n',
    }
    for (const [rel, body] of Object.entries(stored)) await seed(slug, rel, body)
    const summary = await materialize(slug, wt)
    const identical: Record<string, boolean> = {}
    const modes: Record<string, number | null> = {}
    for (const rel of Object.keys(stored)) {
      identical[rel] =
        (await hex(join(wt, rel)).catch(() => 'missing')) ===
        (await hex(join(env.PROJECTS_DIR, slug, 'env', rel)))
      modes[rel] = await mode(join(wt, rel)).catch(() => null)
    }
    facts.bytes = {
      summary,
      identical,
      modes,
      porcelain: await porcelain(wt),
      exclude: await excludeLines(excludePath),
    }
  }

  // --- a file the branch really tracks is never overwritten ------------------
  {
    const slug = 'tracked'
    const { wts, excludePath } = await project(slug, { 'server/.env': 'TRACKED=1\n' })
    const wt = wts[0] as string
    await seed(slug, 'server/.env', 'FROM_STORE=1\n')
    await seed(slug, '.env', 'ROOT=1\n')
    const summary = await materialize(slug, wt)
    facts.tracked = {
      summary,
      content: await readFile(join(wt, 'server/.env'), 'utf8'),
      porcelain: await porcelain(wt),
      exclude: await excludeLines(excludePath),
    }
  }

  // --- the branch's own .gitignore is honoured per path ---------------------
  {
    const slug = 'ignored'
    // Root-anchored: ignores ./.env only, not server/.env.
    const { wts, excludePath } = await project(slug, { '.gitignore': '/.env\n' })
    const wt = wts[0] as string
    await seed(slug, '.env', 'A=1\n')
    await seed(slug, 'server/.env', 'B=1\n')
    const summary = await materialize(slug, wt)
    facts.ignored = {
      summary,
      porcelain: await porcelain(wt),
      exclude: await excludeLines(excludePath),
    }
  }

  // --- three sessions of one project share info/exclude, no duplicates ------
  {
    const slug = 'repeat'
    const { wts, excludePath } = await project(slug, {}, 3)
    await seed(slug, '.env', 'A=1\n')
    await seed(slug, 'server/.env', 'B=1\n')
    const summaries = []
    const porcelains = []
    for (const wt of wts) {
      summaries.push(await materialize(slug, wt))
      porcelains.push(await porcelain(wt))
    }
    facts.repeat = { summaries, porcelains, exclude: await excludeLines(excludePath) }
  }

  // --- an existing info/exclude without a trailing newline -------------------
  {
    const slug = 'nonl'
    const { wts, excludePath } = await project(slug, {})
    await writeFile(excludePath, '# local rules\n/custom-ignore')
    await seed(slug, '.env', 'A=1\n')
    await materialize(slug, wts[0] as string)
    facts.nonl = {
      raw: await readFile(excludePath, 'utf8'),
      porcelain: await porcelain(wts[0] as string),
    }
  }

  // --- a symlinked directory in the branch pointing outside the worktree ----
  {
    const slug = 'symdir'
    const outside = join(outsideRoot, 'symdir-target')
    await mkdir(outside, { recursive: true })
    const { wts } = await project(slug, { server: { symlink: outside } })
    await seed(slug, 'server/.env', 'S=1\n')
    await seed(slug, 'server/sub/.env', 'SUB=1\n')
    await seed(slug, '.env', 'ROOT=1\n')
    const summary = await materialize(slug, wts[0] as string)
    facts.symdir = {
      summary,
      outsideEntries: await readdir(outside),
      rootCopied: await exists(join(wts[0] as string, '.env')),
    }
  }

  // --- a dangling symlink the branch tracks at the exact target path --------
  {
    const slug = 'symfile'
    const planted = join(outsideRoot, 'planted.env')
    const { wts } = await project(slug, { 'config/.env': { symlink: planted } })
    await seed(slug, 'config/.env', 'C=1\n')
    const summary = await materialize(slug, wts[0] as string)
    facts.symfile = { summary, plantedExists: await exists(planted) }
  }

  // --- symlinks inside the store are ignored, not followed ------------------
  {
    const slug = 'storelinks'
    const outside = join(outsideRoot, 'storelinks')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.env'), 'OUTSIDE_FILE=1\n')
    await writeFile(join(outside, '.env'), 'OUTSIDE_DIR=1\n')
    const { wts } = await project(slug, {})
    const wt = wts[0] as string
    await seed(slug, '.env', 'REAL=1\n')
    const store = join(env.PROJECTS_DIR, slug, 'env')
    await symlink(join(outside, 'secret.env'), join(store, 'link.env'))
    await symlink(outside, join(store, 'linkdir'))
    const summary = await materialize(slug, wt)
    facts.storelinks = {
      summary,
      linkFile: await exists(join(wt, 'link.env')),
      linkDir: await exists(join(wt, 'linkdir')),
    }
  }

  // --- an unreadable store file: skipped, others still copied, no residue ---
  {
    const slug = 'unreadable'
    const { wts } = await project(slug, {})
    const wt = wts[0] as string
    await seed(slug, '.env', 'OK=1\n')
    await seed(slug, 'locked/.env', 'LOCKED=1\n')
    await chmod(join(env.PROJECTS_DIR, slug, 'env', 'locked', '.env'), 0o000)
    const summary = await materialize(slug, wt)
    await chmod(join(env.PROJECTS_DIR, slug, 'env', 'locked', '.env'), 0o600)
    facts.unreadable = {
      summary,
      okContent: await readFile(join(wt, '.env'), 'utf8').catch(() => null),
      lockedInWorktree: await exists(join(wt, 'locked', '.env')),
      porcelain: await porcelain(wt),
    }
  }

  // --- the branch has a regular file where the store needs a directory ------
  {
    const slug = 'fileasdir'
    const { wts } = await project(slug, { server: 'I am a file\n' })
    const wt = wts[0] as string
    await seed(slug, 'server/.env', 'S=1\n')
    await seed(slug, '.env', 'ROOT=1\n')
    const summary = await materialize(slug, wt)
    facts.fileasdir = {
      summary,
      serverFile: await readFile(join(wt, 'server'), 'utf8'),
      rootCopied: await exists(join(wt, '.env')),
      porcelain: await porcelain(wt),
    }
  }

  // --- the branch has a directory where the store has a file -----------------
  {
    const slug = 'dirasfile'
    const { wts } = await project(slug, { 'conf.env/keep': 'k\n' })
    const wt = wts[0] as string
    await seed(slug, 'conf.env', 'C=1\n')
    const summary = await materialize(slug, wt)
    facts.dirasfile = {
      summary,
      keep: await readFile(join(wt, 'conf.env', 'keep'), 'utf8'),
      porcelain: await porcelain(wt),
    }
  }

  // --- a worktree path that does not exist at all ---------------------------
  {
    const slug = 'nowt'
    await seed(slug, '.env', 'A=1\n')
    const ghost = join(env.PROJECTS_DIR, slug, 'worktrees', 'ghost')
    const summary = await materialize(slug, ghost)
    facts.nowt = { summary, created: await exists(ghost) }
  }

  // --- info/exclude cannot be written ----------------------------------------
  {
    const slug = 'roexclude'
    const { wts, excludePath } = await project(slug, {})
    const wt = wts[0] as string
    await writeFile(excludePath, '# read-only\n')
    await chmod(excludePath, 0o444)
    await seed(slug, '.env', `TOKEN=${SECRET}\n`)
    const summary = await materialize(slug, wt)
    await chmod(excludePath, 0o644)
    facts.roexclude = {
      summary,
      envInWorktree: await exists(join(wt, '.env')),
      porcelain: await porcelain(wt),
    }
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
