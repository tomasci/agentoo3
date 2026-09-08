// POST /ideas/{id}/blocks/reorder, against a real Postgres.
//
// Every scenario here turns on something a faked `db` cannot honestly
// answer: whether a two-phase (offset, then settle) write across
// `idea_blocks_idea_seq_key` — a real, non-deferrable unique index — commits
// at all for a permutation with cycles (a full reversal), rather than
// tripping over its own not-yet-updated rows partway through. See
// idea-reorder-db-child.ts for why this runs in a child process (the `@/env`
// first-import-wins constraint pg-cluster.ts's own header explains) and for
// the fixtures behind each fact below.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

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
      PROJECTS_DIR: `/tmp/agentoo-idea-reorder-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-idea-reorder-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-reorder-db-child.ts')], {
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
    console.warn('No Postgres server binaries on this box; the reorder scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(3)
})

// --- a full reversal, across a real unique index -----------------------------

dbTest('a full reversal succeeds without tripping the (idea_id, seq) unique index', () => {
  const f = fact('fullReversal')
  expect(f.reorderStatus).toBe(200)
})

dbTest('...and the returned/listed blocks come back in exactly the requested order', () => {
  const f = fact('fullReversal')
  expect(f.responseOrder).toEqual(f.requestedOrder)
  expect(f.listedOrder).toEqual(f.requestedOrder)
})

dbTest("...and the serializer's own output order changes to match", () => {
  const f = fact('fullReversal')
  expect(f.serializedOrderMatches).toBe(true)
})

dbTest('...and ideas.updatedAt is left untouched by a reorder', () => {
  const f = fact('fullReversal')
  expect(f.updatedAtUnchanged).toBe(true)
})

// --- validation: an exact permutation, or a 400 naming the problem -----------

dbTest('a permutation that omits a block id 400s', () => {
  const f = fact('omitsId')
  expect(f.status).toBe(400)
  expect(f.error).toContain('exactly')
})

dbTest('a permutation with a duplicate block id 400s', () => {
  const f = fact('duplicateId')
  expect(f.status).toBe(400)
  expect(f.error).toContain('duplicate')
})

dbTest("a permutation naming a block from a different idea's canvas 400s", () => {
  const f = fact('foreignBlock')
  expect(f.status).toBe(400)
  expect(f.error).toContain('does not belong to this idea')
})

dbTest('none of the rejected requests changed any seq', () => {
  expect(fact('omitsId').seqUnchanged).toBe(true)
  expect(fact('duplicateId').seqUnchanged).toBe(true)
  expect(fact('foreignBlock').seqUnchanged).toBe(true)
})

// --- idempotency ---------------------------------------------------------------

dbTest('submitting the current order is a no-op', () => {
  const f = fact('noop')
  expect(f.status).toBe(200)
  expect(f.seqUnchanged).toBe(true)
  expect(f.updatedAtUnchanged).toBe(true)
})
