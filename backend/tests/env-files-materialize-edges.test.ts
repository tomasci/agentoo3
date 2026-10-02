// materializeEnvFiles (features/env-files/materialize.ts) past the happy
// path — see env-files-materialize-edges-child.ts for the fixture behind each
// fact, and env-files-materialize.test.ts for why it runs in a child process.
// The child runs under `umask 000` and LOG_LEVEL=5.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BACKEND = new URL('..', import.meta.url).pathname
const SECRET = 'MATERIALIZE-SECRET-91b3' // keep in sync with the child

type Summary = { threw: string | null; copied: string[]; skipped: { path: string; reason: string }[] }

const base = await mkdtemp(join(tmpdir(), 'agentoo-env-materialize-edges-'))
const projectsDir = join(base, 'projects')
await mkdir(projectsDir)
let facts: Record<string, any> = {}
let setupError = ''
let logs = ''

try {
  const child = Bun.spawn(
    ['sh', '-c', 'umask 000 && exec bun "$0"', join(BACKEND, 'tests/env-files-materialize-edges-child.ts')],
    {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: projectsDir,
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
    const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-2000)
    setupError = `child exited ${code}: ${failure}`
  } else {
    facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim())
    logs = stdout.slice(0, marker) + stderr
  }
} catch (error) {
  setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
}

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

const fact = (key: string): any => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value
}
const summary = (key: string): Summary => fact(key).summary
const skippedPaths = (s: Summary) => s.skipped.map((x) => x.path).sort()

test('the scenarios ran at all', () => {
  expect(setupError).toBe('')
})

// --- copying ---------------------------------------------------------------------

test('every stored file is copied, nested parents created, without throwing', () => {
  const s = summary('bytes')
  expect(s.threw).toBeNull()
  expect([...s.copied].sort()).toEqual(['.devcontainer/.env', '.env', '.env.local', 'a/b/c/.env', 'docker/db.env'])
  expect(s.skipped).toEqual([])
})

test('each copy is byte-identical to the stored file, including non-UTF-8 bytes', () => {
  expect(fact('bytes').identical).toEqual({
    '.env': true,
    '.env.local': true,
    'a/b/c/.env': true,
    '.devcontainer/.env': true,
    'docker/db.env': true,
  })
})

test('each copy is mode 0600 even under umask 000', () => {
  for (const m of Object.values(fact('bytes').modes)) expect(m).toBe(0o600)
})

test('none of them shows up in git status, and each gets one anchored info/exclude line', () => {
  const f = fact('bytes')
  expect(f.porcelain).toBe('')
  expect([...f.exclude].sort()).toEqual([
    '/.devcontainer/.env',
    '/.env',
    '/.env.local',
    '/a/b/c/.env',
    '/docker/db.env',
  ])
})

// --- the branch wins -------------------------------------------------------------

test('a file the branch tracks is never overwritten, and the rest still copy', () => {
  const f = fact('tracked')
  expect(f.summary.threw).toBeNull()
  expect(f.summary.copied).toEqual(['.env'])
  expect(skippedPaths(f.summary)).toEqual(['server/.env'])
  expect(f.content).toBe('TRACKED=1\n')
  // Not modified, and not excluded (it is tracked; an exclude line would be noise).
  expect(f.porcelain).toBe('')
  expect(f.exclude).toEqual(['/.env'])
})

// --- git-ignore handling ------------------------------------------------------------

test('a path the branch already ignores gets no exclude line; a sibling it does not ignore does', () => {
  const f = fact('ignored')
  expect([...f.summary.copied].sort()).toEqual(['.env', 'server/.env'])
  expect(f.exclude).toEqual(['/server/.env'])
  expect(f.porcelain).toBe('')
})

test('three sessions of one project: all copied, all clean, each exclude line exactly once', () => {
  const f = fact('repeat')
  for (const s of f.summaries as Summary[]) expect([...s.copied].sort()).toEqual(['.env', 'server/.env'])
  expect(f.porcelains).toEqual(['', '', ''])
  expect([...f.exclude].sort()).toEqual(['/.env', '/server/.env'])
})

test('an existing info/exclude without a trailing newline keeps its last rule intact', () => {
  const f = fact('nonl')
  expect(f.raw).toBe('# local rules\n/custom-ignore\n/.env\n')
  expect(f.porcelain).toBe('')
})

// --- symlinks ------------------------------------------------------------------------

test('a branch symlink to a directory outside the worktree gets nothing written through it', () => {
  const f = fact('symdir')
  expect(f.summary.threw).toBeNull()
  // Neither server/.env nor server/sub/.env, nor the sub/ directory itself.
  expect(f.outsideEntries).toEqual([])
  expect(skippedPaths(f.summary)).toEqual(['server/.env', 'server/sub/.env'])
  expect(f.summary.copied).toEqual(['.env'])
  expect(f.rootCopied).toBe(true)
})

test('a dangling branch symlink at the target path is not followed to create its target', () => {
  const f = fact('symfile')
  expect(f.summary.threw).toBeNull()
  expect(f.summary.copied).toEqual([])
  expect(f.plantedExists).toBe(false)
})

test('symlinked files and directories inside the store are ignored, not followed', () => {
  const f = fact('storelinks')
  expect(f.summary.copied).toEqual(['.env'])
  expect(f.linkFile).toBe(false)
  expect(f.linkDir).toBe(false)
})

// --- best effort ----------------------------------------------------------------------

test('an unreadable stored file is skipped while the readable ones still copy', () => {
  const f = fact('unreadable')
  expect(f.summary.threw).toBeNull()
  expect(f.summary.copied).toEqual(['.env'])
  expect(skippedPaths(f.summary)).toEqual(['locked/.env'])
  expect(f.okContent).toBe('OK=1\n')
})

test('...and leaves no empty placeholder of it behind in the worktree', () => {
  const f = fact('unreadable')
  expect(f.lockedInWorktree).toBe(false)
  expect(f.porcelain).toBe('')
})

test('a regular file in the branch where the store needs a directory is skipped, left intact', () => {
  const f = fact('fileasdir')
  expect(f.summary.threw).toBeNull()
  expect(skippedPaths(f.summary)).toEqual(['server/.env'])
  expect(f.summary.copied).toEqual(['.env'])
  expect(f.serverFile).toBe('I am a file\n')
  expect(f.porcelain).toBe('')
})

test('a directory in the branch where the store has a file is skipped, left intact', () => {
  const f = fact('dirasfile')
  expect(f.summary.threw).toBeNull()
  expect(f.summary.copied).toEqual([])
  expect(skippedPaths(f.summary)).toEqual(['conf.env'])
  expect(f.keep).toBe('k\n')
  expect(f.porcelain).toBe('')
})

test('a worktree path that does not exist neither throws nor gets created', () => {
  const f = fact('nowt')
  expect(f.summary.threw).toBeNull()
  expect(f.summary.copied).toEqual([])
  expect(f.created).toBe(false)
})

test('when info/exclude cannot be written, materialization does not throw...', () => {
  expect(fact('roexclude').summary.threw).toBeNull()
})

test('...and does not leave a copy behind that git status shows as untracked', () => {
  // The spec's invariant: no env file ever shows as untracked after
  // materialization. A copy that could not be excluded is one `git add -A`
  // away from being committed.
  expect(fact('roexclude').porcelain).toBe('')
})

// --- logging ---------------------------------------------------------------------------

test('file contents never reach the logs, including on the warn paths; paths do', () => {
  expect(setupError).toBe('')
  expect(logs).toContain('locked/.env')
  expect(logs).not.toContain(SECRET)
  expect(logs).not.toContain('LOCKED=1')
})
