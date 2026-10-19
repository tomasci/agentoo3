// What a session does about a turn that ended badly.
//
// Two layers, because the bug this covers had both. `recover` is the decision:
// given how many times this session has already been nudged, does it send
// another continuation or stop and say why — and what does it do when the nudge
// itself cannot be delivered, which is the likely case, since the failure it
// exists for is the machine running out of memory. `runTurn` is the wiring: a
// turn whose CLI was killed has to reach that decision at all, rather than
// being recorded as a failure the way it was before.

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

/** Auto-prompt rows `autoContinuationsSincePrompt` reads back, newest first. */
let transcript: Row[] = []
/** The pending prompt a turn picks up. */
let pending: Row[] = [{ id: 'msg-1', seq: 4, payload: { text: 'do the thing' } }]
/** Messages that arrived while the turn was running, if any. */
let arrivedDuringTurn: Row[] = []
/** Control-event handlers the turn registered, so a test can interrupt it. */
let interrupters: ((event: { kind: 'interrupt' }) => void)[] = []
/** Every message row written, in order. */
let written: Row[] = []
/** Every status the session was moved to, with its lastError. */
let statuses: { status: string; lastError?: unknown }[] = []
/** Turns queued to run. */
let queued: string[] = []
/** What each turn handed the SDK's `query`, and what it asked `optionsFor` for. */
let queryCalls: { prompt: string }[] = []
let optionsCalls: unknown[][] = []

/**
 * Failure switches, each standing for a database or queue dying mid-recovery.
 *
 * `insertFails` needs no scope of its own: every insert on these paths is a
 * transcript write through `appendMessage`, and the claim writes none.
 * `messageReadFails` does need one — see below.
 */
let insertFails = false
/**
 * Reads of the `messages` table fail, and only those: the continuation count,
 * the mid-turn drain check, and the stranded-prompt read. Those three are what
 * every test below that sets this flag is about.
 *
 * The scope is the point. This used to fail every projected select the fake was
 * asked for, which quietly included the session row a claim read about itself
 * while `claimTurn` was briefly a transaction rather than one statement — so
 * 'a database that cannot answer the stranded-prompt read' threw out of the
 * claim before the turn had begun, and stopped covering the read it is named
 * for while still passing as a test of it. What the claim reads about the
 * session is answered whatever this says.
 */
let messageReadFails = false
let statusWriteFails = false
let enqueueFails = false

/**
 * The `compact_context` row a compacted session starts from, as the turn's
 * unordered, unprojected read of `messages` sees it. Empty for every session
 * that was not made by compaction, which is every test but the seeding ones.
 */
let contextRows: Row[] = []
/** That read failing, as a database going down at the worst moment would. */
let contextReadFails = false
/** The `set()` argument of every update, so a test can prove what was never written. */
let updateSets: Row[] = []

/** What the SDK's `query` does when a turn runs. */
let turnBehaviour: () => AsyncIterable<unknown> = () => empty()

let seq = 100

const DB_DOWN = 'terminating connection due to administrator command'

async function* empty(): AsyncIterable<unknown> {}

async function* throwing(message: string): AsyncIterable<unknown> {
  // A generator, not a rejected promise: this is how the SDK surfaces a dead
  // CLI — the failure arrives while the caller is iterating the stream.
  await Promise.resolve()
  throw new Error(message)
  // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
  yield undefined
}

// Drizzle's builders are thenable and chain in a fixed order, so the fake only
// answers the shapes this file's code path actually builds. `.where()` serves
// two of them: awaited directly it is a status update, and `.returning()` on it
// is the sequence allocation.
const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

/** The session row this fake hands back, whether it is claimed or merely read. */
const claimedRow: Row = {
  id: 'sess-1',
  projectId: 'proj-1',
  orchestrator: 'orchestrator',
  worktreePath: '/tmp/worktree',
  sdkSessionId: null,
  maxBudgetUsd: null,
  totalCostUsd: 0,
  status: 'running',
}

