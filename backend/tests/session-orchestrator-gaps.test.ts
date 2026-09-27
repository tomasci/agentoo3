// The orchestrator-required rule, the cases session-create.test.ts leaves
// out — see session-orchestrator-gaps-db-child.ts for each fixture. Real
// Postgres and a real git repo, in a child process for the same `@/env`
// first-import-wins reason every other db-child pair here gives.
//
//   - whitespace-only / null orchestrators over HTTP (zod's min(1) passes
//     "   ", so only createSession's own trim guard stands between it and a
//     row plus a worktree);
//   - a positive control that makes the "no worktree" facts meaningful: the
//     same fixture with a valid orchestrator does create `worktrees/` and a
//     second git worktree;
//   - createSession called directly with the field missing or blank;
//   - a legacy NULL-orchestrator row: listable, readable, deletable, refuses
//     a message with a 400 naming the orchestrator, and recoverable by PATCH.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP_PROJECTS = `/tmp/agentoo-session-orch-gaps-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-session-orch-gaps-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/session-orchestrator-gaps-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: TEMP_PROJECTS,
        ATTACHMENTS_DIR: TEMP_ATTACHMENTS,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
        // Nothing here should ever reach the docker daemon.
        DOCKER_ENABLED: 'false',
        EDITOR_ENABLED: 'false',
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
  await rm(TEMP_ATTACHMENTS, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the orchestrator-gap scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'httpControl',
    'httpNull',
    'httpSpaces',
    'httpTabsNewlines',
    'legacyDelete',
    'legacyRead',
    'legacyRecover',
    'legacySend',
    'serviceMissing',
    'serviceSpaces',
  ])
})

// --- the positive control first: it is what makes the negatives honest -----

dbTest(
  'control: a valid create on this fixture does make worktrees/ and a second git worktree',
  () => {
    const f = fact<{
      status: number
      orchestrator: unknown
      before: { rowCount: number; worktreesDirCreated: boolean; gitWorktrees: number }
      after: { rowCount: number; worktreesDirCreated: boolean; gitWorktrees: number }
    }>('httpControl')
    expect(f.status).toBe(201)
    expect(f.orchestrator).toBe('coder')
    expect(f.before).toEqual({ rowCount: 0, worktreesDirCreated: false, gitWorktrees: 1 })
    expect(f.after).toEqual({ rowCount: 1, worktreesDirCreated: true, gitWorktrees: 2 })
  },
)

// --- HTTP create: whitespace-only and null ---------------------------------

for (const [key, label] of [
  ['httpSpaces', '"   "'],
  ['httpTabsNewlines', '"\\t\\n "'],
  ['httpNull', 'null'],
] as const) {
  dbTest(`POST with orchestrator ${label}: 400, no row, no worktree`, () => {
    const f = fact(key)
    expect({
      status: f.status,
      rowCount: f.rowCount,
      dir: f.worktreesDirCreated,
      wt: f.gitWorktrees,
    }).toEqual({
      status: 400,
      rowCount: 0,
      dir: false,
      wt: 1,
    })
  })
}

dbTest('a whitespace-only orchestrator 400 names the orchestrator in its message', () => {
  expect(String(fact('httpSpaces').bodyText).toLowerCase()).toContain('orchestrator')
})

// --- createSession directly ------------------------------------------------

for (const key of ['serviceMissing', 'serviceSpaces'] as const) {
  dbTest(
    `createSession (${key}): throws a 400 naming the orchestrator, leaves nothing behind`,
    () => {
      const f = fact(key)
      expect(String(f.threw).toLowerCase()).toContain('orchestrator')
      expect(f.status).toBe(400)
      expect({ rowCount: f.rowCount, dir: f.worktreesDirCreated, wt: f.gitWorktrees }).toEqual({
        rowCount: 0,
        dir: false,
        wt: 1,
      })
    },
  )
}

// --- legacy NULL-orchestrator row -----------------------------------------

dbTest('a legacy NULL-orchestrator row still lists and GETs, reporting orchestrator null', () => {
  const f = fact('legacyRead')
  expect(f.listStatus).toBe(200)
  expect(f.listedOrchestrator).toBeNull()
  expect(f.getStatus).toBe(200)
  expect(f.getOrchestrator).toBeNull()
  expect(typeof f.getId).toBe('string')
})

dbTest('sending it a message 400s with a message naming the orchestrator', () => {
  const f = fact('legacySend')
  expect(f.status).toBe(400)
  expect(String(f.error).toLowerCase()).toContain('orchestrator')
})

dbTest('...and records nothing: no message row, seq untouched, still idle', () => {
  const f = fact('legacySend')
  expect(f.messageRows).toBe(0)
  expect(f.nextSeqUnchanged).toBe(true)
  expect(f.statusAfter).toBe('idle')
})

dbTest('it DELETEs: 204, the row is gone, a later GET is 404', () => {
  const f = fact('legacyDelete')
  expect(f.status).toBe(204)
  expect(f.rowGone).toBe(true)
  expect(f.getAfterStatus).toBe(404)
})

dbTest(
  'PATCHing an orchestrator onto a legacy row recovers it: 200, then a message is accepted',
  () => {
    const f = fact('legacyRecover')
    expect(f.patchStatus).toBe(200)
    expect(f.patchOrchestrator).toBe('coder')
    expect(f.sendStatus).toBe(201)
    expect(f.messageRows).toBe(1)
  },
)
