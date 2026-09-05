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

/** Failure switches, each standing for a database or queue dying mid-recovery. */
let insertFails = false
let selectFails = false
let statusWriteFails = false
let enqueueFails = false

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

const db = {
  select: (fields?: unknown) => ({
    from: (t: unknown) => {
      // A projection means `autoContinuationsSincePrompt`, which reads prompts
      // back; a bare select means the turn picking up its pending message.
      let ordered = false
      const rows = () => {
        if (table(t) === 'projects') return [{ id: 'proj-1', slug: 'demo', sshKeyId: null }]
        if (fields === undefined) return pending
        if (selectFails) throw new Error(DB_DOWN)
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
        return [
          {
            id: 'sess-1',
            projectId: 'proj-1',
            orchestrator: 'orchestrator',
            worktreePath: '/tmp/worktree',
            sdkSessionId: null,
            maxBudgetUsd: null,
            totalCostUsd: 0,
          },
        ]
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
        return { where }
      },
    }
  },
  insert: () => ({
    values: (row: Row) => ({
      returning: async () => {
        if (insertFails) throw new Error(DB_DOWN)
        written.push(row)
        return [row]
      },
    }),
  }),
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
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async ({ sessionId }: { sessionId: string }) => {
    if (enqueueFails) throw new Error('Stream is not writeable and enableOfflineQueue is false')
    queued.push(sessionId)
    return {}
  },
}))

// Nothing here may reach Anthropic, a git worktree or the plugin directory.
// Only `query` is ever called from the SDK at runtime; everything else this
// codebase takes from it is a type, which is erased.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: () => turnBehaviour() }))

// Forwarding again, and for the same reason: delegation-hook.test.ts imports
// `delegationHook` from this module and a stub namespace reached it too, taking
// all nine of its tests down. Only `optionsFor` is replaced, and only while
// this file runs — it would otherwise sync the plugin directory and shell out
// to git for a session that does not exist.
const realRunnerOptions = await import(`${B}/features/sessions/runner-options.ts`)
const realOptionsFor = realRunnerOptions.optionsFor
mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  ...realRunnerOptions,
  optionsFor: async (...args: Parameters<typeof realOptionsFor>) =>
    quiet ? { cwd: '/tmp' } : realOptionsFor(...args),
}))

const { recover, runTurn } = await import(`${B}/queue/session-run.worker.ts`)

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
  insertFails = false
  selectFails = false
  statusWriteFails = false
  enqueueFails = false
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
  selectFails = true

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