const db = {
  select: (fields?: unknown) => ({
    from: (t: unknown) => {
      // A projection means `autoContinuationsSincePrompt`, which reads prompts
      // back; a bare select means the turn picking up its pending message.
      let ordered = false
      const rows = () => {
        if (table(t) === 'projects') return [{ id: 'proj-1', slug: 'demo', sshKeyId: null }]
        // The attachments announcement's own select — nothing here uploads a
        // file, so there is never anything new to announce.
        if (table(t) === 'session_files') return []
        // Anything the claim reads about the session itself. `running` is the
        // coherent answer here because this fake's claim always succeeds, so
        // runTurn's blocked-vs-lost re-read — the only other reader of this row
        // — would find the turn taken. A refused claim cannot be reached
        // through this fake at all; session-claim-db.test.ts covers that
        // against a real Postgres.
        if (table(t) === 'sessions') return [claimedRow]
        // The one read of `messages` with no projection and no ordering: the
        // compacted-session seed (a claim's pending prompt is ordered).
        if (fields === undefined && !ordered && table(t) === 'messages') {
          if (contextReadFails) throw new Error(DB_DOWN)
          return contextRows
        }
        if (fields === undefined) return pending
        if (messageReadFails) throw new Error(DB_DOWN)
        // Ordered means `autoContinuationsSincePrompt` reading prompts back;
        // unordered is the turn checking whether anything arrived while it ran.
        return ordered ? transcript : arrivedDuringTurn
      }
      const q = {
        where: () => q,
        orderBy: () => {
          ordered = true
          return q
        },
        limit: async () => rows(),
        then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(rows)
            .then(ok, err),
      }
      return q
    },
  }),
  update: (t: unknown) => {
    let payload: Row = {}
    const where = () => ({
      returning: async (fields?: unknown) => {
        if (fields !== undefined) return [{ seq: seq++ }]
        // The turn's claim: whatever the conditional UPDATE returns is the
        // session it owns.
        return [claimedRow]
      },
      then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) => {
        if (table(t) === 'sessions' && 'status' in payload) {
          if (statusWriteFails) return Promise.reject(new Error(DB_DOWN)).then(ok, err)
          statuses.push({ status: String(payload.status), lastError: payload.lastError })
        }
        return Promise.resolve([]).then(ok, err)
      },
    })
    return {
      set: (p: Row) => {
        payload = p
        updateSets.push(p)
        return { where }
      },
    }
  },
  insert: () => ({
    values: (row: Row) => ({
      returning: async () => {
        if (insertFails) throw new Error(DB_DOWN)
        // Real Postgres fills these in on INSERT (defaultRandom/defaultNow);
        // toMessageDto (the one place a published message is built — see
        // service.ts) needs a real createdAt now that appendMessage publishes
        // through it rather than the bare row.
        const stamped = { id: `msg-${written.length}`, createdAt: new Date(), ...row }
        written.push(stamped)
        return [stamped]
      },
    }),
  }),
  // The attachments announcement runs inside one — see session-run.worker.ts.
  // Nothing here needs real atomicity, only that the callback gets an object
  // shaped like `db` itself to call `.select`/`.update`/`.insert` on.
  transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
}

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

// The event bus is quietened rather than replaced.
//
// Two constraints meet here. Everything this file writes is published, and a
// publish against the Redis that is not running takes seconds to give up —
// eight tests timed out on it. But `mock.module` swaps a module for the *whole
// run*, not for one file, so a stub namespace also reaches
// session-stream.test.ts, which needs the real bus: replacing it outright took
// five of its tests down.
//
// So the replacement forwards to the real module and only holds its tongue
// while this file is running. It is built eagerly, before the mock is
// registered: `mock.module` rebinds the live namespace, so a factory that
// spread `realEvents` at call time would be spreading *this replacement* — and
// its publish would call itself until the stack ran out.
let quiet = true
const realEvents = await import(`${B}/lib/events.ts`)
const realPublish = realEvents.publishSessionEvent
const realSubscribeControl = realEvents.subscribeControl
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async (event: unknown) => {
    if (!quiet) await realPublish(event as never)
  },
  subscribeControl: (sessionId: string, onEvent: (event: never) => void) => {
    if (!quiet) return realSubscribeControl(sessionId, onEvent)
    interrupters.push(onEvent as (event: { kind: 'interrupt' }) => void)
    return () => {}
  },
}))
afterAll(() => {
  quiet = false
})

mock.module(`${B}/queue/index.ts`, () => ({
  // Additive stub for features/editor -- not exercised here, kept only so
  // this hard-coded (non-spread) mock does not remove it from the shared
  // module for whichever other test file imports it while this mock is live.
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  // attachments/service.ts's storageSummary reads completed-job history off
  // this for lastCheckAt/lastCleanupAt; nothing this file exercises reaches
  // that path, so an empty history is enough to satisfy the import.
  attachmentsGcQueue: { getJobs: async () => [] },
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async ({ sessionId }: { sessionId: string }) => {
    if (enqueueFails) throw new Error('Stream is not writeable and enableOfflineQueue is false')
    queued.push(sessionId)
    return {}
  },
  enqueueAttachmentsGc: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
  enqueueLearningRun: async () => ({}),
  // endTurn reads this off a namespace import. When this file is the first to
  // load queue/index.ts the name is simply absent and the call fails fast, but
  // when an earlier file in the same run has already loaded the real module
  // (turn-mode.test.ts does, through runner-options), mock.module keeps every
  // export this object does not list, so the REAL enqueueTurnEnded stayed
  // bound: a BullMQ add against a Redis nobody started, which waits for a
  // connection forever. Each turn then hung for the 5s test timeout, and its
  // heartbeat interval (whose fake `.where()` has no `.catch`) kept throwing
  // into whichever file ran next. Listed, so the outcome no longer depends on
  // which file loaded first.
  enqueueTurnEnded: async () => ({}),
}))

// Nothing here may reach Anthropic, a git worktree or the plugin directory.
// `query` is the only thing ever called from the SDK at runtime; almost
// everything else this codebase takes from it is a type, erased at build
// time — except SYSTEM_PROMPT_DYNAMIC_BOUNDARY, a real value runner-options.ts
// imports, so the stub has to export it too or importing that module (below)
// fails to resolve the name against this mock rather than the real package.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string }) => {
    queryCalls.push(args)
    return turnBehaviour()
  },
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

// Forwarding again, and for the same reason: delegation-hook.test.ts imports
// `delegationHook` from this module and a stub namespace reached it too, taking
// all nine of its tests down. Only `optionsFor` is replaced, and only while
// this file runs — it would otherwise sync the plugin directory and shell out
// to git for a session that does not exist.
const realRunnerOptions = await import(`${B}/features/sessions/runner-options.ts`)
const realOptionsFor = realRunnerOptions.optionsFor
mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  ...realRunnerOptions,
  optionsFor: async (...args: Parameters<typeof realOptionsFor>) => {
    if (!quiet) return realOptionsFor(...args)
    optionsCalls.push(args)
    return { cwd: '/tmp' }
  },
}))

