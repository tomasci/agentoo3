// The loop that closes the Idea Manager, against a real Postgres.
//
// Every scenario here turns on something a faked `db` cannot honestly
// answer: a real unique-constraint violation on `idea_runs_open_key` when
// two sweeps race the same idea, a real `createSession` failure, and real
// relational data for the continuation-chain walk. See
// idea-handoff-db-child.ts for why this runs in a child process (the `@/env`
// first-import-wins constraint pg-cluster.ts's own header explains) and for
// the fixtures behind each fact below.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis, bullmq
      // and the event bus. `@/env` still insists on a value.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: `/tmp/agentoo-idea-handoff-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-idea-handoff-test-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-handoff-db-child.ts')], {
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
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the idea-handoff scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(8)
})

// --- the claim: two concurrent sweeps of one idea produce exactly one run ---

dbTest('two concurrent sweeps of one idea produce exactly one run', () => {
  const f = fact('twoConcurrentSweeps')
  expect(f.runCount).toBe(1)
  expect(f.status).toBe('generating')
  // Neither sweep's own createIdeaPrompt call reached far enough to advance
  // the card off the column it was claimed from.
  expect(f.ideaStatusStillSelected).toBe('selected_for_development')
})

// --- the handoff itself: assets land before the prompt message does --------

dbTest('assets are copied into the session before the prompt message is sent', () => {
  const f = fact('assetOrdering')
  expect(f.callOrder).toEqual(['attach', 'send'])
  expect(f.copiedFileCount).toBe(1)
  expect(f.runStatus).toBe('running')
  expect(f.promptMessageIdSet).toBe(true)
  expect(f.ideaStatusAfter).toBe('in_progress_dev')
  // The session DTO's ideaId is the reverse of ideas.sessionId, joined in
  // rather than stored — this is what proves the join actually finds the row
  // handoff just wrote, not merely that the column exists.
  expect(f.sessionIdeaId).toBe(f.ideaId)
})

// --- a createSession failure closes the run and writes ideas.lastError -----

dbTest('a createSession failure closes the run needs_attention and writes lastError', () => {
  const f = fact('createSessionFailure')
  expect(f.runStatus).toBe('closed')
  expect(f.runOutcome).toBe('needs_attention')
  expect(f.runEndedAtSet).toBe(true)
  // The card never advanced off the column it was claimed from — the
  // handoff never reached the point that moves it.
  expect(f.ideaStatusUnchanged).toBe('selected_for_development')
  expect(String(f.ideaLastError)).toContain('Could not create a session')
  expect(String(f.ideaLastError)).toContain('is missing')
})

// --- the full outcome -> (run outcome, board move, lastError) mapping ------

dbTest('every turn_outcome maps to the documented run outcome and board move', () => {
  const results = fact<Record<string, { matchesExpectation: boolean }>>('outcomeMapping')
  for (const [outcome, result] of Object.entries(results)) {
    expect([outcome, result.matchesExpectation]).toEqual([outcome, true])
  }
})

dbTest('completed clears lastError; every other outcome carries one but "finished"', () => {
  const results = fact<
    Record<string, { lastErrorIsNull: boolean; lastErrorMentionsSentinel: boolean }>
  >('outcomeMapping')
  expect(results.completed?.lastErrorIsNull).toBe(true)
  expect(results.interrupted?.lastErrorIsNull).toBe(true)
  expect(results.drained?.lastErrorIsNull).toBe(false)
  expect(results.failed?.lastErrorIsNull).toBe(false)
  // The needs_attention group carries the turn's own sentence verbatim, not a
  // generic label — each case's sentinel detail names its own outcome.
  expect(results.stopped_over_budget?.lastErrorMentionsSentinel).toBe(true)
  expect(results.failed?.lastErrorMentionsSentinel).toBe(true)
  expect(results.stranded?.lastErrorMentionsSentinel).toBe(true)
})

// --- a `continuing` outcome leaves the run open and the card unmoved --------

