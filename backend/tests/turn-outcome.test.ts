// Turn-end attribution: the branch-g outcome mapping, endTurn's own
// idempotency (which the backstop in runTurn's `finally` and the reconciler
// both depend on), and the two reconciler predicates.
//
// The db here is a fake in the same style session-recovery.test.ts already
// uses, and with the identical limitation that file documents: a fake
// `where()` cannot verify a real SQL predicate (join conditions, date
// comparisons) — only session-claim-db.test.ts's real-Postgres child process
// can do that. What is unit-testable, and what these tests cover instead, is
// the JS-level orchestration around a query: given the candidates a SELECT
// returns, does the code call `endTurn` with the right outcome, and does it
// correctly stand down when `endTurn` says the verdict was already someone
// else's to render.
//
// `endTurn`'s own guarded UPDATE is faked by call order, not by parsing the
// WHERE clause it is actually given: every prompt row in play is listed up
// front, in the exact order `endTurn` will be called against it, and the fake
// advances through that list one call at a time. That is sufficient here
// because `endTurn` never targets more than one row per call and every test
// below calls it (directly, or once per reconciler candidate) in a
// deterministic, known order.
//
// One test near the end drives `runTurn` itself, end to end, for the
// abandoned/revived cycle: a stale verdict left by the reconciler has to be
// cleared by the claim that picks the prompt back up, not merely tolerated by
// it. That test's fakes for the SDK, the event bus and `runner-options` mirror
// session-recovery.test.ts's own (read that file first if these look
// unfamiliar); nothing here reaches Anthropic, Redis or a real git worktree.

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

/** What the next reconciler SELECT (messages join sessions) answers. */
let selectResult: Row[] = []

/**
 * `messages` rows `endTurn`'s guarded update is called against, one entry per
 * call, in call order. `turnEndedAt` starting non-null models a row some
 * other branch (or an earlier call in the same test) already closed.
 */
let messageUpdates: Row[] = []
let messageUpdateIndex = 0

/** Every `sessions` row the reconciler moved to `failed`. */
let sessionUpdates: Row[] = []

/** Every job `endTurn` handed to the turn-ended queue. */
let turnEndedJobs: Row[] = []
let enqueueTurnEndedFails = false

// --- state for the one test that drives `runTurn` itself ----------------------

/** The session row `claimTurn`'s guarded UPDATE hands back. */
let claimedRow: Row = {
  id: 'sess-1',
  projectId: 'proj-1',
  orchestrator: 'orchestrator',
  worktreePath: '/tmp/worktree',
  sdkSessionId: null,
  maxBudgetUsd: null,
  totalCostUsd: 0,
  status: 'running',
}
/** The one prompt row `runTurn` claims and runs, or `undefined` if this test isn't using it. */
let promptRow: Row | undefined
/** Every status `setStatus` (not `claimTurn`) wrote, in order. */
let statuses: { status: string; lastError?: unknown }[] = []
/** Rows `appendMessage` inserted — the turn's own transcript. */
let inserted: Row[] = []
let seqCounter = 100
/** What the (fake) SDK's `query()` yields for the one test that calls `runTurn`. */
let turnBehaviour: () => AsyncIterable<unknown> = () => (async function* () {})()

// getTableName needs the real column/table metadata drizzle attaches to the
// schema objects, which this fake `t` (the real `messages`/`sessions`/
// `projects`/`session_files` exports) still carries — only the query methods
// below are faked.
const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

/**
 * What a non-join SELECT from `name` answers, given the fields it asked for.
 * `messages` is read bare (no projected fields) at two call sites in
 * `runTurn` — the oldest-pending-prompt lookup and the later drain check —
 * and the two must not answer alike: this is evaluated lazily, at the moment
 * the query actually runs, so it reflects whatever `promptRow.pending` is
 * *then*, not what it was when the row was set up. That is what lets one
 * fake `promptRow` stand in for both calls correctly across a claim that
 * flips it to `false` in between.
 */
