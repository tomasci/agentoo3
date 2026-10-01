// Runs every database-backed learning/suggestion scenario once, against the
// throwaway cluster its parent (learning-db.test.ts) started, and prints what
// happened as JSON — the same child/parent split every other *-db.test.ts
// file in this suite uses (see session-claim-db-child.ts's own header for
// why a child process at all: `@/env` parses process.env once, at first
// import, and this needs a real LIBRARY_DIR and DATABASE_URL before anything
// else in the process touches either).
//
// Real Postgres is what proves the thing a faked `db` cannot: the partial
// unique index enforcing at most one active learning run, and a genuine
// concurrent double-apply racing on the same row. Library writes are real
// filesystem operations too, under a scratch LIBRARY_DIR, so "the file was
// actually written" and "the version history matches the file byte-for-byte"
// are checked against real bytes on disk, not a mock of them.
//
// BullMQ and ioredis are faked exactly as system-settings-db-child.ts fakes
// them: nothing here is testing a queue, only that createLearningRun calls it
// and reacts correctly when it does (or, in one scenario, when it doesn't).

import { readFile } from 'node:fs/promises'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

const enqueued: { name: string; data: unknown; opts: unknown }[] = []
let enqueueShouldFail = false

mock.module('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown, opts: unknown) {
      if (enqueueShouldFail) throw new Error('redis unreachable (simulated)')
      enqueued.push({ name, data, opts })
      return { id: `job-${enqueued.length}` }
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

const { eq } = await import('drizzle-orm')
const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { learningRuns, projects, sessions } = await import(`${SRC}/db/schema.ts`)
const { createApp } = await import(`${SRC}/app.ts`)
const { createLearningRun } = await import(`${SRC}/features/learning/runs.ts`)
const { insertSuggestion } = await import(`${SRC}/features/learning/suggestions.ts`)
const { createAgent } = await import(`${SRC}/features/library/service.ts`)
const { agentPath, skillDir } = await import(`${SRC}/library/index.ts`)
const { join } = await import('node:path')

const facts: Record<string, unknown> = {}
const app = createApp()

type Res = { status: number; body: Record<string, unknown> }

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

async function newProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}`, source: 'existing', status: 'ready' })
    .returning()
  if (!row) throw new Error('no project row')
  return row.id
}

async function newSession(projectId: string, title: string): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId, title, status: 'idle' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

async function readAgentMarkdown(name: string): Promise<string> {
  return readFile(agentPath(name), 'utf8')
}

async function readSkillMarkdown(name: string): Promise<string> {
  return readFile(join(skillDir(name), 'SKILL.md'), 'utf8')
}

// --- 1. at most one active run ----------------------------------------------

async function runConstraintScenarios() {
  const windowEnd = new Date('2026-01-02T04:00:00.000Z')

  const first = await createLearningRun({ trigger: 'manual', windowEnd })
  const firstRun = 'run' in first ? first.run : undefined
  if (!firstRun) throw new Error('expected the first learning run to succeed')
  const enqueuedAfterFirst = enqueued.map((e) => e.name)

  const secondWhileQueued = await createLearningRun({ trigger: 'manual', windowEnd })

  await db.update(learningRuns).set({ status: 'running' }).where(eq(learningRuns.id, firstRun.id))
  const secondWhileRunning = await createLearningRun({ trigger: 'manual', windowEnd })

  await db
    .update(learningRuns)
    .set({ status: 'completed', finishedAt: new Date() })
    .where(eq(learningRuns.id, firstRun.id))
  const afterCompletion = await createLearningRun({ trigger: 'manual', windowEnd })

  facts.runConstraint = {
    firstStatus: firstRun.status,
    firstWindowStart: firstRun.windowStart,
    firstWindowEnd: firstRun.windowEnd,
    enqueuedAfterFirst,
    secondWhileQueuedIsConflict: 'conflict' in secondWhileQueued,
    secondWhileQueuedConflictId:
      'conflict' in secondWhileQueued ? secondWhileQueued.conflict.id === firstRun.id : false,
    secondWhileRunningIsConflict: 'conflict' in secondWhileRunning,
    afterCompletionSucceeded: 'run' in afterCompletion,
    afterCompletionIsNewRow:
      'run' in afterCompletion ? afterCompletion.run.id !== firstRun.id : false,
  }

  // Enqueue failure must not leave the row blocking future runs forever.
  await db.delete(learningRuns)
  enqueueShouldFail = true
  const failedEnqueue = await createLearningRun({ trigger: 'manual', windowEnd })
  enqueueShouldFail = false
  const afterFailedEnqueue = await createLearningRun({ trigger: 'manual', windowEnd })
  facts.enqueueFailure = {
    failedRunStatus: 'run' in failedEnqueue ? failedEnqueue.run.status : 'conflict',
    failedRunHasError: 'run' in failedEnqueue ? Boolean(failedEnqueue.run.error) : false,
    nextRunSucceeded: 'run' in afterFailedEnqueue,
  }

  await db.delete(learningRuns)
}

// --- the HTTP route itself, 202/409 ------------------------------------------

async function runRouteScenarios() {
  const first = await request('POST', '/api/library/learning/runs')
  const second = await request('POST', '/api/library/learning/runs')
  facts.runRoute = {
    firstStatus: first.status,
    firstBodyStatus: first.body.status,
    secondStatus: second.status,
    secondHasError: typeof second.body.error === 'string',
  }
  const overview = await request('GET', '/api/library/learning')
  facts.overview = {
    status: overview.status,
    hasSchedule: typeof overview.body.schedule === 'object',
    activeRunPresent: overview.body.activeRun !== null,
  }
  await db.delete(learningRuns)
}

// --- 2 & 3. apply-modify: write, version history, stale-hash rejection -----

async function modifyScenarios() {
  await createAgent({
    name: 'scout',
    role: 'subagent',
    team: true,
    description: 'Original description',
    prompt: 'Original prompt body.',
  })
  const originalMarkdown = await readAgentMarkdown('scout')

  const project = await newProject('learning-modify-project')
  const session = await newSession(project, 'A session that asked scout for X')

  const suggestion = await insertSuggestion({
    runId: null,
    kind: 'agent',
    action: 'modify',
    name: 'scout',
    title: 'Clarify scout description',
    rationale: 'Multiple sessions asked scout to do X; the description should say so.',
    sourceSessionIds: [session, '00000000-0000-0000-0000-00000000dead'],
    proposed: {
      role: 'subagent',
      team: true,
      description: 'Updated description mentioning X',
      prompt: 'Original prompt body.',
    },
    baseMarkdown: originalMarkdown,
  })

  const summaryList = await request('GET', '/api/library/suggestions?status=pending')
  const detail = await request('GET', `/api/library/suggestions/${suggestion.id}`)

  // Wrong hash: must 409 and leave the file untouched.
  const staleApply = await request('POST', `/api/library/suggestions/${suggestion.id}/apply`, {
    expectedCurrentHash: 'not-the-real-hash',
  })
  const markdownAfterStaleApply = await readAgentMarkdown('scout')
  const suggestionAfterStaleApply = await request('GET', `/api/library/suggestions/${suggestion.id}`)

  // Correct hash: must apply, write the file, and record both versions.
  const goodApply = await request('POST', `/api/library/suggestions/${suggestion.id}/apply`, {
    expectedCurrentHash: (detail.body as { currentHash: string }).currentHash,
  })
  const markdownAfterGoodApply = await readAgentMarkdown('scout')
  const versions = await request('GET', '/api/library/agents/scout/versions')

  // Applying an already-applied suggestion again must 409.
  const reapply = await request('POST', `/api/library/suggestions/${suggestion.id}/apply`, {
    expectedCurrentHash: (detail.body as { currentHash: string }).currentHash,
  })

  facts.modify = {
    summaryListLength: (summaryList.body as unknown[]).length,
    summaryEntry: (summaryList.body as Record<string, unknown>[])[0],
    detailStatus: detail.status,
    detailTargetExists: detail.body.targetExists,
    detailStale: detail.body.stale,
    detailSourceSessions: detail.body.sourceSessions,
    staleApplyStatus: staleApply.status,
    fileUnchangedAfterStaleApply: markdownAfterStaleApply === originalMarkdown,
    suggestionStillPendingAfterStaleApply: suggestionAfterStaleApply.body.status,
    goodApplyStatus: goodApply.status,
    goodApplyStatusField: goodApply.body.status,
    goodApplyAppliedVersion: goodApply.body.appliedVersion,
    fileMatchesProposedAfterApply:
      markdownAfterGoodApply === (detail.body as { proposedMarkdown: string }).proposedMarkdown,
    versionsStatus: versions.status,
    versionsCount: (versions.body as unknown[]).length,
    versions: versions.body,
    reapplyStatus: reapply.status,
  }
}

// --- 4. apply-create: new agent/skill, version 1, 409 if name taken --------

async function createScenarios() {
  const first = await insertSuggestion({
    runId: null,
    kind: 'skill',
    action: 'create',
    name: 'triage',
    title: 'Add a triage skill',
    rationale: 'Sessions repeatedly re-derive the same triage steps.',
    sourceSessionIds: [],
    proposed: { description: 'How to triage an incoming bug report', body: 'Step one. Step two.' },
    baseMarkdown: null,
  })
  const firstApply = await request('POST', `/api/library/suggestions/${first.id}/apply`, {
    expectedCurrentHash: null,
  })
  const createdMarkdown = await readSkillMarkdown('triage')
  const versions = await request('GET', '/api/library/skills/triage/versions')

  const second = await insertSuggestion({
    runId: null,
    kind: 'skill',
    action: 'create',
    name: 'triage',
    title: 'Add a triage skill (again)',
    rationale: 'A duplicate proposal, for the name-taken scenario.',
    sourceSessionIds: [],
    proposed: { description: 'Same idea, proposed twice', body: 'Step one.' },
    baseMarkdown: null,
  })
  const secondApply = await request('POST', `/api/library/suggestions/${second.id}/apply`, {
    expectedCurrentHash: null,
  })
  const secondAfter = await request('GET', `/api/library/suggestions/${second.id}`)

  facts.create = {
    firstApplyStatus: firstApply.status,
    firstApplyVersion: firstApply.body.appliedVersion,
    createdMarkdownHasDescription: createdMarkdown.includes('How to triage an incoming bug report'),
    versionsCount: (versions.body as unknown[]).length,
    secondApplyStatus: secondApply.status,
    secondApplyIsConflict: secondApply.status === 409,
    secondSuggestionStillPending: secondAfter.body.status === 'pending',
  }
}

// --- 5 & 6. reject, and delete only works once rejected ---------------------

async function rejectAndDeleteScenarios() {
  await createAgent({
    name: 'ranger',
    role: 'subagent',
    team: true,
    description: 'Original ranger description',
    prompt: 'Original ranger prompt.',
  })
  const baseMarkdown = await readAgentMarkdown('ranger')
  const suggestion = await insertSuggestion({
    runId: null,
    kind: 'agent',
    action: 'modify',
    name: 'ranger',
    title: 'Tweak ranger',
    rationale: 'For the reject/delete scenario.',
    sourceSessionIds: [],
    proposed: {
      role: 'subagent',
      team: true,
      description: 'A description nobody asked for',
      prompt: 'Original ranger prompt.',
    },
    baseMarkdown,
  })

  // Deleting a pending suggestion must 409.
  const deleteWhilePending = await request('DELETE', `/api/library/suggestions/${suggestion.id}`)

  const reject = await request('POST', `/api/library/suggestions/${suggestion.id}/reject`)
  const rejectedList = await request('GET', '/api/library/suggestions?status=rejected')
  const pendingListAfterReject = await request('GET', '/api/library/suggestions?status=pending')

  // Rejecting an already-rejected suggestion must 409.
  const rejectAgain = await request('POST', `/api/library/suggestions/${suggestion.id}/reject`)

  const del = await request('DELETE', `/api/library/suggestions/${suggestion.id}`)
  const getAfterDelete = await request('GET', `/api/library/suggestions/${suggestion.id}`)
  const deleteAgain = await request('DELETE', `/api/library/suggestions/${suggestion.id}`)
  const deleteUnknown = await request(
    'DELETE',
    '/api/library/suggestions/00000000-0000-0000-0000-000000000000',
  )

  facts.rejectAndDelete = {
    deleteWhilePendingStatus: deleteWhilePending.status,
    rejectStatus: reject.status,
    rejectStatusField: reject.body.status,
    rejectedListIncludesIt: (rejectedList.body as Record<string, unknown>[]).some(
      (s) => s.id === suggestion.id,
    ),
    pendingListExcludesItAfterReject: !(
      pendingListAfterReject.body as Record<string, unknown>[]
    ).some((s) => s.id === suggestion.id),
    rejectAgainStatus: rejectAgain.status,
    deleteStatus: del.status,
    getAfterDeleteStatus: getAfterDelete.status,
    deleteAgainStatus: deleteAgain.status,
    deleteUnknownStatus: deleteUnknown.status,
  }
}

// --- 7. concurrent double-apply writes exactly once -------------------------

async function concurrentApplyScenario() {
  await createAgent({
    name: 'duo',
    role: 'subagent',
    team: true,
    description: 'Original duo description',
    prompt: 'Original duo prompt.',
  })
  const baseMarkdown = await readAgentMarkdown('duo')
  const suggestion = await insertSuggestion({
    runId: null,
    kind: 'agent',
    action: 'modify',
    name: 'duo',
    title: 'Tweak duo',
    rationale: 'For the concurrent-apply scenario.',
    sourceSessionIds: [],
    proposed: {
      role: 'subagent',
      team: true,
      description: 'An updated duo description',
      prompt: 'Original duo prompt.',
    },
    baseMarkdown,
  })
  const detail = await request('GET', `/api/library/suggestions/${suggestion.id}`)
  const hash = (detail.body as { currentHash: string }).currentHash

  const [a, b] = await Promise.all([
    request('POST', `/api/library/suggestions/${suggestion.id}/apply`, {
      expectedCurrentHash: hash,
    }),
    request('POST', `/api/library/suggestions/${suggestion.id}/apply`, {
      expectedCurrentHash: hash,
    }),
  ])
  const statuses = [a.status, b.status].sort()
  const versions = await request('GET', '/api/library/agents/duo/versions')

  facts.concurrentApply = {
    statuses,
    exactlyOneSucceeded: statuses[0] === 200 && statuses[1] === 409,
    versionsCount: (versions.body as unknown[]).length,
  }
}

async function main() {
  await runConstraintScenarios()
  await runRouteScenarios()
  await modifyScenarios()
  await createScenarios()
  await rejectAndDeleteScenarios()
  await concurrentApplyScenario()
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
