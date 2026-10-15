// Gathers every database-backed fact for sessions-last-message.test.ts, once,
// against the throwaway cluster its parent started, and prints them as JSON —
// the same child/parent split as sessions-overview-db-child.ts: the child
// builds fixtures and records what the API answered; every assertion lives in
// the parent.
//
// Real: Postgres, the migrations, every sessions route through the real
// createApp(), and sendMessage (for a genuinely pending prompt). Faked: the
// SDK, BullMQ, ioredis and the event bus — nothing here runs a turn or needs
// Redis.
//
// Message rows are inserted directly with explicit created_at values, so the
// expected `lastMessageAt` and list order are exact rather than "roughly now".

import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { assertDisposableTestDb } from './disposable-db-guard'

// Before anything below can reach DATABASE_URL: refuse to run unless it is a
// throwaway cluster from pg-cluster.ts (see disposable-db-guard.ts).
await assertDisposableTestDb()

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {})(),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
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

const B = new URL('../src', import.meta.url).pathname

const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async () => {},
  subscribeControl: () => () => {},
}))

mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  optionsFor: async () => ({ cwd: tmpdir() }),
}))

const { and, desc, eq } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { messages, projects, sessions } = await import('@/db/schema')
const { sendMessage } = await import('@/features/sessions/service')
const { projectRepo } = await import('@/lib/paths')
const { createApp } = await import('@/app')

const app = createApp()
const facts: Record<string, unknown> = {}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** One fixed reference instant for the whole run, so equal offsets are equal. */
const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

type Dto = {
  id: string
  title: string | null
  lastMessageAt?: string | null
  messageCount: number
  pendingPrompts: number
  createdAt: string
  updatedAt: string
}
type Overview = { running: Dto[]; unchecked: Dto[]; recent: Dto[] }

async function http(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, body: json }
}

async function newProject(name: string) {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  await mkdir(projectRepo(slug), { recursive: true })
  return row.id
}