const { recover, runTurn } = await import(`${B}/queue/session-run.worker.ts`)
const { QA_MODE_INSTRUCTION } = await import(`${B}/features/sessions/turn-mode.ts`)

const auto = (n: number) => Array.from({ length: n }, () => ({ payload: { auto: true } }))
const spoken = { payload: { text: 'do the thing' } }

const RECOVERY = {
  notice: (attempt: number, of: number) => `killed by SIGTERM, resuming (${attempt} of ${of}).`,
  instruction: 'Your previous turn was cut short.',
  giveUp: 'Gave up: the process keeps being killed.',
}

afterEach(() => {
  transcript = []
  pending = [{ id: 'msg-1', seq: 4, payload: { text: 'do the thing' } }]
  arrivedDuringTurn = []
  interrupters = []
  written = []
  statuses = []
  queued = []
  queryCalls = []
  optionsCalls = []
  insertFails = false
  messageReadFails = false
  statusWriteFails = false
  enqueueFails = false
  contextRows = []
  contextReadFails = false
  updateSets = []
  claimedRow.sdkSessionId = null
  turnBehaviour = () => empty()
})

const rowsOfType = (type: string) => written.filter((r) => r.type === type)
const lastError = () => String(statuses.at(-1)?.lastError)

// --- nudging ------------------------------------------------------------------

test('a first kill queues a continuation instead of failing the session', async () => {
  // The whole point. Before this, the operator saw "Turn failed: Claude Code
  // process exited with code 143" and had to type "Continue" themselves.
  transcript = [spoken]
  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses.map((s) => s.status)).toEqual(['queued'])
  expect(queued).toEqual(['sess-1'])

  const prompt = rowsOfType('prompt')[0]
  expect(prompt?.pending).toBe(true)
  expect((prompt?.payload as Row).auto).toBe(true)
  expect((prompt?.payload as Row).text).toBe(RECOVERY.instruction)
})

test('it is a notice while it is recovering, not an error', async () => {
  // `error` renders as "Turn failed" in the transcript, which is wrong for
  // something that is picking itself back up.
  transcript = [spoken]
  await recover('sess-1', 'orchestrator', RECOVERY)
  expect(rowsOfType('notice')).toHaveLength(1)
  expect(rowsOfType('error')).toHaveLength(0)
})

test('the notice counts the attempt, so a loop is visible as it happens', async () => {
  transcript = [...auto(2), spoken]
  await recover('sess-1', 'orchestrator', RECOVERY)
  expect((rowsOfType('notice')[0]?.payload as Row).message).toBe(
    'killed by SIGTERM, resuming (3 of 3).',
  )
})

// --- stopping -----------------------------------------------------------------

test('the budget is spent after three, and the session stops', async () => {
  transcript = [...auto(3), spoken]
  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses).toEqual([{ status: 'failed', lastError: RECOVERY.giveUp }])
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
})

test('giving up is said in the transcript too, not only on the session row', async () => {
  // A failure that shows only as a red line on the sessions list is invisible
  // from inside the session, which is where the person reading it is.
  transcript = [...auto(3), spoken]
  await recover('sess-1', 'orchestrator', RECOVERY)
  expect((rowsOfType('error')[0]?.payload as Row).message).toBe(RECOVERY.giveUp)
})

test('the operator speaking resets the budget', async () => {
  // The count is "since the operator last spoke", so a real prompt after three
  // continuations buys three more. Reading past it would strand the session.
  transcript = [spoken, ...auto(3)]
  await recover('sess-1', 'orchestrator', RECOVERY)
  expect(statuses.map((s) => s.status)).toEqual(['queued'])
})

// --- when the recovery itself cannot be delivered -----------------------------
//
// Every one of these runs while the machine is in trouble, which is when the
// database and the queue are least likely to answer. None of them may throw:
// an escaping error leaves the session at `running` with no worker holding it,
// which the UI will not delete and will only queue new messages behind.

test('a queue that is going down fails the session rather than stranding it', async () => {
  transcript = [spoken]
  enqueueFails = true

  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(lastError()).toContain('Recovering from that failed too')
  // And it still says what happened, not just that the recovery did not land.
  expect(lastError()).toContain('killed by SIGTERM')
})

test('an insert that fails mid-nudge fails the session rather than throwing', async () => {
  transcript = [spoken]
  insertFails = true

  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(lastError()).toContain('killed by SIGTERM')
  expect(queued).toEqual([])
})

test('a read that fails before anything is decided still fails the session', async () => {
  // The continuation count is the *first* thing the recovery does, and it is a
  // database read. Leaving it outside the guard meant the commonest failure of
  // all — Postgres unreachable — escaped before the guard could see it.
  messageReadFails = true

  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(lastError()).toContain(RECOVERY.giveUp)
  expect(lastError()).toContain('Recovering from that failed too')
})

test('a write that fails while giving up still fails the session', async () => {
  // The give-up branch writes its own transcript row first. If that throws, the
  // session must still be marked failed — otherwise the one path that exists to
  // stop a session leaves it running.
  transcript = [...auto(3), spoken]
  insertFails = true

  await recover('sess-1', 'orchestrator', RECOVERY)

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(lastError()).toContain(RECOVERY.giveUp)
})

