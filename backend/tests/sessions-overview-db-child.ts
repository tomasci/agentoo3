// Runs every database-backed scenario for the System tab's sessions dashboard
// once, against the throwaway cluster its parent (sessions-overview.test.ts)
// started, and prints what happened as JSON — the same child/parent split as
// session-create-db-child.ts and turn-outcome-truth-db-child.ts: the child
// gathers facts, every assertion lives in the parent.
//
// Real: Postgres, the migrations, every sessions route mounted by the real
// createApp() (so route ordering across routers is the production ordering),
// sendMessage, claimTurn/runTurn/setStatus/recover, reconcileStrandedTurns.
// Faked: the SDK's `query` (nothing may reach Anthropic), runner-options
// (shells out to git in a checkout), the event bus and BullMQ (no Redis).

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mock } from 'bun:test'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

// --- fakes, registered before anything imports the modules that use them -----

type Step = SDKMessage | (() => Promise<void> | void)
/** What the next `query()` does: yields messages / runs callbacks in order,
 * then optionally throws. Set per case below. */
let script: { steps: Step[]; throwAfter?: string } = { steps: [] }

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const step of script.steps) {
        if (typeof step === 'function') await step()
        else yield step
      }
      if (script.throwAfter) throw new Error(script.throwAfter)
    })(),
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

/** The control handler runTurn registered for each session, so a case can
 * deliver a real `interrupt` event mid-turn. */
const controlHandlers = new Map<string, (event: { kind: string }) => void>()

const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async () => {},
  subscribeControl: (sessionId: string, handler: (event: { kind: string }) => void) => {
    controlHandlers.set(sessionId, handler)
    return () => controlHandlers.delete(sessionId)
  },
}))

mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  optionsFor: async () => ({ cwd: tmpdir() }),
}))

const { desc, eq, gte, sql } = await import('drizzle-orm')
const { closeDb, db } = await import('@/db/client')
const { messages, projects, sessions } = await import('@/db/schema')
const { sendMessage } = await import('@/features/sessions/service')
const { recover, runTurn } = await import('@/queue/session-run.worker')
const { reconcileStrandedTurns } = await import('@/queue/turn-reconcile.worker')
const { projectRepo } = await import('@/lib/paths')
const { createApp } = await import('@/app')

const app = createApp()
const facts: Record<string, unknown> = {}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms)

type Dto = {
  id: string
  status: string
  settledAt: string | null
  seenAt: string | null
  unchecked: boolean
  updatedAt: string
  projectName?: string
}
type Overview = { running: Dto[]; unchecked: Dto[]; recent: Dto[]; window: string }

// --- fixtures -----------------------------------------------------------------

async function newProject(name: string): Promise<{ id: string; name: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  // createSession needs projectRepo(slug) to exist; a plain dir (not a git
  // repo) makes it share the checkout, which is all these cases need.
  await mkdir(projectRepo(slug), { recursive: true })
  return { id: row.id, name }
}