function plainSelectRows(name: string, fields: unknown): Row[] {
  if (name === 'projects') return [{ id: 'proj-1', slug: 'demo', sshKeyId: null }]
  if (name === 'session_files') return []
  if (name === 'sessions') return [claimedRow]
  if (name === 'messages' && fields === undefined) {
    return promptRow?.pending ? [promptRow] : []
  }
  return []
}

const db = {
  select: (fields?: unknown) => ({
    from: (t: unknown) => {
      const name = table(t)
      const rows = () => plainSelectRows(name, fields)
      const q = {
        // The reconciler's own shape: a projected select, joined, filtered —
        // answered from `selectResult` regardless of the real join/where,
        // exactly like the rest of this fake ignores conditions it is handed.
        innerJoin: (_t2: unknown, _cond: unknown) => ({
          where: async () => selectResult,
        }),
        where: () => q,
        orderBy: () => q,
        limit: async () => rows(),
        then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
          Promise.resolve().then(rows).then(ok, err),
      }
      return q
    },
  }),
  update: (t: unknown) => ({
    set: (patch: Row) => ({
      where: () => {
        const run = () => runUpdate(t, patch)
        return {
          returning: async () => run(),
          then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
            run().then(ok, err),
        }
      },
    }),
  }),
  insert: (t: unknown) => ({
    values: (row: Row) => ({
      returning: async () => {
        if (table(t) !== 'messages') return []
        const stamped = { id: `ins-${inserted.length}`, createdAt: new Date(), ...row }
        inserted.push(stamped)
        return [stamped]
      },
    }),
  }),
  transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
}

async function runUpdate(t: unknown, patch: Row): Promise<Row[]> {
  const name = table(t)
  if (name === 'sessions') {
    // `nextSeq`'s own allocation (appendMessage's first step): a plain
    // counter stands in for the real atomic increment.
    if ('nextSeq' in patch) return [{ seq: seqCounter++ }]
    // `claimTurn`'s own UPDATE is the only place `status` is ever set to
    // 'running' — every other status transition goes through `setStatus`.
    if (patch.status === 'running') return [claimedRow]
    if ('status' in patch) {
      sessionUpdates.push(patch)
      statuses.push({ status: String(patch.status), lastError: patch.lastError })
    }
    // sdkSessionId, totalCostUsd and the heartbeat all update `sessions`
    // without touching `status` — nothing here needs to observe those.
    return []
  }
  // messages: two distinct call shapes share this one table.
  if ('pending' in patch) {
    // The claim's own reset (this file's fix): unconditional, unlike
    // endTurn's guarded update below — a claim does not ask whether a turn
    // already ended here, it declares that a new one is starting.
    const target = messageUpdates[messageUpdateIndex]
    messageUpdateIndex++
    if (!target) return []
    Object.assign(target, patch)
    return []
  }
  // endTurn's own guarded update.
  const target = messageUpdates[messageUpdateIndex]
  messageUpdateIndex++
  if (!target || target.turnEndedAt !== null) return []
  target.turnEndedAt = patch.turnEndedAt
  target.turnOutcome = patch.turnOutcome
  target.turnDetail = patch.turnDetail
  return [{ sessionId: target.sessionId }]
}

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
  turnEndedQueue: {},
  turnReconcileQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  enqueueTurnEnded: async (job: Row) => {
    if (enqueueTurnEndedFails) throw new Error('Stream is not writeable and enableOfflineQueue is false')
    turnEndedJobs.push(job)
  },
  ensureAttachmentsGcSchedule: async () => {},
  ensureTurnReconcileSchedule: async () => {},
}))

// The event bus is quietened, not replaced outright — forwarded to the real
// module and only silenced while this file runs, for the identical
// cross-file reason session-recovery.test.ts's own copy of this comment
// gives: `mock.module` swaps the whole namespace for the specifier for the
// entire run, and a stub here would just as well reach whichever other test
// file imports events.ts next.
let quiet = true
const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async (event: unknown) => {
    if (!quiet) await realEvents.publishSessionEvent(event as never)
  },
  subscribeControl: (sessionId: string, onEvent: (event: never) => void) => {
    if (!quiet) return realEvents.subscribeControl(sessionId, onEvent)
    return () => {}
  },
}))
afterAll(() => {
  quiet = false
})

