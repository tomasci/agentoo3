// Independent verification of the topbar notifications feed against a real
// Postgres, filling spec points notifications-db-child.ts asserts weakly or
// not at all. Same child/parent split as that file (see its header): `@/env`
// parses process.env once at first import, so DATABASE_URL has to be right
// from this process's first line. BullMQ, ioredis and the Agent SDK are faked
// identically; everything else is the real createApp().
//
// Unlike notifications-db-child.ts, every scenario here starts from an empty
// feed (resetAll) so each fact depends only on its own fixtures.

import { mock } from 'bun:test'

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job' }
    }
    async upsertJobScheduler() {}
    async setGlobalConcurrency() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {},
  }),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const { randomUUID } = await import('node:crypto')
const { eq, sql } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { librarySuggestions, projects, sessions, systemSettings } = await import('@/db/schema')
const { NOTIFICATIONS_READ_THROUGH_KEY } = await import('@/features/notifications/schema')
const { createApp } = await import('@/app')

const app = createApp()
const facts: Record<string, unknown> = {}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

type Item = Record<string, unknown> & {
  source: 'session' | 'suggestion'
  id: string
  at: string
  unread: boolean
}
type Feed = { items: Item[]; hasUnread: boolean; truncated: boolean }
type Res = { status: number; body: any; contentType: string | null }

async function send(path: string, init: RequestInit = {}): Promise<Res> {
  const res = await app.request(path, init)
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body, contentType: res.headers.get('content-type') }
}

const json = (method: string, path: string, body: unknown) =>
  send(path, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const getFeed = async (): Promise<Feed> => (await send('/api/notifications')).body as Feed
const postRead = async (upTo: string) => json('POST', '/api/notifications/read', { upTo })

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

async function newSession(projectId: string, values: Partial<typeof sessions.$inferInsert> = {}) {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, orchestrator: 'orchestrator', status: 'completed', ...values })
    .returning()
  if (!row) throw new Error('no session row')
  return row
}

async function newSuggestion(values: Partial<typeof librarySuggestions.$inferInsert> = {}) {
  const [row] = await db
    .insert(librarySuggestions)
    .values({
      kind: 'agent',
      action: 'modify',
      name: `s-${randomUUID().slice(0, 8)}`,
      title: 'Untitled suggestion',
      rationale: 'r',
      proposed: {},
      status: 'pending',
      ...values,
    })
    .returning()
  if (!row) throw new Error('no suggestion row')
  return row
}

async function storedRow(): Promise<{ value: unknown; updatedAt: string } | null> {
  const rows = (await db.execute(
    sql`select value, updated_at::text as "updatedAt" from system_settings where key = ${NOTIFICATIONS_READ_THROUGH_KEY}`,
  )) as unknown as { value: unknown; updatedAt: string }[]
  return rows[0] ?? null
}

async function resetAll(): Promise<void> {
  await db.delete(sessions)
  await db.delete(librarySuggestions)
  await db.delete(projects)
  await db.delete(systemSettings).where(eq(systemSettings.key, NOTIFICATIONS_READ_THROUGH_KEY))
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))])
}

