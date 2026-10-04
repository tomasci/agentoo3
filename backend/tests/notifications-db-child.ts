// Runs every database-backed scenario for the topbar notifications feed once,
// against the throwaway cluster its parent (notifications-db.test.ts)
// started, and prints what happened as JSON — the same child/parent split
// every other *-db.test.ts file in this suite uses (see whats-new-db-child.ts
// and sessions-overview-db-child.ts's own headers for why a child process at
// all: `@/env` parses process.env once, at first import, so DATABASE_URL and
// LIBRARY_DIR have to be right from this process's very first line).
//
// Real: Postgres, the migrations, every route mounted by the real
// createApp() (sessions, library/suggestions, notifications), so route
// ordering and the validation envelope are exactly what a real client gets.
// Faked: BullMQ, ioredis and the Claude Agent SDK, exactly as
// whats-new-db-child.ts fakes them — nothing here drives a turn or touches
// Redis/Anthropic, but createApp() reaches all three through other feature
// routers mounted alongside notificationsRouter.
//
// Fixtures go straight through Drizzle into `sessions`/`library_suggestions`,
// not through sendMessage/createSession or insertSuggestion's own validation
// — this feed only reads rows another feature already owns, so the cheapest
// honest way to seed "a settled, unseen session" or "a pending suggestion" is
// to insert the row directly, the same shortcut sessions-overview-db-child.ts
// takes for its own truth table. The one exception is the apply/reject
// section near the end, which goes through insertSuggestion and the real
// HTTP routes on purpose — that is what proves applying or rejecting a
// suggestion removes it from the feed without this feature reaching into
// library_suggestions itself.

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
const { insertSuggestion } = await import('@/features/learning/suggestions')
const { logger } = await import('@/lib/logger')
const { createApp } = await import('@/app')

const app = createApp()
const facts: Record<string, unknown> = {}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms)

type Res = { status: number; body: Record<string, unknown> }
type Item = {
  source: 'session' | 'suggestion'
  id: string
  at: string
  unread: boolean
  status?: string
}
type Feed = { items: Item[]; hasUnread: boolean; truncated: boolean }

async function request(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed as Record<string, unknown> }
}

/** A raw POST with no body and no content-type at all — `request` above
 * always sets one when a body is given, which is exactly the thing this is
 * for *not* testing (see learning-db-child.ts's identical rawRequest). */
async function rawRequest(method: string, path: string): Promise<Res> {
  const res = await app.request(path, { method })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed as Record<string, unknown> }
}

async function getFeed(): Promise<{ status: number; body: Feed }> {
  const res = await request('GET', '/api/notifications')
  return { status: res.status, body: res.body as unknown as Feed }
}

async function postRead(upTo: string): Promise<{ status: number; body: Feed }> {
  const res = await request('POST', '/api/notifications/read', { upTo })
  return { status: res.status, body: res.body as unknown as Feed }
}

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}`, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

async function newSession(
  projectId: string,
  values: Partial<typeof sessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, orchestrator: 'orchestrator', ...values })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]

const suggestionRow = async (id: string) =>
  (await db.select().from(librarySuggestions).where(eq(librarySuggestions.id, id)).limit(1))[0]

/** A library_suggestions row, inserted directly — bypassing insertSuggestion's
 * own validateProposed, which a feed-membership fixture has no need to
 * satisfy (see this file's own header). */
async function newSuggestion(
  values: Partial<typeof librarySuggestions.$inferInsert> & { name: string },
) {
  const [row] = await db
    .insert(librarySuggestions)
    .values({
      kind: 'agent',
      action: 'modify',
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

async function clearReadThrough(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, NOTIFICATIONS_READ_THROUGH_KEY))
}

async function storedReadThrough(): Promise<unknown> {
  const rows = (await db.execute(
    sql`select value from system_settings where key = ${NOTIFICATIONS_READ_THROUGH_KEY}`,
  )) as unknown as { value: unknown }[]
  return rows.length === 0 ? null : rows[0]?.value
}

/** Writes a raw jsonb literal for the watermark, bypassing the write path's
 * own validation — the only way to get a malformed row into the table at all
 * (mirrors whats-new-db-child.ts's identical writeRaw). */
async function writeRawReadThrough(jsonLiteral: string): Promise<void> {
  await db.execute(
    sql`insert into system_settings (key, value) values (${NOTIFICATIONS_READ_THROUGH_KEY}, ${jsonLiteral}::jsonb)
        on conflict (key) do update set value = excluded.value`,
  )
}

async function readThroughRowCount(): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as n from system_settings where key = ${NOTIFICATIONS_READ_THROUGH_KEY}`,
  )) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/** Every logger.warn emitted while `fn` ran (mirrors whats-new-db-child.ts's
 * identical capturingWarnings). */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const original = logger.warn.bind(logger)
  logger.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }) as typeof logger.warn
  try {
    return { result: await fn(), warnings }
  } finally {
    logger.warn = original
  }
}