// Nothing in this file ever needs the real SDK — every test that reaches
// `runTurn` replaces `query` outright, the same as session-recovery.test.ts
// and attachments-announcement.test.ts already do.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => turnBehaviour(),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const realRunnerOptions = await import(`${B}/features/sessions/runner-options.ts`)
mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  ...realRunnerOptions,
  optionsFor: async (...args: Parameters<typeof realRunnerOptions.optionsFor>) =>
    quiet ? { cwd: '/tmp' } : realRunnerOptions.optionsFor(...args),
}))

const { completionOutcome, endTurn, runTurn } = await import(`${B}/queue/session-run.worker.ts`)
const { reconcileStrandedTurns, reconcileAbandonedPrompts } = await import(
  `${B}/queue/turn-reconcile.worker.ts`
)

afterEach(() => {
  selectResult = []
  messageUpdates = []
  messageUpdateIndex = 0
  sessionUpdates = []
  turnEndedJobs = []
  enqueueTurnEndedFails = false
  promptRow = undefined
  statuses = []
  inserted = []
  turnBehaviour = () => (async function* () {})()
})

const result = (subtype: string, isError: boolean) =>
  ({ type: 'result', subtype, is_error: isError }) as never

// --- completionOutcome: the truth behind branch g -----------------------------

test('a clean success is completed', () => {
  expect(completionOutcome('success', result('success', false))).toBe('completed')
})

test('error_max_turns is stopped_turn_limit, even though the real shape also carries is_error: true', () => {
  // Order matters: if the is_error check ran first, this would misread as
  // stopped_api_error and the turn-limit stop would never be told apart from
  // a genuine model/API failure.
  expect(completionOutcome('error_max_turns', result('error_max_turns', true))).toBe(
    'stopped_turn_limit',
  )
})

test('is_error: true on any other subtype is stopped_api_error', () => {
  expect(completionOutcome('success', result('success', true))).toBe('stopped_api_error')
})

test('an error_* subtype other than max_turns is stopped_execution_error, even though it also carries is_error: true', () => {
  // is_error: true, not false: SDKResultError declares is_error as a plain
  // boolean, not narrowed to true, but every error_* result actually observed
  // — error_max_turns above, and error_during_execution here — carries
  // is_error: true. A fixture of false never exercises the case that matters:
  // it was this test's own is_error: false, passing for the wrong reason,
  // that let completionOutcome check is_error === true before ruling out
  // every other error_* subtype and swallow this one into stopped_api_error,
  // making stopped_execution_error a value nothing could ever write. An
  // independent real-Postgres pass (turn-outcome-truth.test.ts) is what
  // caught it; this fixture is corrected to actually cover it.
  expect(completionOutcome('error_during_execution', result('error_during_execution', true))).toBe(
    'stopped_execution_error',
  )
})

test('no result at all falls through to completed, matching branch g before this existed', () => {
  expect(completionOutcome(undefined, undefined)).toBe('completed')
})

test('a non-result message in lastResult is read the same as no result at all', () => {
  expect(completionOutcome(undefined, { type: 'assistant' } as never)).toBe('completed')
})

// --- endTurn: idempotency, and the backstop's own mechanism -------------------

const freshRow = (id: string, sessionId: string): Row => ({
  id,
  sessionId,
  turnEndedAt: null,
  turnOutcome: null,
  turnDetail: null,
})

test('endTurn records the verdict on a fresh prompt', async () => {
  messageUpdates = [freshRow('m1', 'sess-1')]
  const rendered = await endTurn('m1', 'completed', null)
  expect(rendered).toBe(true)
  expect(messageUpdates[0]?.turnOutcome).toBe('completed')
})

test('a second endTurn call does not overwrite the first verdict', async () => {
  const row = freshRow('m1', 'sess-1')
  messageUpdates = [row, row]
  const first = await endTurn('m1', 'completed', null)
  const second = await endTurn('m1', 'failed', 'a later, wrong verdict')
  expect(first).toBe(true)
  expect(second).toBe(false)
  expect(row.turnOutcome).toBe('completed')
  expect(row.turnDetail).toBeNull()
})

