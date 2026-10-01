// Runs the learning engine (features/learning/engine.ts's runLearning) for
// real scenarios against the throwaway cluster its parent
// (learning-engine-db.test.ts) started, with @anthropic-ai/claude-agent-sdk
// mocked — the same child/parent split learning-db-child.ts already uses, for
// the identical reason: @/env parses process.env once, at first import.
//
// BullMQ and ioredis are faked exactly as learning-db-child.ts fakes them:
// this is not testing the queue, only the engine's own orchestration against
// real Postgres and a real (temporary) LIBRARY_DIR.

import { mkdir, readFile } from 'node:fs/promises'
import { mock } from 'bun:test'
// features/library/schema.ts's createAgentSchema/createSkillSchema call
// `.openapi()` on their fields, which only exists once @hono/zod-openapi has
// patched zod's prototype (a side effect of importing it at all) — the
// identical precedent tests/system-models.test.ts and tests/learning-
// candidates.test.ts already rely on. learning-db-child.ts never needs this
// because it imports the whole app (createApp) instead, which pulls it in
// for free.
import '@hono/zod-openapi'

const SRC = new URL('../src', import.meta.url).pathname

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-x' }
    }
    async upsertJobScheduler() {}
    async setGlobalConcurrency() {}
    async getJob() {
      return undefined
    }
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

/** Every call `query()` was made with, in order — read back to assert the
 * prompt actually sent (library contents, pending/rejected list, digests). */
const queryCalls: { prompt: string; options: Record<string, unknown> }[] = []
/** What query() yields for the *next* call — shifted off per call, so a test
 * can script an exact sequence (review call, then judge call, ...). */
const responseQueue: (() => AsyncIterable<unknown>)[] = []

async function* empty(): AsyncIterable<unknown> {}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(params)
    const next = responseQueue.shift()
    return (next ?? (() => empty()))()
  },
  // features/learning/engine.ts imports HEARTBEAT_INTERVAL_MS from
  // queue/session-run.worker.ts, which statically imports this real export
  // (via features/sessions/runner-options.ts) — needs to exist in the mock
  // even though nothing in this child's own scenarios ever reaches it.
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

function successStream(answer: unknown, costUsd = 0.01) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(answer),
      total_cost_usd: costUsd,
    }
  })()
}

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { learningRuns, librarySuggestions, messages, projects, sessions } = await import(
  `${SRC}/db/schema.ts`
)
const { runLearning } = await import(`${SRC}/features/learning/engine.ts`)
const { createLearningRun } = await import(`${SRC}/features/learning/runs.ts`)
const {
  deleteRejectedSuggestion,
  insertSuggestion,
  rejectSuggestion,
} = await import(`${SRC}/features/learning/suggestions.ts`)
const { createAgent, createSkill } = await import(`${SRC}/features/library/service.ts`)
const { agentPath } = await import(`${SRC}/library/index.ts`)
const { env } = await import(`${SRC}/env.ts`)

