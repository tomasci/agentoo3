// The env-files HTTP API and its createSession hand-off, end to end: the real
// createApp() (app.ts) — so the real router mount, the real OpenAPI
// validation hook and the real onError envelope — against a throwaway
// Postgres cluster (projects are looked up by id) and a real PROJECTS_DIR on
// disk. Spawned by env-files-routes.test.ts under `umask 000`, so every mode
// asserted there is one the code forced, not one the umask happened to give.
//
// Same shape as session-create-db-child.ts: bullmq and ioredis are faked (no
// queue or Redis is ever needed), the child gathers facts, every assertion
// lives in the parent.

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'bun:test'

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
    async publish() {
      return 0
    }
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

const { closeDb, db } = await import('@/db/client')
const { projects } = await import('@/db/schema')
const { git } = await import('@/lib/git')
const { projectEnvDir, projectRepo } = await import('@/lib/paths')
const { createApp } = await import('@/app')

const app = createApp()
const facts: Record<string, unknown> = {}

/** Only ever appears inside file *content*; the parent greps every log line
 * the child printed for it. */
export const SECRET = 'S3CR3T-TOKEN-7f1c2a'

type Res = { status: number; body: unknown; text: string }

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed, text }
}

const put = (id: string, path: string, content: string) =>
  call('PUT', `/projects/${id}/env-files`, { path, content })
const del = (id: string, path: string) =>
  call('DELETE', `/projects/${id}/env-files?path=${encodeURIComponent(path)}`)
const list = (id: string) => call('GET', `/projects/${id}/env-files`)

const mode = async (p: string) => (await stat(p)).mode & 0o777
const exists = async (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  )

async function newProject(name: string, withRepo = false): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  if (withRepo) {
    const repo = projectRepo(slug)
    const init = await git(['init', '-q', '-b', 'main', repo])
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
    await writeFile(join(repo, 'README.md'), 'hi\n')
    await git(['add', '-A'], repo)
    const commit = await git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'first'], repo)
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
  }
  return { id: row.id, slug }
}

const VALID_PATHS = [
  '.env',
  '.env.local',
  'server/.env',
  'docker/db.env',
  '.devcontainer/.env',
  `${'a'.repeat(250)}/.env`, // exactly 255 characters
]

const INVALID_PATHS: Record<string, string> = {
  dotdot: '../.env',
  absolute: '/etc/.env',
  emptySegment: 'a//.env',
  dotSegment: './.env',
  gitSegment: '.git/.env',
  gitUpper: '.GIT/x/.env',
  nodeModules: 'node_modules/.env',
  notEnvFile: 'package.json',
  backslash: 'server\\.env',
  trailingSlash: 'server/',
  nul: 'server/.e\0nv',
  controlChar: 'server/.e\x07nv',
  empty: '',
  tooLong: `${'a'.repeat(251)}/.env`, // 256 characters
}