test('a database that answers nothing at all does not throw either', async () => {
  // Nothing can be written, including the failure. All this can do is not make
  // it worse by throwing out of the worker.
  transcript = [spoken]
  insertFails = true
  statusWriteFails = true

  await recover('sess-1', 'orchestrator', RECOVERY)
  expect(statuses).toEqual([])
})

// --- the wiring ---------------------------------------------------------------
//
// `recover` being right is worth nothing if a killed turn never reaches it.
// These run the turn itself, with the SDK replaced by a stream that fails the
// way the real one did.

const KILLED = 'Claude Code process exited with code 143'

test('a turn whose CLI was killed resumes instead of failing', async () => {
  transcript = [spoken]
  turnBehaviour = () => throwing(KILLED)

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  // And the transcript says why, in words rather than in the number 143.
  const message = String((rowsOfType('notice')[0]?.payload as Row)?.message)
  expect(message).toContain('SIGTERM')
  expect(message).toContain('systemd')
})

test('the continuation tells the model what happened and what not to repeat', async () => {
  transcript = [spoken]
  turnBehaviour = () => throwing(KILLED)

  await runTurn({ sessionId: 'sess-1' })

  const text = String((rowsOfType('prompt')[0]?.payload as Row)?.text)
  expect(text).toContain('cut short')
  // The advice that would have ended the real incident four turns earlier: the
  // agent kept re-running the same test suite that had exhausted the box.
  expect(text).toContain('do not run it the same way again')
})

test('a turn that failed for any other reason still fails', async () => {
  // The classifier is what separates these, and the turn has to consult it.
  // Without that, every failure would be retried three times at full cost.
  transcript = [spoken]
  turnBehaviour = () => throwing('Claude Code returned an error result: something went wrong')

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(queued).toEqual([])
  expect(rowsOfType('error')).toHaveLength(1)
})

test('a killed turn stops being resumed once the budget is spent', async () => {
  transcript = [...auto(3), spoken]
  turnBehaviour = () => throwing(KILLED)

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(String(statuses.at(-1)?.lastError)).toContain('keeps being killed')
  expect(queued).toEqual([])
})

test('an operator interrupt is not mistaken for a kill', async () => {
  // Aborting the query raises the same class of error as a dying process, and
  // the abort *is* a kill — this session asked for it. Without the interrupt
  // guard ahead of the classifier, cancelling a turn would be answered by three
  // continuations restarting the very work the operator just stopped.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
      await Promise.resolve()
      throw new Error(KILLED)
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
})

test('a turn that ended with delegated work still running is resumed too', async () => {
  // The other thing `recover` serves, and the reason it is shared. A result
  // that reports background subagents the exiting process destroyed is a turn
  // that did not finish, whatever its subtype says.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        subagent_stats: {
          spawned: 1,
          completed: 0,
          killed: { system: 1 },
          started_in_background: 1,
        },
      }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(String((rowsOfType('notice')[0]?.payload as Row)?.message)).toContain(
    'still running in the background',
  )
})

test('a clean turn completes and queues nothing', async () => {
  // The control: everything above has to be reachable only when something
  // actually went wrong.
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
})

// --- a command backgrounded past the turn boundary -----------------------------
//
// The incident this covers, reproduced end to end: an agentoo session
// backgrounded a `git push` behind a multi-minute pre-push hook, ended its
// turn, and the SDK's kill for that task arrived roughly five seconds *after*
// the turn's own `result` had already streamed by. agentoo marked the turn
// `completed` anyway, because the only signal it read was `lastResult`.

test('a command killed after the result is still caught, because the ledger — not lastResult — is what is read', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      // The result the old code would have stopped at, and read as clean.
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      // The kill, arriving after it — this is the whole point of the test.
      yield { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(String((rowsOfType('notice')[0]?.payload as Row)?.message)).toContain('background')
})

// --- a tool the harness cancelled, misread as a refusal ------------------------

test('a tool cancelled by the harness is nudged, not treated as a user refusal', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(String((rowsOfType('notice')[0]?.payload as Row)?.message)).toContain('cancelled')
})

// --- a message queued behind a turn that later gets interrupted or drained -----