const facts: Record<string, unknown> = {}

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}`, source: 'existing', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

async function newSession(projectId: string, title: string, createdAt: Date): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, title, status: 'completed', createdAt, updatedAt: createdAt })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

/** A single operator prompt row — enough for digestSession to produce
 * non-null content for this session. */
async function addPrompt(sessionId: string, text: string): Promise<void> {
  await db.insert(messages).values({ sessionId, seq: 0, type: 'prompt', payload: { text } })
}

/** Queues a learning run directly against a real row (createLearningRun's own
 * insert + enqueue, same as the manual "run now" button), bypassing the
 * BullMQ dispatch entirely — runLearning is called directly, exactly as
 * queue/session-run.worker.ts's own dispatcher would. */
async function queueRun(windowEnd: Date): Promise<string> {
  const result = await createLearningRun({ trigger: 'manual', windowEnd })
  if (!('run' in result)) throw new Error(`expected a new run, got a conflict: ${JSON.stringify(result)}`)
  return result.run.id
}

async function runRow(id: string) {
  const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, id)).limit(1)
  return row
}

async function pendingSuggestionsFor(name: string) {
  return db
    .select()
    .from(librarySuggestions)
    .where(eq(librarySuggestions.name, name))
}

// --- fixtures: one agent and one skill in the library ------------------------

async function seedLibrary() {
  await createAgent({
    name: 'scout',
    role: 'subagent',
    team: true,
    description: 'Original scout description, mentioning nothing project-specific.',
    prompt: 'Original scout prompt body, full of generic craft.',
  })
  await createSkill({
    name: 'triage',
    description: 'How to triage an incoming bug report, in general.',
    body: 'Step one: reproduce it. Step two: isolate it.',
  })
}

// --- 1. window boundaries, >=2 projects, prompt contains the library --------

async function windowBoundaryScenario() {
  const windowEnd = new Date('2026-02-02T04:00:00.000Z')
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000)

  const projectA = await newProject('learning-engine-a')
  const projectB = await newProject('learning-engine-b')

  const includedA = await newSession(projectA, 'Included: exactly at windowStart', windowStart)
  await addPrompt(includedA, 'Please fix the export button in project A.')

  const includedB = await newSession(projectB, 'Included: well inside the window', new Date(windowStart.getTime() + 60_000))
  await addPrompt(includedB, 'Please add a retry to the upload flow in project B.')

  const excludedAtEnd = await newSession(projectA, 'Excluded: exactly at windowEnd', windowEnd)
  await addPrompt(excludedAtEnd, 'This one must never reach the model.')

  const excludedBefore = await newSession(
    projectA,
    'Excluded: one millisecond before windowStart',
    new Date(windowStart.getTime() - 1),
  )
  await addPrompt(excludedBefore, 'Neither must this one.')

  const runId = await queueRun(windowEnd)
  responseQueue.push(() => successStream({ suggestions: [] }, 0.02))

  await runLearning({ learningRunId: runId })

  const row = await runRow(runId)
  const call = queryCalls.at(-1)
  const prompt = call?.prompt ?? ''

  facts.windowBoundary = {
    status: row?.status,
    sessionsAnalyzed: row?.sessionsAnalyzed,
    suggestionsCreated: row?.suggestionsCreated,
    duplicatesSkipped: row?.duplicatesSkipped,
    costUsd: row?.costUsd,
    error: row?.error,
    promptContainsAgentMarkdown: prompt.includes('Original scout prompt body, full of generic craft.'),
    promptContainsSkillMarkdown: prompt.includes('Step one: reproduce it. Step two: isolate it.'),
    promptContainsIncludedA: prompt.includes(includedA),
    promptContainsIncludedB: prompt.includes(includedB),
    promptContainsExcludedAtEnd: prompt.includes(excludedAtEnd),
    promptContainsExcludedBefore: prompt.includes(excludedBefore),
    callCount: queryCalls.length,
  }
}

// --- 2 & 3. judge-flags-a-rejected-row dedupe, then free-to-resurface, -------
//            and the library file untouched either way --------------------

async function dedupeAndUntouchedFileScenario() {
  const project = await newProject('learning-engine-dedupe')
  const windowEnd = new Date('2026-02-03T04:00:00.000Z')
  const session = await newSession(project, 'Asked scout to do X, again', new Date(windowEnd.getTime() - 60_000))
  await addPrompt(session, 'Scout keeps being asked to handle X — teach it the pattern.')

  const originalMarkdown = await readFile(agentPath('scout'), 'utf8')

  // A rejected suggestion already on file, worded differently from what the
  // model is about to propose — the deterministic layer must NOT catch this
  // on its own; only the judge should.
  const rejected = await insertSuggestion({
    runId: null,
    kind: 'agent',
    action: 'modify',
    name: 'scout',
    title: 'Teach scout about X (first attempt)',
    rationale: 'An earlier run already proposed handling X.',
    sourceSessionIds: [],
    proposed: {
      role: 'subagent',
      team: true,
      description: 'Original scout description, mentioning nothing project-specific.',
      prompt: 'Original scout prompt body, full of generic craft. Also: when asked to do X, always do Y first.',
    },
    baseMarkdown: originalMarkdown,
  })
  await rejectSuggestion(rejected.id)

  const modelProposal = {
    suggestions: [
      {
        kind: 'agent',
        action: 'modify',
        name: 'scout',
        title: 'Teach scout the X pattern',
        rationale: 'Multiple sessions asked scout to handle X the same way.',
        sourceSessionIds: [session],
        proposed: {
          role: 'subagent',
          team: true,
          description: 'Original scout description, mentioning nothing project-specific.',
          prompt: 'Original scout prompt body, full of generic craft. When X comes up, handle it by doing Y first, always.',
        },
      },
    ],
  }

  // --- run 1: the judge marks this a duplicate of the rejected row ----------
  const runId1 = await queueRun(windowEnd)
  responseQueue.push(() => successStream(modelProposal, 0.03))
  responseQueue.push(() =>
    successStream({
      results: [{ candidateIndex: 0, duplicateOfId: rejected.id, reason: 'same underlying pattern' }],
    }, 0.01),
  )
  await runLearning({ learningRunId: runId1 })
  const row1 = await runRow(runId1)
  const afterRun1Markdown = await readFile(agentPath('scout'), 'utf8')
  const pendingAfterRun1 = await pendingSuggestionsFor('scout')

  facts.dedupeRun1 = {
    status: row1?.status,
    suggestionsCreated: row1?.suggestionsCreated,
    duplicatesSkipped: row1?.duplicatesSkipped,
    fileUnchanged: afterRun1Markdown === originalMarkdown,
    noPendingSuggestionInserted: pendingAfterRun1.filter((s) => s.status === 'pending').length === 0,
  }

  // --- the rejected row is deleted: free to resurface ------------------------
  await deleteRejectedSuggestion(rejected.id)

  // --- run 2: the same candidate, nothing left to match against -------------
  const windowEnd2 = new Date(windowEnd.getTime() + 60_000)
  const runId2 = await queueRun(windowEnd2)
  responseQueue.push(() => successStream(modelProposal, 0.03))
  responseQueue.push(() => successStream({ results: [{ candidateIndex: 0, duplicateOfId: null, reason: 'nothing to match' }] }, 0.01))
  await runLearning({ learningRunId: runId2 })
  const row2 = await runRow(runId2)
  const afterRun2Markdown = await readFile(agentPath('scout'), 'utf8')
  const pendingAfterRun2 = (await pendingSuggestionsFor('scout')).filter((s) => s.status === 'pending')

  facts.dedupeRun2 = {
    status: row2?.status,
    suggestionsCreated: row2?.suggestionsCreated,
    duplicatesSkipped: row2?.duplicatesSkipped,
    // The engine must never write to LIBRARY_DIR — only ever produce
    // suggestions — whether or not it decides to insert one.
    fileStillByteIdenticalToOriginal: afterRun2Markdown === originalMarkdown,
    pendingSuggestionInserted: pendingAfterRun2.length === 1,
    insertedMatchesCandidate:
      pendingAfterRun2[0]?.title === 'Teach scout the X pattern' &&
      JSON.stringify(pendingAfterRun2[0]?.sourceSessionIds) === JSON.stringify([session]),
  }
}

// --- 4. zero sessions in the window: completed, zero counters, no SDK call --

async function zeroSessionsScenario() {
  const before = queryCalls.length
  const windowEnd = new Date('2019-01-01T00:00:00.000Z') // far in the past, nothing created then
  const runId = await queueRun(windowEnd)
  await runLearning({ learningRunId: runId })
  const row = await runRow(runId)
  facts.zeroSessions = {
    status: row?.status,
    sessionsAnalyzed: row?.sessionsAnalyzed,
    suggestionsCreated: row?.suggestionsCreated,
    duplicatesSkipped: row?.duplicatesSkipped,
    costUsd: row?.costUsd,
    error: row?.error,
    noNewCalls: queryCalls.length === before,
  }
}

async function main() {
  await mkdir(env.LIBRARY_DIR, { recursive: true })
  await seedLibrary()
  await windowBoundaryScenario()
  await dedupeAndUntouchedFileScenario()
  await zeroSessionsScenario()
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
