// GET/PUT/DELETE /api/projects/{id}/env-files through the real createApp(),
// and createSession copying the store into a real worktree — against a real
// Postgres and a real PROJECTS_DIR. See env-files-routes-db-child.ts for the
// fixture behind each fact below, and why it runs in a child process (the
// `@/env` first-import-wins constraint pg-cluster.ts's own header explains).
//
// The child runs under `umask 000`: every 0700/0600 asserted here is a mode
// the code forced, not one a restrictive umask happened to produce.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const SECRET = 'S3CR3T-TOKEN-7f1c2a' // keep in sync with the child

type Res = { status: number; body: any; text: string }
type Facts = Record<string, any>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''
let logs = ''
const projectsDir = await mkdtemp(join(tmpdir(), 'agentoo-env-routes-'))

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(
      ['sh', '-c', 'umask 000 && exec bun "$0"', join(BACKEND, 'tests/env-files-routes-db-child.ts')],
      {
        cwd: BACKEND,
        env: {
          ...process.env,
          DATABASE_URL: cluster.connectionString,
          REDIS_URL: 'redis://127.0.0.1:1',
          PROJECTS_DIR: projectsDir,
          ATTACHMENTS_DIR: join(projectsDir, '.attachments'),
          CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
          // Everything, down to debug/trace: the "contents never logged"
          // assertion below is only as strong as what was allowed to print.
          LOG_LEVEL: '5',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
      logs = stdout.slice(0, marker) + stderr
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(projectsDir, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = (key: string): any => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value
}

const expectValidationFailed = (res: Res) => {
  expect(res.status).toBe(400)
  expect(res.body.error).toBe('Validation failed')
  expect(Array.isArray(res.body.issues)).toBe(true)
  expect(res.body.issues.length).toBeGreaterThan(0)
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the env-files route scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
})

// --- 404 / 400 on the project id --------------------------------------------

dbTest('GET, PUT and DELETE on an unknown project are 404 with the standard envelope', () => {
  const f = fact('unknownProject')
  for (const res of [f.get, f.put, f.del] as Res[]) {
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Project not found' })
  }
})

dbTest('a malformed project id is a 400 validation failure, not a 500', () => {
  expectValidationFailed(fact('unknownProject').malformedId)
})

dbTest('a project with no store answers { files: [] } and creates nothing on disk', () => {
  const f = fact('noStore')
  expect(f.res.status).toBe(200)
  expect(f.res.body).toEqual({ files: [] })
  expect(f.envDirExists).toBe(false)
})

// --- PUT / GET ----------------------------------------------------------------

dbTest('PUT answers the stored EnvFile: path, content, UTF-8 byte size, ISO updatedAt', () => {
  const f = fact('crud')
  const res = f.created['.env.local'] as Res
  expect(res.status).toBe(200)
  expect(Object.keys(res.body).sort()).toEqual(['content', 'path', 'size', 'updatedAt'])
  expect(res.body.path).toBe('.env.local')
  expect(res.body.content).toBe('Ü=é\n')
  expect(res.body.size).toBe(6) // Ü(2) = é(2) \n(1) -> 6 bytes, 4 chars
  expect(new Date(res.body.updatedAt).toISOString()).toBe(res.body.updatedAt)
  const t = Date.parse(res.body.updatedAt)
  expect(t).toBeGreaterThanOrEqual(f.before - 2000)
  expect(t).toBeLessThanOrEqual(f.after + 2000)
})

dbTest('an empty file is a valid file of size 0', () => {
  const res = fact('crud').created['.devcontainer/.env'] as Res
  expect(res.status).toBe(200)
  expect(res.body.size).toBe(0)
  expect(res.body.content).toBe('')
})

dbTest('GET lists every stored file, sorted by path, with its content', () => {
  const res = fact('crud').listed as Res
  expect(res.status).toBe(200)
  const files = res.body.files as { path: string; content: string; size: number }[]
  expect(files.map((x) => x.path)).toEqual([
    '.devcontainer/.env',
    '.env',
    '.env.local',
    'docker/db.env',
    'server/.env',
  ])
  expect(files.find((x) => x.path === 'server/.env')?.content).toBe(`TOKEN=${SECRET}\n`)
  expect(files.find((x) => x.path === '.env.local')?.size).toBe(6)
})

dbTest('PUT on an existing path overwrites it in place: one file, new content', () => {
  const f = fact('crud')
  expect(f.overwrite.status).toBe(200)
  expect(f.overwrite.body.content).toBe('TOKEN=rotated\n')
  expect(f.onDiskAfterOverwrite).toBe('TOKEN=rotated\n')
  const files = f.listedAfterOverwrite.body.files as { path: string; content: string }[]
  expect(files).toHaveLength(5)
  expect(files.find((x) => x.path === 'server/.env')?.content).toBe('TOKEN=rotated\n')
})

dbTest('an overwrite is a rename onto the target (new inode) and leaves no temp file behind', () => {
  const f = fact('crud')
  expect(f.inodeChangedOnOverwrite).toBe(true)
  expect(f.serverDirEntries).toEqual(['.env'])
})

dbTest('store directories are 0700 and stored files 0600, even under umask 000', () => {
  expect(fact('crud').modes).toEqual({
    root: 0o700,
    serverDir: 0o700,
    devcontainerDir: 0o700,
    rootFile: 0o600,
    nestedFile: 0o600,
    overwrittenFile: 0o600,
  })
})

// --- DELETE -----------------------------------------------------------------

dbTest('DELETE answers 204 with an empty body', () => {
  const f = fact('del')
  expect(f.deep.status).toBe(204)
  expect(f.deep.text).toBe('')
  expect(f.nested.status).toBe(204)
})

dbTest('DELETE prunes every now-empty parent directory inside the store', () => {
  expect(fact('del').aGone).toBe(true)
})

dbTest('DELETE prunes only empty directories: a sibling file keeps its parent', () => {
  const f = fact('del')
  expect(f.subGone).toBe(true)
  expect(f.keepStillThere).toBe(true)
})

dbTest('DELETE of the last file never removes the store root', () => {
  const f = fact('del')
  expect(f.lastTwo.map((r: Res) => r.status)).toEqual([204, 204])
  expect(f.listedEmpty.body).toEqual({ files: [] })
  expect(f.rootStillExists).toBe(true)
  expect(f.rootEntries).toEqual([])
})

dbTest('DELETE of a file that is not stored is a 404 with the standard envelope', () => {
  const f = fact('del')
  for (const res of [f.again, f.neverExisted] as Res[]) {
    expect(res.status).toBe(404)
    expect(typeof res.body.error).toBe('string')
  }
})

dbTest('DELETE with an invalid or missing ?path= is a 400 validation failure', () => {
  const f = fact('del').invalid
  for (const key of ['dotdot', 'gitSegment', 'notEnvFile', 'missingQuery']) expectValidationFailed(f[key])
})

// --- path rules at the HTTP boundary ------------------------------------------

dbTest('every valid path shape from the spec is accepted by PUT', () => {
  const f = fact('paths')
  for (const [path, res] of Object.entries(f.valid as Record<string, Res>)) {
    expect({ path, status: res.status }).toEqual({ path, status: 200 })
  }
  expect((f.listed.body.files as { path: string }[]).map((x) => x.path).sort()).toEqual(
    Object.keys(f.valid).sort(),
  )
})

dbTest('every invalid path shape from the spec is a 400 naming the "path" field', () => {
  const f = fact('paths')
  for (const [key, res] of Object.entries(f.invalid as Record<string, Res>)) {
    expect({ key, status: res.status }).toEqual({ key, status: 400 })
    expect(res.body.error).toBe('Validation failed')
    expect((res.body.issues as { path: string }[]).map((i) => i.path)).toContain('path')
  }
})

dbTest('no refused path wrote anything inside or outside the store', () => {
  const f = fact('paths')
  expect(f.outsideEtc).toBe(false)
  expect(f.parentEnv).toBe(false)
})

// --- body / content rules -------------------------------------------------------

dbTest('a missing or mistyped field is a 400 validation failure naming that field', () => {
  const f = fact('body')
  expectValidationFailed(f.missingContent)
  expect(f.missingContent.body.issues.map((i: { path: string }) => i.path)).toContain('content')
  expectValidationFailed(f.missingPath)
  expect(f.missingPath.body.issues.map((i: { path: string }) => i.path)).toContain('path')
  expectValidationFailed(f.numberContent)
})

dbTest('content containing a NUL byte is a 400 and nothing is stored', () => {
  const f = fact('body')
  expectValidationFailed(f.nulContent)
  expect(f.listed.body).toEqual({ files: [] })
})

dbTest('content of exactly 64 KiB is accepted and stored at full size', () => {
  const f = fact('size')
  expect(f.exact).toEqual({ status: 200, size: 65536 })
  expect(f.exactOnDisk).toBe(65536)
})

dbTest('64 KiB + 1 byte is a 400 and nothing is written', () => {
  const f = fact('size')
  expect(f.overByOne.status).toBe(400)
  expect(f.overByOne.body.error).toBe('Validation failed')
  expect(f.overCreated).toBe(false)
})

dbTest('the limit is UTF-8 bytes, not characters', () => {
  const f = fact('size')
  expect(f.multibyteOver.status).toBe(400)
  expect(f.multibyteOverCreated).toBe(false)
  expect(f.multibyteExact).toEqual({ status: 200, size: 65536 })
})

// --- 100-file cap ---------------------------------------------------------------

dbTest('the 101st new file is a 409 and is not written', () => {
  const f = fact('cap')
  expect(f.allCreated).toBe(true)
  expect(f.overCap.status).toBe(409)
  expect(typeof f.overCap.body.error).toBe('string')
  expect(f.overCapCreated).toBe(false)
  expect(f.listedCount).toBe(100)
})

dbTest('at the cap, overwriting an existing file is still allowed', () => {
  expect(fact('cap').overwriteAtCap).toBe(200)
})

dbTest('deleting one file at the cap frees exactly one slot', () => {
  const f = fact('cap')
  expect(f.freed).toBe(204)
  expect(f.refill).toBe(200)
  expect(f.overAgain).toBe(409)
})

// --- symlinks planted in the store ---------------------------------------------

dbTest('GET does not list (or follow) a symlinked file or directory in the store', () => {
  expect(fact('symlist').paths).toEqual(['.env'])
})

dbTest('DELETE does not treat a symlink as a stored file, and never touches its target', () => {
  const f = fact('symlist')
  expect(f.delLink).toBe(404)
  expect(f.outsideStillThere).toBe(true)
})

// --- file/directory collisions inside the store ---------------------------------

// The route documents both collisions as a 409 (routes.ts's PUT responses).
dbTest('saving under a path whose parent is already a stored file is a 409, not a 500', () => {
  const [first, second] = fact('shape').fileThenDir
  expect(first.status).toBe(200)
  expect(second.status).toBe(409)
  expect(typeof second.body.error).toBe('string')
})

dbTest('saving a file where the store already has a directory of that name is a 409, not a 500', () => {
  const [first, second] = fact('shape').dirThenFile
  expect(first.status).toBe(200)
  expect(second.status).toBe(409)
  expect(typeof second.body.error).toBe('string')
})

// --- createSession ----------------------------------------------------------------

dbTest('a new session over HTTP gets a worktree holding every stored file, byte for byte', () => {
  const f = fact('session')
  expect(f.status).toBe(201)
  expect(f.isolated).toBe(true)
  expect(f.rootEnv).toBe(`ROOT=${SECRET}\n`)
  expect(f.serverEnv).toBe('SERVER=1\r\nNO_NEWLINE=é')
})

dbTest('...each copy mode 0600', () => {
  const f = fact('session')
  expect(f.rootMode).toBe(0o600)
  expect(f.serverMode).toBe(0o600)
})

dbTest('...and git status in that worktree shows nothing untracked', () => {
  expect(fact('session').porcelain).toBe('')
})

dbTest('a second session of the same project gets its own copy and is just as clean', () => {
  const f = fact('session2')
  expect(f.status).toBe(201)
  expect(f.rootEnv).toBe(`ROOT=${SECRET}\n`)
  expect(f.porcelain).toBe('')
})

dbTest('an unreadable stored file does not fail session creation; the readable ones still land', () => {
  const f = fact('brokenStore')
  expect(f.status).toBe(201)
  expect(f.isolated).toBe(true)
  expect(f.okEnv).toBe('OK=1\n')
})

dbTest('a project with no store creates an isolated, clean session exactly as before', () => {
  const f = fact('noStoreSession')
  expect(f.status).toBe(201)
  expect(f.isolated).toBe(true)
  expect(f.porcelain).toBe('')
})

// --- logging ---------------------------------------------------------------------

dbTest('file contents never appear in the logs, at any log level; paths do', () => {
  expect(setupError).toBe('')
  // Proves logging was actually on and reached this capture at all.
  expect(logs).toContain('server/.env')
  expect(logs).not.toContain(SECRET)
  expect(logs).not.toContain('TOKEN=rotated')
})
