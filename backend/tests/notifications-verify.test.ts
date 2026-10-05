// Independent verification of the notifications feed (GET /api/notifications,
// POST /api/notifications/read) against a real temp Postgres, covering spec
// points notifications-db.test.ts asserts weakly or not at all: exact item
// shape, re-settle after seen, deleted projects, far-future clamp followed by
// a now()-settled session, concurrent POSTs (including more than the DB
// pool's 10 connections), the millisecond boundary, never-backwards after the
// newest item disappears, empty-feed no-write with an existing watermark, the
// 50/51 cap across both sources, non-UTC offsets, and exact 400 envelopes.
// See notifications-verify-db-child.ts for the fixtures behind each fact.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

let cluster: Cluster | undefined
let facts: Record<string, any> = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/notifications-verify-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: `/tmp/agentoo-notifications-verify-projects-${process.pid}`,
        ATTACHMENTS_DIR: `/tmp/agentoo-notifications-verify-attachments-${process.pid}`,
        LIBRARY_DIR: `/tmp/agentoo-notifications-verify-library-${process.pid}`,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
        LOG_LEVEL: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killer = setTimeout(() => child.kill(), 90_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(killer)
    const marker = stdout.indexOf('__FACTS__')
    if (marker === -1) {
      setupError = `child exited ${code} with no facts: ${stderr.slice(-4000)}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim())
      if (facts.__error) setupError = `child threw: ${facts.__error}`
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
})

const dbTest = hasPostgres ? test : test.skip

const fact = (key: string): any => {
  const value = facts[key]
  if (value === undefined) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value
}

test('the verification scenarios all ran', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; notifications-verify did not run.')
    return
  }
  expect(setupError).toBe('')
})

// --- item shape ---------------------------------------------------------------

dbTest('the feed body has exactly items, hasUnread, truncated', () => {
  expect(fact('shape').topLevelKeys).toEqual(['hasUnread', 'items', 'truncated'])
})

dbTest('a session item carries exactly the spec fields, with the row\'s values', () => {
  const f = fact('shape')
  expect(f.sessionKeys).toEqual(['at', 'id', 'projectId', 'projectName', 'source', 'status', 'title', 'unread'])
  expect(f.session).toEqual(f.expectedSession)
})

dbTest('an untitled session item has title null and keeps a non-completed status', () => {
  const f = fact('shape')
  expect(f.untitled.title).toBeNull()
  expect(f.untitled.status).toBe('interrupted')
})

dbTest('a suggestion item carries exactly the spec fields, with the row\'s values', () => {
  const f = fact('shape')
  expect(f.suggestionKeys).toEqual(['action', 'at', 'id', 'kind', 'name', 'source', 'title', 'unread'])
  expect(f.suggestion).toEqual(f.expectedSuggestion)
})

// --- re-settle -----------------------------------------------------------------

dbTest('settled, marked read, seen, then settled again: back in the feed and unread', () => {
  const f = fact('resettle')
  expect(f.readStatus).toBe(200)
  expect(f.readHasUnread).toBe(false)
  expect(f.seenStatus).toBe(200)
  expect(f.inFeedAfterSeen).toBe(false)
  expect(f.inFeedAfterResettle).toBe(true)
  expect(f.unreadAfterResettle).toBe(true)
  expect(f.hasUnreadAfterResettle).toBe(true)
  expect(f.inOverviewUnchecked).toBe(true)
})

// --- deleted project ---------------------------------------------------------

dbTest('a session in a deleted project is no longer listed; the other project\'s is', () => {
  const f = fact('deletedProject')
  expect(f.before.sort()).toEqual([f.keptId, f.goneId].sort())
  expect(f.deleteStatus).toBe(204)
  expect(f.after).toEqual([f.keptId])
  expect(f.getStatusAfter).toBe(200)
})

// --- far-future clamp ---------------------------------------------------------

dbTest('a far-future upTo clamps to the newest existing item', () => {
  const f = fact('futureClampThenNow')
  expect(f.postStatus).toBe(200)
  expect(f.postHasUnread).toBe(false)
  expect(f.stored).toEqual(f.expectedStored)
})

dbTest('after that clamp, a session settled at now() and a new suggestion are unread', () => {
  const f = fact('futureClampThenNow')
  expect(f.oldUnread).toBe(false)
  expect(f.oldSuggUnread).toBe(false)
  expect(f.freshUnread).toBe(true)
  expect(f.freshSuggUnread).toBe(true)
  expect(f.hasUnread).toBe(true)
})

// --- concurrency ----------------------------------------------------------------

dbTest('8 concurrent POSTs with different upTo values always end at the max (6 rounds)', () => {
  const f = fact('concurrent')
  expect(f.rounds).toHaveLength(6)
  for (const round of f.rounds) {
    expect(round.statuses).toEqual(Array(8).fill(200))
    expect(round.stored).toEqual(f.expected)
  }
})

dbTest('25 concurrent POSTs (more than the 10-connection pool) complete and end at the max', () => {
  const f = fact('poolConcurrency')
  expect(f.timedOut).toBe(false)
  expect(f.statuses).toEqual(Array(25).fill(200))
  expect(f.stored?.value).toEqual(f.expected)
})

// --- millisecond precision -----------------------------------------------------

dbTest('unread compares at ms precision: at == watermark is read, +1ms is unread', () => {
  const f = fact('msBoundary')
  expect(f.postStatus).toBe(200)
  expect(f.stored).toEqual(f.expectedStored)
  expect(f.atTUnread).toBe(false)
  expect(f.atT1Unread).toBe(true)
  expect(f.hasUnread).toBe(true)
})

dbTest('a settled_at with sub-millisecond digits is reported and compared at its millisecond', () => {
  const f = fact('msBoundary')
  expect(f.subMsAt).toBe(f.expectedSubMsAt)
  expect(f.subMsUnread).toBe(false)
})

// --- never backwards / empty feed --------------------------------------------

dbTest('when the newest item leaves the feed, posting the new (older) newest does not move the watermark back', () => {
  const f = fact('neverBackwards')
  expect(f.storedAfterFirst).not.toBeNull()
  expect(f.storedAfterSecond).toEqual(f.storedAfterFirst)
  expect(f.items).toEqual([f.olderId])
  expect(f.secondHasUnread).toBe(false)
})

dbTest('an empty feed with an existing watermark: POST returns the empty feed and writes nothing', () => {
  const f = fact('emptyWithWatermark')
  expect(f.postStatus).toBe(200)
  expect(f.postBody).toEqual({ items: [], hasUnread: false, truncated: false })
  expect(f.before).not.toBeNull()
  expect(f.after).toEqual(f.before) // value and updated_at both unchanged
})

// --- cap ---------------------------------------------------------------------------

dbTest('exactly 50 items across both sources: all returned, truncated false, newest first', () => {
  const f = fact('cap')
  expect(f.exactly50).toEqual({ count: 50, truncated: false, sorted: true })
})

dbTest('51 items: 50 returned, truncated true, the oldest is the one dropped', () => {
  const f = fact('cap')
  expect(f.fiftyOne).toEqual({ count: 50, truncated: true, hasOldest: false })
})

dbTest('a newest-of-all suggestion tops a truncated mixed feed', () => {
  const f = fact('cap')
  expect(f.fiftyTwo.count).toBe(50)
  expect(f.fiftyTwo.truncated).toBe(true)
  expect(f.fiftyTwo.topId).toBe(f.newestId)
  expect(f.fiftyTwo.sorted).toBe(true)
  expect(f.fiftyTwo.sources).toEqual(['session', 'suggestion'])
})

// --- partial unread, offsets, POST == GET ---------------------------------

dbTest('a non-UTC offset upTo (+05:30) is stored as the same instant in UTC', () => {
  const f = fact('partial')
  expect(f.postStatus).toBe(200)
  expect(f.stored).toEqual(f.expectedStored)
})

dbTest('only items strictly newer than the watermark are unread, and hasUnread reflects one', () => {
  const f = fact('partial')
  expect(f.unreadById).toEqual({ [f.ids.a]: false, [f.ids.b]: false, [f.ids.c]: true })
  expect(f.hasUnread).toBe(true)
})

dbTest('the POST response is the same feed a GET returns right after', () => {
  expect(fact('partial').postEqualsGet).toBe(true)
})

// --- mark-read side effects ---------------------------------------------------

dbTest('marking read leaves the session and suggestion rows byte-identical', () => {
  const f = fact('untouched')
  expect(f.seenAt).toBeNull()
  expect(f.suggStatus).toBe('pending')
  expect(f.sessionRowEqual).toBe(true)
  expect(f.suggestionRowEqual).toBe(true)
})

// --- 400 envelopes -----------------------------------------------------------

const validationCases = ['noBody', 'emptyObject', 'numberUpTo', 'nullUpTo', 'emptyString', 'dateOnly']

for (const name of validationCases) {
  dbTest(`POST /notifications/read 400s with the validation envelope naming upTo: ${name}`, () => {
    const c = fact('envelope').cases[name]
    expect(c.status).toBe(400)
    expect(c.contentType).toContain('application/json')
    expect(Object.keys(c.body).sort()).toEqual(['error', 'issues'])
    expect(c.body.error).toBe('Validation failed')
    expect(c.body.issues.length).toBeGreaterThan(0)
    for (const issue of c.body.issues) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path'])
      expect(typeof issue.message).toBe('string')
      expect(issue.message.length).toBeGreaterThan(0)
    }
    expect(c.body.issues.map((i: { path: string }) => i.path)).toEqual(['upTo'])
  })
}

dbTest('a malformed JSON body is a JSON 400 with an error string, never a 500', () => {
  const c = fact('envelope').cases.malformedJson
  expect(c.status).toBe(400)
  expect(c.contentType).toContain('application/json')
  expect(typeof c.body.error).toBe('string')
  expect(c.body.error.length).toBeGreaterThan(0)
})

dbTest('a text/plain body is rejected with a 400', () => {
  expect(fact('envelope').cases.textPlain.status).toBe(400)
})

dbTest('none of the rejected POSTs wrote a watermark', () => {
  expect(fact('envelope').storedAfter).toBeNull()
})