async function main() {
  // --- A. item shape: exact keys and values per source ---------------------
  {
    await resetAll()
    const projectId = await newProject('Shape')
    const settledAt = new Date(Date.now() - 2 * HOUR)
    const s = await newSession(projectId, { title: 'Fix the login bug', status: 'failed', settledAt })
    const untitled = await newSession(projectId, { title: null, status: 'interrupted', settledAt: new Date(Date.now() - 3 * HOUR) })
    const g = await newSuggestion({ kind: 'skill', action: 'create', name: 'deploy-helper', title: 'Add a deploy skill' })
    const feed = await getFeed()
    const si = feed.items.find((i) => i.id === s.id)
    const ui = feed.items.find((i) => i.id === untitled.id)
    const gi = feed.items.find((i) => i.id === g.id)
    facts.shape = {
      sessionKeys: si && Object.keys(si).sort(),
      suggestionKeys: gi && Object.keys(gi).sort(),
      session: si,
      untitled: ui,
      suggestion: gi,
      expectedSession: {
        source: 'session',
        id: s.id,
        at: settledAt.toISOString(),
        unread: true,
        projectId,
        projectName: 'Shape',
        title: 'Fix the login bug',
        status: 'failed',
      },
      expectedSuggestion: {
        source: 'suggestion',
        id: g.id,
        at: g.createdAt.toISOString(),
        unread: true,
        kind: 'skill',
        action: 'create',
        name: 'deploy-helper',
        title: 'Add a deploy skill',
      },
      topLevelKeys: Object.keys(feed).sort(),
    }
  }

  // --- B. settled -> seen -> settled again comes back, unread ----------------
  {
    await resetAll()
    const projectId = await newProject('Resettle')
    const s = await newSession(projectId, { settledAt: new Date(Date.now() - 10 * MIN) })
    const first = await getFeed()
    const read = await postRead(first.items[0]!.at)
    const seen = await send(`/api/sessions/${s.id}/seen`, { method: 'POST' })
    const afterSeen = await getFeed()
    // A new turn settles: settled_at moves to now, past both seen_at and the
    // watermark.
    await db.update(sessions).set({ settledAt: new Date(Date.now() + 1000) }).where(eq(sessions.id, s.id))
    const afterResettle = await getFeed()
    const item = afterResettle.items.find((i) => i.id === s.id)
    const overview = (await send('/api/sessions/overview?window=7d')).body as { unchecked: { id: string }[] }
    facts.resettle = {
      readStatus: read.status,
      readHasUnread: read.body.hasUnread,
      seenStatus: seen.status,
      inFeedAfterSeen: afterSeen.items.some((i) => i.id === s.id),
      inFeedAfterResettle: item !== undefined,
      unreadAfterResettle: item?.unread,
      hasUnreadAfterResettle: afterResettle.hasUnread,
      inOverviewUnchecked: overview.unchecked.some((d) => d.id === s.id),
    }
  }

  // --- C. a session in a deleted project is not listed ----------------------
  {
    await resetAll()
    const keep = await newProject('Keep')
    const doomed = await newProject('Doomed')
    const kept = await newSession(keep, { settledAt: new Date(Date.now() - 2 * HOUR) })
    const gone = await newSession(doomed, { settledAt: new Date(Date.now() - HOUR) })
    const before = await getFeed()
    const del = await send(`/api/projects/${doomed}`, { method: 'DELETE' })
    const after = await getFeed()
    facts.deletedProject = {
      before: before.items.map((i) => i.id),
      deleteStatus: del.status,
      after: after.items.map((i) => i.id),
      keptId: kept.id,
      goneId: gone.id,
      getStatusAfter: (await send('/api/notifications')).status,
    }
  }

  // --- D. far-future clamp, then a session settled at now() is unread ------
  {
    await resetAll()
    const projectId = await newProject('Clamp')
    const old = await newSession(projectId, { settledAt: new Date(Date.now() - 5 * MIN) })
    const oldSugg = await newSuggestion({ createdAt: new Date(Date.now() - 10 * MIN) })
    const post = await postRead(new Date(Date.now() + 10 * 365 * DAY).toISOString())
    const stored = await storedRow()
    await Bun.sleep(5)
    const fresh = await newSession(projectId, { settledAt: new Date() })
    const freshSugg = await newSuggestion() // default now() createdAt
    const after = await getFeed()
    facts.futureClampThenNow = {
      postStatus: post.status,
      postHasUnread: post.body.hasUnread,
      stored: stored?.value,
      expectedStored: { readThrough: old.settledAt!.toISOString() },
      oldUnread: after.items.find((i) => i.id === old.id)?.unread,
      oldSuggUnread: after.items.find((i) => i.id === oldSugg.id)?.unread,
      freshUnread: after.items.find((i) => i.id === fresh.id)?.unread,
      freshSuggUnread: after.items.find((i) => i.id === freshSugg.id)?.unread,
      hasUnread: after.hasUnread,
    }
  }

  // --- E. concurrent POSTs end at the max -----------------------------------
  {
    await resetAll()
    const projectId = await newProject('Concurrent')
    const base = Date.now() - HOUR
    const ats: string[] = []
    for (let i = 0; i < 8; i++) {
      const s = await newSession(projectId, { settledAt: new Date(base + i * 1000) })
      ats.push(s.settledAt!.toISOString())
    }
    const max = ats[ats.length - 1]!
    const rounds: { stored: unknown; statuses: number[] }[] = []
    for (let round = 0; round < 6; round++) {
      await db.delete(systemSettings).where(eq(systemSettings.key, NOTIFICATIONS_READ_THROUGH_KEY))
      // Max first in some rounds, last in others, so the write order varies.
      const order = round % 2 === 0 ? [...ats] : [...ats].reverse()
      const results = await withTimeout(Promise.all(order.map((at) => postRead(at))), 15_000)
      rounds.push({
        stored: (await storedRow())?.value,
        statuses: results === 'TIMEOUT' ? [] : results.map((r) => r.status),
      })
    }
    facts.concurrent = { rounds, expected: { readThrough: max } }
  }

  // --- E2. concurrent POSTs beyond the DB pool size (max 10) ----------------
  // Run last-but-one; if it wedges the pool, later scenarios would hang, so
  // only the envelope checks (which never touch the DB on a 400) follow it.

  // --- F. millisecond boundary --------------------------------------------
  {
    await resetAll()
    const projectId = await newProject('Boundary')
    const T = new Date(Date.now() - HOUR)
    const atT = await newSession(projectId, { settledAt: T })
    const atT1 = await newSession(projectId, { settledAt: new Date(T.getTime() + 1) })
    // Same millisecond as T but with 999 extra microseconds, written raw.
    const sub = await newSession(projectId, { settledAt: T })
    await db.execute(
      sql`update sessions set settled_at = settled_at + interval '999 microseconds' where id = ${sub.id}`,
    )
    const post = await postRead(T.toISOString())
    const feed = await getFeed()
    facts.msBoundary = {
      postStatus: post.status,
      stored: (await storedRow())?.value,
      expectedStored: { readThrough: T.toISOString() },
      atTUnread: feed.items.find((i) => i.id === atT.id)?.unread,
      atT1Unread: feed.items.find((i) => i.id === atT1.id)?.unread,
      subMsAt: feed.items.find((i) => i.id === sub.id)?.at,
      subMsUnread: feed.items.find((i) => i.id === sub.id)?.unread,
      expectedSubMsAt: T.toISOString(),
      hasUnread: feed.hasUnread,
    }
  }

  // --- G. never backwards when the newest item disappears -------------------
  {
    await resetAll()
    const projectId = await newProject('Backwards')
    const older = await newSession(projectId, { settledAt: new Date(Date.now() - 2 * HOUR) })
    const newer = await newSession(projectId, { settledAt: new Date(Date.now() - HOUR) })
    await postRead(newer.settledAt!.toISOString())
    const storedAfterFirst = (await storedRow())?.value
    await send(`/api/sessions/${newer.id}/seen`, { method: 'POST' })
    // Now the feed's newest is `older`; a client that last saw `older` posts it.
    const second = await postRead(older.settledAt!.toISOString())
    facts.neverBackwards = {
      storedAfterFirst,
      storedAfterSecond: (await storedRow())?.value,
      secondHasUnread: second.body.hasUnread,
      items: second.body.items.map((i: Item) => i.id),
      olderId: older.id,
    }
  }

  // --- H. empty feed with an existing watermark: POST writes nothing --------
  {
    await resetAll()
    const projectId = await newProject('Empty')
    const s = await newSession(projectId, { settledAt: new Date(Date.now() - HOUR) })
    await postRead(s.settledAt!.toISOString())
    const before = await storedRow()
    await send(`/api/sessions/${s.id}/seen`, { method: 'POST' })
    await Bun.sleep(20)
    const post = await postRead(new Date(Date.now() + DAY).toISOString())
    const after = await storedRow()
    facts.emptyWithWatermark = {
      postStatus: post.status,
      postBody: post.body,
      before,
      after,
    }
  }

  // --- I. cap at exactly 50 / 51, merged across both sources ---------------
  {
    await resetAll()
    const projectId = await newProject('Cap')
    const now = Date.now()
    const sessionRows: (typeof sessions.$inferInsert)[] = []
    const suggRows: (typeof librarySuggestions.$inferInsert)[] = []
    // 25 + 25 interleaved: sessions on even seconds, suggestions on odd ones.
    for (let i = 0; i < 25; i++) {
      sessionRows.push({ projectId, status: 'completed', settledAt: new Date(now - (2 * i + 1) * 1000) })
      suggRows.push({
        kind: 'agent',
        action: 'modify',
        name: `cap-${i}`,
        title: 't',
        rationale: 'r',
        proposed: {},
        createdAt: new Date(now - (2 * i + 2) * 1000),
      })
    }
    await db.insert(sessions).values(sessionRows)
    await db.insert(librarySuggestions).values(suggRows)
    const exactly50 = await getFeed()

    // One more, oldest of all: 51 total, the oldest one is dropped.
    const oldest = await newSuggestion({ createdAt: new Date(now - DAY) })
    const fiftyOne = await getFeed()
    // And one newest-of-all suggestion: it must appear at the top, displacing
    // the oldest session.
    const newest = await newSuggestion({ createdAt: new Date(now + 1000) })
    const fiftyTwo = await getFeed()

    const isSortedDesc = (items: Item[]) =>
      items.every((it, i) => i === 0 || items[i - 1]!.at >= it.at)

    facts.cap = {
      exactly50: { count: exactly50.items.length, truncated: exactly50.truncated, sorted: isSortedDesc(exactly50.items) },
      fiftyOne: {
        count: fiftyOne.items.length,
        truncated: fiftyOne.truncated,
        hasOldest: fiftyOne.items.some((i) => i.id === oldest.id),
      },
      fiftyTwo: {
        count: fiftyTwo.items.length,
        truncated: fiftyTwo.truncated,
        topId: fiftyTwo.items[0]?.id,
        sorted: isSortedDesc(fiftyTwo.items),
        sources: [...new Set(fiftyTwo.items.map((i) => i.source))].sort(),
      },
      newestId: newest.id,
    }
  }

  // --- J. partial unread; POST response equals the next GET; non-UTC offset -
  {
    await resetAll()
    const projectId = await newProject('Partial')
    const a = await newSession(projectId, { settledAt: new Date(Date.now() - 3 * HOUR) })
    const b = await newSuggestion({ createdAt: new Date(Date.now() - 2 * HOUR) })
    const c = await newSession(projectId, { settledAt: new Date(Date.now() - HOUR) })
    // b's instant, spelled in +05:30.
    const bMs = b.createdAt.getTime()
    const local = new Date(bMs + 5.5 * HOUR).toISOString().replace('Z', '+05:30')
    const post = await postRead(local)
    const get = await getFeed()
    facts.partial = {
      postStatus: post.status,
      upToSent: local,
      stored: (await storedRow())?.value,
      expectedStored: { readThrough: b.createdAt.toISOString() },
      unreadById: Object.fromEntries(get.items.map((i) => [i.id, i.unread])),
      ids: { a: a.id, b: b.id, c: c.id },
      hasUnread: get.hasUnread,
      postEqualsGet: JSON.stringify(post.body) === JSON.stringify(get),
    }
  }

  // --- K. mark-read never touches seen_at / status / updated_at -------------
  {
    await resetAll()
    const projectId = await newProject('Untouched')
    const s = await newSession(projectId, { settledAt: new Date(Date.now() - HOUR) })
    const g = await newSuggestion()
    const before = {
      s: (await db.select().from(sessions).where(eq(sessions.id, s.id)))[0],
      g: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.id, g.id)))[0],
    }
    await postRead(new Date().toISOString())
    const after = {
      s: (await db.select().from(sessions).where(eq(sessions.id, s.id)))[0],
      g: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.id, g.id)))[0],
    }
    facts.untouched = {
      sessionRowEqual: JSON.stringify(before.s) === JSON.stringify(after.s),
      suggestionRowEqual: JSON.stringify(before.g) === JSON.stringify(after.g),
      seenAt: after.s?.seenAt ?? null,
      suggStatus: after.g?.status,
    }
  }

  // --- L. exact 400 envelopes -----------------------------------------------
  {
    await resetAll()
    const projectId = await newProject('Envelope')
    await newSession(projectId, { settledAt: new Date(Date.now() - HOUR) })
    const cases: Record<string, Res> = {
      noBody: await send('/api/notifications/read', { method: 'POST' }),
      emptyObject: await json('POST', '/api/notifications/read', {}),
      numberUpTo: await json('POST', '/api/notifications/read', { upTo: 1_700_000_000_000 }),
      nullUpTo: await json('POST', '/api/notifications/read', { upTo: null }),
      emptyString: await json('POST', '/api/notifications/read', { upTo: '' }),
      dateOnly: await json('POST', '/api/notifications/read', { upTo: '2026-01-01' }),
      malformedJson: await send('/api/notifications/read', {
        method: 'POST',
        body: '{"upTo":',
        headers: { 'content-type': 'application/json' },
      }),
      textPlain: await send('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ upTo: new Date().toISOString() }),
        headers: { 'content-type': 'text/plain' },
      }),
    }
    facts.envelope = {
      cases: Object.fromEntries(
        Object.entries(cases).map(([k, v]) => [k, { status: v.status, body: v.body, contentType: v.contentType }]),
      ),
      storedAfter: await storedRow(),
    }
  }

  // --- E2 (continued). 25 concurrent POSTs, more than the pool's max of 10 --
  {
    await resetAll()
    const projectId = await newProject('Pool')
    const ats: string[] = []
    for (let i = 0; i < 25; i++) {
      const s = await newSession(projectId, { settledAt: new Date(Date.now() - HOUR + i * 1000) })
      ats.push(s.settledAt!.toISOString())
    }
    const started = Date.now()
    const results = await withTimeout(Promise.all(ats.map((at) => postRead(at))), 20_000)
    const elapsedMs = Date.now() - started
    const afterGet = await withTimeout(send('/api/notifications'), 5_000)
    facts.poolConcurrency = {
      timedOut: results === 'TIMEOUT',
      elapsedMs,
      statuses: results === 'TIMEOUT' ? [] : results.map((r) => r.status),
      getAfterTimedOut: afterGet === 'TIMEOUT',
      stored: afterGet === 'TIMEOUT' ? 'unknown' : (await withTimeout(storedRow(), 5_000)),
      expected: { readThrough: ats[ats.length - 1] },
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await withTimeout(closeDb(), 3000)
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__FACTS__${JSON.stringify({ ...facts, __error: detail })}`)
    await withTimeout(closeDb().catch(() => {}), 3000)
    process.exit(0)
  })