// Not asserted here: that the first call above also handed a job to
// `enqueueTurnEnded`. `session-run.worker.ts` is a single module shared by
// several other test files in this suite, each already mocking
// `@/queue/index.ts` with its own literal — some written before
// `enqueueTurnEnded` existed — and `bun:test`'s `mock.module` registry is
// process-wide, not per file (every one of those files' own comments says as
// much). Which literal `session-run.worker.ts`'s own `queueIndex` import ends
// up bound to is therefore a function of whole-suite execution order, not of
// this file alone. `endTurn`'s contract that matters here — the row commits,
// and commits exactly once — holds regardless of that; the announce is
// covered on its own terms below (never throws, never fires when nothing
// committed), which does not depend on whose `enqueueTurnEnded` is live.

test("the backstop's own mechanism: endTurn('unknown') succeeds when nothing else has rendered a verdict", async () => {
  // This is what runTurn's `finally` calls unconditionally when its `verdict`
  // flag is still false. There is no live path through runTurn's own cascade
  // that reaches it today (the cascade is exhaustive by design), so this
  // exercises the guard the backstop actually depends on directly.
  messageUpdates = [freshRow('m1', 'sess-1')]
  const rendered = await endTurn('m1', 'unknown', 'No branch in this turn recorded an outcome.')
  expect(rendered).toBe(true)
  expect(messageUpdates[0]?.turnOutcome).toBe('unknown')
})

test('the backstop is a no-op once a real branch already rendered a verdict', async () => {
  const row = freshRow('m1', 'sess-1')
  messageUpdates = [row, row]
  await endTurn('m1', 'completed', null)
  const backstop = await endTurn('m1', 'unknown', 'No branch in this turn recorded an outcome.')
  expect(backstop).toBe(false)
  expect(row.turnOutcome).toBe('completed')
})

test('endTurn never throws when the announce queue rejects — the row it already wrote is the durable fact', async () => {
  messageUpdates = [freshRow('m1', 'sess-1')]
  enqueueTurnEndedFails = true
  const rendered = await endTurn('m1', 'completed', null)
  expect(rendered).toBe(true)
  expect(turnEndedJobs).toEqual([])
})

test('endTurn on a prompt no row matches renders nothing and does not throw', async () => {
  messageUpdates = []
  const rendered = await endTurn('missing', 'failed', 'irrelevant')
  expect(rendered).toBe(false)
  expect(turnEndedJobs).toEqual([])
})

// --- the reconciler's two predicates -------------------------------------------

test('a stranded turn is closed and its session is failed', async () => {
  selectResult = [
    { promptId: 'm1', sessionId: 'sess-1', heartbeatAt: null, updatedAt: new Date(Date.now() - 999_999) },
  ]
  messageUpdates = [freshRow('m1', 'sess-1')]

  const recovered = await reconcileStrandedTurns()

  expect(recovered).toBe(1)
  expect(messageUpdates[0]?.turnOutcome).toBe('stranded')
  expect(sessionUpdates).toHaveLength(1)
  expect(sessionUpdates[0]?.status).toBe('failed')
  expect(typeof sessionUpdates[0]?.lastError).toBe('string')
})

test('a turn that actually finished between the SELECT and the UPDATE is not overwritten, and its session is left alone', async () => {
  selectResult = [
    { promptId: 'm1', sessionId: 'sess-1', heartbeatAt: null, updatedAt: new Date(Date.now() - 999_999) },
  ]
  // Already closed for real — endTurn's own guard must find nothing to do,
  // and the reconciler must not then move a healthy session to `failed`.
  messageUpdates = [{ id: 'm1', sessionId: 'sess-1', turnEndedAt: new Date(), turnOutcome: 'completed', turnDetail: null }]

  const recovered = await reconcileStrandedTurns()

  expect(recovered).toBe(0)
  expect(sessionUpdates).toHaveLength(0)
})