test('a message that arrived mid-turn still drains normally, without recover', async () => {
  // The plain drain path, unrelated to the interrupt notice below: no new
  // notice, no recover — just queued for the pending message to run next.
  arrivedDuringTurn = [{ id: 'msg-2' }]
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('an interrupted turn says so when a message is left stranded behind it', async () => {
  // Both interrupt exits return before the drain check, so without the notice
  // a message sent mid-turn would sit `pending` with nothing telling anyone.
  // It is not lost — sendMessage moves the session out of `interrupted` on the
  // next send and runTurn takes the oldest pending row first — but that is
  // exactly the fact worth saying rather than leaving to be discovered.
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
  expect(rowsOfType('notice')).toHaveLength(1)
})

// --- the healthy turns that must not be nudged --------------------------------
//
// `recover` spends one of three auto-continuations and then fails the session,
// so a false positive here does not merely add a row: it degrades every session
// that runs shell commands. The ledger enrols every local_bash task, foreground
// included, which makes these the load-bearing cases.

test('a foreground command the turn never settled completes cleanly', () => {
  // The exact shape a turn cut short leaves behind: task_started arrives and
  // nothing else ever does — no task_notification, no task_updated. The entry
  // sits unsettled to the end of the stream and must still not nudge, because
  // `is_backgrounded` was false.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: false,
        description: 'bun test tests/',
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  return runTurn({ sessionId: 'sess-1' }).then(() => {
    expect(statuses.at(-1)?.status).toBe('completed')
    expect(queued).toEqual([])
    expect(rowsOfType('notice')).toHaveLength(0)
    expect(rowsOfType('prompt')).toHaveLength(0)
  })
})

test('a foreground command with no is_backgrounded field at all completes cleanly', async () => {
  // The field is optional on SDKTaskStartedMessage, so absence has to read as
  // foreground. Reading it the other way would nudge — then fail — every
  // session whose CLI stopped sending it.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash' }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(queued).toEqual([])
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('a turn that ends before any result at all does not nudge over a foreground command', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: false,
      }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('a backgrounded command that settles after the result completes cleanly', async () => {
  // The mirror of the kill-after-the-result case above, and the reason the
  // ledger is read after the loop rather than at the result: the settle lands
  // late too, so an implementation that decided at the `result` message would
  // report a command that finished as lost.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      yield { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(queued).toEqual([])
  expect(rowsOfType('notice')).toHaveLength(0)
})

// --- one loss, one notice -----------------------------------------------------

test('a killed background subagent is reported once, by lostSubagents alone', async () => {
  // Both ledgers see this turn: subagent_stats reports the destroyed subagent,
  // and its task_id also flows past foldBackgroundCommand as task_started and
  // task_updated. Counting it twice would put two contradictory notices on one
  // turn — and the background-command wording ("run it in the foreground") is
  // the wrong advice for delegated work.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-1',
        task_type: 'local_agent',
        subagent_type: 'agentoo:tester',
        is_backgrounded: true,
      }
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        subagent_stats: { spawned: 1, completed: 0, killed: { system: 1 }, started_in_background: 1 },
      }
      yield { type: 'system', subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'killed' } }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(rowsOfType('notice')).toHaveLength(1)
  expect(String((rowsOfType('notice')[0]?.payload as Row)?.message)).toContain('1 delegated task')
  expect(rowsOfType('prompt')).toHaveLength(1)
})

test('a turn that both loses a command and reports a cancellation nudges once', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(rowsOfType('notice')).toHaveLength(1)
  expect(rowsOfType('prompt')).toHaveLength(1)
})

// --- what outranks what -------------------------------------------------------
//
// Both new branches sit after the pending-message drain and the budget stop. A
// test that only exercises one of them at a time passes whatever the order is,
// so each of these puts two triggers on one turn and asserts which one won.

