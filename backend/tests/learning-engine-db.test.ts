// The learning engine (features/learning/engine.ts) against a real Postgres,
// with @anthropic-ai/claude-agent-sdk mocked — see learning-engine-db-child.ts
// for why this runs in a child process and for the fixtures behind each fact
// below. Mirrors tests/learning-db.test.ts's own parent/child split.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''
let libraryDir = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    libraryDir = await mkdtemp(join(tmpdir(), 'agentoo-learning-engine-library-'))

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      REDIS_URL: 'redis://127.0.0.1:1',
      LIBRARY_DIR: libraryDir,
      PROJECTS_DIR: `/tmp/agentoo-learning-engine-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-learning-engine-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
      // Generous enough that every fixture in the child fits in one batch —
      // the child scripts its exact SDK call sequence around that.
      LEARNING_BATCH_CHARS: '60000',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/learning-engine-db-child.ts')], {
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
  if (libraryDir) await rm(libraryDir, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the learning engine scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(3)
})

// --- window boundaries, >=2 projects, prompt contains the library -----------

dbTest('a session created exactly at windowStart is included', () => {
  expect(fact('windowBoundary').promptContainsIncludedA).toBe(true)
})

dbTest('a session created well inside the window, in a second project, is included', () => {
  expect(fact('windowBoundary').promptContainsIncludedB).toBe(true)
})

dbTest('a session created exactly at windowEnd is excluded (end is exclusive)', () => {
  expect(fact('windowBoundary').promptContainsExcludedAtEnd).toBe(false)
})

dbTest('a session created one millisecond before windowStart is excluded', () => {
  expect(fact('windowBoundary').promptContainsExcludedBefore).toBe(false)
})

dbTest('sessionsAnalyzed counts exactly the sessions actually sent to the model', () => {
  expect(fact('windowBoundary').sessionsAnalyzed).toBe(2)
})

dbTest('the prompt sent to the model contains every agent\'s and every skill\'s full markdown', () => {
  const f = fact('windowBoundary')
  expect(f.promptContainsAgentMarkdown).toBe(true)
  expect(f.promptContainsSkillMarkdown).toBe(true)
})

dbTest('the run completes with zero suggestions, zero duplicates, and a recorded cost', () => {
  const f = fact('windowBoundary')
  expect(f.status).toBe('completed')
  expect(f.suggestionsCreated).toBe(0)
  expect(f.duplicatesSkipped).toBe(0)
  expect(f.costUsd).toBeGreaterThan(0)
  expect(f.error).toBeNull()
  expect(f.callCount).toBe(1)
})

// --- dedupe against a rejected row, then free to resurface -------------------

dbTest('a candidate the judge marks as duplicating a rejected row is not inserted', () => {
  const f = fact('dedupeRun1')
  expect(f.status).toBe('completed')
  expect(f.suggestionsCreated).toBe(0)
  expect(f.duplicatesSkipped).toBe(1)
  expect(f.noPendingSuggestionInserted).toBe(true)
  // Never writes a library file — suggestions-only.
  expect(f.fileUnchanged).toBe(true)
})

dbTest('after the rejected row is deleted, the same candidate is inserted on the next run', () => {
  const f = fact('dedupeRun2')
  expect(f.status).toBe('completed')
  expect(f.suggestionsCreated).toBe(1)
  expect(f.duplicatesSkipped).toBe(0)
  expect(f.pendingSuggestionInserted).toBe(true)
  expect(f.insertedMatchesCandidate).toBe(true)
})

dbTest('the library file is byte-identical to the original even after a run that produced a modify suggestion', () => {
  expect(fact('dedupeRun2').fileStillByteIdenticalToOriginal).toBe(true)
})

// --- zero sessions in the window ---------------------------------------------

dbTest('zero sessions in the window: completed, zero counters, and no SDK call', () => {
  const f = fact('zeroSessions')
  expect(f.status).toBe('completed')
  expect(f.sessionsAnalyzed).toBe(0)
  expect(f.suggestionsCreated).toBe(0)
  expect(f.duplicatesSkipped).toBe(0)
  expect(f.costUsd).toBe(0)
  expect(f.error).toBeNull()
  expect(f.noNewCalls).toBe(true)
})