async function main() {
  // --- unknown / malformed project ids --------------------------------------
  {
    const ghost = randomUUID()
    facts.unknownProject = {
      get: await list(ghost),
      put: await put(ghost, '.env', 'A=1\n'),
      del: await del(ghost, '.env'),
      malformedId: await list('not-a-uuid'),
    }
  }

  // --- a project with no store at all ---------------------------------------
  {
    const p = await newProject('nostore')
    const res = await list(p.id)
    facts.noStore = { res, envDirExists: await exists(projectEnvDir(p.slug)) }
  }

  // --- create, list (sorted), overwrite, modes, atomicity --------------------
  {
    const p = await newProject('crud')
    const root = projectEnvDir(p.slug)
    const before = Date.now()
    // Inserted deliberately out of order.
    const created: Record<string, Res> = {}
    for (const [path, content] of [
      ['server/.env', `TOKEN=${SECRET}\n`],
      ['.env', 'A=1\n'],
      ['docker/db.env', 'PG=1\n'],
      ['.env.local', 'Ü=é\n'], // multi-byte: size must be UTF-8 bytes (6), not chars (4)
      ['.devcontainer/.env', ''],
    ] as const) {
      created[path] = await put(p.id, path, content)
    }
    const after = Date.now()
    const listed = await list(p.id)

    const inodeBefore = (await stat(join(root, 'server/.env'))).ino
    const overwrite = await put(p.id, 'server/.env', 'TOKEN=rotated\n')
    const inodeAfter = (await stat(join(root, 'server/.env'))).ino
    const listedAfterOverwrite = await list(p.id)
    const serverDirEntries = await readdir(join(root, 'server'))

    facts.crud = {
      created,
      before,
      after,
      listed,
      overwrite,
      listedAfterOverwrite,
      onDiskAfterOverwrite: await readFile(join(root, 'server/.env'), 'utf8'),
      inodeChangedOnOverwrite: inodeBefore !== inodeAfter,
      serverDirEntries,
      modes: {
        root: await mode(root),
        serverDir: await mode(join(root, 'server')),
        devcontainerDir: await mode(join(root, '.devcontainer')),
        rootFile: await mode(join(root, '.env')),
        nestedFile: await mode(join(root, 'server/.env')),
        overwrittenFile: await mode(join(root, 'server/.env')),
      },
    }
  }

  // --- delete + pruning ------------------------------------------------------
  {
    const p = await newProject('del')
    const root = projectEnvDir(p.slug)
    await put(p.id, 'a/b/c/.env', 'X=1\n')
    await put(p.id, 'keep/.env', 'K=1\n')
    await put(p.id, 'keep/sub/.env', 'K2=1\n')
    await put(p.id, '.env', 'R=1\n')

    const deep = await del(p.id, 'a/b/c/.env')
    const aGone = !(await exists(join(root, 'a')))

    const nested = await del(p.id, 'keep/sub/.env')
    const keepStillThere = await exists(join(root, 'keep/.env'))
    const subGone = !(await exists(join(root, 'keep/sub')))

    const again = await del(p.id, 'keep/sub/.env')
    const neverExisted = await del(p.id, 'nope/.env')
    const lastTwo = [await del(p.id, 'keep/.env'), await del(p.id, '.env')]
    const listedEmpty = await list(p.id)
    const rootStillExists = await exists(root)
    const rootEntries = rootStillExists ? await readdir(root) : null

    // An invalid path on DELETE goes through the same 400 as on PUT.
    const invalid = {
      dotdot: await del(p.id, '../.env'),
      gitSegment: await del(p.id, '.git/.env'),
      notEnvFile: await del(p.id, 'package.json'),
      missingQuery: await call('DELETE', `/projects/${p.id}/env-files`),
    }

    facts.del = {
      deep,
      aGone,
      nested,
      keepStillThere,
      subGone,
      again,
      neverExisted,
      lastTwo,
      listedEmpty,
      rootStillExists,
      rootEntries,
      invalid,
    }
  }

  // --- the path-rule matrix, through PUT -------------------------------------
  {
    const p = await newProject('paths')
    const root = projectEnvDir(p.slug)
    const valid: Record<string, Res> = {}
    for (const path of VALID_PATHS) valid[path] = await put(p.id, path, 'V=1\n')
    const invalid: Record<string, Res> = {}
    for (const [key, path] of Object.entries(INVALID_PATHS)) invalid[key] = await put(p.id, path, 'V=1\n')
    const listed = await list(p.id)
    // Nothing outside the store, and no stray directory for any refused path.
    const outsideEtc = await exists(join(root, '..', 'etc'))
    const parentEnv = await exists(join(root, '..', '.env'))
    facts.paths = { valid, invalid, listed, outsideEtc, parentEnv }
  }

  // --- body shape ------------------------------------------------------------
  {
    const p = await newProject('body')
    facts.body = {
      missingContent: await call('PUT', `/projects/${p.id}/env-files`, { path: '.env' }),
      missingPath: await call('PUT', `/projects/${p.id}/env-files`, { content: 'A=1' }),
      numberContent: await call('PUT', `/projects/${p.id}/env-files`, { path: '.env', content: 5 }),
      nulContent: await put(p.id, '.env', 'A=1\0B=2\n'),
      listed: await list(p.id),
    }
  }

  // --- the 64 KiB content boundary ------------------------------------------
  {
    const p = await newProject('size')
    const root = projectEnvDir(p.slug)
    const exact = await put(p.id, 'exact.env', 'a'.repeat(64 * 1024))
    const overByOne = await put(p.id, 'over.env', 'a'.repeat(64 * 1024 + 1))
    // 65,536 UTF-16 code units but 65,537 UTF-8 bytes: must be measured in bytes.
    const multibyteOver = await put(p.id, 'mb.env', `${'a'.repeat(64 * 1024 - 1)}é`)
    const multibyteExact = await put(p.id, 'mbok.env', `${'a'.repeat(64 * 1024 - 2)}é`)
    facts.size = {
      exact: { status: exact.status, size: (exact.body as { size?: number })?.size },
      exactOnDisk: (await stat(join(root, 'exact.env'))).size,
      overByOne: { status: overByOne.status, body: overByOne.body },
      overCreated: await exists(join(root, 'over.env')),
      multibyteOver: { status: multibyteOver.status },
      multibyteOverCreated: await exists(join(root, 'mb.env')),
      multibyteExact: {
        status: multibyteExact.status,
        size: (multibyteExact.body as { size?: number })?.size,
      },
    }
  }

  // --- the 100-file cap ------------------------------------------------------
  {
    const p = await newProject('cap')
    const root = projectEnvDir(p.slug)
    const statuses: number[] = []
    for (let i = 0; i < 100; i++) {
      statuses.push((await put(p.id, `d${i % 7}/f${i}.env`, `N=${i}\n`)).status)
    }
    const overCap = await put(p.id, 'extra.env', 'X=1\n')
    const overCapCreated = await exists(join(root, 'extra.env'))
    const overwriteAtCap = await put(p.id, 'd0/f0.env', 'N=changed\n')
    const listed = await list(p.id)
    // After a delete there is room for exactly one more.
    const freed = await del(p.id, 'd1/f1.env')
    const refill = await put(p.id, 'extra.env', 'X=1\n')
    const overAgain = await put(p.id, 'extra2.env', 'X=1\n')
    facts.cap = {
      allCreated: statuses.every((s) => s === 200),
      overCap,
      overCapCreated,
      overwriteAtCap: overwriteAtCap.status,
      listedCount: (listed.body as { files: unknown[] }).files.length,
      freed: freed.status,
      refill: refill.status,
      overAgain: overAgain.status,
    }
  }

  // --- store symlinks are not followed by the listing -----------------------
  {
    const p = await newProject('symlist')
    const root = projectEnvDir(p.slug)
    await put(p.id, '.env', 'A=1\n')
    const outside = join(projectEnvDir(p.slug), '..', 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'leak.env'), 'LEAK=1\n')
    await symlink(join(outside, 'leak.env'), join(root, 'link.env'))
    await symlink(outside, join(root, 'linkdir'))
    const listed = await list(p.id)
    // A symlink at the target path is not "an existing file" to DELETE either.
    const delLink = await del(p.id, 'link.env')
    facts.symlist = {
      paths: ((listed.body as { files: { path: string }[] }).files ?? []).map((f) => f.path),
      delLink: delLink.status,
      outsideStillThere: await exists(join(outside, 'leak.env')),
    }
  }

  // --- a path that is a directory in the store, and a file where a directory
  //     is needed: both are the PUT route's documented 409, never a 500.
  {
    const p = await newProject('shape')
    const fileThenDir = [await put(p.id, 'db.env', 'A=1\n'), await put(p.id, 'db.env/.env', 'B=1\n')]
    const dirThenFile = [await put(p.id, 'x.env/.env', 'A=1\n'), await put(p.id, 'x.env', 'B=1\n')]
    facts.shape = {
      fileThenDir: fileThenDir.map((r) => ({ status: r.status, body: r.body })),
      dirThenFile: dirThenFile.map((r) => ({ status: r.status, body: r.body })),
    }
  }

  // --- createSession copies the store into the new worktree -----------------
  {
    const p = await newProject('session', true)
    await put(p.id, '.env', `ROOT=${SECRET}\n`)
    await put(p.id, 'server/.env', 'SERVER=1\r\nNO_NEWLINE=é')
    const res = await call('POST', `/projects/${p.id}/sessions`, { orchestrator: 'coder' })
    const s = res.body as { id?: string; worktreePath?: string | null; isolated?: boolean }
    const wt = s.worktreePath ?? ''
    const status = wt ? await git(['status', '--porcelain', '--untracked-files=all'], wt) : null
    facts.session = {
      status: res.status,
      isolated: s.isolated,
      worktreePath: wt,
      rootEnv: wt ? await readFile(join(wt, '.env'), 'utf8').catch(() => null) : null,
      serverEnv: wt ? await readFile(join(wt, 'server/.env'), 'utf8').catch(() => null) : null,
      rootMode: wt ? await mode(join(wt, '.env')).catch(() => null) : null,
      serverMode: wt ? await mode(join(wt, 'server/.env')).catch(() => null) : null,
      porcelain: status?.stdout ?? null,
    }

    // A second session of the same project: still clean, still copied.
    const res2 = await call('POST', `/projects/${p.id}/sessions`, { orchestrator: 'coder' })
    const s2 = res2.body as { worktreePath?: string | null }
    const wt2 = s2.worktreePath ?? ''
    facts.session2 = {
      status: res2.status,
      rootEnv: wt2 ? await readFile(join(wt2, '.env'), 'utf8').catch(() => null) : null,
      porcelain: wt2 ? (await git(['status', '--porcelain', '--untracked-files=all'], wt2)).stdout : null,
    }
  }

  // --- a broken store never fails session creation ---------------------------
  {
    const p = await newProject('brokenstore', true)
    await put(p.id, '.env', 'OK=1\n')
    await put(p.id, 'locked/.env', 'LOCKED=1\n')
    await chmod(join(projectEnvDir(p.slug), 'locked/.env'), 0o000)
    const res = await call('POST', `/projects/${p.id}/sessions`, { orchestrator: 'coder' })
    await chmod(join(projectEnvDir(p.slug), 'locked/.env'), 0o600)
    const s = res.body as { worktreePath?: string | null; isolated?: boolean }
    const wt = s.worktreePath ?? ''
    facts.brokenStore = {
      status: res.status,
      isolated: s.isolated,
      okEnv: wt ? await readFile(join(wt, '.env'), 'utf8').catch(() => null) : null,
    }
  }

  // --- a project with no store creates sessions exactly as before ------------
  {
    const p = await newProject('nostoresession', true)
    const res = await call('POST', `/projects/${p.id}/sessions`, { orchestrator: 'coder' })
    const s = res.body as { worktreePath?: string | null; isolated?: boolean }
    facts.noStoreSession = {
      status: res.status,
      isolated: s.isolated,
      porcelain: s.worktreePath
        ? (await git(['status', '--porcelain', '--untracked-files=all'], s.worktreePath)).stdout
        : null,
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
