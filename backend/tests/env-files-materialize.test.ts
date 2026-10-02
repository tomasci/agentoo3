// materializeEnvFiles (features/env-files/materialize.ts) — see
// env-files-materialize-child.ts for the fixture behind each fact below, and
// why it runs in a child process (PROJECTS_DIR has to be a real scratch
// directory before `@/env` parses it, and setup-env.ts has already fixed it
// to a nonexistent path for the shared test process).

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

const root = await mkdtemp(join(tmpdir(), 'agentoo-env-materialize-'))
let facts: Facts = {}
let setupError = ''

try {
  const child = Bun.spawn(['bun', join(BACKEND, 'tests/env-files-materialize-child.ts')], {
    cwd: BACKEND,
    env: {
      ...process.env,
      // Dead on purpose — materializeEnvFiles never dials either, but `@/env`
      // still insists on a non-empty value for both.
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: root,
      LOG_LEVEL: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
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
    facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
  }
} catch (error) {
  setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBe(6)
})

// --- copying into a fresh worktree -----------------------------------------

test('a stored file is copied to the same relative path', () => {
  const f = fact('copy')
  expect(f.copied).toEqual(['server/.env'])
  expect(f.skipped).toEqual([])
  expect(f.content).toBe('SECRET=1\n')
})

test('the copy lands mode 0600', () => {
  expect(fact('copy').mode).toBe(0o600)
})

test('a project with no env store at all copies nothing and does not throw', () => {
  expect(fact('empty')).toEqual({ copied: [], skipped: [] })
})

// --- the branch always wins -------------------------------------------------

test('a file the branch already tracks at that path is never overwritten', () => {
  const f = fact('tracked')
  expect(f.copied).toEqual([])
  expect(f.skipped).toEqual([
    { path: 'server/.env', reason: 'Already present in the worktree (tracked by the branch)' },
  ])
  // The branch's own content, not the store's.
  expect(f.content).toBe('TRACKED=1\n')
})

// --- keeping the copy out of git --------------------------------------------

test('a path not already gitignored gets a local-only info/exclude entry', () => {
  const f = fact('exclude')
  expect((f.lines as string[])).toContain('/.env')
  // Never written into a tracked file, and never staged: the repo's own
  // status shows nothing to commit.
  expect(f.statusClean).toBe(true)
})

test('a second worktree of the same project shares the entry, with no duplicate line', () => {
  const f = fact('exclude')
  // The second worktree gets its own real copy (a fresh file, not a retry) —
  // the case where a duplicate line would actually show up if the dedup check
  // did not work.
  expect(f.secondWorktreeCopied).toEqual(['.env'])
  expect(f.linesAfterSecondWorktree).toHaveLength(1)
})

test('a path already covered by the branch’s own .gitignore gets no info/exclude entry', () => {
  expect((fact('ignored').lines as string[])).not.toContain('/.env')
})

// --- disk state checkEnvFilePath would never have allowed -------------------

test('a stored path that fails validation is skipped, not copied', () => {
  const f = fact('badPath')
  expect(f.copied).toEqual([])
  expect((f.skipped as { path: string }[])[0]?.path).toBe('secrets.txt')
})