test('a message the operator sent mid-turn outranks the cancellation nudge', async () => {
  // If the cancellation branch moved above the drain, this turn would append an
  // auto-continuation and run *that* before the operator's own message.
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(rowsOfType('prompt')).toHaveLength(0)
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('a message the operator sent mid-turn outranks the lost-command nudge', async () => {
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      yield { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  expect(rowsOfType('prompt')).toHaveLength(0)
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('the budget stop outranks the cancellation nudge', async () => {
  // Running out of money cancels whatever was outstanding. Nudging there would
  // spend continuations fighting a limit that is working.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(String(statuses.at(-1)?.lastError)).toContain('budget')
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
})

test('a maxTurns stop is not read as a harness cancellation', async () => {
  // error_* means the turn stopped for a stated reason, and stopping cancels
  // whatever tool calls were still outstanding. That cancellation is a
  // consequence of the limit, not evidence of the bug this branch exists for.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(queued).toEqual([])
  expect(rowsOfType('notice')).toHaveLength(0)
  expect(rowsOfType('prompt')).toHaveLength(0)
})

// --- the stranded-prompt notice may never throw out of an interrupt -----------

test('an interrupt with nothing pending behind it says nothing', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('a database that cannot answer the stranded-prompt read still interrupts cleanly', async () => {
  // The read is the first thing the notice does, and an interrupt is exactly
  // when the machine may be in trouble. A throw escaping here would leave the
  // session at `running` with no worker holding it.
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  messageReadFails = true
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('a database that cannot write the stranded-prompt notice still interrupts cleanly', async () => {
  // The other call site, inside runTurn's catch block — an abort surfaces there
  // as a thrown error — with the insert failing under it.
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  insertFails = true
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
      await Promise.resolve()
      throw new Error(KILLED)
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(queued).toEqual([])
  expect(rowsOfType('notice')).toHaveLength(0)
})

test('the interrupt notice is written from the catch path too, not only the clean one', async () => {
  transcript = [spoken]
  arrivedDuringTurn = [{ id: 'msg-2' }]
  turnBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
      await Promise.resolve()
      throw new Error(KILLED)
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('interrupted')
  expect(rowsOfType('notice')).toHaveLength(1)
  expect(String((rowsOfType('notice')[0]?.payload as Row)?.message)).toContain('still waiting')
  // Still not auto-drained: the interrupt is honoured, not worked around.
  expect(queued).toEqual([])
  expect(rowsOfType('prompt')).toHaveLength(0)
})

// --- two fixes from an independent review -------------------------------------
//
// Confirmed with concrete inputs against the first version of this file.

test('a maxTurns stop is not read as a lost background command either', async () => {
  // The same rationale as 'a maxTurns stop is not read as a harness
  // cancellation' above, for the sibling branch: error_* means the SDK itself
  // stopped the turn, and that stop legitimately kills whatever was still
  // backgrounded. This is not a new loss to hide behind the guard — before
  // the background-command ledger existed at all, a turn shaped like this
  // already fell through to `completed`, so the guard restores that status
  // quo rather than creating one.
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('completed')
  expect(queued).toEqual([])
  expect(rowsOfType('notice')).toHaveLength(0)
  expect(rowsOfType('prompt')).toHaveLength(0)
})

test('two commands lost in one turn are both named, in the plural', async () => {
  transcript = [spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't2',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      yield { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } }
      yield { type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'killed' } }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])
  const message = String((rowsOfType('notice')[0]?.payload as Row)?.message)
  expect(message).toContain('2 commands')
  expect(message).toContain('were')
  expect(message).not.toContain('undefined')
})

test('giving up on a repeatedly cancelled tool says so in the transcript', async () => {
  transcript = [...auto(3), spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(String(statuses.at(-1)?.lastError)).toContain('keeps coming back cancelled by the harness')
  expect(queued).toEqual([])
})

test('giving up on a repeatedly lost background command says so in the transcript', async () => {
  transcript = [...auto(3), spoken]
  turnBehaviour = () =>
    (async function* () {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        task_type: 'local_bash',
        is_backgrounded: true,
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      yield { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('failed')
  expect(String(statuses.at(-1)?.lastError)).toContain(
    'every turn ended with a command still running in the background',
  )
  expect(queued).toEqual([])
})


// --- Q&A mode ------------------------------------------------------------------
//
// The mode is per prompt, and a continuation is not the operator's prompt: it is
// spawned by a turn, so unless it inherits that turn's mode it would run with
// full write permissions for a message that was only ever a question.

const QA_PROMPT = { id: 'msg-1', seq: 4, payload: { text: 'why is the loader slow?', mode: 'qa' } }

test('a Q&A turn asks optionsFor for Q&A and hands the SDK the instruction before the text', async () => {
  pending = [QA_PROMPT]
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls).toHaveLength(1)
  expect(optionsCalls[0]?.[4]).toBe('qa')
  expect(queryCalls[0]?.prompt).toBe(`${QA_MODE_INSTRUCTION}\n\nwhy is the loader slow?`)
  expect(statuses.at(-1)?.status).toBe('completed')
})

test('a Code turn, with or without the key, runs as Code with the text untouched', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  for (const payload of [{ text: 'do the thing' }, { text: 'do the thing', mode: 'code' }]) {
    pending = [{ id: 'msg-1', seq: 4, payload }]
    await runTurn({ sessionId: 'sess-1' })
  }

  expect(optionsCalls.map((args) => args[4])).toEqual(['code', 'code'])
  expect(queryCalls.map((q) => q.prompt)).toEqual(['do the thing', 'do the thing'])
})

test('a prompt whose mode is garbage runs as Code rather than failing the turn', async () => {
  pending = [{ id: 'msg-1', seq: 4, payload: { text: 'do the thing', mode: { qa: true } } }]
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
    })()

  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls[0]?.[4]).toBe('code')
  expect(queryCalls[0]?.prompt).toBe('do the thing')
})

test('a continuation of a Q&A turn is stored as Q&A', async () => {
  transcript = [spoken]
  await recover('sess-1', 'orchestrator', RECOVERY, 'msg-1', 'qa')

  const prompt = rowsOfType('prompt')[0]
  expect(prompt?.payload).toStrictEqual({ text: RECOVERY.instruction, auto: true, mode: 'qa' })
  expect(prompt?.continuesMessageId).toBe('msg-1')
  expect(queued).toEqual(['sess-1'])
})

test('a continuation of a Code turn is stored exactly as it always was', async () => {
  // Not `mode: 'code'` and not `mode: undefined` — the key is absent, so every
  // existing reader of these rows sees the shape it always saw.
  transcript = [spoken]
  await recover('sess-1', 'orchestrator', RECOVERY, 'msg-1', 'code')
  await recover('sess-1', 'orchestrator', RECOVERY, 'msg-1')
  await recover('sess-1', 'orchestrator', RECOVERY)

  const prompts = rowsOfType('prompt')
  expect(prompts).toHaveLength(3)
  for (const prompt of prompts) {
    expect(prompt.payload).toStrictEqual({ text: RECOVERY.instruction, auto: true })
  }
})

test('every recovery path out of a Q&A turn carries the mode into its continuation', async () => {
  pending = [QA_PROMPT]
  transcript = [spoken]

  const scenarios: [string, () => AsyncIterable<unknown>][] = [
    ['a killed process', () => throwing(KILLED)],
    [
      'delegated work lost at the end of the turn',
      () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            total_cost_usd: 0,
            subagent_stats: { spawned: 1, completed: 0, killed: { system: 1 }, started_in_background: 1 },
          }
        })(),
    ],
    [
      'a background command lost at the end of the turn',
      () =>
        (async function* () {
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 't1',
            task_type: 'local_bash',
            is_backgrounded: true,
          }
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
          yield {
            type: 'system',
            subtype: 'task_updated',
            task_id: 't1',
            patch: { status: 'killed' },
          }
        })(),
    ],
    [
      'a tool call the harness cancelled',
      () =>
        (async function* () {
          yield {
            type: 'user',
            message: { role: 'user', content: [] },
            parent_tool_use_id: null,
            tool_result_meta: [{ id: 'toolu_01', non_execution_kind: 'cancelled' }],
          }
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        })(),
    ],
  ]

  for (const [label, behaviour] of scenarios) {
    written = []
    turnBehaviour = behaviour
    await runTurn({ sessionId: 'sess-1' })

    const continuation = rowsOfType('prompt')[0]
    expect(continuation?.payload, label).toMatchObject({ auto: true, mode: 'qa' })
    expect(continuation?.continuesMessageId, label).toBe('msg-1')
  }
})

