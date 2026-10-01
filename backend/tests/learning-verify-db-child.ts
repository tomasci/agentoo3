// Child process for learning-verify-db.test.ts: real Postgres (the parent's
// throwaway cluster), a real scratch LIBRARY_DIR, the real HTTP app, and the
// real engine — with only @anthropic-ai/claude-agent-sdk, bullmq and ioredis
// faked. Prints `__FACTS__<json>`; the parent asserts on it.
//
// LIBRARY_DIR is <root>/lib/library so that a path-escaping name ("../../x")
// lands inside <root> where this child can see whether anything was written.
//
// VERIFY_MODE=nocred runs only the no-credential scenario (the parent starts
// this child a second time without any credential in its env, because
// `hasClaudeCredential` is fixed at the first import of @/env).

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { mock } from 'bun:test'
import '@hono/zod-openapi'

const SRC = new URL('../src', import.meta.url).pathname
const MODE = process.env.VERIFY_MODE ?? 'main'
const ROOT = process.env.VERIFY_ROOT as string

// --- fakes -------------------------------------------------------------------

const enqueued: { queue: string; name: string; data: unknown; opts: unknown }[] = []
/** BullMQ job id -> state the fake getJob reports; absent = no such job. */
const jobStates = new Map<string, string>()
/** Runs inside Queue.add before the job exists — lets a scenario place
 * another actor exactly between createLearningRun's insert and its enqueue. */
let beforeAddHook: (() => Promise<unknown>) | undefined

mock.module('bullmq', () => ({
  Queue: class {
    name: string
    constructor(name: string) {
      this.name = name
    }
    async add(name: string, data: unknown, opts: { jobId?: string } | undefined) {
      const hook = beforeAddHook
      beforeAddHook = undefined
      if (hook) await hook()
      enqueued.push({ queue: this.name, name, data, opts })
      if (opts?.jobId) jobStates.set(opts.jobId, 'waiting')
      return { id: opts?.jobId ?? `job-${enqueued.length}` }
    }
    async getJob(id: string) {
      const state = jobStates.get(id)
      return state === undefined ? undefined : { id, getState: async () => state }
    }
    async upsertJobScheduler() {}
    async removeJobScheduler() {}
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
    async publish() {
      return 0
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

type QueryParams = { prompt: string; options: Record<string, unknown> }
const queryCalls: QueryParams[] = []
let handler: (p: QueryParams) => AsyncIterable<unknown> = () => empty()

async function* empty(): AsyncIterable<unknown> {}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: QueryParams) => {
    queryCalls.push(params)
    return handler(params)
  },
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

function success(answer: unknown, cost = 0.01) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), total_cost_usd: cost }
  })()
}
function failure() {
  return (async function* () {
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['judge exploded'], total_cost_usd: 0.001 }
  })()
}
const isJudge = (p: QueryParams) => String(p.options.systemPrompt ?? '').startsWith('You judge whether')
/** How many candidates a judge prompt lists. */
const judgeCandidateCount = (p: QueryParams) => (p.prompt.match(/\bid=candidate:\d+/g) ?? []).length
const allNullJudge = (p: QueryParams) =>
  success({
    results: Array.from({ length: judgeCandidateCount(p) }, (_, i) => ({
      candidateIndex: i,
      duplicateOfId: null,
      reason: 'new',
    })),
  })

// --- imports under test ------------------------------------------------------

const { and, eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const schema = await import(`${SRC}/db/schema.ts`)
const { learningRuns, librarySuggestions, libraryItemVersions, messages, projects, sessions, systemSettings } = schema
const { createApp } = await import(`${SRC}/app.ts`)
const { runLearning } = await import(`${SRC}/features/learning/engine.ts`)
const { createLearningRun } = await import(`${SRC}/features/learning/runs.ts`)
const { insertSuggestion, rejectSuggestion } = await import(`${SRC}/features/learning/suggestions.ts`)
const { reconcileStaleLearningRuns } = await import(`${SRC}/features/learning/stale.ts`)
const { handleLearningScheduleTrigger } = await import(`${SRC}/queue/learning-schedule.worker.ts`)
const { createAgent, createSkill, deleteAgent } = await import(`${SRC}/features/library/service.ts`)
const { env, hasClaudeCredential } = await import(`${SRC}/env.ts`)

const facts: Record<string, unknown> = {}
const app = createApp()
const DAY = 24 * HOURS(1)
function HOURS(n: number) {
  return n * 3_600_000
}

type Res = { status: number; body: any }
async function request(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** Every file under `dir` -> sha256 of its bytes, plus every directory. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(d: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      const rel = relative(dir, p)
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir'
        await walk(p)
      } else {
        out[rel] = sha(await readFile(p))
      }
    }
  }
  await walk(dir)
  return out
}
function diffTrees(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => a[k] !== b[k]).sort()
}

