// The Idea Manager's HTTP surface, against a real Postgres.
//
// Every scenario here turns on something a faked `db` cannot honestly answer:
// a real 404 from a real (empty) query rather than a stubbed chain that
// cannot tell "not found" from "broken WHERE clause"; a genuine race on
// `ideas.next_seq`'s `UPDATE ... RETURNING`; a transaction that has to really
// roll back when its own precondition fails partway through; and a real
// `double precision` column, whose two adjacent boardPosition values either
// are or are not the same float64 once Postgres has actually stored them.
// See ideas-routes-db-child.ts for why this runs in a child process (the
// `@/env` first-import-wins constraint pg-cluster.ts's own header explains)
// and for the fixtures behind each fact below.

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
      PROJECTS_DIR: `/tmp/agentoo-ideas-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-ideas-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/ideas-routes-db-child.ts')], {
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
    console.warn('No Postgres server binaries on this box; the ideas scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(5)
})

// --- unknown idea -> 404 in the standard error envelope ----------------------

dbTest('GET /ideas/{id} 404s an unknown idea in the standard error envelope', () => {
  const f = fact('unknownIdea404')
  expect(f.status).toBe(404)
  // Same shape errorBody() produces everywhere else in this API — see
  // lib/errors.ts.
  expect(f.body).toEqual({ error: 'Idea not found' })
})

// --- a full HTTP round trip through the OpenAPI-validated schemas -----------

dbTest('POST /projects/{id}/ideas creates a card, over real HTTP', () => {
  const f = fact('httpSmoke')
  expect(f.createStatus).toBe(201)
  expect(f.createTitle).toBe('HTTP smoke idea')
})

dbTest('POST /ideas/{id}/blocks accepts every block kind through the discriminated union', () => {
  const f = fact('httpSmoke')
  expect(f.noteStatus).toBe(201)
  expect(f.linkStatus).toBe(201)
  expect(f.linkKind).toBe('link')
  expect(f.linkUrl).toBe('https://example.com')
  expect(f.linkLabel).toBe('Example')
})

dbTest('...and 400s a block missing its kind-specific content field', () => {
  expect(fact('httpSmoke').badBlockStatus).toBe(400)
})

dbTest('PATCH /idea-blocks/{id} updates content and canvas position together', () => {
  const f = fact('httpSmoke')
  expect(f.patchStatus).toBe(200)
  expect(f.patchedText).toBe('an updated note')
  expect(f.patchedX).toBe(12)
})

dbTest('POST /ideas/{id}/move and a follow-up GET agree on the result', () => {
  const f = fact('httpSmoke')
  expect(f.moveStatus).toBe(200)
  expect(f.movedStatus).toBe('todo')
  expect(f.getStatus).toBe(200)
  expect(f.fetchedBlockCount).toBe(2)
})

// --- concurrent block creation gets distinct seq values ----------------------

dbTest('two concurrent block creations on one idea get distinct, gapless seq values', () => {
  const f = fact('concurrentBlockSeq')
  expect(f.distinct).toBe(true)
  expect(f.seqs).toEqual([0, 1])
  expect(f.nextSeqAfter).toBe(2)
})

// --- move into a full column renumbers rather than exhausting precision -----

dbTest('a move whose neighbours are already an exhausted gap does not throw', () => {
  const f = fact('moveRenumber')
  expect(f.threw).toBe('')
})

dbTest('...and renumbers the whole column instead of computing an unusable midpoint', () => {
  const f = fact('moveRenumber')
  // The seeded gap (1e-9) is already below the service's own epsilon.
  const before = f.before as number[]
  expect(before).toHaveLength(2)
  expect(before[1]! - before[0]!).toBeLessThan(1e-6)
  // The moved card landed exactly where it was asked to, between its two
  // named neighbours — proof the renumber preserved the requested order, not
  // just that it produced *some* three distinct numbers.
  expect(f.order).toEqual(['left', 'moved', 'right'])
  expect(f.allDistinct).toBe(true)
  // A renumber, not a lucky midpoint: every position lands on a clean
  // multiple of the service's own spacing constant.
  expect(f.allIntegersOfStep).toBe(true)
})

// --- the followup prompt transaction --------------------------------------------

dbTest('a followup prompt is accepted and generation is enqueued exactly once', () => {
  const f = fact('followupConsume')
  expect(f.promptStatus).toBe('pending')
  expect(f.promptKind).toBe('followup')
  expect(f.digestHasNewComments).toBe(true)
  expect(f.enqueuedCount).toBe(1)
  expect(f.enqueuedPromptId).toBe(true)
})

dbTest('...stamps consumedAt on exactly the previously-unconsumed comments', () => {
  const f = fact('followupConsume')
  expect(f.c1ConsumedAfter).toBe(true)
  expect(f.c2ConsumedAfter).toBe(true)
})

dbTest('...and on nothing else — a comment already consumed keeps its own timestamp', () => {
  const f = fact('followupConsume')
  expect(f.alreadyConsumedUnchanged).toBe(true)
})

dbTest('a followup whose precondition fails inside the transaction enqueues nothing', () => {
  const f = fact('noRunToFollowUp')
  expect(f.threw).toContain('no completed run yet to follow up on')
  expect(f.enqueuedDelta).toBe(0)
  // Rolled back, not left half-written: no prompt row survives the failure.
  expect(f.promptRowsDelta).toBe(0)
})

// --- a failed prompt's retry -----------------------------------------------------

dbTest('retrying a failed prompt copies its stored digest into a new row', () => {
  const f = fact('failedRetry')
  expect(f.digestCopiedVerbatim).toBe(true)
  expect(f.retriedIsNewRow).toBe(true)
  expect(f.retriedStatus).toBe('pending')
  // The stale row is superseded, not mutated: it is still exactly what it
  // was — 'failed' — rather than flipped back to pending under it.
  expect(f.staleRowUntouched).toBe('failed')
})

dbTest('...and does not un-consume, or newly consume, any comment', () => {
  const f = fact('failedRetry')
  expect(f.stillUnconsumedUntouched).toBe(true)
  expect(f.enqueuedDelta).toBe(1)
})

// --- handoff preconditions, guarded here, naming the idea --------------------

dbTest('generating a prompt for an idea with no orchestrator 400s naming the idea', () => {
  const f = fact('handoffGuards')
  expect(f.threwNoOrchestrator).toContain('This idea has no orchestrator')
  expect(f.namesIdeaNotSession).toBe(true)
})

dbTest('generating a prompt while the project is not ready 409s', () => {
  const f = fact('handoffGuards')
  expect(f.threwNotReady).toContain('has to finish setup first')
})
