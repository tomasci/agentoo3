// Runs every database-backed automation-sweep scenario once, against the
// throwaway cluster its parent (automations-scheduler.test.ts) started, and
// prints what happened as JSON — same shape as idea-handoff-db-child.ts: the
// child gathers facts, every assertion lives in the parent.
//
// Real Postgres, real createSession/sendMessage and a real git repo per
// project. Faked, exactly as idea-handoff-db-child.ts fakes them: bullmq
// (Queue.add is recorded, never sent; Worker records its processor so the
// sweep worker's wiring can be driven by hand), ioredis, and the pub/sub
// bridge in lib/events.ts.
//
// Every scenario runs on a simulated clock in March 2026 — earlier than the
// real clock — and every scenario quiesces (pauses) every automation it made
// on the way out, so one scenario's leftover next_run_at can never be fired by
// another scenario's sweep. Expected instants are written out by hand, never
// computed with the cron helpers under test.

import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'

const SRC = new URL('../src', import.meta.url).pathname

// --- fakes, registered before anything imports the modules that use them ---

const enqueued: { queue: string; name: string; data: unknown }[] = []
const schedulers: { queue: string; id: string; repeat: unknown }[] = []
const workerProcessors = new Map<string, (job: unknown) => Promise<unknown>>()

mock.module('bullmq', () => ({
  Queue: class {
    constructor(private readonly queueName: string) {}
    async add(name: string, data: unknown) {
      enqueued.push({ queue: this.queueName, name, data })
      return { id: `job-${enqueued.length}` }
    }
    async upsertJobScheduler(id: string, repeat: unknown) {
      schedulers.push({ queue: this.queueName, id, repeat })
    }
    async close() {}
  },
  Worker: class {
    constructor(queueName: string, processor: (job: unknown) => Promise<unknown>) {
      workerProcessors.set(queueName, processor)
    }
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

const { asc, eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { automationRuns, automations, messages, projects, sessions } = await import(
  `${SRC}/db/schema.ts`
)
const { createSession, getSession, listSessions } = await import(
  `${SRC}/features/sessions/service.ts`
)
const { createAutomation, getAutomation, updateAutomation } = await import(
  `${SRC}/features/automations/service.ts`
)
const { sweepAutomations } = await import(`${SRC}/features/automations/scheduler.ts`)
const { automationsRouter } = await import(`${SRC}/features/automations/routes.ts`)
const { startAutomationSweepWorker } = await import(`${SRC}/queue/automation-sweep.worker.ts`)
const { ensureAutomationSweepSchedule, QUEUE_AUTOMATION_SWEEP } = await import(
  `${SRC}/queue/index.ts`
)
const { git } = await import(`${SRC}/lib/git.ts`)
const { projectRepo } = await import(`${SRC}/lib/paths.ts`)
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { default: postgres } = await import('postgres')
const { openApiValidationHook } = await import(`${SRC}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', automationsRouter)

const request = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const facts: Record<string, unknown> = {}

// --- fixtures ----------------------------------------------------------------

const T = (iso: string) => new Date(iso)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/** A real git repo with one commit on `main` and a second branch `develop`. */
async function newProject(
  name: string,
  status: 'ready' | 'cloning' = 'ready',
): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db
    .insert(projects)
    .values({ name, slug, source: 'empty', status })
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
  const branch = await git(['branch', 'develop'], repo)
  if (!branch.ok) throw new Error(`git branch failed: ${branch.stderr}`)
  return { id: row.id, slug }
}

type AutomationInput = Parameters<typeof createAutomation>[1]

/** Created through the real service, then pinned to a simulated due instant. */
async function newAutomation(
  projectId: string,
  input: Partial<AutomationInput> & { cron: string; timezone: string },
  nextRunAt: Date | null,
): Promise<string> {
  const created = await createAutomation(projectId, {
    name: 'auto',
    prompt: 'do the scheduled thing',
    orchestrator: 'coder',
    ...input,
  } as AutomationInput)
  await setNextRunAt(created.id, nextRunAt)
  return created.id
}

async function setNextRunAt(id: string, at: Date | null): Promise<void> {
  await db.update(automations).set({ nextRunAt: at }).where(eq(automations.id, id))
}

const autoRow = async (id: string) =>
  (await db.select().from(automations).where(eq(automations.id, id)).limit(1))[0]
const runsFor = async (automationId: string) =>
  db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.scheduledFor))
const sessionsIn = async (projectId: string) =>
  db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(asc(sessions.createdAt))
const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0]
const messagesOf = async (sessionId: string) =>
  db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.seq))

/** Takes every automation out of the sweep's reach — see this file's header. */
async function quiesce(): Promise<void> {
  await db.update(automations).set({ paused: true, nextRunAt: null })
}

async function scenario(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    facts[name] = await fn()
  } catch (error) {
    facts[name] = {
      thrown: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
  } finally {
    await quiesce()
  }
}

/** Ticks a simulated clock from `from` to `to` (inclusive) every `stepMs`,
 * sweeping at each tick, and reports every run the automation produced. */
async function simulate(
  automationId: string,
  from: Date,
  to: Date,
  stepMs: number,
): Promise<{
  scheduledFor: (string | null)[]
  firedAtTick: string[]
  maxClaimedInOneTick: number
  sweepThrew: string[]
  nextRunAtAfterEachFiring: (string | null)[]
}> {
  let maxClaimed = 0
  const sweepThrew: string[] = []
  const firedAtTick: string[] = []
  const nextRunAtAfterEachFiring: (string | null)[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
    const now = new Date(t)
    try {
      const result = await sweepAutomations(now)
      maxClaimed = Math.max(maxClaimed, result.claimed)
      if (result.claimed > 0) {
        firedAtTick.push(now.toISOString())
        nextRunAtAfterEachFiring.push(iso((await autoRow(automationId))?.nextRunAt))
      }
    } catch (error) {
      sweepThrew.push(`${now.toISOString()}: ${String(error)}`)
    }
  }
  const runs = await runsFor(automationId)
  return {
    scheduledFor: runs.map((r) => iso(r.scheduledFor)),
    firedAtTick,
    maxClaimedInOneTick: maxClaimed,
    sweepThrew,
    nextRunAtAfterEachFiring,
  }
}

/** The next HH:MM UTC wall-clock instant strictly after `after`, by plain
 * arithmetic — an independent oracle for "recomputed from now". */
function nextDailyUtc(after: Date, hour: number, minute: number): string {
  const d = new Date(after)
  d.setUTCHours(hour, minute, 0, 0)
  if (d.getTime() <= after.getTime()) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}

function nextHalfHourUtc(after: Date): string {
  const d = new Date(after)
  d.setUTCMinutes(30, 0, 0)
  if (d.getTime() <= after.getTime()) d.setUTCHours(d.getUTCHours() + 1)
  return d.toISOString()
}

async function main() {
  // --- 1. firing: one due automation, end to end ------------------------------
  await scenario('firing', async () => {
    const project = await newProject('firing')
    const id = await newAutomation(
      project.id,
      {
        name: 'Nightly audit',
        prompt: 'Audit the repository and report findings',
        cron: '0 9 * * *',
        timezone: 'Europe/Berlin',
        orchestrator: 'coder',
        baseBranch: 'develop',
        maxBudgetUsd: 7,
      },
      T('2026-03-02T08:00:00Z'),
    )
    // A session that has nothing to do with any automation, for the null case.
    const manual = await createSession(project.id, { orchestrator: 'coder', title: 'manual' })
    const enqueuedBefore = enqueued.length

    const result = await sweepAutomations(T('2026-03-02T08:00:07Z'))

    const all = await sessionsIn(project.id)
    const created = all.filter((s) => s.id !== manual.id)
    const session = created[0]
    const msgs = session ? await messagesOf(session.id) : []
    const runs = await runsFor(id)
    const run = runs[0]
    const row = await autoRow(id)
    const dto = session ? await getSession(session.id) : undefined
    const listed = await listSessions(project.id)
    const newEnqueues = enqueued.slice(enqueuedBefore)
    return {
      result,
      createdSessionCount: created.length,
      sessionTitle: session?.title,
      sessionOrchestrator: session?.orchestrator,
      sessionMaxBudgetUsd: session?.maxBudgetUsd,
      sessionBaseBranch: session?.baseBranch,
      sessionHasWorktree: Boolean(session?.worktreePath),
      sessionStatus: session?.status,
      messageCount: msgs.length,
      firstMessageType: msgs[0]?.type,
      firstMessageText: (msgs[0]?.payload as { text?: string } | undefined)?.text,
      runCount: runs.length,
      runSessionMatches: run?.sessionId === session?.id && Boolean(run?.sessionId),
      runPromptMessageMatches: Boolean(msgs[0]) && run?.promptMessageId === msgs[0]?.id,
      runScheduledFor: iso(run?.scheduledFor),
      runPrompt: run?.prompt,
      runStatus: run?.status,
      runError: run?.error,
      nextRunAt: iso(row?.nextRunAt),
      lastRunAt: iso(row?.lastRunAt),
      getSessionAutomationId: dto?.automationId,
      listSessionsAutomationId: listed.find((s) => s.id === session?.id)?.automationId,
      manualSessionAutomationId: listed.find((s) => s.id === manual.id)?.automationId,
      automationId: id,
      enqueuedSessionIds: newEnqueues.map((e) => (e.data as { sessionId?: string }).sessionId),
      sessionId: session?.id,
      runCountOnDto: (await getAutomation(id)).runCount,
    }
  })

  // --- 1b. title at local midnight renders 00:00 in the automation's zone ----
  await scenario('midnightTitle', async () => {
    const project = await newProject('midnight')
    const id = await newAutomation(
      project.id,
      { name: 'Midnight', cron: '0 0 * * *', timezone: 'Europe/Berlin' },
      T('2026-03-02T23:00:00Z'),
    )
    await sweepAutomations(T('2026-03-02T23:00:05Z'))
    const [session] = await sessionsIn(project.id)
    return { title: session?.title, runCount: (await runsFor(id)).length }
  })

  // --- 2. always a brand-new session -----------------------------------------
  await scenario('alwaysNew', async () => {
    const project = await newProject('always-new')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC', prompt: 'hourly prompt' },
      T('2026-03-02T10:00:00Z'),
    )

    await sweepAutomations(T('2026-03-02T10:00:05Z'))
    const [s1] = await sessionsIn(project.id)
    if (!s1) throw new Error('first firing created no session')
    const s1StatusAfterFirst = s1.status // left queued: the enqueue is faked
    const s1MessagesAfterFirst = (await messagesOf(s1.id)).length
    const s1NextSeqAfterFirst = s1.nextSeq

    await sweepAutomations(T('2026-03-02T11:00:05Z'))
    const afterSecond = await sessionsIn(project.id)
    const s2 = afterSecond.find((s) => s.id !== s1.id)
    const s1AfterSecond = await sessionRow(s1.id)
    const s1MessagesAfterSecond = (await messagesOf(s1.id)).length

    // Now the newest one is mid-turn: the next firing still must not touch it.
    if (s2) await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, s2.id))
    await sweepAutomations(T('2026-03-02T12:00:05Z'))
    const afterThird = await sessionsIn(project.id)
    const s2AfterThird = s2 ? await sessionRow(s2.id) : undefined
    const s2MessagesAfterThird = s2 ? (await messagesOf(s2.id)).length : -1
    const s1MessagesAfterThird = (await messagesOf(s1.id)).length
    const runs = await runsFor(id)

    return {
      s1StatusAfterFirst,
      s1MessagesAfterFirst,
      sessionCountAfterSecond: afterSecond.length,
      s1StatusAfterSecond: s1AfterSecond?.status,
      s1MessagesAfterSecond,
      s1NextSeqUnchanged: s1AfterSecond?.nextSeq === s1NextSeqAfterFirst,
      sessionCountAfterThird: afterThird.length,
      distinctSessionIds: new Set(afterThird.map((s) => s.id)).size,
      s2StatusAfterThird: s2AfterThird?.status,
      s2MessagesAfterThird,
      s1MessagesAfterThird,
      runCount: runs.length,
      runSessionIdsDistinct: new Set(runs.map((r) => r.sessionId)).size,
      runSessionIdsAllSet: runs.every((r) => r.sessionId !== null),
      runStatuses: runs.map((r) => r.status),
    }
  })

  // --- 3. paused: never fired, still editable, resume never back-fills -------
  await scenario('paused', async () => {
    const project = await newProject('paused')
    const id = await newAutomation(
      project.id,
      { cron: '0 9 * * *', timezone: 'UTC', name: 'Pausable' },
      T('2026-03-02T09:00:00Z'),
    )
    const pausedDto = await updateAutomation(id, { paused: true })

    // Force a past due instant directly, behind the API's back, while paused.
    await setNextRunAt(id, T('2026-03-01T09:00:00Z'))
    const sweepWhilePaused = await sweepAutomations(T('2026-03-05T00:00:00Z'))
    const runsWhilePaused = (await runsFor(id)).length
    const sessionsWhilePaused = (await sessionsIn(project.id)).length
    const rowWhilePaused = await autoRow(id)

    const getStatus = (await request('GET', `/automations/${id}`)).status
    const patchRes = await request('PATCH', `/automations/${id}`, { name: 'Renamed while paused' })
    const patchBody = (await patchRes.json()) as {
      name?: string
      paused?: boolean
      nextRunAt?: string | null
    }
    // Force it into the past once more, then sweep at a much later instant.
    await setNextRunAt(id, T('2026-03-01T09:00:00Z'))
    const secondSweepWhilePaused = await sweepAutomations(T('2026-03-20T00:00:00Z'))
    const runsAfterSecondSweep = (await runsFor(id)).length

    // Resume: next occurrence after the real now, nothing back-filled.
    const before = new Date()
    const resumeRes = await request('PATCH', `/automations/${id}`, { paused: false })
    const after = new Date()
    const resumed = (await resumeRes.json()) as { paused?: boolean; nextRunAt?: string | null }
    const sweepRightAfterResume = await sweepAutomations(new Date())
    const runsAfterResume = (await runsFor(id)).length

    const createdPaused = await createAutomation(project.id, {
      name: 'born paused',
      prompt: 'p',
      cron: '0 9 * * *',
      timezone: 'UTC',
      orchestrator: 'coder',
      paused: true,
    })

    return {
      pauseNextRunAt: pausedDto.nextRunAt,
      pausePaused: pausedDto.paused,
      sweepWhilePaused,
      runsWhilePaused,
      sessionsWhilePaused,
      forcedNextRunAtUntouched: iso(rowWhilePaused?.nextRunAt) === '2026-03-01T09:00:00.000Z',
      getStatus,
      patchStatus: patchRes.status,
      patchName: patchBody.name,
      patchPaused: patchBody.paused,
      patchNextRunAt: patchBody.nextRunAt,
      secondSweepWhilePaused,
      runsAfterSecondSweep,
      resumeStatus: resumeRes.status,
      resumedPaused: resumed.paused,
      resumedNextRunAt: resumed.nextRunAt,
      expectedResumeCandidates: [nextDailyUtc(before, 9, 0), nextDailyUtc(after, 9, 0)],
      sweepRightAfterResume,
      runsAfterResume,
      createdPausedNextRunAt: createdPaused.nextRunAt,
      createdPausedPaused: createdPaused.paused,
    }
  })

  // --- 4. edits apply to the next run; only cron/timezone move next_run_at ---
  await scenario('edits', async () => {
    const project = await newProject('edits')
    const id = await newAutomation(
      project.id,
      {
        cron: '0 * * * *',
        timezone: 'UTC',
        name: 'Old name',
        prompt: 'old prompt',
        orchestrator: 'coder',
      },
      T('2026-03-02T10:00:00Z'),
    )
    await sweepAutomations(T('2026-03-02T10:00:05Z'))
    const afterFirstFire = iso((await autoRow(id))?.nextRunAt)

    const nameDto = await updateAutomation(id, { name: 'New name' })
    const promptDto = await updateAutomation(id, { prompt: 'new prompt' })
    const orchDto = await updateAutomation(id, { orchestrator: 'reviewer' })
    const budgetDto = await updateAutomation(id, { maxBudgetUsd: 3, baseBranch: null })
    const samePairDto = await updateAutomation(id, { cron: '0 * * * *', timezone: 'UTC' })

    await sweepAutomations(T('2026-03-02T11:00:05Z'))
    const runs = await runsFor(id)
    const second = runs.find((r) => iso(r.scheduledFor) === '2026-03-02T11:00:00.000Z')
    const secondSession = second?.sessionId ? await sessionRow(second.sessionId) : undefined
    const secondMsgs = second?.sessionId ? await messagesOf(second.sessionId) : []
    const first = runs.find((r) => iso(r.scheduledFor) === '2026-03-02T10:00:00.000Z')
    const firstSession = first?.sessionId ? await sessionRow(first.sessionId) : undefined

    // Schedule edits recompute from the real clock.
    const beforeCron = new Date()
    const cronDto = await updateAutomation(id, { cron: '30 * * * *' })
    const afterCron = new Date()
    await updateAutomation(id, { cron: '0 9 * * *' })
    const beforeTz = new Date()
    const tzDto = await updateAutomation(id, { timezone: 'Asia/Kolkata' })
    const afterTz = new Date()

    return {
      afterFirstFire,
      nameNextRunAt: nameDto.nextRunAt,
      promptNextRunAt: promptDto.nextRunAt,
      orchNextRunAt: orchDto.nextRunAt,
      budgetNextRunAt: budgetDto.nextRunAt,
      samePairNextRunAt: samePairDto.nextRunAt,
      secondTitle: secondSession?.title,
      secondOrchestrator: secondSession?.orchestrator,
      secondMaxBudgetUsd: secondSession?.maxBudgetUsd,
      secondMessageText: (secondMsgs[0]?.payload as { text?: string } | undefined)?.text,
      secondRunPrompt: second?.prompt,
      firstRunPromptSnapshot: first?.prompt,
      firstSessionTitle: firstSession?.title,
      firstSessionOrchestrator: firstSession?.orchestrator,
      cronNextRunAt: cronDto.nextRunAt,
      cronExpected: [nextHalfHourUtc(beforeCron), nextHalfHourUtc(afterCron)],
      tzNextRunAt: tzDto.nextRunAt,
      // 09:00 in Asia/Kolkata (UTC+05:30, no DST) is 03:30 UTC.
      tzExpected: [nextDailyUtc(beforeTz, 3, 30), nextDailyUtc(afterTz, 3, 30)],
    }
  })

  // --- 5. delete: stops runs, cascades runs, keeps sessions -------------------
  await scenario('deleted', async () => {
    const project = await newProject('deleted')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T10:00:00Z'),
    )
    await sweepAutomations(T('2026-03-02T10:00:05Z'))
    await sweepAutomations(T('2026-03-02T11:00:05Z'))
    const runsBefore = (await runsFor(id)).length
    const sessionIdsBefore = (await sessionsIn(project.id)).map((s) => s.id)

    const del = await request('DELETE', `/automations/${id}`)
    const sweepAfter = await sweepAutomations(T('2026-03-02T12:00:05Z'))
    const sweepLater = await sweepAutomations(T('2026-03-09T12:00:05Z'))
    const sessionIdsAfter = (await sessionsIn(project.id)).map((s) => s.id)
    const runsAfter = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, id))
    const getAfter = await request('GET', `/automations/${id}`)
    return {
      runsBefore,
      sessionsBefore: sessionIdsBefore.length,
      deleteStatus: del.status,
      sweepAfter,
      sweepLater,
      runsAfter: runsAfter.length,
      sessionsAfter: sessionIdsAfter.length,
      sameSessionsKept: sessionIdsBefore.every((s) => sessionIdsAfter.includes(s)),
      getAfterStatus: getAfter.status,
    }
  })

  // --- 6. recurrence over simulated time --------------------------------------
  const MIN = 60_000
  await scenario('hourlyUtc', async () => {
    const project = await newProject('hourly')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T01:00:00Z'),
    )
    // Ticks land exactly on each occurrence (offset 0).
    return simulate(id, T('2026-03-02T00:00:00Z'), T('2026-03-02T06:00:00Z'), 15 * MIN)
  })

  await scenario('every3hNewYork', async () => {
    const project = await newProject('every3h')
    const id = await newAutomation(
      project.id,
      { cron: '15 */3 * * *', timezone: 'America/New_York', name: 'Three-hourly' },
      T('2026-03-02T05:15:00Z'),
    )
    const sim = await simulate(id, T('2026-03-02T05:00:07Z'), T('2026-03-03T03:00:00Z'), 15 * MIN)
    const titles = (await sessionsIn(project.id)).map((s) => s.title)
    return { ...sim, titles }
  })

  await scenario('weekdaysBerlin', async () => {
    const project = await newProject('weekdays')
    const id = await newAutomation(
      project.id,
      { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin', name: 'Weekday' },
      T('2026-03-05T08:00:00Z'),
    )
    const sim = await simulate(id, T('2026-03-05T00:00:07Z'), T('2026-03-10T12:00:00Z'), 15 * MIN)
    const titles = (await sessionsIn(project.id)).map((s) => s.title)
    return { ...sim, titles }
  })

  await scenario('weekendsNewYork', async () => {
    const project = await newProject('weekends')
    const id = await newAutomation(
      project.id,
      { cron: '0 9 * * 0,6', timezone: 'America/New_York', name: 'Weekend' },
      T('2026-03-07T14:00:00Z'),
    )
    const sim = await simulate(id, T('2026-03-05T00:00:07Z'), T('2026-03-16T00:00:00Z'), 15 * MIN)
    const titles = (await sessionsIn(project.id)).map((s) => s.title)
    return { ...sim, titles }
  })

  // --- 7. catch-up: many missed occurrences, one run --------------------------
  await scenario('catchUp', async () => {
    const project = await newProject('catch-up')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-02-27T05:00:00Z'),
    )
    const first = await sweepAutomations(T('2026-03-02T10:20:00Z'))
    const runsAfterFirst = await runsFor(id)
    const rowAfterFirst = await autoRow(id)
    const again = await sweepAutomations(T('2026-03-02T10:20:00Z'))
    const later = await sweepAutomations(T('2026-03-02T10:50:00Z'))
    const runsBeforeNext = (await runsFor(id)).length
    const next = await sweepAutomations(T('2026-03-02T11:00:05Z'))
    const runsAfterNext = await runsFor(id)
    return {
      first,
      runsAfterFirst: runsAfterFirst.length,
      firstScheduledFor: iso(runsAfterFirst[0]?.scheduledFor),
      nextRunAtAfterFirst: iso(rowAfterFirst?.nextRunAt),
      lastRunAtAfterFirst: iso(rowAfterFirst?.lastRunAt),
      againClaimed: again.claimed,
      laterClaimed: later.claimed,
      runsBeforeNext,
      nextClaimed: next.claimed,
      scheduledForAfterNext: runsAfterNext.map((r) => iso(r.scheduledFor)),
      sessions: (await sessionsIn(project.id)).length,
    }
  })

  // --- 8a. concurrent sweeps converge on one run ------------------------------
  await scenario('concurrentSweeps', async () => {
    const project = await newProject('concurrent')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T10:00:00Z'),
    )
    const rounds: Record<string, unknown>[] = []
    for (let h = 10; h < 15; h++) {
      const hh = String(h).padStart(2, '0')
      const now = T(`2026-03-02T${hh}:00:05Z`)
      const results = await Promise.allSettled([
        sweepAutomations(now),
        sweepAutomations(now),
        sweepAutomations(now),
      ])
      const runs = await runsFor(id)
      rounds.push({
        hour: hh,
        rejected: results
          .filter((r) => r.status === 'rejected')
          .map((r) => String((r as PromiseRejectedResult).reason)),
        claimedTotal: results.reduce(
          (n, r) => n + (r.status === 'fulfilled' ? r.value.claimed : 0),
          0,
        ),
        runCount: runs.length,
        sessionCount: (await sessionsIn(project.id)).length,
        nextRunAt: iso((await autoRow(id))?.nextRunAt),
      })
    }
    return { rounds }
  })

  // --- 8b. lost-update regression: a stale next_run_at written back ------------
  await scenario('lostUpdate', async () => {
    const project = await newProject('lost-update')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T10:00:00Z'),
    )
    await sweepAutomations(T('2026-03-02T10:00:05Z'))
    const afterFire = iso((await autoRow(id))?.nextRunAt)

    // A PATCH that read the row before the claim and wrote it back after.
    await setNextRunAt(id, T('2026-03-02T10:00:00Z'))
    let threw = ''
    let result: unknown = null
    try {
      result = await sweepAutomations(T('2026-03-02T10:30:00Z'))
    } catch (error) {
      threw = String(error)
    }
    const runsAfterStale = (await runsFor(id)).length
    const sessionsAfterStale = (await sessionsIn(project.id)).length
    const nextRunAtAfterStale = iso((await autoRow(id))?.nextRunAt)

    // And it is not stuck: the following occurrence still fires.
    const following = await sweepAutomations(T('2026-03-02T11:00:05Z'))
    const runsAfterFollowing = await runsFor(id)
    return {
      afterFire,
      threw,
      result,
      runsAfterStale,
      sessionsAfterStale,
      nextRunAtAfterStale,
      followingClaimed: following.claimed,
      scheduledForAfterFollowing: runsAfterFollowing.map((r) => iso(r.scheduledFor)),
      nextRunAtAfterFollowing: iso((await autoRow(id))?.nextRunAt),
    }
  })

  // --- 8c. a name PATCH right after (and racing) a claim never reverts it ----
  await scenario('patchAfterClaim', async () => {
    const project = await newProject('patch-after-claim')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T10:00:00Z'),
    )
    await sweepAutomations(T('2026-03-02T10:00:05Z'))
    const patchRes = await request('PATCH', `/automations/${id}`, { name: 'renamed after claim' })
    const patchBody = (await patchRes.json()) as { nextRunAt?: string | null }
    const rowAfterPatch = await autoRow(id)

    const races: Record<string, unknown>[] = []
    for (let h = 11; h < 17; h++) {
      const hh = String(h).padStart(2, '0')
      const runsBefore = (await runsFor(id)).length
      await Promise.all([
        sweepAutomations(T(`2026-03-02T${hh}:00:05Z`)),
        updateAutomation(id, { name: `race ${hh}` }),
      ])
      races.push({
        hour: hh,
        newRuns: (await runsFor(id)).length - runsBefore,
        nextRunAt: iso((await autoRow(id))?.nextRunAt),
      })
    }
    return {
      patchStatus: patchRes.status,
      patchNextRunAt: patchBody.nextRunAt,
      rowNextRunAt: iso(rowAfterPatch?.nextRunAt),
      rowName: rowAfterPatch?.name,
      races,
    }
  })

  // --- 8d. the lost-update interleaving, forced deterministically --------------
  //
  // A third connection holds the automation row FOR UPDATE. The sweep reads
  // the candidate and queues its claim UPDATE behind that lock; then a
  // name-only PATCH reads the (still un-advanced) row and queues its own
  // UPDATE behind the sweep's. Releasing the lock makes the claim commit
  // first and the PATCH write second — exactly the window in which writing
  // back the PATCH's stale read of next_run_at would undo the claim.
  await scenario('patchRacesClaim', async () => {
    const project = await newProject('patch-races-claim')
    const id = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC' },
      T('2026-03-02T11:00:00Z'),
    )
    const url = process.env.DATABASE_URL as string
    const holder = postgres(url, { max: 1, onnotice: () => {} })
    const probe = postgres(url, { max: 1, onnotice: () => {} })
    const lockWaiters = async () => {
      const [row] = await probe`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and datname = current_database()`
      return (row?.n as number) ?? 0
    }
    const waitForWaiters = async (n: number) => {
      const deadline = Date.now() + 10_000
      while ((await lockWaiters()) < n) {
        if (Date.now() > deadline) throw new Error(`never saw ${n} lock waiter(s)`)
        await Bun.sleep(10)
      }
    }
    try {
      const reserved = await holder.reserve()
      await reserved`begin`
      await reserved`select id from automations where id = ${id} for update`
      const sweep = sweepAutomations(T('2026-03-02T11:00:05Z'))
      await waitForWaiters(1)
      const patch = updateAutomation(id, { name: 'renamed mid-claim' })
      await waitForWaiters(2)
      await reserved`commit`
      reserved.release()
      const [sweepResult, patchDto] = await Promise.all([sweep, patch])
      const row = await autoRow(id)
      const followUp = await sweepAutomations(T('2026-03-02T11:30:00Z'))
      return {
        sweepClaimed: sweepResult.claimed,
        patchName: patchDto.name,
        rowName: row?.name,
        rowNextRunAt: iso(row?.nextRunAt),
        lastRunAt: iso(row?.lastRunAt),
        runs: (await runsFor(id)).map((r) => iso(r.scheduledFor)),
        followUpClaimed: followUp.claimed,
      }
    } finally {
      await holder.end({ timeout: 5 })
      await probe.end({ timeout: 5 })
    }
  })

  // --- 9a. project not ready / missing base branch; a healthy one still fires -
  await scenario('dispatchFailures', async () => {
    const notReady = await newProject('not-ready', 'cloning')
    const badBranch = await newProject('bad-branch')
    const healthy = await newProject('healthy')
    const due = T('2026-03-02T10:00:00Z')
    const notReadyId = await newAutomation(notReady.id, { cron: '0 * * * *', timezone: 'UTC' }, due)
    const badBranchId = await newAutomation(
      badBranch.id,
      { cron: '0 * * * *', timezone: 'UTC', baseBranch: 'no-such-branch' },
      due,
    )
    const healthyId = await newAutomation(healthy.id, { cron: '0 * * * *', timezone: 'UTC' }, due)

    let threw = ''
    let result: unknown = null
    try {
      result = await sweepAutomations(T('2026-03-02T10:00:05Z'))
    } catch (error) {
      threw = String(error)
    }
    const describe = async (automationId: string, projectId: string) => {
      const runs = await runsFor(automationId)
      const row = await autoRow(automationId)
      return {
        runCount: runs.length,
        status: runs[0]?.status,
        error: runs[0]?.error,
        sessionId: runs[0]?.sessionId,
        nextRunAt: iso(row?.nextRunAt),
        lastRunAt: iso(row?.lastRunAt),
        sessions: (await sessionsIn(projectId)).length,
      }
    }
    const notReadyFacts = await describe(notReadyId, notReady.id)
    const badBranchFacts = await describe(badBranchId, badBranch.id)
    const healthyFacts = await describe(healthyId, healthy.id)
    // Next tick, not due yet: the failed ones are not retried.
    const retry = await sweepAutomations(T('2026-03-02T10:15:05Z'))
    return {
      threw,
      result,
      notReady: notReadyFacts,
      badBranch: badBranchFacts,
      healthy: healthyFacts,
      retryClaimed: retry.claimed,
      notReadyRunsAfterRetry: (await runsFor(notReadyId)).length,
    }
  })

  // --- 9b. a run stranded in 'dispatching' is failed, never re-dispatched ----
  await scenario('staleDispatching', async () => {
    const project = await newProject('stale')
    const id = await newAutomation(project.id, { cron: '0 * * * *', timezone: 'UTC' }, null)
    await db.update(automations).set({ paused: true }).where(eq(automations.id, id))
    const now = T('2026-03-02T12:00:00Z')
    const [old] = await db
      .insert(automationRuns)
      .values({
        automationId: id,
        scheduledFor: T('2026-03-02T11:00:00Z'),
        prompt: 'stranded',
        status: 'dispatching',
        startedAt: new Date(now.getTime() - 11 * 60_000),
      })
      .returning()
    const [recent] = await db
      .insert(automationRuns)
      .values({
        automationId: id,
        scheduledFor: T('2026-03-02T12:00:00Z'),
        prompt: 'still in flight',
        status: 'dispatching',
        startedAt: new Date(now.getTime() - 9 * 60_000),
      })
      .returning()
    if (!old || !recent) throw new Error('no stale run rows')

    const first = await sweepAutomations(now)
    const oldAfterFirst = (
      await db.select().from(automationRuns).where(eq(automationRuns.id, old.id))
    )[0]
    const recentAfterFirst = (
      await db.select().from(automationRuns).where(eq(automationRuns.id, recent.id))
    )[0]
    const second = await sweepAutomations(new Date(now.getTime() + 20 * 60_000))
    const recentAfterSecond = (
      await db.select().from(automationRuns).where(eq(automationRuns.id, recent.id))
    )[0]
    const third = await sweepAutomations(new Date(now.getTime() + 40 * 60_000))
    return {
      first,
      oldStatus: oldAfterFirst?.status,
      oldError: oldAfterFirst?.error,
      oldSessionId: oldAfterFirst?.sessionId,
      recentStatusAfterFirst: recentAfterFirst?.status,
      second,
      recentStatusAfterSecond: recentAfterSecond?.status,
      third,
      sessions: (await sessionsIn(project.id)).length,
      runCount: (await runsFor(id)).length,
    }
  })

  // --- 9c. a hand-corrupted cron / timezone neither crashes nor loops --------
  await scenario('corruptSchedule', async () => {
    const project = await newProject('corrupt')
    const due = T('2026-03-02T10:00:00Z')
    const badCronId = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC', name: 'bad cron' },
      due,
    )
    const badTzId = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC', name: 'bad tz' },
      due,
    )
    const goodId = await newAutomation(
      project.id,
      { cron: '0 * * * *', timezone: 'UTC', name: 'good' },
      due,
    )
    await db
      .update(automations)
      .set({ cron: 'not a cron at all' })
      .where(eq(automations.id, badCronId))
    await db.update(automations).set({ timezone: 'Mars/Phobos' }).where(eq(automations.id, badTzId))

    let threw = ''
    let result: unknown = null
    try {
      result = await sweepAutomations(T('2026-03-02T10:00:05Z'))
    } catch (error) {
      threw = String(error)
    }
    const second = await sweepAutomations(T('2026-03-02T10:00:20Z'))
    const third = await sweepAutomations(T('2026-03-05T10:00:20Z'))
    const badCronRow = await autoRow(badCronId)
    const badTzRow = await autoRow(badTzId)
    const getCorrupt = await request('GET', `/automations/${badCronId}`)
    return {
      threw,
      result,
      secondClaimed: second.claimed,
      thirdClaimedOnlyGood: third.claimed,
      badCronNextRunAt: iso(badCronRow?.nextRunAt),
      badCronRuns: (await runsFor(badCronId)).length,
      badTzNextRunAt: iso(badTzRow?.nextRunAt),
      badTzRuns: (await runsFor(badTzId)).length,
      goodRuns: (await runsFor(goodId)).map((r) => ({ at: iso(r.scheduledFor), status: r.status })),
      getCorruptStatus: getCorrupt.status,
    }
  })

  // --- worker wiring: the BullMQ processor and the 15 s schedule --------------
  await scenario('workerWiring', async () => {
    const project = await newProject('worker')
    // Due one minute ago on the real clock: the worker's processor sweeps "now".
    const id = await newAutomation(
      project.id,
      { cron: '0 9 * * *', timezone: 'UTC' },
      new Date(Date.now() - 60_000),
    )
    startAutomationSweepWorker()
    const processor = workerProcessors.get(QUEUE_AUTOMATION_SWEEP)
    const processorResult = processor ? await processor({ data: { reason: 'scheduled' } }) : null
    await ensureAutomationSweepSchedule()
    const sched = schedulers.filter((s) => s.queue === QUEUE_AUTOMATION_SWEEP)
    const runs = await runsFor(id)
    return {
      queueName: QUEUE_AUTOMATION_SWEEP,
      processorRegistered: Boolean(processor),
      processorResult,
      runCount: runs.length,
      runStatus: runs[0]?.status,
      schedulerRepeat: sched.map((s) => s.repeat),
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