test('the same recovery out of a Code turn leaves the continuation as plain { text, auto }', async () => {
  transcript = [spoken]
  turnBehaviour = () => throwing(KILLED)

  await runTurn({ sessionId: 'sess-1' })

  expect(rowsOfType('prompt')[0]?.payload).toStrictEqual({
    text: expect.stringContaining('cut short'),
    auto: true,
  })
})

// --- consecutive turns in one session switching mode ---------------------------
//
// The worker holds no mode between turns: each one is read off the prompt row it
// claims. These run two (or three) real `runTurn`s back to back on the same
// session and pin that the mode handed to `optionsFor` and the prompt handed to
// `query` follow each row, so nothing from a Q&A turn survives into the Code
// turn after it, and the reverse.

const succeeds = () =>
  (async function* () {
    yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
  })()

const CODE_ROW = { id: 'msg-2', seq: 6, payload: { text: 'now fix it' } }

test('Q&A then Code in one session: the Code turn gets Code options and the bare text', async () => {
  turnBehaviour = succeeds

  pending = [QA_PROMPT]
  await runTurn({ sessionId: 'sess-1' })
  pending = [CODE_ROW]
  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls.map((args) => args[4])).toEqual(['qa', 'code'])
  expect(queryCalls.map((q) => q.prompt)).toEqual([
    `${QA_MODE_INSTRUCTION}\n\nwhy is the loader slow?`,
    'now fix it',
  ])
  // Same session both times: Q&A is not a side conversation.
  expect(optionsCalls.map((args) => (args[0] as Row).id)).toEqual(['sess-1', 'sess-1'])
  expect(statuses.filter((s) => s.status === 'completed')).toHaveLength(2)
})

test('Code then Q&A then Code: the mode flips on every turn and back again', async () => {
  turnBehaviour = succeeds

  for (const row of [CODE_ROW, QA_PROMPT, CODE_ROW]) {
    pending = [row]
    await runTurn({ sessionId: 'sess-1' })
  }

  expect(optionsCalls.map((args) => args[4])).toEqual(['code', 'qa', 'code'])
  expect(queryCalls[0]?.prompt).toBe('now fix it')
  expect(queryCalls[1]?.prompt).toBe(`${QA_MODE_INSTRUCTION}\n\nwhy is the loader slow?`)
  expect(queryCalls[2]?.prompt).toBe('now fix it')
  for (const i of [0, 2]) expect(queryCalls[i]?.prompt).not.toContain('[Q&A mode]')
})

test('a Q&A message queued behind a running Code turn drains as Q&A, and the Code turn stayed Code', async () => {
  // The first turn is Code. While it runs, a Q&A message lands (the turn's drain
  // check sees it), so the session is re-queued rather than going idle. The next
  // turn claims that row and must run it as Q&A.
  turnBehaviour = succeeds
  pending = [CODE_ROW]
  arrivedDuringTurn = [{ id: 'msg-3' }]

  await runTurn({ sessionId: 'sess-1' })

  expect(statuses.at(-1)?.status).toBe('queued')
  expect(queued).toEqual(['sess-1'])

  pending = [{ id: 'msg-3', seq: 8, payload: { text: 'what did you just change?', mode: 'qa' } }]
  arrivedDuringTurn = []
  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls.map((args) => args[4])).toEqual(['code', 'qa'])
  expect(queryCalls.map((q) => q.prompt)).toEqual([
    'now fix it',
    `${QA_MODE_INSTRUCTION}\n\nwhat did you just change?`,
  ])
  expect(statuses.at(-1)?.status).toBe('completed')
})

test('a continuation written by a killed Q&A turn runs as Q&A when the next turn claims it', async () => {
  // End to end through the stored row: the killed Q&A turn writes the
  // continuation, and that exact payload is what the next turn claims.
  transcript = [spoken]
  pending = [QA_PROMPT]
  turnBehaviour = () => throwing(KILLED)
  await runTurn({ sessionId: 'sess-1' })

  const continuation = rowsOfType('prompt')[0]
  if (!continuation) throw new Error('the killed Q&A turn wrote no continuation')

  pending = [{ id: 'msg-cont', seq: 9, payload: continuation.payload }]
  turnBehaviour = succeeds
  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls.map((args) => args[4])).toEqual(['qa', 'qa'])
  expect(queryCalls[1]?.prompt).toBe(
    `${QA_MODE_INSTRUCTION}\n\n${String((continuation.payload as Row).text)}`,
  )
})

test('a continuation written by a killed Code turn runs as Code when the next turn claims it', async () => {
  transcript = [spoken]
  pending = [CODE_ROW]
  turnBehaviour = () => throwing(KILLED)
  await runTurn({ sessionId: 'sess-1' })

  const continuation = rowsOfType('prompt')[0]
  if (!continuation) throw new Error('the killed Code turn wrote no continuation')

  pending = [{ id: 'msg-cont', seq: 9, payload: continuation.payload }]
  turnBehaviour = succeeds
  await runTurn({ sessionId: 'sess-1' })

  expect(optionsCalls.map((args) => args[4])).toEqual(['code', 'code'])
  expect(queryCalls[1]?.prompt).toBe(String((continuation.payload as Row).text))
})

// --- seeding a compacted session's first turn ------------------------------------
//
// A session made by compaction starts from a `compact_context` row, not from a
// conversation the SDK can resume. Its first turn is handed the summary in front
// of the operator's message; once that turn's `init` has persisted an SDK session,
// `resume` carries the summary and later turns must not repeat it. What is stored
// is never the seeded text — the transcript shows only what the operator typed.