dbTest('a continuing outcome leaves the run open and the idea unmoved', () => {
  const f = fact('continuingLeavesOpen')
  expect(f.runStatus).toBe('running')
  expect(f.runEndedAtIsNull).toBe(true)
  expect(f.runOutcomeIsNull).toBe(true)
  expect(f.ideaStatus).toBe('in_progress_dev')
})

// --- a two-hop continuation chain closes on the tail's outcome --------------

dbTest('a two-hop chain stays open through both continuations', () => {
  const f = fact('twoHopChain')
  expect(f.stillOpenAfterRootContinuing).toBe(true)
  expect(f.stillOpenAfterHop1Continuing).toBe(true)
})

dbTest('...and closes on the tail message\'s own outcome, not the root\'s', () => {
  const f = fact('twoHopChain')
  expect(f.finalRunOutcome).toBe('finished')
  expect(f.finalRunStatus).toBe('closed')
  expect(f.finalIdeaStatus).toBe('verification')
  expect(String(f.finalRunDetail)).toContain('Done, end to end.')
})

// --- idea_runs.detail: the last result message, falling back to turnDetail -

dbTest('idea_runs.detail reads the last result message verbatim when there is one', () => {
  const f = fact('runDetailDigest')
  expect(f.withResultMessage).toBe('The agent shipped the export button.')
})

dbTest('...and falls back to the turn\'s own detail when there is no result message', () => {
  const f = fact('runDetailDigest')
  expect(f.withoutResultMessageFallsBackToTurnDetail).toBe('Stopped: over budget.')
})

// --- the reconciler's third predicate ---------------------------------------

dbTest('a run whose session was deleted closes as session_deleted', () => {
  const f = fact('sessionDeleted')
  expect(f.closedCount).toBe(1)
  expect(f.runOutcome).toBe('session_deleted')
  expect(f.runStatus).toBe('closed')
  expect(f.runSessionIdNull).toBe(true)
})

dbTest('...but a run still generating (no session assigned yet) is left alone', () => {
  const f = fact('generatingRunNotOrphaned')
  expect(f.status).toBe('generating')
  expect(f.endedAtIsNull).toBe(true)
})

// --- the follow-up path ------------------------------------------------------

dbTest('continueIdea claims a follow-up run, and a second call while it is open conflicts', () => {
  const f = fact('continueIdea')
  expect(f.openRunKind).toBe('followup')
  expect(f.openRunStatus).toBe('generating')
  expect(String(f.conflictOnSecondCall)).toContain('already has a handoff in progress')
})

// --- the retry gate: a fixable failure re-triggers once per user action, ---
// never on its own ------------------------------------------------------------

dbTest('a handoff that fails for a missing orchestrator strands the card, lastError and all', () => {
  const f = fact('retryGate')
  expect(f.ideaStatusAfterFailure).toBe('selected_for_development')
  expect(f.lastErrorMentionsOrchestrator).toBe(true)
  expect(f.runCountAfterFailure).toBe(1)
})

dbTest('an idle re-sweep claims nothing — the assertion that guards the gate', () => {
  const f = fact('retryGate')
  // If closeRun ever bumps ideas.updatedAt again, this fails: the just-closed
  // run would satisfy "closed at or after updatedAt" trivially and a second
  // run would appear here with no user action at all.
  expect(f.runCountAfterIdleResweep).toBe(1)
})

dbTest('fixing the orchestrator makes the next sweep claim exactly once', () => {
  const f = fact('retryGate')
  expect(f.runCountAfterFix).toBe(2)
})

dbTest('...and a further idle sweep claims nothing again', () => {
  const f = fact('retryGate')
  expect(f.runCountAfterSecondIdleResweep).toBe(2)
})

// --- crash recovery: a re-dispatch adopts the already-sent message ---------

dbTest('a re-dispatch after the promptMessageId-commit crash adopts the same message rather than resending', () => {
  const f = fact('crashRecovery')
  expect(f.promptMessageCount).toBe(1)
  expect(f.adoptedSameMessageId).toBe(true)
  expect(f.runStatus).toBe('running')
  expect(f.ideaStatus).toBe('in_progress_dev')
})
