// The topbar notifications feed against a real Postgres: membership (matches
// GET /sessions/overview's `unchecked` and GET /library/suggestions?status=
// pending exactly), ordering/tie-breaks, the millisecond-precision read
// watermark (including the regression a SQL comparison against
// library_suggestions.created_at's microsecond precision would reintroduce),
// the 50-item cap, and that marking read never touches seenAt or a
// suggestion's status. See notifications-db-child.ts for every fixture
// behind each fact below, and whats-new-db.test.ts/learning-db.test.ts for
// the child/parent split and the LIBRARY_DIR temp dir this also needs (the
// apply/reject section writes a real skill file).

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, any>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''
let libraryDir = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    libraryDir = await mkdtemp(join(tmpdir(), 'agentoo-notifications-db-library-'))

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
      REDIS_URL: 'redis://127.0.0.1:1',
      LIBRARY_DIR: libraryDir,
      PROJECTS_DIR: `/tmp/agentoo-notifications-db-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-notifications-db-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/notifications-db-child.ts')], {
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

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (value === undefined) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the notifications scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(10)
})

// --- 1. empty DB ------------------------------------------------------------

dbTest('an empty database is an empty feed, and POST writes no row', () => {
  const f = fact('empty')
  expect(f.get.status).toBe(200)
  expect(f.get.body).toEqual({ items: [], hasUnread: false, truncated: false })
  expect(f.post.status).toBe(200)
  expect(f.post.body).toEqual({ items: [], hasUnread: false, truncated: false })
  expect(f.storedAfter).toBeNull()
})

// --- 2. membership -----------------------------------------------------------

dbTest('feed membership matches the overview\'s unchecked list, session by session', () => {
  const f = fact('membership')
  expect(f.perSession.seen).toEqual({ inFeed: false, inOverviewUnchecked: false })
  expect(f.perSession.seenBeforeSettled).toEqual({ inFeed: true, inOverviewUnchecked: true })
  expect(f.perSession.runningWithSettledAt).toEqual({ inFeed: false, inOverviewUnchecked: false })
  expect(f.perSession.queuedWithSettledAt).toEqual({ inFeed: false, inOverviewUnchecked: false })
  expect(f.perSession.idleUnchecked).toEqual({ inFeed: true, inOverviewUnchecked: true })
  expect(f.perSession.neverSettled).toEqual({ inFeed: false, inOverviewUnchecked: false })
  // A settled session that went back to 'idle' is still shown with its real
  // status, not coerced to something else.
  expect(f.idleItemStatus).toBe('idle')
})

dbTest('feed membership matches /library/suggestions?status=pending, by status', () => {
  const f = fact('membership')
  expect(f.suggestions.pending).toEqual({ inFeed: true, inPendingList: true })
  expect(f.suggestions.applied).toEqual({ inFeed: false, inPendingList: false })
  expect(f.suggestions.rejected).toEqual({ inFeed: false, inPendingList: false })
})

// --- 3. ordering, tie-breaks, and millisecond-exact `at` --------------------

dbTest('newest first; on an exact tie, a session sorts before a suggestion, then id ascending', () => {
  const f = fact('ordering')
  expect(f.count).toBe(3)
  expect(f.sources).toEqual(['session', 'session', 'suggestion'])
  expect(f.ids.slice(0, 2).sort()).toEqual(f.expectedSessionOrder)
  expect(f.ids).toEqual([...f.expectedSessionOrder, f.suggId])
})

dbTest('`at` equals the source row\'s own timestamp, to the millisecond', () => {
  const f = fact('ordering')
  expect(f.atMatchesRow).toEqual({ sessA: true, sessB: true, sugg: true })
  expect(f.atMatchesInput).toBe(true)
})

// --- 4. no stored watermark: everything unread ------------------------------

dbTest('no stored row: every item is unread; POST items[0].at clears hasUnread and stores it', () => {
  const f = fact('noStoredRow')
  expect(f.itemCount).toBeGreaterThan(0)
  expect(f.beforeAllUnread).toBe(true)
  expect(f.postHasUnread).toBe(false)
  expect(f.stored).toEqual(f.expectedStored)
})

// --- 5. the microsecond-createdAt precision regression ----------------------

dbTest('a freshly inserted suggestion (default microsecond createdAt) can be marked read', () => {
  const f = fact('precisionRegression')
  expect(f.topIsThisSuggestion).toBe(true)
  expect(f.postStatus).toBe(200)
  expect(f.postHasUnread).toBe(false)
})

// --- 6. race: GET, insert newer, POST the stale upTo ------------------------

dbTest('an item that arrives between a GET and the POST that follows it stays unread', () => {
  const f = fact('race')
  expect(f.newerInFeed).toBe(true)
  expect(f.newerItemUnread).toBe(true)
  expect(f.postHasUnread).toBe(true)
})

// --- 7. future upTo is clamped -----------------------------------------------

dbTest('a future upTo is clamped to the feed\'s actual newest item', () => {
  const f = fact('futureClamped')
  expect(f.postHasUnread).toBe(false)
  expect(f.storedAfterClamp).toEqual(f.expectedStored)
})

dbTest('a session that settles after that clamp is unread', () => {
  const f = fact('futureClamped')
  expect(f.laterItemUnread).toBe(true)
})

// --- 8. older upTo is a no-op; repeats are idempotent -----------------------

dbTest('marking read, then repeating the same upTo, stores one row and does not duplicate it', () => {
  const f = fact('olderAndIdempotent')
  expect(f.firstHasUnread).toBe(false)
  expect(f.storedAfterRepeat).toEqual(f.storedAfterFirst)
  expect(f.rowsAfterRepeat).toBe(1)
})

dbTest('an older upTo changes nothing', () => {
  const f = fact('olderAndIdempotent')
  expect(f.olderPostStatus).toBe(200)
  expect(f.unchangedByOlder).toBe(true)
})

// --- 9. POST validation ------------------------------------------------------

dbTest('a POST with no body at all is a 400 and writes nothing', () => {
  const f = fact('validation')
  expect(f.noBody.status).toBe(400)
  expect(f.storedAfterNoBody).toBeNull()
})

dbTest('a POST with a non-ISO upTo is a 400 naming the field, and writes nothing', () => {
  const f = fact('validation')
  expect(f.badDatetime.status).toBe(400)
  expect(f.badDatetime.body).toEqual({
    error: 'Validation failed',
    issues: [{ path: 'upTo', message: 'Invalid ISO datetime' }],
  })
  expect(f.storedAfterBadDatetime).toBeNull()
})

dbTest('the offset form of upTo (not just Z) is accepted', () => {
  const f = fact('validation')
  expect(f.offsetForm.status).toBe(200)
  expect(f.offsetForm.hasUnread).toBe(false)
  expect(f.storedAfterOffsetForm).not.toBeNull()
})

// --- 10. a malformed stored row is absent, never a 500 ----------------------

for (const name of ['notAnObject', 'missingField', 'badDatetime']) {
  dbTest(`a malformed stored watermark (${name}) is treated as absent, with a warning, never a 500`, () => {
    const f = fact(`malformed_${name}`)
    expect(f.status).toBe(200)
    expect(f.hasItems).toBe(true)
    expect(f.allUnread).toBe(true)
    expect(f.warned).toBe(true)
  })
}

dbTest('a malformed stored row is overwritten cleanly by the next POST', () => {
  const f = fact('malformedOverwritten')
  expect(f.postHasUnread).toBe(false)
  expect(f.stored).toEqual(f.expectedStored)
})

// --- 11. seen/apply/reject remove items; mark-read touches neither ---------

dbTest('a session, a pending-apply and a pending-reject suggestion all start in the feed', () => {
  const f = fact('seenApplyReject')
  expect(f.beforeHasAll).toBe(true)
})

dbTest('marking read never sets seenAt, never changes a suggestion\'s status, and the overview is unchanged', () => {
  const f = fact('seenApplyReject')
  expect(f.seenAtUntouched).toBe(true)
  expect(f.applyStatusUntouched).toBe(true)
  expect(f.rejectStatusUntouched).toBe(true)
  expect(f.stillUncheckedAfterMarkRead).toBe(true)
})

dbTest('POST /sessions/{id}/seen, apply and reject each remove their own item from the feed', () => {
  const f = fact('seenApplyReject')
  expect(f.seenRouteStatus).toBe(200)
  expect(f.applyRouteStatus).toBe(200)
  expect(f.rejectRouteStatus).toBe(200)
  expect(f.afterHasNone).toBe(true)
  expect(f.noLongerUnchecked).toBe(true)
  expect(f.noLongerPending).toBe(true)
})

// --- 12. the 50-item cap -----------------------------------------------------

dbTest('more than 50 unread items: exactly 50 are returned, truncated is true', () => {
  const f = fact('truncation')
  expect(f.itemCount).toBe(50)
  expect(f.truncated).toBe(true)
})

dbTest('marking read through the newest of a truncated feed still clears hasUnread', () => {
  const f = fact('truncation')
  expect(f.postHasUnread).toBe(false)
})

// --- 13. OpenAPI --------------------------------------------------------------

dbTest('GET /api/notifications and POST /api/notifications/read are both in the OpenAPI document', () => {
  const f = fact('openapi')
  expect(f.status).toBe(200)
  expect(f.hasGet).toBe(true)
  expect(f.hasPost).toBe(true)
})