const SEED = {
  summary: 'SEED-SUMMARY: the toggle lives in Settings; contrast is still open.',
  sourceSessionId: '11111111-1111-4111-8111-111111111111',
  sourceTitle: 'Add dark mode',
  sourceTotalCostUsd: 1.25,
  sourceBranch: 'agentoo/s-11111111',
  method: 'sdk_compact',
}

test('the first turn of a compacted session is handed the summary, then the operator\'s message', async () => {
  const { withCompactedContext } = await import(`${B}/features/sessions/turn-mode.ts`)
  contextRows = [{ id: 'ctx-1', seq: 0, type: 'compact_context', payload: SEED }]
  pending = [CODE_ROW]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  const prompt = String(queryCalls[0]?.prompt)
  expect(prompt).toContain('[Compacted context from previous session]')
  expect(prompt).toContain(SEED.summary)
  expect(prompt.endsWith('[End of compacted context]\n\nnow fix it')).toBe(true)
  // Exactly what the pure function says, not a second implementation of it.
  expect(prompt).toBe(
    withCompactedContext('now fix it', {
      summary: SEED.summary,
      sourceSessionId: SEED.sourceSessionId,
      sourceTitle: SEED.sourceTitle,
      sourceBranch: SEED.sourceBranch,
    }),
  )
  expect(statuses.at(-1)?.status).toBe('completed')
})

test('the stored prompt row is not rewritten: the summary is never written anywhere', async () => {
  contextRows = [{ id: 'ctx-1', seq: 0, type: 'compact_context', payload: SEED }]
  pending = [CODE_ROW]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  expect(CODE_ROW.payload).toEqual({ text: 'now fix it' })
  // Strings only: an update's `set` can hold Drizzle SQL fragments, which are
  // cyclic and cannot be serialised.
  const writtenStrings = updateSets
    .flatMap((set) => Object.values(set))
    .filter((v): v is string => typeof v === 'string')
  expect(writtenStrings.some((v) => v.includes('SEED-SUMMARY'))).toBe(false)
  expect(JSON.stringify(written)).not.toContain('SEED-SUMMARY')
  expect(updateSets.some((set) => 'payload' in set)).toBe(false)
})

test('once the session has an SDK session to resume, the summary is not sent again', async () => {
  // `resume` already carries it; repeating it would pay for it on every turn.
  claimedRow.sdkSessionId = 'sdk-sess-1'
  contextRows = [{ id: 'ctx-1', seq: 0, type: 'compact_context', payload: SEED }]
  pending = [CODE_ROW]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  expect(queryCalls.map((q) => q.prompt)).toEqual(['now fix it'])
})

test('a first turn that died before it had an SDK session seeds the next one again', async () => {
  contextRows = [{ id: 'ctx-1', seq: 0, type: 'compact_context', payload: SEED }]
  pending = [CODE_ROW]
  turnBehaviour = () => throwing('Claude Code returned an error result: something went wrong')
  await runTurn({ sessionId: 'sess-1' })
  expect(statuses.at(-1)?.status).toBe('failed')

  turnBehaviour = succeeds
  await runTurn({ sessionId: 'sess-1' })

  // Nothing persisted an sdkSessionId, so nothing carried the first attempt.
  expect(queryCalls).toHaveLength(2)
  for (const call of queryCalls) expect(call.prompt).toContain(SEED.summary)
})

test('a Q&A first turn gets the summary first, then the Q&A instruction and the question', async () => {
  contextRows = [{ id: 'ctx-1', seq: 0, type: 'compact_context', payload: SEED }]
  pending = [QA_PROMPT]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  const prompt = String(queryCalls[0]?.prompt)
  expect(prompt.startsWith('[Compacted context from previous session]')).toBe(true)
  expect(prompt.endsWith(`${QA_MODE_INSTRUCTION}\n\nwhy is the loader slow?`)).toBe(true)
})

test('a session that was not made by compaction is handed the prompt exactly as before', async () => {
  contextRows = []
  pending = [CODE_ROW]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  expect(queryCalls.map((q) => q.prompt)).toEqual(['now fix it'])
})

test('a malformed compact_context row degrades to no seed instead of failing the turn', async () => {
  // It is JSON from the database; the turn has already been claimed by the time
  // it is read, so throwing here would strand the session at `running`.
  for (const payload of [{ summary: 5 }, {}, { text: 'not a context' }, 'garbage', null]) {
    queryCalls = []
    statuses = []
    contextRows = [{ id: 'ctx-bad', seq: 0, type: 'compact_context', payload }]
    pending = [CODE_ROW]
    turnBehaviour = succeeds

    await runTurn({ sessionId: 'sess-1' })

    expect(queryCalls.map((q) => q.prompt)).toEqual(['now fix it'])
    expect(statuses.at(-1)?.status).toBe('completed')
  }
})

test('a database that fails while the seed is read fails the turn visibly, not stuck running', async () => {
  contextReadFails = true
  pending = [CODE_ROW]
  turnBehaviour = succeeds

  await runTurn({ sessionId: 'sess-1' })

  // Nothing was sent to the model without its context, and the session is not
  // left at `running` with nobody holding it.
  expect(queryCalls).toEqual([])
  expect(statuses.at(-1)?.status).toBe('failed')
  expect(rowsOfType('error')).toHaveLength(1)
})