async function newSession(
  projectId: string,
  values: Partial<typeof sessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({
      projectId,
      orchestrator: 'orchestrator',
      // Non-null, so claimTurn's sibling predicate never blocks one case on
      // another.
      worktreePath: `/tmp/agentoo-overview-wt-${randomUUID()}`,
      ...values,
    })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

const row = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

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

async function getDto(id: string): Promise<Dto> {
  const res = await http('GET', `/sessions/${id}`)
  if (res.status !== 200) throw new Error(`GET /sessions/${id} -> ${res.status}`)
  return res.body as Dto
}

async function overview(query = ''): Promise<Overview> {
  const res = await http('GET', `/sessions/overview${query}`)
  if (res.status !== 200) {
    throw new Error(`GET /sessions/overview${query} -> ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body as Overview
}

/** Only this case's fixture ids, in the order the list returned them. */
const pick = (list: Dto[], ids: string[]) => list.filter((d) => ids.includes(d.id)).map((d) => d.id)

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  server_tool_use: null,
  service_tier: null,
} as unknown as SDKResultMessage['usage']

function success(): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'sdk-session-1',
  }
}

function overBudget(): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'error_max_budget_usd',
    duration_ms: 4200,
    duration_api_ms: 3900,
    is_error: true,
    num_turns: 12,
    stop_reason: null,
    total_cost_usd: 0.42,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: randomUUID(),
    session_id: 'sdk-session-1',
  }
}

/** A real turn: send, claim, run the scripted stream. Returns the wall-clock
 * bracket the turn ran inside, for asserting settledAt landed "now". */
async function turn(sessionId: string, steps: Step[], throwAfter?: string) {
  await sendMessage(sessionId, 'do the thing')
  const afterSend = await row(sessionId)
  script = { steps, throwAfter }
  const before = Date.now()
  await runTurn({ sessionId })
  const after = Date.now()
  return { before, after, afterSend }
}

async function main() {
  const alpha = await newProject('Alpha')
  const beta = await newProject('Beta')
  const gamma = await newProject('Gamma')

  // --- DTO shape on every session endpoint ----------------------------------
  {
    const created = await http('POST', `/projects/${alpha.id}/sessions`, {
      title: 'fresh',
      orchestrator: 'orchestrator',
    })
    const c = created.body as Dto
    const settled = await newSession(alpha.id, {
      status: 'completed',
      settledAt: ago(HOUR),
    })
    const list = await http('GET', `/projects/${alpha.id}/sessions`)
    const listed = (list.body as Dto[]).find((d) => d.id === settled)
    const got = await getDto(settled)
    const patched = await http('PATCH', `/sessions/${settled}`, { title: 'renamed' })
    const p = patched.body as Dto
    const settledRow = await row(settled)
    facts.dtoShape = {
      createStatus: created.status,
      create: { settledAt: c.settledAt, seenAt: c.seenAt, unchecked: c.unchecked },
      createHasKeys: ['settledAt', 'seenAt', 'unchecked'].every((k) => k in c),
      listStatus: list.status,
      list: listed && {
        settledAt: listed.settledAt,
        seenAt: listed.seenAt,
        unchecked: listed.unchecked,
      },
      get: { settledAt: got.settledAt, seenAt: got.seenAt, unchecked: got.unchecked },
      patchStatus: patched.status,
      patch: { settledAt: p.settledAt, seenAt: p.seenAt, unchecked: p.unchecked },
      rowSettledAt: iso(settledRow?.settledAt),
    }
  }

  // --- the unchecked truth table, via GET, list, and the overview -----------
  {
    const t = ago(2 * HOUR)
    const cases: Record<string, Partial<typeof sessions.$inferInsert>> = {
      legacyNeverSettled: { status: 'completed' },
      completedUnseen: { status: 'completed', settledAt: ago(HOUR) },
      failedUnseen: { status: 'failed', settledAt: ago(HOUR) },
      interruptedUnseen: { status: 'interrupted', settledAt: ago(HOUR) },
      idleSettledUnseen: { status: 'idle', settledAt: ago(HOUR) },
      seenBeforeSettled: { status: 'completed', settledAt: ago(HOUR), seenAt: ago(2 * HOUR) },
      seenAfterSettled: { status: 'completed', settledAt: ago(2 * HOUR), seenAt: ago(HOUR) },
      seenEqualsSettled: { status: 'completed', settledAt: t, seenAt: t },
      runningSettledUnseen: { status: 'running', settledAt: ago(HOUR) },
      queuedSettledUnseen: { status: 'queued', settledAt: ago(HOUR) },
      seenNeverSettled: { status: 'completed', seenAt: ago(HOUR) },
    }
    const ids: Record<string, string> = {}
    for (const [name, values] of Object.entries(cases)) ids[name] = await newSession(beta.id, values)
    const list = (await http('GET', `/projects/${beta.id}/sessions`)).body as Dto[]
    const ov = await overview('?window=7d')
    const out: Record<string, unknown> = {}
    for (const [name, id] of Object.entries(ids)) {
      out[name] = {
        get: (await getDto(id)).unchecked,
        list: list.find((d) => d.id === id)?.unchecked,
        inOverviewUnchecked: ov.unchecked.some((d) => d.id === id),
        inOverviewRunning: ov.running.some((d) => d.id === id),
      }
    }
    facts.truthTable = out
  }

  // --- overview: windows, ordering, overlap, projectName --------------------
  {
    const ids = {
      settled40h: await newSession(gamma.id, {
        status: 'completed',
        settledAt: ago(40 * HOUR),
        updatedAt: ago(40 * HOUR),
      }),
      seen5d: await newSession(gamma.id, {
        status: 'completed',
        settledAt: ago(5 * DAY),
        seenAt: ago(5 * DAY - HOUR),
        updatedAt: ago(5 * DAY),
      }),
      settled8d: await newSession(gamma.id, {
        status: 'failed',
        settledAt: ago(8 * DAY),
        updatedAt: ago(8 * DAY),
      }),
      runningOld: await newSession(gamma.id, { status: 'running', updatedAt: ago(10 * DAY) }),
      queuedOld: await newSession(alpha.id, { status: 'queued', updatedAt: ago(9 * DAY) }),
      runningFresh: await newSession(gamma.id, { status: 'running', updatedAt: ago(MIN) }),
      // settledAt order (u2 newer) is the reverse of updatedAt order (u1
      // newer), so only an ORDER BY settled_at gets u2 first.
      u1: await newSession(gamma.id, {
        status: 'completed',
        settledAt: ago(3 * HOUR),
        updatedAt: ago(2 * MIN),
      }),
      u2: await newSession(alpha.id, {
        status: 'completed',
        settledAt: ago(HOUR),
        updatedAt: ago(2 * HOUR),
      }),
    }
    const all = Object.values(ids)
    const windows: Record<string, Overview> = {
      default: await overview(''),
      '1d': await overview('?window=1d'),
      '3d': await overview('?window=3d'),
      '7d': await overview('?window=7d'),
    }
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]))
    const names = (list: Dto[]) => pick(list, all).map((id) => byId[id])
    const out: Record<string, unknown> = {}
    for (const [w, ov] of Object.entries(windows)) {
      const isDesc = (list: Dto[], key: 'updatedAt' | 'settledAt') =>
        list.every((d, i) => i === 0 || String(list[i - 1]?.[key]) >= String(d[key]))
      out[w] = {
        window: ov.window,
        keys: Object.keys(ov).sort(),
        running: names(ov.running),
        unchecked: names(ov.unchecked),
        recent: names(ov.recent),
        runningSortedByUpdatedAt: isDesc(ov.running, 'updatedAt'),
        uncheckedSortedBySettledAt: isDesc(ov.unchecked, 'settledAt'),
        recentSortedByUpdatedAt: isDesc(ov.recent, 'updatedAt'),
        allRunningAreRunningOrQueued: ov.running.every((d) =>
          ['running', 'queued'].includes(d.status),
        ),
        allUncheckedFlagged: ov.unchecked.every((d) => d.unchecked === true),
      }
    }
    const one = windows['7d']
    const item = one?.running.find((d) => d.id === ids.queuedOld)
    const gammaItem = one?.unchecked.find((d) => d.id === ids.u1)
    facts.overview = {
      windows: out,
      projectNames: {
        queuedOld: item?.projectName,
        u1: gammaItem?.projectName,
        u2: one?.unchecked.find((d) => d.id === ids.u2)?.projectName,
      },
      itemHasDtoFields: gammaItem
        ? ['settledAt', 'seenAt', 'unchecked', 'updatedAt', 'status', 'projectName'].every(
            (k) => k in gammaItem,
          )
        : false,
    }
  }

  // --- overview: validation and routing -------------------------------------
  {
    const bad: Record<string, unknown> = {}
    for (const q of ['?window=2d', '?window=', '?window=1D', '?window=30d', '?window=all']) {
      bad[q] = await http('GET', `/sessions/overview${q}`)
    }
    facts.overviewValidation = {
      bad,
      nonUuidSessionId: await http('GET', '/sessions/not-a-uuid'),
      unknownSessionId: await http('GET', `/sessions/${randomUUID()}`),
      overviewStatus: (await http('GET', '/sessions/overview')).status,
    }
  }

  // --- POST /sessions/{id}/seen ----------------------------------------------
  {
    const id = await newSession(alpha.id, {
      status: 'completed',
      settledAt: ago(HOUR),
      updatedAt: ago(30 * MIN),
    })
    const before = await getDto(id)
    const rowBefore = await row(id)
    const inUncheckedBefore = (await overview('?window=7d')).unchecked.some((d) => d.id === id)
    const t0 = Date.now()
    const first = await http('POST', `/sessions/${id}/seen`)
    const t1 = Date.now()
    const rowAfterFirst = await row(id)
    const second = await http('POST', `/sessions/${id}/seen`)
    const rowAfterSecond = await row(id)
    const afterGet = await getDto(id)
    const inUncheckedAfter = (await overview('?window=7d')).unchecked.some((d) => d.id === id)

    const neverSettled = await newSession(alpha.id, { status: 'idle' })
    const seenNever = await http('POST', `/sessions/${neverSettled}/seen`)

    const runningId = await newSession(alpha.id, { status: 'running', settledAt: ago(HOUR) })
    const seenRunning = await http('POST', `/sessions/${runningId}/seen`)

    const f = first.body as Dto
    const s = second.body as Dto
    facts.seen = {
      before: { unchecked: before.unchecked, updatedAt: before.updatedAt },
      inUncheckedBefore,
      firstStatus: first.status,
      first: { unchecked: f.unchecked, seenAt: f.seenAt, updatedAt: f.updatedAt, settledAt: f.settledAt },
      firstSeenAtMs: f.seenAt ? Date.parse(f.seenAt) : null,
      t0,
      t1,
      rowUpdatedAtBefore: iso(rowBefore?.updatedAt),
      rowUpdatedAtAfterFirst: iso(rowAfterFirst?.updatedAt),
      rowUpdatedAtAfterSecond: iso(rowAfterSecond?.updatedAt),
      rowSettledAtAfter: iso(rowAfterSecond?.settledAt),
      rowStatusAfter: rowAfterSecond?.status,
      secondStatus: second.status,
      second: { unchecked: s.unchecked, updatedAt: s.updatedAt },
      afterGet: { unchecked: afterGet.unchecked, updatedAt: afterGet.updatedAt },
      inUncheckedAfter,
      unknown: await http('POST', `/sessions/${randomUUID()}/seen`),
      nonUuid: await http('POST', '/sessions/not-a-uuid/seen'),
      neverSettled: {
        status: seenNever.status,
        unchecked: (seenNever.body as Dto).unchecked,
        settledAt: (seenNever.body as Dto).settledAt,
        seenAtSet: Boolean((seenNever.body as Dto).seenAt),
      },
      running: { status: seenRunning.status, unchecked: (seenRunning.body as Dto).unchecked },
    }
  }

  // --- rule 2: settledAt written by the real worker paths --------------------
  {
    // completed, then seen, then completed again.
    const id = await newSession(alpha.id)
    let mid: Record<string, unknown> = {}
    const first = await turn(id, [
      async () => {
        const r = await row(id)
        const d = await getDto(id)
        mid = { status: r?.status, settledAt: iso(r?.settledAt), unchecked: d.unchecked }
      },
      success(),
    ])
    const afterFirst = await row(id)
    const dtoAfterFirst = await getDto(id)
    const seenRes = await http('POST', `/sessions/${id}/seen`)
    let mid2: Record<string, unknown> = {}
    const second = await turn(id, [
      async () => {
        const r = await row(id)
        const d = await getDto(id)
        mid2 = { status: r?.status, settledAt: iso(r?.settledAt), unchecked: d.unchecked }
      },
      success(),
    ])
    const afterSecond = await row(id)
    const dtoAfterSecond = await getDto(id)
    facts.workerCompleted = {
      afterSendStatus: first.afterSend?.status,
      afterSendSettledAt: iso(first.afterSend?.settledAt),
      mid,
      before: first.before,
      after: first.after,
      status: afterFirst?.status,
      settledAtMs: afterFirst?.settledAt?.getTime() ?? null,
      unchecked: dtoAfterFirst.unchecked,
      seenStatus: seenRes.status,
      seenUnchecked: (seenRes.body as Dto).unchecked,
      seenAtMs: Date.parse(String((seenRes.body as Dto).seenAt)),
      secondAfterSendSettledAt: iso(second.afterSend?.settledAt),
      secondAfterSendStatus: second.afterSend?.status,
      mid2,
      firstSettledAtIso: iso(afterFirst?.settledAt),
      secondBefore: second.before,
      secondAfter: second.after,
      secondStatus: afterSecond?.status,
      secondSettledAtMs: afterSecond?.settledAt?.getTime() ?? null,
      secondUnchecked: dtoAfterSecond.unchecked,
    }
  }
  {
    // failed: the SDK stream throws.
    const id = await newSession(alpha.id)
    const t = await turn(id, [], 'boom: the CLI exited 1')
    const r = await row(id)
    facts.workerFailed = {
      status: r?.status,
      settledAtMs: r?.settledAt?.getTime() ?? null,
      before: t.before,
      after: t.after,
      unchecked: (await getDto(id)).unchecked,
    }
  }
  {
    // failed: over budget (its own setStatus call in the cascade).
    const id = await newSession(alpha.id)
    const t = await turn(id, [overBudget()])
    const r = await row(id)
    facts.workerOverBudget = {
      status: r?.status,
      settledAtMs: r?.settledAt?.getTime() ?? null,
      before: t.before,
      after: t.after,
    }
  }
  {
    // interrupted: a real control event delivered mid-turn.
    const id = await newSession(alpha.id)
    const t = await turn(id, [
      () => {
        const handler = controlHandlers.get(id)
        if (!handler) throw new Error('runTurn registered no control handler')
        handler({ kind: 'interrupt' })
      },
      success(),
    ])
    const r = await row(id)
    facts.workerInterrupted = {
      status: r?.status,
      settledAtMs: r?.settledAt?.getTime() ?? null,
      before: t.before,
      after: t.after,
      unchecked: (await getDto(id)).unchecked,
    }
  }
  {
    // drained -> queued must NOT touch a previous settledAt.
    const old = ago(3 * HOUR)
    const id = await newSession(alpha.id, { status: 'completed', settledAt: old })
    await turn(id, [
      async () => {
        await sendMessage(id, 'another one, sent mid-turn')
      },
      success(),
    ])
    const r = await row(id)
    const dto = await getDto(id)
    facts.workerDrained = {
      old: old.toISOString(),
      status: r?.status,
      settledAt: iso(r?.settledAt),
      unchecked: dto.unchecked,
    }
  }
  {
    // recover(): three continuations (-> queued), then give up (-> failed).
    const old = ago(3 * HOUR)
    const id = await newSession(alpha.id, { status: 'running', settledAt: old })
    const recovery = {
      notice: (a: number, of: number) => `retrying ${a} of ${of}`,
      instruction: 'carry on',
      giveUp: 'gave up',
    }
    const continued: unknown[] = []
    for (let i = 0; i < 3; i++) {
      const outcome = await recover(id, 'orchestrator', recovery)
      const r = await row(id)
      continued.push({ outcome: outcome.outcome, status: r?.status, settledAt: iso(r?.settledAt) })
    }
    const before = Date.now()
    const last = await recover(id, 'orchestrator', recovery)
    const after = Date.now()
    const r = await row(id)
    facts.recover = {
      old: old.toISOString(),
      continued,
      last: last.outcome,
      status: r?.status,
      settledAtMs: r?.settledAt?.getTime() ?? null,
      before,
      after,
    }
  }

  // --- rule 2: the stranded-turn reconciler -----------------------------------
  {
    const old = ago(5 * HOUR)
    const stranded = await newSession(alpha.id, {
      status: 'running',
      settledAt: old,
      heartbeatAt: ago(10 * MIN),
      updatedAt: ago(10 * MIN),
      nextSeq: 1,
    })
    await db.insert(messages).values({
      sessionId: stranded,
      seq: 0,
      type: 'prompt',
      payload: { text: 'hello' },
      turnStartedAt: ago(10 * MIN),
    })
    const healthy = await newSession(alpha.id, {
      status: 'running',
      heartbeatAt: new Date(),
      updatedAt: new Date(),
      nextSeq: 1,
    })
    await db.insert(messages).values({
      sessionId: healthy,
      seq: 0,
      type: 'prompt',
      payload: { text: 'hello' },
      turnStartedAt: ago(MIN),
    })
    const before = Date.now()
    const recovered = await reconcileStrandedTurns()
    const after = Date.now()
    const s = await row(stranded)
    const h = await row(healthy)
    const ov = await overview()
    facts.reconciler = {
      recovered,
      old: old.toISOString(),
      before,
      after,
      stranded: {
        status: s?.status,
        settledAtMs: s?.settledAt?.getTime() ?? null,
        unchecked: (await getDto(stranded)).unchecked,
        inOverviewUnchecked: ov.unchecked.some((d) => d.id === stranded),
      },
      healthy: { status: h?.status, settledAt: iso(h?.settledAt) },
    }
  }

  // --- caps: recent capped at 200, running/unchecked not capped --------------
  {
    const now = Date.now()
    const bulk: (typeof sessions.$inferInsert)[] = []
    for (let i = 0; i < 210; i++) {
      bulk.push({
        projectId: beta.id,
        status: 'running',
        updatedAt: new Date(now - (i + 1) * 1000),
      })
      bulk.push({
        projectId: beta.id,
        status: 'completed',
        settledAt: new Date(now - (i + 1) * 1000 - 500),
        updatedAt: new Date(now - (i + 1) * 1000 - 500),
      })
    }
    await db.insert(sessions).values(bulk)
    const ov = await overview('?window=1d')
    const inWindow = await db
      .select({ id: sessions.id, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(gte(sessions.updatedAt, new Date(Date.now() - DAY)))
      .orderBy(desc(sessions.updatedAt))
    const returned = new Set(ov.recent.map((d) => d.id))
    const minReturned = Math.min(...ov.recent.map((d) => Date.parse(d.updatedAt)))
    const maxLeftOut = Math.max(
      ...inWindow.filter((r) => !returned.has(r.id)).map((r) => r.updatedAt.getTime()),
    )
    // Counted independently of the implementation's own SQL, straight from
    // the spec's definitions.
    const [counts] = await db.execute<{ running: number; unchecked: number }>(sql`
      select
        count(*) filter (where status in ('running', 'queued'))::int as running,
        count(*) filter (
          where settled_at is not null
            and status not in ('running', 'queued')
            and (seen_at is null or seen_at < settled_at)
        )::int as unchecked
      from sessions`)
    facts.caps = {
      inWindowCount: inWindow.length,
      recentLength: ov.recent.length,
      recentUnique: returned.size,
      minReturnedUpdatedAt: minReturned,
      maxLeftOutUpdatedAt: maxLeftOut,
      runningLength: ov.running.length,
      dbRunningCount: counts?.running,
      uncheckedLength: ov.unchecked.length,
      dbUncheckedCount: counts?.unchecked,
      window: ov.window,
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