async function main() {
  const projectId = await newProject('Alpha')

  // --- 1. empty DB: GET is an empty feed, POST writes nothing ---------------
  {
    const get = await getFeed()
    const post = await postRead(new Date().toISOString())
    facts.empty = {
      get: { status: get.status, body: get.body },
      post: { status: post.status, body: post.body },
      storedAfter: await storedReadThrough(),
    }
  }

  // --- 2. membership: matches /sessions/overview's unchecked and ------------
  //     /library/suggestions?status=pending exactly, across seeded states.
  {
    const ids = {
      seen: await newSession(projectId, {
        status: 'completed',
        settledAt: ago(2 * HOUR),
        seenAt: ago(HOUR),
      }),
      seenBeforeSettled: await newSession(projectId, {
        status: 'completed',
        settledAt: ago(HOUR),
        seenAt: ago(2 * HOUR),
      }),
      runningWithSettledAt: await newSession(projectId, { status: 'running', settledAt: ago(HOUR) }),
      queuedWithSettledAt: await newSession(projectId, { status: 'queued', settledAt: ago(HOUR) }),
      idleUnchecked: await newSession(projectId, { status: 'idle', settledAt: ago(HOUR) }),
      neverSettled: await newSession(projectId, { status: 'completed' }),
    }
    const pending = await newSuggestion({ name: `membership-pending-${randomUUID().slice(0, 8)}` })
    const applied = await newSuggestion({
      name: `membership-applied-${randomUUID().slice(0, 8)}`,
      status: 'applied',
      decidedAt: new Date(),
    })
    const rejected = await newSuggestion({
      name: `membership-rejected-${randomUUID().slice(0, 8)}`,
      status: 'rejected',
      decidedAt: new Date(),
    })

    const feed = await getFeed()
    const overview = (await request('GET', '/api/sessions/overview?window=7d')).body as {
      unchecked: { id: string }[]
    }
    const pendingList = (await request('GET', '/api/library/suggestions?status=pending')).body as {
      id: string
    }[]

    const sessionIds = Object.values(ids)
    const feedSessionIds = new Set(
      feed.body.items.filter((i) => i.source === 'session').map((i) => i.id),
    )
    const overviewUncheckedIds = new Set(overview.unchecked.map((d) => d.id))
    const feedSuggestionIds = new Set(
      feed.body.items.filter((i) => i.source === 'suggestion').map((i) => i.id),
    )
    const pendingListIds = new Set(pendingList.map((s) => s.id))

    const idleItem = feed.body.items.find((i) => i.id === ids.idleUnchecked)

    facts.membership = {
      perSession: Object.fromEntries(
        sessionIds.map((id) => [
          Object.keys(ids).find((k) => ids[k as keyof typeof ids] === id),
          { inFeed: feedSessionIds.has(id), inOverviewUnchecked: overviewUncheckedIds.has(id) },
        ]),
      ),
      suggestions: {
        pending: { inFeed: feedSuggestionIds.has(pending.id), inPendingList: pendingListIds.has(pending.id) },
        applied: { inFeed: feedSuggestionIds.has(applied.id), inPendingList: pendingListIds.has(applied.id) },
        rejected: {
          inFeed: feedSuggestionIds.has(rejected.id),
          inPendingList: pendingListIds.has(rejected.id),
        },
      },
      idleItemStatus: idleItem?.status,
    }
  }

  // --- 3. ordering/tie-break, and `at` matches the source timestamp to -------
  //     the millisecond.
  {
    const T = new Date(Date.now() - 50 * MIN)
    const sessA = await newSession(projectId, { status: 'completed', settledAt: T })
    const sessB = await newSession(projectId, { status: 'completed', settledAt: T })
    const sugg = await newSuggestion({ name: `tie-${randomUUID().slice(0, 8)}`, createdAt: T })

    const sessARow = await sessionRow(sessA)
    const sessBRow = await sessionRow(sessB)
    const suggRow = await suggestionRow(sugg.id)

    const feed = await getFeed()
    const relevant = feed.body.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => [sessA, sessB, sugg.id].includes(item.id))
      .sort((a, b) => a.index - b.index)
      .map(({ item }) => item)

    const expectedSessionOrder = [sessA, sessB].sort()

    facts.ordering = {
      count: relevant.length,
      sources: relevant.map((i) => i.source),
      ids: relevant.map((i) => i.id),
      suggId: sugg.id,
      expectedSessionOrder,
      atMatchesRow: {
        sessA: relevant.find((i) => i.id === sessA)?.at === sessARow?.settledAt?.toISOString(),
        sessB: relevant.find((i) => i.id === sessB)?.at === sessBRow?.settledAt?.toISOString(),
        sugg: relevant.find((i) => i.id === sugg.id)?.at === suggRow?.createdAt.toISOString(),
      },
      atMatchesInput: relevant.every((i) => i.at === T.toISOString()),
    }
  }

  // --- 4. no stored watermark: everything unread; POST items[0].at clears ---
  //     hasUnread, and stores exactly { readThrough }.
  {
    await clearReadThrough()
    const before = await getFeed()
    const newest = before.body.items[0]?.at
    const post = newest === undefined ? undefined : await postRead(newest)
    facts.noStoredRow = {
      beforeAllUnread: before.body.items.length > 0 && before.body.items.every((i) => i.unread),
      itemCount: before.body.items.length,
      postHasUnread: post?.body.hasUnread,
      stored: await storedReadThrough(),
      expectedStored: newest ? { readThrough: newest } : null,
    }
  }

  // --- 5. the microsecond-createdAt precision regression ---------------------
  {
    await clearReadThrough()
    const sugg = await newSuggestion({ name: `precision-${randomUUID().slice(0, 8)}` }) // default createdAt
    const feed = await getFeed()
    const top = feed.body.items[0]
    const post = await postRead(top?.at ?? new Date().toISOString())
    facts.precisionRegression = {
      topIsThisSuggestion: top?.id === sugg.id && top?.source === 'suggestion',
      topAt: top?.at,
      postStatus: post.status,
      postHasUnread: post.body.hasUnread,
    }
  }

  // --- 6. race: GET, insert a newer item, POST the old upTo -> the newer -----
  //     item stays unread.
  {
    await clearReadThrough()
    const before = await getFeed()
    const capturedNewest = before.body.items[0]?.at ?? new Date(0).toISOString()
    const newer = await newSession(projectId, {
      status: 'completed',
      settledAt: new Date(Date.now() + 10 * MIN),
    })
    const post = await postRead(capturedNewest)
    const newerItem = post.body.items.find((i) => i.id === newer)
    facts.race = {
      postHasUnread: post.body.hasUnread,
      newerItemUnread: newerItem?.unread,
      newerInFeed: newerItem !== undefined,
    }
  }

  // --- 7. a future upTo is clamped to the feed's actual newest item ----------
  {
    await clearReadThrough()
    const before = await getFeed()
    const newestBefore = before.body.items[0]?.at
    const farFuture = new Date(Date.now() + 365 * DAY).toISOString()
    const post = await postRead(farFuture)
    const storedAfterClamp = await storedReadThrough()

    const later = await newSession(projectId, {
      status: 'completed',
      settledAt: new Date(Date.now() + 20 * MIN),
    })
    const after = await getFeed()
    const laterItem = after.body.items.find((i) => i.id === later)

    facts.futureClamped = {
      postHasUnread: post.body.hasUnread,
      storedAfterClamp,
      expectedStored: newestBefore ? { readThrough: newestBefore } : null,
      laterItemUnread: laterItem?.unread,
    }
  }

  // --- 8. an older upTo is a no-op; repeating the same upTo is idempotent ---
  {
    await clearReadThrough()
    const before = await getFeed()
    const newest = before.body.items[0]?.at
    if (newest === undefined) throw new Error('expected a non-empty feed at this point')

    const first = await postRead(newest)
    const storedAfterFirst = await storedReadThrough()
    const repeat = await postRead(newest)
    const storedAfterRepeat = await storedReadThrough()
    const rowsAfterRepeat = await readThroughRowCount()

    const olderUpTo = ago(100 * DAY).toISOString()
    const olderPost = await postRead(olderUpTo)
    const storedAfterOlder = await storedReadThrough()

    facts.olderAndIdempotent = {
      firstHasUnread: first.body.hasUnread,
      storedAfterFirst,
      storedAfterRepeat,
      rowsAfterRepeat,
      olderPostStatus: olderPost.status,
      storedAfterOlder,
      unchangedByOlder:
        JSON.stringify(storedAfterFirst) === JSON.stringify(storedAfterOlder),
    }
  }

  // --- 9. POST validation: missing body, non-ISO upTo, offset form accepted -
  {
    await clearReadThrough()
    const before = await getFeed()
    const newest = before.body.items[0]?.at

    const noBody = await rawRequest('POST', '/api/notifications/read')
    const storedAfterNoBody = await storedReadThrough()
    const badDatetime = await request('POST', '/api/notifications/read', { upTo: 'not-a-date' })
    const storedAfterBadDatetime = await storedReadThrough()
    const offsetForm =
      newest === undefined
        ? undefined
        : await request('POST', '/api/notifications/read', {
            // Same instant as `newest`, just spelled with a numeric offset
            // instead of Z — see markNotificationsReadSchema's own comment.
            upTo: new Date(newest).toISOString().replace('Z', '+00:00'),
          })
    const storedAfterOffsetForm = await storedReadThrough()

    facts.validation = {
      noBody: { status: noBody.status, body: noBody.body },
      storedAfterNoBody,
      badDatetime: { status: badDatetime.status, body: badDatetime.body },
      storedAfterBadDatetime,
      offsetForm: offsetForm && { status: offsetForm.status, hasUnread: offsetForm.body.hasUnread },
      storedAfterOffsetForm,
    }
  }

  // --- 10. a malformed stored row is treated as absent (no 500), and is ------
  //      overwritten cleanly by the next POST.
  {
    await clearReadThrough()
    for (const [name, literal] of Object.entries({
      notAnObject: '"not-an-object"',
      missingField: '{}',
      badDatetime: JSON.stringify({ readThrough: 'not-a-date' }),
    })) {
      await writeRawReadThrough(literal)
      const { result, warnings } = await capturingWarnings(() => getFeed())
      facts[`malformed_${name}`] = {
        status: result.status,
        hasItems: result.body.items.length > 0,
        allUnread: result.body.items.every((i) => i.unread),
        warned: warnings.some((w) => w.includes('notifications_read_through')),
      }
    }

    // One more malformed row, this time overwritten by a real POST.
    await writeRawReadThrough('{"readThrough": 12345}')
    const feed = await getFeed()
    const newest = feed.body.items[0]?.at
    const post = newest === undefined ? undefined : await postRead(newest)
    facts.malformedOverwritten = {
      postHasUnread: post?.body.hasUnread,
      stored: await storedReadThrough(),
      expectedStored: newest ? { readThrough: newest } : null,
    }
  }

  // --- 11. seen/apply/reject remove items; mark-read touches neither --------
  {
    const seenFlowSession = await newSession(projectId, {
      status: 'completed',
      settledAt: ago(HOUR),
    })
    const applySugg = await insertSuggestion({
      runId: null,
      kind: 'skill',
      action: 'create',
      name: `notif-apply-${randomUUID().slice(0, 8)}`,
      title: 'Add a notifications test skill',
      rationale: 'r',
      sourceSessionIds: [],
      proposed: { description: 'A test skill', body: 'Step one.' },
      baseMarkdown: null,
    })
    const rejectSugg = await insertSuggestion({
      runId: null,
      kind: 'skill',
      action: 'create',
      name: `notif-reject-${randomUUID().slice(0, 8)}`,
      title: 'A suggestion nobody wanted',
      rationale: 'r',
      sourceSessionIds: [],
      proposed: { description: 'Another test skill', body: 'Step one.' },
      baseMarkdown: null,
    })

    const beforeFeed = await getFeed()
    const beforeIds = new Set(beforeFeed.body.items.map((i) => i.id))

    await clearReadThrough()
    const withNewest = await getFeed()
    const newest = withNewest.body.items[0]?.at
    if (newest === undefined) throw new Error('expected a non-empty feed at this point')
    await postRead(newest)

    const sessionAfterMarkRead = await sessionRow(seenFlowSession)
    const applySuggAfterMarkRead = await suggestionRow(applySugg.id)
    const rejectSuggAfterMarkRead = await suggestionRow(rejectSugg.id)
    const overviewAfterMarkRead = (await request('GET', '/api/sessions/overview?window=7d')).body as {
      unchecked: { id: string }[]
    }

    const seenRes = await request('POST', `/api/sessions/${seenFlowSession}/seen`)
    const applyRes = await request('POST', `/api/library/suggestions/${applySugg.id}/apply`, {
      expectedCurrentHash: null,
    })
    const rejectRes = await request('POST', `/api/library/suggestions/${rejectSugg.id}/reject`)

    const afterFeed = await getFeed()
    const afterIds = new Set(afterFeed.body.items.map((i) => i.id))
    const pendingAfter = (await request('GET', '/api/library/suggestions?status=pending')).body as {
      id: string
    }[]
    const overviewAfterActions = (await request('GET', '/api/sessions/overview?window=7d')).body as {
      unchecked: { id: string }[]
    }

    facts.seenApplyReject = {
      beforeHasAll: [seenFlowSession, applySugg.id, rejectSugg.id].every((id) => beforeIds.has(id)),
      markReadStatus: 200,
      seenAtUntouched: sessionAfterMarkRead?.seenAt === null,
      applyStatusUntouched: applySuggAfterMarkRead?.status === 'pending',
      rejectStatusUntouched: rejectSuggAfterMarkRead?.status === 'pending',
      stillUncheckedAfterMarkRead: overviewAfterMarkRead.unchecked.some((d) => d.id === seenFlowSession),
      seenRouteStatus: seenRes.status,
      applyRouteStatus: applyRes.status,
      rejectRouteStatus: rejectRes.status,
      afterHasNone: [seenFlowSession, applySugg.id, rejectSugg.id].every((id) => !afterIds.has(id)),
      noLongerUnchecked: !overviewAfterActions.unchecked.some((d) => d.id === seenFlowSession),
      noLongerPending: ![applySugg.id, rejectSugg.id].some((id) =>
        pendingAfter.some((s) => s.id === id),
      ),
    }
  }

  // --- 12. the 50-item cap and `truncated` ------------------------------------
  {
    await clearReadThrough()
    const now = Date.now()
    const bulk: (typeof sessions.$inferInsert)[] = []
    for (let i = 0; i < 60; i++) {
      bulk.push({
        projectId,
        status: 'completed',
        settledAt: new Date(now - (i + 1) * 1000),
      })
    }
    await db.insert(sessions).values(bulk)

    const feed = await getFeed()
    const newest = feed.body.items[0]?.at
    const post = newest === undefined ? undefined : await postRead(newest)

    facts.truncation = {
      itemCount: feed.body.items.length,
      truncated: feed.body.truncated,
      postHasUnread: post?.body.hasUnread,
    }
  }

  // --- 13. the OpenAPI document carries both routes ---------------------------
  {
    const doc = await request('GET', '/api/openapi.json')
    const paths = (doc.body as { paths?: Record<string, Record<string, unknown>> }).paths ?? {}
    facts.openapi = {
      status: doc.status,
      hasGet: 'get' in (paths['/api/notifications'] ?? {}),
      hasPost: 'post' in (paths['/api/notifications/read'] ?? {}),
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
