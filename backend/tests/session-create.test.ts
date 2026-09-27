// The orchestrator becoming a required field on session creation, against a
// real Postgres and a real git repo — see session-create-db-child.ts for the
// exact fixture behind each fact below, and why it runs in a child process
// (the `@/env` first-import-wins constraint pg-cluster.ts's own header
// explains).
//
// Covers both halves of the rule: createSessionSchema refusing a missing or
// blank orchestrator at the HTTP boundary, and createSession's own guard
// refusing the same thing for a caller that reaches the service directly —
// plus updateSessionSchema refusing to clear an orchestrator that is already
// set, while still allowing it to be swapped for another name.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP_PROJECTS = `/tmp/agentoo-session-create-test-projects-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis and
      // bullmq. `@/env` still insists on a value.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: TEMP_PROJECTS,
      ATTACHMENTS_DIR: `/tmp/agentoo-session-create-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/session-create-db-child.ts')], {
      cwd: BACKEND,
      env: childEnv,
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
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the session-create scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'createTrimmed',
    'httpBlank',
    'httpMissing',
    'httpValid',
    'patchClear',
    'patchSwap',
    'patchWhitespace',
    'serviceGuard',
  ])
})

// --- create: orchestrator is required ---------------------------------------

dbTest('a missing orchestrator 400s and creates no row or worktree', () => {
  const f = fact('httpMissing')
  expect(f.status).toBe(400)
  expect(f.rowCount).toBe(0)
  expect(f.worktreesDirCreated).toBe(false)
})

dbTest('...and names the field, the same way every other validation failure does', () => {
  const f = fact('httpMissing')
  expect(f.error).toBe('Validation failed')
  expect(f.issuePaths).toContain('orchestrator')
})

dbTest('a blank orchestrator ("") is refused exactly like a missing one', () => {
  const f = fact('httpBlank')
  expect(f.status).toBe(400)
  expect(f.rowCount).toBe(0)
  expect(f.worktreesDirCreated).toBe(false)
})

dbTest('a real orchestrator creates the session and persists it', () => {
  const f = fact('httpValid')
  expect(f.status).toBe(201)
  expect(f.orchestratorInResponse).toBe('coder')
  expect(f.orchestratorInRow).toBe('coder')
})

dbTest('...on a real git repo, that session gets its own worktree', () => {
  const f = fact('httpValid')
  expect(f.isolated).toBe(true)
  expect(f.worktreePathSet).toBe(true)
})

// --- create: the service's own guard holds for a caller that skips zod -----

dbTest('createSession refuses a blank orchestrator even called directly, not just over HTTP', () => {
  const f = fact('serviceGuard')
  expect(String(f.threw)).toContain('orchestrator')
  expect(f.rowCount).toBe(0)
  expect(f.worktreesDirCreated).toBe(false)
})

// --- update: may change, never clear ----------------------------------------

dbTest('PATCH orchestrator: null is refused, and the session keeps its orchestrator', () => {
  const f = fact('patchClear')
  expect(f.status).toBe(400)
  expect(f.orchestratorAfter).toBe('coder')
})

dbTest('PATCH to another orchestrator name succeeds', () => {
  const f = fact('patchSwap')
  expect(f.status).toBe(200)
  expect(f.orchestratorInResponse).toBe('reviewer')
  expect(f.orchestratorInRow).toBe('reviewer')
})

// --- update: whitespace-only is refused exactly like null -------------------

dbTest('PATCH orchestrator: "   " (whitespace-only) is refused, session unchanged', () => {
  const f = fact('patchWhitespace')
  expect(f.status).toBe(400)
  expect(f.orchestratorAfter).toBe('coder')
})

// --- create: persisted trimmed, not verbatim --------------------------------

dbTest('create with surrounding whitespace persists the trimmed name', () => {
  const f = fact('createTrimmed')
  expect(f.status).toBe(201)
  expect(f.orchestratorInResponse).toBe('lead')
  expect(f.orchestratorInRow).toBe('lead')
})
