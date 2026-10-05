// Runs every HTTP-contract scenario for project automations once, against the
// throwaway cluster its parent (automations-routes.test.ts) started, and
// prints what happened as JSON — the child gathers facts, every assertion
// lives in the parent (same shape as ideas-routes-db-child.ts).
//
// The router is mounted the way app.ts mounts it, under /api with the real
// OpenAPI validation hook. Run history is produced by the real sweep
// (sweepAutomations) firing into real sessions on a real git repo; bullmq,
// ioredis and the pub/sub bridge are faked, as in idea-handoff-db-child.ts.

import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'

const SRC = new URL('../src', import.meta.url).pathname

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

mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { automationRuns, automations, projects, sessions } = await import(`${SRC}/db/schema.ts`)
const { sweepAutomations } = await import(`${SRC}/features/automations/scheduler.ts`)
const { automationsRouter } = await import(`${SRC}/features/automations/routes.ts`)
const { git } = await import(`${SRC}/lib/git.ts`)
const { projectRepo } = await import(`${SRC}/lib/paths.ts`)
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import(`${SRC}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', automationsRouter)

const facts: Record<string, unknown> = {}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json as Record<string, unknown> & unknown[] }
}

async function newProject(name: string): Promise<string> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  const repo = projectRepo(slug)
  const init = await git(['init', '-q', '-b', 'main', repo])
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  const commit = await git(
    ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'first'],
    repo,
  )
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
  return row.id
}

async function scenario(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    facts[name] = await fn()
  } catch (error) {
    facts[name] = {
      thrown: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
  } finally {
    await db.update(automations).set({ paused: true, nextRunAt: null })
  }
}

const valid = {
  name: 'Daily digest',
  prompt: 'Summarise yesterday',
  cron: '0 9 * * *',
  timezone: 'UTC',
  orchestrator: 'coder',
}

async function main() {
  // --- create: every invalid body is a 400 and nothing is stored ------------
  await scenario('createRejects', async () => {
    const projectId = await newProject('rejects')
    const { orchestrator: _omit, ...missingOrchestrator } = valid
    const cases: Record<string, unknown> = {
      sixFieldCron: { ...valid, cron: '0 0 9 * * *' },
      atDaily: { ...valid, cron: '@daily' },
      everyMinute: { ...valid, cron: '* * * * *' },
      twoMinuteApart: { ...valid, cron: '0,1 9 * * *' },
      feb30: { ...valid, cron: '0 0 30 2 *' },
      unknownTimezone: { ...valid, timezone: 'Mars/Phobos' },
      emptyName: { ...valid, name: '' },
      blankName: { ...valid, name: '   ' },
      emptyPrompt: { ...valid, prompt: '' },
      blankPrompt: { ...valid, prompt: '   \n\t' },
      controlCharName: { ...valid, name: 'bad\u0007name' },
      newlineName: { ...valid, name: 'two\nlines' },
      missingOrchestrator,
      blankOrchestrator: { ...valid, orchestrator: '' },
      emptyCron: { ...valid, cron: '' },
    }
    const out: Record<string, unknown> = {}
    for (const [key, body] of Object.entries(cases)) {
      const res = await call('POST', `/projects/${projectId}/automations`, body)
      out[key] = { status: res.status, error: res.body?.error, issues: res.body?.issues }
    }
    const stored = await db.select().from(automations).where(eq(automations.projectId, projectId))
    return { cases: out, storedCount: stored.length }
  })

  // --- create: the accepted shapes ------------------------------------------
  await scenario('createAccepts', async () => {
    const projectId = await newProject('accepts')
    const before = Date.now()
    const every5 = await call('POST', `/projects/${projectId}/automations`, {
      ...valid,
      name: '  Every five  ',
      cron: '*/5 * * * *',
      baseBranch: 'main',
      maxBudgetUsd: 4,
    })
    const after = Date.now()
    const second = await call('POST', `/projects/${projectId}/automations`, {
      ...valid,
      name: 'second',
    })
    const list = await call('GET', `/projects/${projectId}/automations`)
    const e = every5.body as Record<string, unknown>
    const nextMs = typeof e.nextRunAt === 'string' ? Date.parse(e.nextRunAt) : Number.NaN
    return {
      status: every5.status,
      name: e.name,
      cron: e.cron,
      timezone: e.timezone,
      paused: e.paused,
      orchestrator: e.orchestrator,
      baseBranch: e.baseBranch,
      maxBudgetUsd: e.maxBudgetUsd,
      lastRunAt: e.lastRunAt,
      runCount: e.runCount,
      nextRunAtOnFiveMinuteMark: nextMs % (5 * 60_000) === 0,
      nextRunAtAfterRequest: nextMs > before,
      nextRunAtWithinFiveMinutes: nextMs <= after + 5 * 60_000,
      secondStatus: second.status,
      listStatus: list.status,
      listNames: (list.body as { name: string }[]).map((a) => a.name),
    }
  })

  // --- 404s and malformed ids -----------------------------------------------
  await scenario('notFound', async () => {
    const ghost = randomUUID()
    return {
      listUnknownProject: (await call('GET', `/projects/${ghost}/automations`)).status,
      createUnknownProject: (await call('POST', `/projects/${ghost}/automations`, valid)).status,
      getUnknown: (await call('GET', `/automations/${ghost}`)).status,
      patchUnknown: (await call('PATCH', `/automations/${ghost}`, { name: 'x' })).status,
      deleteUnknown: (await call('DELETE', `/automations/${ghost}`)).status,
      runsUnknown: (await call('GET', `/automations/${ghost}/runs`)).status,
      getNotAUuid: (await call('GET', '/automations/not-a-uuid')).status,
      notFoundError: (await call('GET', `/automations/${ghost}`)).body?.error,
    }
  })

  // --- PATCH validation -------------------------------------------------------
  await scenario('patchRejects', async () => {
    const projectId = await newProject('patch-rejects')
    const created = await call('POST', `/projects/${projectId}/automations`, valid)
    const id = (created.body as { id: string }).id
    const cases: Record<string, unknown> = {
      empty: {},
      cronOnlyTooFrequent: { cron: '* * * * *' },
      cronOnlyFeb30: { cron: '0 0 30 2 *' },
      cronOnlySixField: { cron: '0 0 9 * * *' },
      timezoneOnlyUnknown: { timezone: 'Mars/Phobos' },
      pairTooFrequent: { cron: '*/2 * * * *', timezone: 'UTC' },
      emptyName: { name: '' },
      controlCharName: { name: 'x\u0000y' },
      blankPrompt: { prompt: '  ' },
      blankOrchestrator: { orchestrator: '' },
    }
    const out: Record<string, number> = {}
    for (const [key, body] of Object.entries(cases)) {
      out[key] = (await call('PATCH', `/automations/${id}`, body)).status
    }
    const [row] = await db.select().from(automations).where(eq(automations.id, id))
    return {
      statuses: out,
      cronAfter: row?.cron,
      timezoneAfter: row?.timezone,
      nameAfter: row?.name,
      nextRunAtUnchanged:
        row?.nextRunAt?.toISOString() === (created.body as { nextRunAt: string }).nextRunAt,
    }
  })

  // --- schedule preview ---------------------------------------------------------
  await scenario('preview', async () => {
    const tooFrequent = await call('POST', '/automations/schedule-preview', {
      cron: '* * * * *',
      timezone: 'UTC',
    })
    const garbage = await call('POST', '/automations/schedule-preview', {
      cron: 'every day at nine',
      timezone: 'UTC',
    })
    const atDaily = await call('POST', '/automations/schedule-preview', {
      cron: '@daily',
      timezone: 'UTC',
    })
    const before = Date.now()
    const good = await call('POST', '/automations/schedule-preview', {
      cron: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      count: 3,
    })
    const defaultCount = await call('POST', '/automations/schedule-preview', {
      cron: '15 */3 * * *',
      timezone: 'UTC',
    })
    const runs = ((good.body as { nextRuns?: string[] }).nextRuns ?? []) as string[]
    return {
      tooFrequent: { status: tooFrequent.status, body: tooFrequent.body },
      garbage: { status: garbage.status, body: garbage.body },
      atDaily: { status: atDaily.status, body: atDaily.body },
      goodStatus: good.status,
      goodValid: (good.body as { valid?: boolean }).valid,
      goodError: (good.body as { error?: unknown }).error,
      goodRuns: runs,
      goodRunsAreIso: runs.every((r) => new Date(r).toISOString() === r),
      goodRunsAllAt0330Z: runs.every((r) => r.endsWith('T03:30:00.000Z')),
      goodRunsFirstAfterNow: runs.length > 0 && Date.parse(runs[0] as string) > before,
      goodRunsOneDayApart: runs
        .slice(1)
        .map((r, i) => Date.parse(r) - Date.parse(runs[i] as string)),
      defaultCount: ((defaultCount.body as { nextRuns?: string[] }).nextRuns ?? []).length,
    }
  })

  // --- run history: order, limit, session summary, FK SET NULL -------------
  await scenario('runs', async () => {
    const projectId = await newProject('runs')
    const created = await call('POST', `/projects/${projectId}/automations`, {
      ...valid,
      name: 'Hourly',
      cron: '0 * * * *',
    })
    const id = (created.body as { id: string }).id
    await db
      .update(automations)
      .set({ nextRunAt: new Date('2026-03-02T10:00:00Z') })
      .where(eq(automations.id, id))
    for (const at of ['2026-03-02T10:00:05Z', '2026-03-02T11:00:05Z', '2026-03-02T12:00:05Z']) {
      await sweepAutomations(new Date(at))
    }

    const all = await call('GET', `/automations/${id}/runs`)
    const allRuns = all.body as unknown as {
      scheduledFor: string
      status: string
      sessionId: string | null
      prompt: string
      session: Record<string, unknown> | null
    }[]
    const limited = await call('GET', `/automations/${id}/runs?limit=2`)
    const limitZero = await call('GET', `/automations/${id}/runs?limit=0`)
    const limitTooBig = await call('GET', `/automations/${id}/runs?limit=501`)
    const limitNotNumber = await call('GET', `/automations/${id}/runs?limit=abc`)

    // Settle the oldest run's session so its summary has something to show.
    const oldest = allRuns.find((r) => r.scheduledFor === '2026-03-02T10:00:00.000Z')
    const middle = allRuns.find((r) => r.scheduledFor === '2026-03-02T11:00:00.000Z')
    if (oldest?.sessionId) {
      await db
        .update(sessions)
        .set({ status: 'completed', settledAt: new Date(), totalCostUsd: 1.25 })
        .where(eq(sessions.id, oldest.sessionId))
    }
    // Delete the middle run's session outright: the run must survive it.
    if (middle?.sessionId) await db.delete(sessions).where(eq(sessions.id, middle.sessionId))

    const afterChanges = await call('GET', `/automations/${id}/runs`)
    const changedRuns = afterChanges.body as unknown as typeof allRuns
    const dto = await call('GET', `/automations/${id}`)
    const runRows = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, id))

    return {
      allStatus: all.status,
      allScheduledFor: allRuns.map((r) => r.scheduledFor),
      allStatuses: allRuns.map((r) => r.status),
      allPrompts: allRuns.map((r) => r.prompt),
      firstSessionKeys: Object.keys(allRuns[0]?.session ?? {}).sort(),
      firstSession: allRuns[0]?.session,
      firstSessionIdMatches: allRuns[0]?.session?.id === allRuns[0]?.sessionId,
      limitedStatus: limited.status,
      limitedScheduledFor: (limited.body as unknown as { scheduledFor: string }[]).map(
        (r) => r.scheduledFor,
      ),
      limitZero: limitZero.status,
      limitTooBig: limitTooBig.status,
      limitNotNumber: limitNotNumber.status,
      settled: changedRuns.find((r) => r.scheduledFor === '2026-03-02T10:00:00.000Z')?.session,
      deletedSessionRun: changedRuns.find((r) => r.scheduledFor === '2026-03-02T11:00:00.000Z'),
      runCountAfterSessionDelete: changedRuns.length,
      runRowsInDb: runRows.length,
      dtoRunCount: (dto.body as { runCount?: number }).runCount,
      dtoLastRunAt: (dto.body as { lastRunAt?: string }).lastRunAt,
    }
  })

  // --- DELETE ---------------------------------------------------------------
  await scenario('deleteHttp', async () => {
    const projectId = await newProject('delete-http')
    const created = await call('POST', `/projects/${projectId}/automations`, valid)
    const id = (created.body as { id: string }).id
    const del = await call('DELETE', `/automations/${id}`)
    const again = await call('DELETE', `/automations/${id}`)
    const get = await call('GET', `/automations/${id}`)
    const list = await call('GET', `/projects/${projectId}/automations`)
    return {
      deleteStatus: del.status,
      deleteBody: del.body,
      secondDeleteStatus: again.status,
      getStatus: get.status,
      listLength: (list.body as unknown[]).length,
    }
  })

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