async function newSession(
  projectId: string,
  title: string,
  values: Partial<typeof sessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({
      projectId,
      title,
      orchestrator: 'orchestrator',
      worktreePath: `/tmp/agentoo-last-message-wt-${randomUUID()}`,
      ...values,
    })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

/** Inserts message rows at the given times, seq in array order, and keeps the
 *  session's nextSeq ahead of them so a later sendMessage cannot collide. */
async function addMessages(
  sessionId: string,
  rows: { at: Date; type?: string; pending?: boolean }[],
) {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
  let seq = s?.nextSeq ?? 0
  for (const r of rows) {
    await db.insert(messages).values({
      sessionId,
      seq: seq++,
      type: r.type ?? 'assistant',
      pending: r.pending ?? false,
      payload: { text: 'x' },
      createdAt: r.at,
    })
  }
  await db.update(sessions).set({ nextSeq: seq }).where(eq(sessions.id, sessionId))
}

const getDto = async (id: string) => {
  const res = await http('GET', `/sessions/${id}`)
  if (res.status !== 200) throw new Error(`GET /sessions/${id} -> ${res.status}`)
  return res.body as Dto
}
const list = async (projectId: string) => {
  const res = await http('GET', `/projects/${projectId}/sessions`)
  if (res.status !== 200) throw new Error(`GET list -> ${res.status}`)
  return res.body as Dto[]
}
/** Titles in list order, and each title's lastMessageAt. */
const listFacts = async (projectId: string) => {
  const l = await list(projectId)
  return {
    order: l.map((d) => d.title),
    lastMessageAt: Object.fromEntries(
      l.map((d) => [d.title, 'lastMessageAt' in d ? d.lastMessageAt : 'MISSING']),
    ),
    hasKey: l.every((d) => 'lastMessageAt' in d),
  }
}

async function main() {
  // --- the value itself, on GET /sessions/{id} --------------------------------
  {
    const p = await newProject('Values')
    const none = await newSession(p, 'none')
    const mixed = await newSession(p, 'mixed')
    // Every kind of row counts; the newest by created_at wins.
    await addMessages(mixed, [
      { at: ago(5 * HOUR), type: 'prompt' },
      { at: ago(4 * HOUR), type: 'assistant' },
      { at: ago(3 * HOUR), type: 'user' },
      { at: ago(2 * HOUR), type: 'result' },
    ])
    // The newest row by time has the *lowest* seq — max(created_at), not max(seq).
    const outOfSeq = await newSession(p, 'outOfSeq')
    await addMessages(outOfSeq, [
      { at: ago(1 * HOUR), type: 'system' },
      { at: ago(6 * HOUR), type: 'assistant' },
    ])
    // A neighbour's newer message must not leak into this one.
    const neighbour = await newSession(p, 'neighbour')
    await addMessages(neighbour, [{ at: ago(1 * MIN) }])

    // A real queued prompt behind a running turn: sendMessage leaves it pending.
    const pending = await newSession(p, 'pending', { status: 'running' })
    await addMessages(pending, [{ at: ago(2 * DAY) }, { at: ago(DAY) }])
    const sent = await sendMessage(pending, 'queued behind the running turn')
    const [pendingRow] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, pending), eq(messages.pending, true)))
      .orderBy(desc(messages.createdAt))
    const pendingNewest = (
      await db
        .select({ at: messages.createdAt })
        .from(messages)
        .where(eq(messages.sessionId, pending))
        .orderBy(desc(messages.createdAt))
        .limit(1)
    )[0]

    const n = await getDto(none)
    const m = await getDto(mixed)
    const o = await getDto(outOfSeq)
    const pd = await getDto(pending)
    facts.values = {
      none: { hasKey: 'lastMessageAt' in n, lastMessageAt: n.lastMessageAt, count: n.messageCount },
      mixed: {
        lastMessageAt: m.lastMessageAt,
        expected: iso(ago(2 * HOUR)),
        count: m.messageCount,
      },
      outOfSeq: { lastMessageAt: o.lastMessageAt, expected: iso(ago(HOUR)) },
      pending: {
        lastMessageAt: pd.lastMessageAt,
        pendingRowCreatedAt: iso(pendingRow?.createdAt),
        newestRowCreatedAt: iso(pendingNewest?.at),
        pendingRowSeq: pendingRow?.seq,
        sentSeq: (sent as { seq: number }).seq,
        pendingPrompts: pd.pendingPrompts,
        count: pd.messageCount,
        isoShape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pd.lastMessageAt ?? ''),
      },
    }
  }

  // --- POST create answers with the field, null -----------------------------------
  {
    const p = await newProject('Create')
    const created = await http('POST', `/projects/${p}/sessions`, {
      title: 'fresh',
      orchestrator: 'orchestrator',
    })
    const body = created.body as Dto
    facts.create = {
      status: created.status,
      hasKey: body && typeof body === 'object' && 'lastMessageAt' in body,
      lastMessageAt: body?.lastMessageAt,
    }
  }

  // --- list order ---------------------------------------------------------------
  {
    const p = await newProject('Order')
    const T4 = ago(4 * HOUR)
    // [title, createdAt, message times]
    const spec: [string, Date, Date[], Partial<typeof sessions.$inferInsert>?][] = [
      ['h-old-no-messages', ago(30 * DAY), []],
      ['g-old-activity-recently-updated', ago(20 * DAY), [ago(10 * DAY)], { updatedAt: ago(MIN) }],
      ['e-T4-created-2d', ago(2 * DAY), [ago(3 * DAY), T4]],
      ['d-T4-created-1d', ago(DAY), [T4]],
      ['f-no-messages-created-T4', T4, []],
      ['c-created-5d-spoke-3h', ago(5 * DAY), [ago(4 * DAY), ago(3 * HOUR)]],
      ['b-created-2h-no-messages', ago(2 * HOUR), []],
      ['a-created-10d-spoke-1h', ago(10 * DAY), [ago(HOUR)]],
    ]
    const ids: Record<string, string> = {}
    for (const [title, createdAt, times, extra] of spec) {
      ids[title] = await newSession(p, title, { createdAt, updatedAt: createdAt, ...extra })
      await addMessages(
        ids[title] as string,
        times.map((at) => ({ at })),
      )
    }

    const before = await listFacts(p)

    // Rename one with messages, one without, and the one at the bottom.
    const renames: Record<string, unknown> = {}
    for (const title of [
      'c-created-5d-spoke-3h',
      'b-created-2h-no-messages',
      'h-old-no-messages',
    ]) {
      const id = ids[title] as string
      const prior = await getDto(id)
      const res = await http('PATCH', `/sessions/${id}`, { title: `${title} (renamed)` })
      const after = res.body as Dto
      await db.update(sessions).set({ title }).where(eq(sessions.id, id)) // keep titles stable for order
      renames[title] = {
        status: res.status,
        patchHasKey: 'lastMessageAt' in after,
        patchLastMessageAt: after.lastMessageAt,
        priorLastMessageAt: prior.lastMessageAt,
        patchTitle: after.title,
        updatedAtBumped: Date.parse(after.updatedAt) > Date.parse(prior.updatedAt),
      }
    }
    // A settings edit, too.
    {
      const id = ids['e-T4-created-2d'] as string
      const prior = await getDto(id)
      const res = await http('PATCH', `/sessions/${id}`, { maxBudgetUsd: 3 })
      const after = res.body as Dto
      renames.budgetEdit = {
        status: res.status,
        patchLastMessageAt: after.lastMessageAt,
        priorLastMessageAt: prior.lastMessageAt,
        updatedAtBumped: Date.parse(after.updatedAt) > Date.parse(prior.updatedAt),
      }
    }
    const afterRename = await listFacts(p)

    // The same value on GET /sessions/{id} as in the list.
    const getMatchesList: Record<string, boolean> = {}
    for (const [title, id] of Object.entries(ids)) {
      getMatchesList[title] = (await getDto(id)).lastMessageAt === afterRename.lastMessageAt[title]
    }

    // A prompt queued into the session with no messages moves it to the top.
    const b = ids['b-created-2h-no-messages'] as string
    await sendMessage(b, 'hello')
    const afterSend = await listFacts(p)

    facts.order = {
      before,
      renames,
      afterRename,
      getMatchesList,
      afterSend,
      expected: {
        T4: iso(T4),
        a: iso(ago(HOUR)),
        c: iso(ago(3 * HOUR)),
        g: iso(ago(10 * DAY)),
      },
    }
  }

  // --- the overview's three lists --------------------------------------------------
  {
    const p = await newProject('Overview')
    const running = await newSession(p, 'ov-running', { status: 'running' })
    await addMessages(running, [{ at: ago(5 * MIN) }])
    const unchecked = await newSession(p, 'ov-unchecked', {
      status: 'completed',
      settledAt: ago(HOUR),
    })
    await addMessages(unchecked, [{ at: ago(2 * HOUR) }, { at: ago(HOUR), type: 'result' }])
    const recent = await newSession(p, 'ov-recent', { status: 'idle', updatedAt: ago(10 * MIN) })
    await addMessages(recent, [{ at: ago(20 * MIN) }])
    const recentEmpty = await newSession(p, 'ov-recent-empty', { status: 'idle' })

    const res = await http('GET', '/sessions/overview?window=1d')
    const ov = res.body as Overview
    const pick = (l: Dto[], id: string) => {
      const d = l.find((x) => x.id === id)
      return d ? { hasKey: 'lastMessageAt' in d, lastMessageAt: d.lastMessageAt } : null
    }
    facts.overview = {
      status: res.status,
      running: pick(ov.running, running),
      unchecked: pick(ov.unchecked, unchecked),
      recent: pick(ov.recent, recent),
      recentEmpty: pick(ov.recent, recentEmpty),
      runningInRecent: pick(ov.recent, running),
      everyRowHasKey: [...ov.running, ...ov.unchecked, ...ov.recent].every(
        (d) => 'lastMessageAt' in d,
      ),
      expected: {
        running: iso(ago(5 * MIN)),
        unchecked: iso(ago(HOUR)),
        recent: iso(ago(20 * MIN)),
      },
    }
  }

  // --- the published contract -----------------------------------------------------
  {
    const res = await http('GET', '/openapi.json')
    const doc = res.body as {
      components?: {
        schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>
      }
    }
    const schemas = doc.components?.schemas ?? {}
    const withField = Object.entries(schemas)
      .filter(([, s]) => s.properties && 'lastMessageAt' in s.properties)
      .map(([name, s]) => ({
        name,
        prop: s.properties?.lastMessageAt,
        required: (s.required ?? []).includes('lastMessageAt'),
      }))
    facts.openapi = { status: res.status, withField }
  }
}

main()
  .then(async () => {
    console.log(`__FACTS__${JSON.stringify(facts)}`)
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