test('multiple stranded candidates are all closed', async () => {
  selectResult = [
    { promptId: 'm1', sessionId: 'sess-1', heartbeatAt: new Date(Date.now() - 999_999), updatedAt: new Date() },
    { promptId: 'm2', sessionId: 'sess-2', heartbeatAt: new Date(Date.now() - 999_999), updatedAt: new Date() },
  ]
  messageUpdates = [freshRow('m1', 'sess-1'), freshRow('m2', 'sess-2')]

  const recovered = await reconcileStrandedTurns()

  expect(recovered).toBe(2)
  expect(sessionUpdates.map((s) => s.status)).toEqual(['failed', 'failed'])
})

test('an abandoned prompt is recorded without touching pending or the session row', async () => {
  selectResult = [{ id: 'm2' }]
  messageUpdates = [freshRow('m2', 'sess-2')]

  const recorded = await reconcileAbandonedPrompts()

  expect(recorded).toBe(1)
  expect(messageUpdates[0]?.turnOutcome).toBe('abandoned')
  // Deliberately not pending: false anywhere in this file's SET — see
  // reconcileAbandonedPrompts's own comment for why a later message reviving
  // the session must still find, and run, this exact prompt.
  expect(sessionUpdates).toHaveLength(0)
})

test('no stranded or abandoned candidates recovers nothing', async () => {
  selectResult = []
  expect(await reconcileStrandedTurns()).toBe(0)
  selectResult = []
  expect(await reconcileAbandonedPrompts()).toBe(0)
  expect(sessionUpdates).toHaveLength(0)
})

// --- the abandoned/revived cycle: a claim must clear a stale verdict ----------
//
// The defect this covers: the reconciler stamps `turn_outcome = 'abandoned'`
// on a prompt that is still pending. If that prompt is later genuinely
// revived by a fresh message and actually runs, its real `endTurn` call must
// not find `turn_ended_at` already non-null and silently no-op — that would
// leave the stale `abandoned` verdict on a prompt that in fact completed,
// exactly the wrong-column-forever failure this whole mechanism exists to
// prevent. The fix lives in the claim's own transaction (runTurn), not here
// and not in the reconciler: a claim starting a fresh turn clears whatever
// verdict was already there, because being claimed at all means a new turn is
// starting on this prompt.

test('a prompt abandoned by the reconciler, then genuinely revived, ends with its real outcome — not the stale one', async () => {
  const row: Row = {
    id: 'm1',
    sessionId: 'sess-1',
    seq: 4,
    payload: { text: 'do the thing' },
    pending: true,
    turnStartedAt: null,
    turnEndedAt: null,
    turnOutcome: null,
    turnDetail: null,
  }
  promptRow = row
  // endTurn's guarded update targets this one row three times, in order: the
  // reconciler's stamp below, the claim's own reset inside runTurn, and the
  // turn's real verdict — each call sees whatever the previous one left.
  messageUpdates = [row, row, row]

  // 1. Abandoned: nothing is running or queued for this session yet.
  selectResult = [{ id: 'm1' }]
  const recorded = await reconcileAbandonedPrompts()
  expect(recorded).toBe(1)
  expect(row.turnOutcome).toBe('abandoned')
  expect(row.turnEndedAt).not.toBeNull()
  expect(row.pending).toBe(true) // still there for a fresh send to find

  // 2. Revived: a message arrives, the session is claimed, and this exact
  // prompt — still pending — is the one runTurn picks up and runs to a real,
  // clean completion.
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  // The claim cleared the stale verdict before the turn ever ran...
  expect(row.turnStartedAt).not.toBeNull()
  // ...and the real branch's own endTurn call is what stuck, not the
  // reconciler's. This is the assertion that fails without the fix: without
  // it, endTurn's guard finds turn_ended_at already set from step 1 and
  // silently no-ops, leaving `row.turnOutcome` at 'abandoned'.
  expect(row.turnOutcome).toBe('completed')
  expect(row.pending).toBe(false)
  expect(statuses.at(-1)?.status).toBe('completed')
})