let projectSeq = 0
async function newProject(name: string): Promise<string> {
  projectSeq++
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${projectSeq}`, source: 'existing', status: 'ready' })
    .returning()
  return row.id
}
async function newSession(projectId: string, title: string, createdAt: Date, prompt: string): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, title, status: 'completed', createdAt, updatedAt: createdAt })
    .returning()
  await db.insert(messages).values({ sessionId: row.id, seq: 0, type: 'prompt', payload: { text: prompt } })
  return row.id
}
async function runRow(id: string) {
  const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, id)).limit(1)
  return row
}
/** Forces every active run to a terminal state so the next one can start. */
async function settleActive() {
  await db
    .update(learningRuns)
    .set({ status: 'failed', error: 'settled by test', finishedAt: new Date() })
    .where(eq(learningRuns.status, 'queued'))
  await db
    .update(learningRuns)
    .set({ status: 'failed', error: 'settled by test', finishedAt: new Date() })
    .where(eq(learningRuns.status, 'running'))
}

let windowSeq = 0
/** One manual run over a fresh window holding one session, with `h` as the
 * SDK handler. Returns the run row and the calls it made. */
async function runOnce(h: (p: QueryParams) => AsyncIterable<unknown>) {
  await settleActive()
  windowSeq++
  const windowEnd = new Date(Date.UTC(2025, 0, 1) + windowSeq * DAY)
  const project = await newProject(`dedupe-${windowSeq}`)
  const sessionId = await newSession(project, `dedupe session ${windowSeq}`, new Date(windowEnd.getTime() - 60_000), `token-${windowSeq}`)
  const created = await createLearningRun({ trigger: 'manual', windowEnd })
  if (!('run' in created)) throw new Error('runOnce: conflict')
  handler = h
  const before = queryCalls.length
  await runLearning({ learningRunId: created.run.id })
  return { row: await runRow(created.run.id), calls: queryCalls.slice(before), sessionId }
}

const LIB = env.LIBRARY_DIR
const agentFile = (n: string) => join(LIB, 'agents', `${n}.md`)
const skillFile = (n: string) => join(LIB, 'skills', n, 'SKILL.md')

// =============================================================================
// 1. settings API
// =============================================================================

/** Next instant strictly after `now` (minute-aligned) where `tz` reads HH:MM —
 * brute force over minutes, Intl only, no cron-parser. */
function oracleNext(time: string, tz: string, now: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  let t = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000
  for (let i = 0; i < 3 * 24 * 60; i++, t += 60_000) {
    if (fmt.format(new Date(t)) === time) return new Date(t).toISOString()
  }
  return 'none'
}

async function settingsScenario() {
  const now = new Date()
  const initial = await request('GET', '/api/system/settings')
  const overview0 = await request('GET', '/api/library/learning')

  const invalidBodies: Record<string, unknown> = {
    'time 24:00': { enabled: true, time: '24:00', timezone: 'Europe/Moscow' },
    'time 4:00': { enabled: true, time: '4:00', timezone: 'Europe/Moscow' },
    'time 04:60': { enabled: true, time: '04:60', timezone: 'Europe/Moscow' },
    'time 04:00:00': { enabled: true, time: '04:00:00', timezone: 'Europe/Moscow' },
    'unknown timezone': { enabled: true, time: '04:00', timezone: 'Mars/Phobos' },
    'empty timezone': { enabled: true, time: '04:00', timezone: '' },
    'missing time': { enabled: true, timezone: 'Europe/Moscow' },
    'missing timezone': { enabled: true, time: '04:00' },
    'missing enabled': { time: '04:00', timezone: 'Europe/Moscow' },
    'enabled as string': { enabled: 'yes', time: '04:00', timezone: 'Europe/Moscow' },
    'schedule as string': 'daily',
    'empty object': {},
  }
  const invalid: Record<string, { status: number; hasError: boolean }> = {}
  for (const [name, value] of Object.entries(invalidBodies)) {
    const r = await request('PATCH', '/api/system/settings', { learningSchedule: value })
    invalid[name] = { status: r.status, hasError: typeof r.body?.error === 'string' }
  }
  const [rowAfterInvalid] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'learning_schedule'))
  const afterInvalid = await request('GET', '/api/system/settings')

  const custom = { enabled: true, time: '05:30', timezone: 'Asia/Jerusalem' }
  const patchCustom = await request('PATCH', '/api/system/settings', { learningSchedule: custom })
  const nowCustom = new Date()
  const getCustom = await request('GET', '/api/system/settings')
  const overviewCustom = await request('GET', '/api/library/learning')

  // A PATCH of the other key alone leaves the schedule untouched.
  const patchOther = await request('PATCH', '/api/system/settings', { maxConcurrentSessions: 3 })
  await request('PATCH', '/api/system/settings', { maxConcurrentSessions: null })

  const disabled = { enabled: false, time: '05:30', timezone: 'Asia/Jerusalem' }
  const patchDisabled = await request('PATCH', '/api/system/settings', { learningSchedule: disabled })
  const overviewDisabled = await request('GET', '/api/library/learning')

  const patchNull = await request('PATCH', '/api/system/settings', { learningSchedule: null })
  const nowReset = new Date()
  const [rowAfterReset] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'learning_schedule'))
  const overviewReset = await request('GET', '/api/library/learning')

  facts.settings = {
    initialStatus: initial.status,
    initialValue: initial.body?.learningSchedule?.value,
    initialSource: initial.body?.learningSchedule?.source,
    initialDefault: initial.body?.learningSchedule?.defaultValue,
    initialNextRunAt: initial.body?.learningSchedule?.nextRunAt,
    expectedInitialNextRunAt: oracleNext('04:00', 'Europe/Moscow', now),
    overview0Schedule: overview0.body?.schedule,
    invalid,
    rowAfterInvalid: rowAfterInvalid ?? null,
    afterInvalidSource: afterInvalid.body?.learningSchedule?.source,
    patchCustomStatus: patchCustom.status,
    patchCustomEcho: patchCustom.body?.learningSchedule?.value,
    getCustomValue: getCustom.body?.learningSchedule?.value,
    getCustomSource: getCustom.body?.learningSchedule?.source,
    getCustomNextRunAt: getCustom.body?.learningSchedule?.nextRunAt,
    expectedCustomNextRunAt: oracleNext('05:30', 'Asia/Jerusalem', nowCustom),
    overviewCustomSchedule: overviewCustom.body?.schedule,
    patchOtherScheduleValue: patchOther.body?.learningSchedule?.value,
    patchDisabledStatus: patchDisabled.status,
    patchDisabledNextRunAt: patchDisabled.body?.learningSchedule?.nextRunAt,
    overviewDisabledSchedule: overviewDisabled.body?.schedule,
    patchNullStatus: patchNull.status,
    patchNullValue: patchNull.body?.learningSchedule?.value,
    patchNullSource: patchNull.body?.learningSchedule?.source,
    patchNullNextRunAt: patchNull.body?.learningSchedule?.nextRunAt,
    expectedResetNextRunAt: oracleNext('04:00', 'Europe/Moscow', nowReset),
    rowAfterReset: rowAfterReset ?? null,
    overviewResetSchedule: overviewReset.body?.schedule,
  }
}

// =============================================================================
// 2. manual run: window end = request time, 409 on a second, concurrent POSTs
// =============================================================================

async function manualRunScenario() {
  await settleActive()
  enqueued.length = 0
  const before = Date.now()
  const first = await request('POST', '/api/library/learning/runs')
  const after = Date.now()
  const second = await request('POST', '/api/library/learning/runs')
  const overview = await request('GET', '/api/library/learning')
  const firstEnqueued = enqueued[0]

  await settleActive()
  enqueued.length = 0
  const burst = await Promise.all(Array.from({ length: 8 }, () => request('POST', '/api/library/learning/runs')))
  const active = await db.select().from(learningRuns).where(eq(learningRuns.status, 'queued'))

  facts.manualRun = {
    firstStatus: first.status,
    trigger: first.body?.trigger,
    runStatus: first.body?.status,
    windowEndMs: Date.parse(first.body?.windowEnd),
    windowStartMs: Date.parse(first.body?.windowStart),
    before,
    after,
    secondStatus: second.status,
    secondError: second.body?.error,
    overviewActiveId: overview.body?.activeRun?.id,
    firstId: first.body?.id,
    enqueuedQueue: firstEnqueued?.queue,
    enqueuedName: firstEnqueued?.name,
    enqueuedData: firstEnqueued?.data,
    enqueuedJobId: (firstEnqueued?.opts as { jobId?: string } | undefined)?.jobId,
    enqueuedCountForFirst: 1,
    burstStatuses: burst.map((r) => r.status).sort(),
    burstActiveRows: active.length,
    burstEnqueued: enqueued.length,
  }
}

// =============================================================================
// 3. window boundaries, across projects, via the scheduled trigger handler
// =============================================================================

async function windowScenario() {
  await settleActive()
  // 04:00:00 in UTC+3 on 2026-03-10.
  const T = Date.parse('2026-03-10T04:00:00.000+03:00')
  const p = [await newProject('win-a'), await newProject('win-b'), await newProject('win-c')]
  const cases: [string, number, number, boolean][] = [
    ['startMinus1ms', T - DAY - 1, 0, false],
    ['startExact', T - DAY, 0, true],
    ['startPlus1ms', T - DAY + 1, 2, true],
    ['middle', T - HOURS(12), 1, true],
    ['endMinus1ms', T - 1, 2, true],
    ['endExact', T, 0, false],
    ['endPlus1ms', T + 1, 1, false],
  ]
  const ids: Record<string, string> = {}
  for (const [label, at, pi, _] of cases) {
    ids[label] = await newSession(p[pi] as string, `win ${label}`, new Date(at), `WINDOW-TOKEN-${label}`)
  }

  // Processed "late": the trigger reaches the handler months after T, and
  // with a timestamp/delay pair that would name a different instant.
  await handleLearningScheduleTrigger({ prevMillis: T, timestamp: T - 5000, delay: 4000 })
  const scheduled = await db
    .select()
    .from(learningRuns)
    .where(and(eq(learningRuns.trigger, 'scheduled'), eq(learningRuns.windowEnd, new Date(T))))
  const run = scheduled[0]
  // A redelivered trigger for the same occurrence.
  await handleLearningScheduleTrigger({ prevMillis: T })
  const scheduledAfterRedelivery = await db
    .select()
    .from(learningRuns)
    .where(and(eq(learningRuns.trigger, 'scheduled'), eq(learningRuns.windowEnd, new Date(T))))

  handler = () => success({ suggestions: [] })
  const before = queryCalls.length
  if (run) await runLearning({ learningRunId: run.id })
  const reviewPrompt = queryCalls.slice(before).map((c) => c.prompt).join('\n')
  const finished = run ? await runRow(run.id) : undefined

  const presence: Record<string, boolean> = {}
  for (const [label] of cases) presence[label] = reviewPrompt.includes(`WINDOW-TOKEN-${label}`) || reviewPrompt.includes(ids[label] as string)
  const expected: Record<string, boolean> = Object.fromEntries(cases.map(([l, , , inWin]) => [l, inWin]))

  // A scheduled trigger that collides with an active manual run is skipped.
  await settleActive()
  const manual = await createLearningRun({ trigger: 'manual', windowEnd: new Date() })
  const T2 = T + DAY
  let collisionThrew = false
  try {
    await handleLearningScheduleTrigger({ prevMillis: T2 })
  } catch {
    collisionThrew = true
  }
  const collisionRows = await db
    .select()
    .from(learningRuns)
    .where(and(eq(learningRuns.trigger, 'scheduled'), eq(learningRuns.windowEnd, new Date(T2))))
  const manualStill = 'run' in manual ? await runRow(manual.run.id) : undefined
  await settleActive()

  // No prevMillis and no timestamp/delay: falls back to the schedule's own
  // latest occurrence (default 04:00 Moscow = 01:00Z), never "now".
  const nowMs = Date.now()
  await handleLearningScheduleTrigger({})
  const [fallback] = await db
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.trigger, 'scheduled'))
    .orderBy(schema.learningRuns.createdAt)
    .then((rows: any[]) => rows.slice(-1))
  await settleActive()

  facts.window = {
    scheduledRows: scheduled.length,
    windowEnd: run?.windowEnd.toISOString(),
    windowStart: run?.windowStart.toISOString(),
    expectedWindowEnd: new Date(T).toISOString(),
    expectedWindowStart: new Date(T - DAY).toISOString(),
    rowsAfterRedelivery: scheduledAfterRedelivery.length,
    status: finished?.status,
    sessionsAnalyzed: finished?.sessionsAnalyzed,
    presence,
    expected,
    projectsInPrompt: ['win-a', 'win-b', 'win-c'].filter((n) => reviewPrompt.includes(n)),
    collisionThrew,
    collisionRows: collisionRows.length,
    manualStillActive: manualStill?.status,
    fallbackWindowEnd: fallback?.windowEnd.toISOString(),
    fallbackNotAfterNow: fallback ? fallback.windowEnd.getTime() <= nowMs : null,
    fallbackWithinADay: fallback ? nowMs - fallback.windowEnd.getTime() < DAY : null,
  }
}

// =============================================================================
// 4. library read in full; never writes; untrusted candidates
// =============================================================================

async function seedLibrary() {
  await mkdir(join(LIB, 'agents'), { recursive: true })
  await mkdir(join(LIB, 'skills'), { recursive: true })
  await mkdir(join(LIB, 'prompts'), { recursive: true })
  await createAgent({
    name: 'scout',
    role: 'subagent',
    team: true,
    description: 'Scout reads code — café ✓ — and reports.',
    prompt: 'SCOUT-BODY: read widely before you conclude.\n\nNever guess.',
    effort: 'high',
    maxTurns: 40,
    tools: ['Read', 'Grep'],
  })
  await createAgent({
    name: 'reviewer',
    role: 'orchestrator',
    team: false,
    description: 'Reviews changes on its own.',
    prompt: 'REVIEWER-BODY: check every claim.',
  })
  // Hand-written, not rendered by agentToMarkdown: comments, odd spacing and
  // a trailing blank line that a re-render would normalise away.
  await writeFile(
    agentFile('handmade'),
    '---\n# a hand-written comment\ndescription:   "Hand made agent"\nrole: subagent\n---\n\nHANDMADE-BODY line one\n\n\n  indented line two\n\n',
    'utf8',
  )
  await createSkill({ name: 'triage', description: 'Triage a bug report.', body: 'TRIAGE-BODY: reproduce, then isolate.' })
  await writeFile(join(LIB, 'skills', 'triage', 'checklist.md'), 'TRIAGE-CHECKLIST bytes\n', 'utf8')
  await mkdir(join(LIB, 'skills', 'triage', 'scripts'), { recursive: true })
  await writeFile(join(LIB, 'skills', 'triage', 'scripts', 'run.sh'), '#!/bin/sh\necho triage\n', 'utf8')
  await createSkill({ name: 'deploy', description: 'Ship a release.', body: 'DEPLOY-BODY: tag, build, publish.' })
  await writeFile(join(LIB, 'prompts', 'session-learning.md'), 'You review sessions. CUSTOM-INSTRUCTION-MARKER.\n', 'utf8')
}

const agentBody = (description: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  role: 'subagent',
  team: true,
  description,
  prompt,
  ...extra,
})

async function engineScenario() {
  await settleActive()
  const T = Date.parse('2026-04-01T01:00:00.000Z')
  const project = await newProject('engine')
  const inBatch = await newSession(project, 'engine session', new Date(T - HOURS(1)), 'ENGINE-SESSION-PROMPT')
  const outside = await newSession(project, 'outside session', new Date(T - 3 * DAY), 'never in this run')

  const diskAgents: Record<string, string> = {}
  for (const n of ['scout', 'reviewer', 'handmade']) diskAgents[n] = await readFile(agentFile(n), 'utf8')
  const diskSkills: Record<string, string> = {}
  for (const n of ['triage', 'deploy']) diskSkills[n] = await readFile(skillFile(n), 'utf8')

  const candidates = [
    // valid
    { kind: 'agent', action: 'modify', name: 'scout', title: 'Scout cites sources', rationale: 'r', sourceSessionIds: [inBatch, outside, 'not-a-session'], proposed: agentBody('Scout reads code — café ✓ — and reports.', 'SCOUT-BODY v2: cite every file you read.', { effort: 'high' }) },
    { kind: 'skill', action: 'create', name: 'release-notes', title: 'Release notes skill', rationale: 'r', sourceSessionIds: [inBatch], proposed: { description: 'Write release notes.', body: 'NOTES-BODY' } },
    { kind: 'skill', action: 'modify', name: 'triage', title: 'Triage bisects', rationale: 'r', sourceSessionIds: [inBatch], proposed: { description: 'Triage a bug report.', body: 'TRIAGE-BODY v2: reproduce, isolate, bisect.' } },
    { kind: 'agent', action: 'create', name: 'linter', title: 'Linter agent', rationale: 'r', sourceSessionIds: [inBatch], proposed: { ...agentBody('Lints.', 'LINTER-BODY'), name: 'evil-rename' } },
    { kind: 'agent', action: 'modify', name: 'reviewer', title: 'Reviewer rename attempt', rationale: 'r', sourceSessionIds: [inBatch], proposed: { role: 'orchestrator', team: false, description: 'Reviews changes on its own.', prompt: 'REVIEWER-BODY v2', name: 'hijacked' } },
    // invalid: every one of these must be dropped
    { kind: 'agent', action: 'create', name: '../../etc/x', title: 'traversal', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'skill', action: 'create', name: 'a/b', title: 'slash', rationale: 'r', sourceSessionIds: [], proposed: { description: 'x', body: 'x' } },
    { kind: 'agent', action: 'create', name: 'Uppercase', title: 'upper', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'agent', action: 'create', name: 'a'.repeat(65), title: 'long', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'agent', action: 'modify', name: 'ghost', title: 'no such target', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'agent', action: 'modify', name: '../agents/scout', title: 'traversal modify', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'skill', action: 'modify', name: 'scout', title: 'kind mismatch', rationale: 'r', sourceSessionIds: [], proposed: { description: 'x', body: 'x' } },
    { kind: 'agent', action: 'create', name: 'scout', title: 'create existing agent', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
    { kind: 'skill', action: 'create', name: 'triage', title: 'create existing skill', rationale: 'r', sourceSessionIds: [], proposed: { description: 'x', body: 'x' } },
    { kind: 'agent', action: 'create', name: 'bad-effort', title: 'bad effort', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x', { effort: 'extreme' }) },
    { kind: 'agent', action: 'create', name: 'neg-turns', title: 'negative maxTurns', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x', { maxTurns: -3 }) },
    { kind: 'agent', action: 'create', name: 'zero-turns', title: 'zero maxTurns', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x', { maxTurns: 0 }) },
    { kind: 'agent', action: 'create', name: 'no-desc', title: 'missing description', rationale: 'r', sourceSessionIds: [], proposed: { role: 'subagent', prompt: 'x' } },
    { kind: 'agent', action: 'create', name: 'empty-prompt', title: 'empty prompt', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', '') },
    { kind: 'agent', action: 'create', name: 'bad-role', title: 'bad role', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x', { role: 'root' }) },
    { kind: 'skill', action: 'create', name: 'no-body', title: 'skill missing body', rationale: 'r', sourceSessionIds: [], proposed: { description: 'x' } },
    { kind: 'agent', action: 'modify', name: 'deploy', title: 'agent modify of a skill name', rationale: 'r', sourceSessionIds: [], proposed: agentBody('x', 'x') },
  ]

  const treeBefore = await snapshotTree(ROOT)
  await createLearningRun({ trigger: 'manual', windowEnd: new Date(T) }).then(async (r) => {
    if (!('run' in r)) throw new Error('engine: conflict')
    let judgePrompt = ''
    handler = (p) => {
      if (isJudge(p)) {
        judgePrompt = p.prompt
        return allNullJudge(p)
      }
      return success({ suggestions: candidates })
    }
    const before = queryCalls.length
    await runLearning({ learningRunId: r.run.id })
    const calls = queryCalls.slice(before)
    const review = calls.find((c) => !isJudge(c))
    const prompt = review?.prompt ?? ''
    const row = await runRow(r.run.id)
    const inserted = await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, r.run.id))
    const treeAfter = await snapshotTree(ROOT)

    facts.engine = {
      runId: r.run.id,
      status: row?.status,
      error: row?.error,
      suggestionsCreated: row?.suggestionsCreated,
      duplicatesSkipped: row?.duplicatesSkipped,
      callKinds: calls.map((c) => (isJudge(c) ? 'judge' : 'review')),
      promptHasEveryAgentVerbatim: Object.fromEntries(Object.entries(diskAgents).map(([n, md]) => [n, prompt.includes(md)])),
      promptHasEverySkillVerbatim: Object.fromEntries(Object.entries(diskSkills).map(([n, md]) => [n, prompt.includes(md)])),
      promptNamesTriageExtraFile: prompt.includes('checklist.md'),
      promptHasSession: prompt.includes('ENGINE-SESSION-PROMPT'),
      systemPromptIsOperatorInstruction: String(review?.options.systemPrompt ?? '').includes('CUSTOM-INSTRUCTION-MARKER'),
      reviewOptionsTools: review?.options.tools,
      insertedNames: inserted.map((s: any) => `${s.kind}:${s.action}:${s.name}`).sort(),
      insertedAllPending: inserted.every((s: any) => s.status === 'pending'),
      proposedCarriesName: inserted.filter((s: any) => 'name' in (s.proposed ?? {})).map((s: any) => s.name),
      scoutSources: inserted.find((s: any) => s.name === 'scout')?.sourceSessionIds,
      inBatch,
      scoutBaseIsDisk: inserted.find((s: any) => s.name === 'scout')?.baseMarkdown === diskAgents.scout,
      judgeSawNames: [...judgePrompt.matchAll(/id=candidate:\d+ kind=\w+ action=\w+ name=(\S+)/g)].map((m) => m[1]).sort(),
      treeDiff: diffTrees(treeBefore, treeAfter),
      treeFileCount: Object.keys(treeBefore).length,
    }
  })
}

// =============================================================================
// 5. decisions over the HTTP API
// =============================================================================

async function idOf(name: string, runId?: string) {
  const rows = await db.select().from(librarySuggestions).where(eq(librarySuggestions.name, name))
  const row = rows.find((r: any) => (runId ? r.runId === runId : true) && r.status === 'pending')
  return row?.id as string
}

async function decisionsScenario() {
  const runId = (facts.engine as any).runId as string
  const scoutId = await idOf('scout', runId)
  const triageId = await idOf('triage', runId)
  const notesId = await idOf('release-notes', runId)
  const linterId = await idOf('linter', runId)
  const reviewerId = await idOf('reviewer', runId)
  const out: Record<string, unknown> = {}

  const pending = await request('GET', '/api/library/suggestions?status=pending')
  out.pendingListStatus = pending.status
  out.pendingListHasAll = [scoutId, triageId, notesId, linterId, reviewerId].every((id) => pending.body.some?.((s: any) => s.id === id))
  out.defaultListStatus = (await request('GET', '/api/library/suggestions')).status
  out.bogusStatusQuery = (await request('GET', '/api/library/suggestions?status=bogus')).status

  // --- modify agent: detail, stale, null, good, again ---
  const scoutDisk0 = await readFile(agentFile('scout'), 'utf8')
  const detail = await request('GET', `/api/library/suggestions/${scoutId}`)
  out.detailStatus = detail.status
  out.detailCurrentIsDisk = detail.body.currentMarkdown === scoutDisk0
  out.detailHashIsSha = detail.body.currentHash === sha(scoutDisk0)
  out.detailProposedDiffers = typeof detail.body.proposedMarkdown === 'string' && detail.body.proposedMarkdown !== scoutDisk0
  out.detailProposedHasNewBody = String(detail.body.proposedMarkdown).includes('SCOUT-BODY v2')
  out.detailStale = detail.body.stale
  const stale = await request('POST', `/api/library/suggestions/${scoutId}/apply`, { expectedCurrentHash: '0'.repeat(64) })
  const nullHash = await request('POST', `/api/library/suggestions/${scoutId}/apply`, { expectedCurrentHash: null })
  out.staleStatus = stale.status
  out.nullHashStatus = nullHash.status
  out.fileUntouchedAfterStale = (await readFile(agentFile('scout'), 'utf8')) === scoutDisk0
  out.stillPendingAfterStale = (await request('GET', `/api/library/suggestions/${scoutId}`)).body.status
  out.noVersionsAfterStale = (await request('GET', '/api/library/agents/scout/versions')).body.length
  const good = await request('POST', `/api/library/suggestions/${scoutId}/apply`, { expectedCurrentHash: detail.body.currentHash })
  const scoutDisk1 = await readFile(agentFile('scout'), 'utf8')
  const versions = await request('GET', '/api/library/agents/scout/versions')
  out.goodStatus = good.status
  out.goodBodyStatus = good.body.status
  out.goodAppliedVersion = good.body.appliedVersion
  out.fileIsProposed = scoutDisk1 === detail.body.proposedMarkdown
  out.fileHasNewBody = scoutDisk1.includes('SCOUT-BODY v2: cite every file you read.')
  out.fileFrontmatterLines = scoutDisk1.split('---')[1]?.trim().split('\n').sort()
  out.shownFrontmatterLines = String(detail.body.proposedMarkdown).split('---')[1]?.trim().split('\n').sort()
  out.fileVsShown = { disk: scoutDisk1, shown: detail.body.proposedMarkdown }
  out.versions = versions.body.map?.((v: any) => ({ version: v.version, source: v.source, suggestionId: v.suggestionId === scoutId ? 'this' : v.suggestionId }))
  out.snapshotIsOriginal = versions.body.find?.((v: any) => v.source === 'snapshot')?.markdown === scoutDisk0
  out.suggestionVersionIsFile = versions.body.find?.((v: any) => v.source === 'suggestion')?.markdown === scoutDisk1
  out.noRenameFile = !(await exists(agentFile('hijacked'))) && !(await exists(agentFile('evil-rename')))
  const again = await request('POST', `/api/library/suggestions/${scoutId}/apply`, { expectedCurrentHash: sha(scoutDisk1) })
  out.againStatus = again.status
  out.versionsAfterAgain = (await request('GET', '/api/library/agents/scout/versions')).body.length
  out.fileAfterAgainUnchanged = (await readFile(agentFile('scout'), 'utf8')) === scoutDisk1

  // --- modify skill with bundled files ---
  const checklist0 = await readFile(join(LIB, 'skills', 'triage', 'checklist.md'))
  const script0 = await readFile(join(LIB, 'skills', 'triage', 'scripts', 'run.sh'))
  const triageDetail = await request('GET', `/api/library/suggestions/${triageId}`)
  const triageApply = await request('POST', `/api/library/suggestions/${triageId}/apply`, { expectedCurrentHash: triageDetail.body.currentHash })
  out.triageApplyStatus = triageApply.status
  out.triageSkillMdIsProposed = (await readFile(skillFile('triage'), 'utf8')) === triageDetail.body.proposedMarkdown
  out.triageChecklistKept = (await readFile(join(LIB, 'skills', 'triage', 'checklist.md'))).equals(checklist0)
  out.triageScriptKept = (await readFile(join(LIB, 'skills', 'triage', 'scripts', 'run.sh'))).equals(script0)
  out.triageVersions = (await request('GET', '/api/library/skills/triage/versions')).body.map?.((v: any) => v.source)

  // --- create skill ---
  const notesApply = await request('POST', `/api/library/suggestions/${notesId}/apply`, { expectedCurrentHash: null })
  out.notesApplyStatus = notesApply.status
  out.notesFileExists = await exists(skillFile('release-notes'))
  out.notesVersions = (await request('GET', '/api/library/skills/release-notes/versions')).body.map?.((v: any) => ({ version: v.version, source: v.source }))

  // --- create whose name is now taken ---
  await createAgent({ name: 'linter', role: 'subagent', team: true, description: 'Human-made linter.', prompt: 'HUMAN-LINTER' })
  const linterDisk = await readFile(agentFile('linter'))
  const linterApply = await request('POST', `/api/library/suggestions/${linterId}/apply`, { expectedCurrentHash: null })
  out.linterApplyStatus = linterApply.status
  out.linterFileUnchanged = (await readFile(agentFile('linter'))).equals(linterDisk)
  out.linterStillPending = (await request('GET', `/api/library/suggestions/${linterId}`)).body.status
  out.linterVersions = (await request('GET', '/api/library/agents/linter/versions')).body.length

  // --- target deleted after the suggestion was created ---
  const reviewerDetail = await request('GET', `/api/library/suggestions/${reviewerId}`)
  await deleteAgent('reviewer')
  const reviewerDetailAfter = await request('GET', `/api/library/suggestions/${reviewerId}`)
  const reviewerApply = await request('POST', `/api/library/suggestions/${reviewerId}/apply`, { expectedCurrentHash: reviewerDetail.body.currentHash })
  out.deletedTargetDetailStatus = reviewerDetailAfter.status
  out.deletedTargetExists = reviewerDetailAfter.body.targetExists
  out.deletedTargetHash = reviewerDetailAfter.body.currentHash
  out.deletedTargetApplyStatus = reviewerApply.status
  out.deletedTargetNotRecreated = !(await exists(agentFile('reviewer')))
  out.deletedTargetStillPending = (await request('GET', `/api/library/suggestions/${reviewerId}`)).body.status

  // --- reject / delete state machine ---
  out.deletePending = (await request('DELETE', `/api/library/suggestions/${reviewerId}`)).status
  out.deleteApplied = (await request('DELETE', `/api/library/suggestions/${scoutId}`)).status
  out.rejectApplied = (await request('POST', `/api/library/suggestions/${scoutId}/reject`)).status
  const reject = await request('POST', `/api/library/suggestions/${reviewerId}/reject`)
  out.rejectStatus = reject.status
  out.rejectBodyStatus = reject.body.status
  const rejectedList = await request('GET', '/api/library/suggestions?status=rejected')
  out.inRejectedList = rejectedList.body.some?.((s: any) => s.id === reviewerId)
  out.notInPendingList = !(await request('GET', '/api/library/suggestions?status=pending')).body.some?.((s: any) => s.id === reviewerId)
  out.rejectAgain = (await request('POST', `/api/library/suggestions/${reviewerId}/reject`)).status
  out.applyRejected = (await request('POST', `/api/library/suggestions/${reviewerId}/apply`, { expectedCurrentHash: null })).status
  out.deleteRejected = (await request('DELETE', `/api/library/suggestions/${reviewerId}`)).status
  out.getAfterDelete = (await request('GET', `/api/library/suggestions/${reviewerId}`)).status
  out.deleteAgain = (await request('DELETE', `/api/library/suggestions/${reviewerId}`)).status
  const appliedList = await request('GET', '/api/library/suggestions?status=applied')
  out.appliedListNames = appliedList.body.map?.((s: any) => s.name).sort()

  // --- unknown and malformed ids ---
  const unknown = '00000000-0000-4000-8000-000000000000'
  out.unknown = {
    get: (await request('GET', `/api/library/suggestions/${unknown}`)).status,
    apply: (await request('POST', `/api/library/suggestions/${unknown}/apply`, { expectedCurrentHash: null })).status,
    reject: (await request('POST', `/api/library/suggestions/${unknown}/reject`)).status,
    delete: (await request('DELETE', `/api/library/suggestions/${unknown}`)).status,
  }
  out.malformed = {
    get: (await request('GET', '/api/library/suggestions/not-a-uuid')).status,
    apply: (await request('POST', '/api/library/suggestions/not-a-uuid/apply', { expectedCurrentHash: null })).status,
    reject: (await request('POST', '/api/library/suggestions/not-a-uuid/reject')).status,
    delete: (await request('DELETE', '/api/library/suggestions/not-a-uuid')).status,
  }
  const handmade0 = await readFile(agentFile('handmade'))
  const noBody = await insertSuggestion({ runId: null, kind: 'agent', action: 'modify', name: 'handmade', title: 'no body', rationale: 'r', sourceSessionIds: [], proposed: agentBody('Hand made agent', 'HANDMADE v2'), baseMarkdown: handmade0.toString('utf8') })
  const noBodyRes = await app.request(`/api/library/suggestions/${noBody.id}/apply`, { method: 'POST' })
  out.applyWithoutBody = { status: noBodyRes.status, fileUnchanged: (await readFile(agentFile('handmade'))).equals(handmade0) }
  await db.delete(librarySuggestions).where(eq(librarySuggestions.id, noBody.id))

  // --- concurrent double apply of one suggestion ---
  const deployMd = await readFile(skillFile('deploy'), 'utf8')
  const dup = await insertSuggestion({
    runId: null,
    kind: 'skill',
    action: 'modify',
    name: 'deploy',
    title: 'deploy v2',
    rationale: 'r',
    sourceSessionIds: [],
    proposed: { description: 'Ship a release.', body: 'DEPLOY-BODY v2' },
    baseMarkdown: deployMd,
  })
  const burst = await Promise.all(
    Array.from({ length: 6 }, () => request('POST', `/api/library/suggestions/${dup.id}/apply`, { expectedCurrentHash: sha(deployMd) })),
  )
  out.concurrentStatuses = burst.map((r) => r.status).sort()
  out.concurrentVersions = (await request('GET', '/api/library/skills/deploy/versions')).body.map?.((v: any) => v.source)

  // --- two different modify suggestions, same base, applied concurrently ---
  const raceTrials: { statuses: number[]; consistent: boolean; detail: string }[] = []
  for (let i = 0; i < 20; i++) {
    const name = `race-${i}`
    await createAgent({ name, role: 'subagent', team: true, description: 'race', prompt: 'RACE-BASE' })
    const base = await readFile(agentFile(name), 'utf8')
    const mk = (body: string) =>
      insertSuggestion({ runId: null, kind: 'agent', action: 'modify', name, title: body, rationale: 'r', sourceSessionIds: [], proposed: agentBody('race', body), baseMarkdown: base })
    const a = await mk('RACE-A')
    const b = await mk('RACE-B')
    const [ra, rb] = await Promise.all([
      request('POST', `/api/library/suggestions/${a.id}/apply`, { expectedCurrentHash: sha(base) }),
      request('POST', `/api/library/suggestions/${b.id}/apply`, { expectedCurrentHash: sha(base) }),
    ])
    const disk = await readFile(agentFile(name), 'utf8')
    const rows = await db.select().from(librarySuggestions).where(eq(librarySuggestions.name, name))
    const applied = rows.filter((r: any) => r.status === 'applied')
    const vers = await db.select().from(libraryItemVersions).where(eq(libraryItemVersions.name, name))
    const latest = vers.sort((x: any, y: any) => y.version - x.version)[0]
    const okCount = [ra.status, rb.status].filter((s) => s === 200).length
    const appliedBody = applied[0]?.title as string | undefined
    const consistent =
      okCount === 1 && applied.length === 1 && appliedBody !== undefined && disk.includes(appliedBody) && latest?.markdown === disk
    raceTrials.push({
      statuses: [ra.status, rb.status],
      consistent,
      detail: `ok=${okCount} applied=${applied.map((r: any) => r.title)} disk=${disk.includes('RACE-A') ? 'A' : disk.includes('RACE-B') ? 'B' : 'base'} latestVersion=${latest?.markdown?.includes('RACE-A') ? 'A' : latest?.markdown?.includes('RACE-B') ? 'B' : 'other'}`,
    })
  }
  out.raceTrials = raceTrials
  out.raceInconsistent = raceTrials.filter((t) => !t.consistent).length

  facts.decisions = out
}

async function exists(p: string) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// =============================================================================
// 6. tampered rows: nothing written outside LIBRARY_DIR
// =============================================================================

async function tamperScenario() {
  const unsafe: { kind: 'agent' | 'skill'; action: 'create' | 'modify'; name: string }[] = [
    { kind: 'agent', action: 'modify', name: '../../escape-agent-mod' },
    { kind: 'agent', action: 'create', name: '../../escape-agent-create' },
    { kind: 'skill', action: 'create', name: '../../escape-skill-create' },
    { kind: 'skill', action: 'modify', name: '../../../escape-skill-mod' },
    { kind: 'agent', action: 'create', name: 'a/b' },
    { kind: 'skill', action: 'create', name: '.' },
    { kind: 'agent', action: 'create', name: '/tmp/abs-escape' },
  ]
  const ids: string[] = []
  for (const u of unsafe) {
    const proposed = u.kind === 'agent' ? agentBody('tampered', 'TAMPERED') : { description: 'tampered', body: 'TAMPERED' }
    const [row] = await db
      .insert(librarySuggestions)
      .values({ runId: null, kind: u.kind, action: u.action, name: u.name, title: `tamper ${u.name}`, rationale: 'r', sourceSessionIds: [], proposed, baseMarkdown: 'x' })
      .returning()
    ids.push(row.id)
  }
  const before = await snapshotTree(ROOT)
  const absBefore = await exists('/tmp/abs-escape.md')
  const results: Record<string, { apply: number; get: number; statusAfter: string }> = {}
  for (let i = 0; i < unsafe.length; i++) {
    const id = ids[i] as string
    const u = unsafe[i] as (typeof unsafe)[number]
    const apply = await request('POST', `/api/library/suggestions/${id}/apply`, { expectedCurrentHash: sha('x') })
    const get = await request('GET', `/api/library/suggestions/${id}`)
    const [row] = await db.select().from(librarySuggestions).where(eq(librarySuggestions.id, id))
    results[`${u.kind}:${u.action}:${u.name}`] = { apply: apply.status, get: get.status, statusAfter: row?.status }
  }
  const pendingList = await request('GET', '/api/library/suggestions?status=pending')
  const after = await snapshotTree(ROOT)
  const absAfter = await exists('/tmp/abs-escape.md')
  facts.tamper = {
    results,
    treeDiff: diffTrees(before, after),
    absEscapeCreated: !absBefore && absAfter,
    pendingListStatus: pendingList.status,
  }
  for (const id of ids) await db.delete(librarySuggestions).where(eq(librarySuggestions.id, id))
  const pendingListClean = await request('GET', '/api/library/suggestions?status=pending')
  ;(facts.tamper as any).pendingListStatusAfterCleanup = pendingListClean.status
}

// =============================================================================
// 7. dedupe
// =============================================================================

async function dedupeScenario() {
  const out: Record<string, unknown> = {}
  const deployMd = await readFile(skillFile('deploy'), 'utf8')
  // A pending suggestion already on file.
  const pending = await insertSuggestion({
    runId: null,
    kind: 'skill',
    action: 'modify',
    name: 'deploy',
    title: 'Deploy should verify checksums',
    rationale: 'Releases shipped without checksum verification.',
    sourceSessionIds: [],
    proposed: { description: 'Ship a release.', body: 'DEPLOY-BODY: tag, build, verify checksums, publish.' },
    baseMarkdown: deployMd,
  })
  const reworded = {
    kind: 'skill',
    action: 'modify',
    name: 'deploy',
    title: 'Check artifact hashes before publishing',
    rationale: 'Same idea, other words.',
    sourceSessionIds: [],
    proposed: { description: 'Ship a release.', body: 'DEPLOY-BODY: tag, build, compare the sha256 of each artifact, then publish.' },
  }
  const identical = { ...reworded, title: 'identical', proposed: { description: 'Ship a release.', body: 'DEPLOY-BODY: tag, build, verify checksums, publish.' } }

  // (a) semantic: reworded, judge names the pending row.
  let judgePromptA = ''
  const a = await runOnce((p) => {
    if (isJudge(p)) {
      judgePromptA = p.prompt
      return success({ results: [{ candidateIndex: 0, duplicateOfId: pending.id, reason: 'same idea' }] })
    }
    return success({ suggestions: [reworded] })
  })
  out.semantic = {
    status: a.row?.status,
    created: a.row?.suggestionsCreated,
    skipped: a.row?.duplicatesSkipped,
    judgeCalled: a.calls.some(isJudge),
    judgeSawExisting: judgePromptA.includes(pending.id),
    newRows: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, a.row.id))).length,
  }

  // (b) exact duplicate: caught without needing the judge.
  const b = await runOnce((p) => (isJudge(p) ? allNullJudge(p) : success({ suggestions: [identical] })))
  out.exact = {
    created: b.row?.suggestionsCreated,
    skipped: b.row?.duplicatesSkipped,
    judgeCalled: b.calls.some(isJudge),
  }

  // (b2) exact duplicate of a pending *agent* suggestion carrying optional
  // frontmatter (effort, maxTurns, tools) — byte-identical proposal.
  const scoutProposal = agentBody('Scout, exact-dup probe.', 'EXACT-DUP-BODY', { effort: 'low', maxTurns: 12, tools: ['Read'] })
  await insertSuggestion({ runId: null, kind: 'agent', action: 'modify', name: 'scout', title: 'exact dup probe', rationale: 'r', sourceSessionIds: [], proposed: scoutProposal, baseMarkdown: await readFile(agentFile('scout'), 'utf8') })
  const b2 = await runOnce((p) => (isJudge(p) ? allNullJudge(p) : success({ suggestions: [{ kind: 'agent', action: 'modify', name: 'scout', title: 'exact dup probe again', rationale: 'r', sourceSessionIds: [], proposed: scoutProposal }] })))
  out.exactAgent = {
    created: b2.row?.suggestionsCreated,
    skipped: b2.row?.duplicatesSkipped,
    judgeCalled: b2.calls.some(isJudge),
  }

  // (c) judge call fails: fail closed.
  const fresh = (title: string, body: string) => ({
    kind: 'agent',
    action: 'create',
    name: `fresh-${title}`,
    title,
    rationale: 'r',
    sourceSessionIds: [],
    proposed: agentBody('fresh', body),
  })
  const c = await runOnce((p) => (isJudge(p) ? failure() : success({ suggestions: [fresh('c1', 'C1'), fresh('c2', 'C2')] })))
  out.judgeFails = {
    status: c.row?.status,
    created: c.row?.suggestionsCreated,
    error: c.row?.error,
    newRows: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, c.row.id))).length,
  }

  // (d) judge answer of the wrong shape: fail closed.
  const d = await runOnce((p) => (isJudge(p) ? success({ results: 'nope' }) : success({ suggestions: [fresh('d1', 'D1')] })))
  out.judgeMalformed = {
    created: d.row?.suggestionsCreated,
    newRows: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, d.row.id))).length,
  }

  // (e) judge answers, but gives no verdict at all for the candidate.
  const e = await runOnce((p) => (isJudge(p) ? success({ results: [] }) : success({ suggestions: [fresh('e1', 'E1')] })))
  out.judgeSilent = {
    created: e.row?.suggestionsCreated,
    newRows: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, e.row.id))).length,
  }

  // (f) rejected blocks; after DELETE the same idea can come back.
  const rej = await insertSuggestion({
    runId: null,
    kind: 'agent',
    action: 'create',
    name: 'bisector',
    title: 'Add a bisector agent',
    rationale: 'r',
    sourceSessionIds: [],
    proposed: agentBody('Bisects regressions.', 'BISECT-ORIGINAL'),
    baseMarkdown: null,
  })
  await rejectSuggestion(rej.id)
  const bisectCandidate = {
    kind: 'agent',
    action: 'create',
    name: 'bisector',
    title: 'A git-bisect helper agent',
    rationale: 'r',
    sourceSessionIds: [],
    proposed: agentBody('Finds the commit that broke it.', 'BISECT-REWORDED'),
  }
  let judgePromptF1 = ''
  const f1 = await runOnce((p) => {
    if (isJudge(p)) {
      judgePromptF1 = p.prompt
      return success({ results: [{ candidateIndex: 0, duplicateOfId: judgePromptF1.includes(rej.id) ? rej.id : null, reason: 'x' }] })
    }
    return success({ suggestions: [bisectCandidate] })
  })
  const del = await request('DELETE', `/api/library/suggestions/${rej.id}`)
  let judgePromptF2 = ''
  const f2 = await runOnce((p) => {
    if (isJudge(p)) {
      judgePromptF2 = p.prompt
      return success({ results: [{ candidateIndex: 0, duplicateOfId: judgePromptF2.includes(rej.id) ? rej.id : null, reason: 'x' }] })
    }
    return success({ suggestions: [bisectCandidate] })
  })
  const resurfaced = await db
    .select()
    .from(librarySuggestions)
    .where(and(eq(librarySuggestions.name, 'bisector'), eq(librarySuggestions.status, 'pending')))
  out.resurface = {
    firstCreated: f1.row?.suggestionsCreated,
    firstSkipped: f1.row?.duplicatesSkipped,
    firstJudgeSawRejected: judgePromptF1.includes(rej.id),
    firstReviewPromptListsRejected: (f1.calls.find((c) => !isJudge(c))?.prompt ?? '').includes('[rejected]'),
    deleteStatus: del.status,
    secondCreated: f2.row?.suggestionsCreated,
    secondJudgeSawRejected: judgePromptF2.includes(rej.id),
    pendingBisector: resurfaced.length,
    pendingBisectorIsNewRow: resurfaced[0]?.id !== rej.id,
  }

  // (g) persistence across runs: rows from earlier runs are still there.
  out.persisted = {
    engineRowsStillThere: (await db.select().from(librarySuggestions).where(eq(librarySuggestions.runId, (facts.engine as any).runId))).length,
  }
  facts.dedupe = out
}

// =============================================================================
// 8. duplicate delivery, no reviewed batch, stale sweeps
// =============================================================================

async function robustnessScenario() {
  const out: Record<string, unknown> = {}

  // Duplicate delivery: the same job handed to runLearning twice at once.
  await settleActive()
  const T = Date.parse('2026-05-01T01:00:00.000Z')
  const project = await newProject('dup-delivery')
  await newSession(project, 'dup', new Date(T - 60_000), 'DUP-DELIVERY')
  const created = await createLearningRun({ trigger: 'manual', windowEnd: new Date(T) })
  if (!('run' in created)) throw new Error('dup: conflict')
  let reviewCalls = 0
  handler = (p) => {
    if (!isJudge(p)) reviewCalls++
    return isJudge(p) ? allNullJudge(p) : success({ suggestions: [] })
  }
  await Promise.all([runLearning({ learningRunId: created.run.id }), runLearning({ learningRunId: created.run.id })])
  await runLearning({ learningRunId: created.run.id })
  out.dupDelivery = { reviewCalls, status: (await runRow(created.run.id))?.status }

  // No batch reviewed: an answer that does not match the schema.
  const bad = await runOnce((p) => (isJudge(p) ? allNullJudge(p) : success({ suggestions: [{ kind: 'prompt' }] })))
  out.malformedReview = { status: bad.row?.status, error: bad.row?.error }
  const failedReview = await runOnce(() => failure())
  out.failedReview = { status: failedReview.row?.status, error: failedReview.row?.error }

  // Stale sweeps, one active row at a time (the unique index allows one).
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  async function insertActive(values: Record<string, unknown>) {
    await settleActive()
    const [row] = await db
      .insert(learningRuns)
      .values({ trigger: 'manual', windowStart: ago(DAY), windowEnd: now, ...values })
      .returning()
    return row.id as string
  }
  const sweep = async (id: string) => {
    const counts = await reconcileStaleLearningRuns(new Date())
    const row = await runRow(id)
    return { counts, status: row?.status, error: row?.error }
  }

  const staleHb = await insertActive({ status: 'running', startedAt: ago(600_000), heartbeatAt: ago(300_000) })
  out.staleHeartbeat = await sweep(staleHb)
  const post1 = await request('POST', '/api/library/learning/runs')
  out.postAfterStaleHeartbeat = post1.status

  const nullHbOld = await insertActive({ status: 'running', startedAt: ago(600_000), heartbeatAt: null })
  out.nullHeartbeatOldStart = await sweep(nullHbOld)

  const freshHb = await insertActive({ status: 'running', startedAt: ago(600_000), heartbeatAt: ago(10_000) })
  out.freshHeartbeat = await sweep(freshHb)

  const justClaimed = await insertActive({ status: 'running', startedAt: ago(20_000), heartbeatAt: null })
  out.justClaimed = await sweep(justClaimed)

  const queuedWaiting = await insertActive({ status: 'queued' })
  jobStates.set(`learning-${queuedWaiting}`, 'waiting')
  out.queuedWaiting = await sweep(queuedWaiting)
  jobStates.set(`learning-${queuedWaiting}`, 'delayed')
  out.queuedDelayed = await sweep(queuedWaiting)
  jobStates.set(`learning-${queuedWaiting}`, 'completed')
  out.queuedJobCompleted = await sweep(queuedWaiting)

  const queuedLost = await insertActive({ status: 'queued' })
  out.queuedLost = await sweep(queuedLost)
  const post2 = await request('POST', '/api/library/learning/runs')
  out.postAfterLost = post2.status
  await settleActive()

  // The recovery sweep landing between createLearningRun's INSERT and its
  // enqueue (runs.ts) — the job does not exist *yet*, it is not lost.
  beforeAddHook = () => reconcileStaleLearningRuns(new Date())
  const racing = await request('POST', '/api/library/learning/runs')
  const racingRow = racing.body?.id ? await runRow(racing.body.id) : undefined
  out.sweepBeforeEnqueue = {
    httpStatus: racing.status,
    reportedStatus: racing.body?.status,
    rowStatus: racingRow?.status,
    rowError: racingRow?.error,
  }
  await settleActive()

  facts.robustness = out
}

// =============================================================================
// no credential (separate process)
// =============================================================================

async function noCredentialScenario() {
  await mkdir(join(LIB, 'agents'), { recursive: true })
  const T = Date.parse('2026-06-01T01:00:00.000Z')
  const project = await newProject('nocred')
  await newSession(project, 'nocred', new Date(T - 60_000), 'NOCRED')
  const created = await createLearningRun({ trigger: 'manual', windowEnd: new Date(T) })
  if (!('run' in created)) throw new Error('nocred: conflict')
  handler = () => success({ suggestions: [] })
  await runLearning({ learningRunId: created.run.id })
  const row = await runRow(created.run.id)
  facts.noCredential = {
    hasClaudeCredential,
    status: row?.status,
    error: row?.error,
    sdkCalls: queryCalls.length,
    finishedAt: row?.finishedAt ? 'set' : null,
  }
}

async function main() {
  await mkdir(dirname(LIB), { recursive: true })
  if (MODE === 'nocred') {
    await noCredentialScenario()
    return
  }
  await rm(LIB, { recursive: true, force: true })
  await seedLibrary()
  const steps: [string, () => Promise<void>][] = [
    ['settings', settingsScenario],
    ['manualRun', manualRunScenario],
    ['window', windowScenario],
    ['engine', engineScenario],
    ['decisions', decisionsScenario],
    ['tamper', tamperScenario],
    ['dedupe', dedupeScenario],
    ['robustness', robustnessScenario],
  ]
  const stepErrors: Record<string, string> = {}
  for (const [name, fn] of steps) {
    try {
      await fn()
    } catch (error) {
      stepErrors[name] = error instanceof Error ? (error.stack ?? error.message) : String(error)
    }
  }
  facts.stepErrors = stepErrors
}

main()
  .then(async () => {
    console.log(`__FACTS__${JSON.stringify(facts)}`)
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    console.log(`__ERROR__${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
