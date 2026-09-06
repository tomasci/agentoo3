// Regression cover for the two things a turn has to get right once it is over:
// what it cost, and whether it actually finished.
//
// The numbers here are not invented. They are lifted from an exported 3.5-hour
// session that recorded $494.91 for $72.78 of work and reported five "crashes"
// that were not crashes, because both signals were being read wrong.

import { expect, test } from 'bun:test'
import {
  type BackgroundCommandLedger,
  cancelledWithoutInterrupt,
  foldBackgroundCommand,
  lostBackgroundCommands,
  lostSubagents,
  newSpend,
} from '../src/queue/session-run.worker'

/** A result message, with only the fields these two helpers look at. */
const result = (stats?: Record<string, unknown>, cost?: number) =>
  ({
    type: 'result',
    subtype: 'success',
    ...(cost !== undefined && { total_cost_usd: cost }),
    ...(stats && { subagent_stats: stats }),
  }) as never

/** A task_started message, with only the fields foldBackgroundCommand looks at. */
const taskStarted = (fields: Record<string, unknown>) =>
  ({ type: 'system', subtype: 'task_started', ...fields }) as never

/** A task_updated message: only task_id and patch ever arrive on the real thing. */
const taskUpdated = (task_id: string, patch: Record<string, unknown>) =>
  ({ type: 'system', subtype: 'task_updated', task_id, patch }) as never

/** A task_notification message, with only the fields foldBackgroundCommand looks at. */
const taskNotification = (task_id: string, fields: Record<string, unknown>) =>
  ({ type: 'system', subtype: 'task_notification', task_id, ...fields }) as never

/** A user message reporting a tool result cancelled with the given kind. */
const userCancelled = (nonExecutionKind: unknown) =>
  ({
    type: 'user',
    message: { role: 'user', content: [] },
    parent_tool_use_id: null,
    tool_result_meta: [{ id: 'toolu_01', non_execution_kind: nonExecutionKind }],
  }) as never

// --- what it cost ------------------------------------------------------------

test('a cumulative total is charged once, not once per result', () => {
  // The real shape: one query emitted ten results, every one reporting the same
  // running total, because `total_cost_usd` is per-process rather than per-turn.
  let charged = 0
  for (let i = 0; i < 10; i++) charged += newSpend(28.86383965, charged)
  expect(charged).toBeCloseTo(28.86383965, 8)
})

test('each result is charged only for what it adds', () => {
  let charged = 0
  const billed: number[] = []
  for (const cumulative of [2.7726, 21.7944, 21.7944, 21.7944]) {
    const delta = newSpend(cumulative, charged)
    charged += delta
    billed.push(delta)
  }
  expect(billed[0]).toBeCloseTo(2.7726, 6)
  expect(billed[1]).toBeCloseTo(19.0218, 6)
  // The repeats add nothing: this is the bug, stated as a test.
  expect(billed[2]).toBe(0)
  expect(billed[3]).toBe(0)
  expect(charged).toBeCloseTo(21.7944, 6)
})

test('the whole session reconciles to what was actually spent', () => {
  // The seven per-query totals from the export. Summing every result instead
  // gave $494.91; summing what each one *added* is the real figure.
  const perQuery = [21.7944, 4.0196, 7.7955, 7.0156, 28.8638, 0.8602, 2.4348]
  const total = perQuery.reduce((sum, cumulative) => {
    // Each query is a fresh process, so its counter restarts at zero.
    let charged = 0
    charged += newSpend(cumulative, charged)
    return sum + charged
  }, 0)
  expect(total).toBeCloseTo(72.78, 2)
})

test('a zero-cost notification result cannot claw back what is already charged', () => {
  // The `num_turns: 0` results really do report 0 after real money was spent.
  expect(newSpend(0, 21.79)).toBe(0)
})

test('a missing or unusable cost is not money', () => {
  expect(newSpend(undefined, 0)).toBe(0)
  expect(newSpend(null, 5)).toBe(0)
  expect(newSpend('12.00', 0)).toBe(0)
  expect(newSpend(Number.NaN, 0)).toBe(0)
  expect(newSpend(Number.POSITIVE_INFINITY, 0)).toBe(0)
})

// --- whether it finished -----------------------------------------------------

test('a subagent the system killed at shutdown counts as lost work', () => {
  // Verbatim from the turn that killed the stylelint agent. The naive
  // `spawned - completed - killed` reading nets to zero here, which is exactly
  // how this went unnoticed: the kill is already counted by the final result.
  expect(
    lostSubagents(
      result({
        spawned: 9,
        completed: 8,
        failed: 0,
        killed: { user: 0, parent: 0, system: 1 },
        started_in_background: 9,
      }),
    ),
  ).toBe(1)
})

test('every killed background track in the real session is accounted for', () => {
  // The five turns that ended with work destroyed, as exported.
  const turns = [
    { spawned: 9, completed: 8, killed: { system: 1 }, started_in_background: 9 },
    { spawned: 1, completed: 0, killed: { system: 1 }, started_in_background: 1 },
    { spawned: 3, completed: 0, killed: { system: 3 }, started_in_background: 3 },
    { spawned: 2, completed: 1, killed: { system: 1 }, started_in_background: 2 },
    { spawned: 10, completed: 9, killed: { system: 1 }, started_in_background: 10 },
  ]
  expect(turns.map((t) => lostSubagents(result(t)))).toEqual([1, 1, 3, 1, 1])
})

test('a subagent neither finished nor killed was abandoned by the exiting process', () => {
  expect(
    lostSubagents(
      result({ spawned: 3, completed: 0, killed: { system: 0 }, started_in_background: 3 }),
    ),
  ).toBe(3)
})

test('an operator interrupt is not reported back to them as lost work', () => {
  expect(
    lostSubagents(
      result({ spawned: 2, completed: 1, killed: { user: 1 }, started_in_background: 2 }),
    ),
  ).toBe(0)
})

test('a clean background turn reports nothing lost', () => {
  expect(
    lostSubagents(
      result({ spawned: 4, completed: 4, killed: { system: 0 }, started_in_background: 4 }),
    ),
  ).toBe(0)
})

test('a fully foreground turn is never treated as having lost anything', () => {
  // The invariant `delegationHook` establishes. What `spawned`/`completed` mean
  // for a foreground subagent is undocumented, so without this gate a healthy
  // delegating turn could be nudged and then failed for no reason.
  expect(lostSubagents(result({ spawned: 3, completed: 0, started_in_background: 0 }))).toBe(0)
})

test('an unrecognisable result degrades to "nothing lost"', () => {
  // `subagent_stats` is undocumented, so a shape change must not raise alarms.
  expect(lostSubagents(undefined)).toBe(0)
  expect(lostSubagents(result())).toBe(0)
  expect(lostSubagents(result({ spawned: 'many', started_in_background: 2 }))).toBe(0)
  expect(lostSubagents({ type: 'assistant' } as never)).toBe(0)
  expect(lostSubagents(result({ started_in_background: 2 }))).toBe(0)
})

test('over-accounting cannot produce a negative count', () => {
  expect(lostSubagents(result({ spawned: 1, completed: 3, started_in_background: 1 }))).toBe(0)
})


// --- whether a backgrounded command survived the turn ------------------------
//
// The incident this covers: an agentoo session backgrounded a `git push`
// behind a multi-minute pre-push hook, ended its turn, and the SDK killed the
// task about five seconds *after* the turn's own `result` had already
// streamed by. `lostSubagents` cannot see this — `subagent_stats` only counts
// delegated work — so this is a second, parallel ledger for commands.

test('a backgrounded local_bash task that gets killed counts as lost', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('a backgrounded local_agent task is not double-counted here', () => {
  // lostSubagents already owns this loss, read off subagent_stats on the
  // final result. Counting it again here would make one turn emit two
  // contradictory notices about the same lost work.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_agent', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a foreground command that never backgrounds counts as nothing', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: false }),
  )
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a backgrounded command that never settles counts as lost', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('a paused command at loop end still counts as lost, not settled', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'paused' }))
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('a task_notification reporting "stopped" is destroyed, not completed', () => {
  // 'stopped' is the SDK's word for cut off rather than finished, matching how
  // the frontend (transcript.ts) already folds it into 'killed'.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskNotification('t1', { status: 'stopped' }))
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('an ambient housekeeping task is never counted', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true, ambient: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a command auto-backgrounded past its timeout is still tracked', () => {
  // The CLI backgrounds a foreground Bash call that overruns its timeout with
  // no task_started ever having said so — only patch.is_backgrounded does.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: false }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { is_backgrounded: true }))
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('garbage message shapes fold into an empty, harmless ledger', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(ledger, undefined)
  foldBackgroundCommand(ledger, {} as never)
  foldBackgroundCommand(ledger, { type: 'assistant' } as never)
  foldBackgroundCommand(ledger, { type: 'system' } as never)
  foldBackgroundCommand(ledger, { type: 'system', subtype: 'task_updated' } as never)
  foldBackgroundCommand(
    ledger,
    { type: 'system', subtype: 'task_started', task_type: 'local_bash' } as never,
  )
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

// --- a tool cancelled by the harness, not refused by anyone -------------------
//
// The other half of the same incident: on the two turns after the push was
// lost, the agent's first Bash call came back with tool_result_meta reporting
// non_execution_kind: "cancelled" and permission_denials: [] — an SDK
// cancellation, not a human answering "no" — and the model read it as a
// refusal both times.

test('cancelledWithoutInterrupt is true for the real tool_result_meta shape', () => {
  expect(cancelledWithoutInterrupt(userCancelled('cancelled'))).toBe(true)
})

test('cancelledWithoutInterrupt degrades to false on anything else', () => {
  expect(cancelledWithoutInterrupt(undefined)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'assistant' } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user' } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: 'nope' } as never)).toBe(false)
  expect(cancelledWithoutInterrupt(userCancelled('permission_denied'))).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: [{}] } as never)).toBe(false)
})

// --- the false positive that would degrade every healthy session --------------
//
// `lostBackgroundCommands` drives `recover`, which spends one of three auto
// continuations and then *fails* the session. Every task the ledger enrols is
// therefore a liability: the enrolment is deliberately wide (every `local_bash`,
// foreground included, so an auto-backgrounded command is still caught), so the
// only thing standing between a healthy turn and a nudge is `background` staying
// false. These pin that gate from the false-alarm side.

test('a task_started with no is_backgrounded field at all is not a background command', () => {
  // The field is optional on SDKTaskStartedMessage. `=== true` is the only
  // enrolment, so an absent field has to read as foreground — otherwise every
  // turn that ran one Bash call and ended before the CLI settled it would nudge
  // itself, three times, and then fail.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(ledger, taskStarted({ task_id: 't1', task_type: 'local_bash' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a foreground command that the turn never settles counts as nothing', () => {
  // The exact case a turn cut short produces: task_started arrives, the
  // task_notification that would have settled it never does, the stream ends.
  // The entry sits at 'running' forever and must still not be counted.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: false }),
  )
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a foreground command left mid-flight by a patch that only says "running"', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: false }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'running' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a foreground command killed at the boundary is still not a background loss', () => {
  // Its caller blocked on it and saw the failure inside the turn, so there is
  // nothing to tell the next turn about. Only `is_backgrounded` promotes.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: false }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a skip_transcript housekeeping task is never counted either', () => {
  // `ambient` has a test above; `skip_transcript` is the other half of the same
  // guard and the SDK sets it independently.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({
      task_id: 't1',
      task_type: 'local_bash',
      is_backgrounded: true,
      skip_transcript: true,
    }),
  )
  foldBackgroundCommand(ledger, taskNotification('t1', { status: 'stopped' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a backgrounded command that settles after the result is not a loss', () => {
  // The other half of the late-arriving-message design. The settle can land
  // after the turn's result exactly as the kill can, so reading the ledger at
  // the result rather than after the loop would report a finished command lost.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskNotification('t1', { status: 'completed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a backgrounded command that failed on its own is settled, not lost', () => {
  // A non-zero exit is a result the model already has. Nudging over it would
  // re-run work that ran.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'failed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

// --- the subagent exclusion, from both directions -----------------------------

test('a subagent task_id neither enrols nor corrupts a real bash entry', () => {
  // `lostSubagents` owns delegated work. A `task_updated`/`task_notification`
  // carrying a subagent's task_id has to find nothing here — otherwise one turn
  // emits two contradictory notices about one loss.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 'bash-1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('agent-1', { status: 'killed', is_backgrounded: true }))
  foldBackgroundCommand(ledger, taskNotification('agent-1', { status: 'stopped' }))
  foldBackgroundCommand(ledger, taskNotification('bash-1', { status: 'completed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a task_type the SDK adds later is not enrolled', () => {
  // The set is open — local_workflow already exists — and anything unrecognised
  // has to stay out rather than be guessed at.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_workflow', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

// --- malformed input, from all three new readers ------------------------------

test('null, arrays and wrong-typed ids fold into nothing rather than a false alarm', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(ledger, null as never)
  foldBackgroundCommand(ledger, [] as never)
  foldBackgroundCommand(ledger, 'task_started' as never)
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 42, task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: ['t1'], task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't2', task_type: ['local_bash'], is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't3', task_type: 'local_bash', is_backgrounded: 'yes' }),
  )
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a settle message with a malformed patch neither throws nor invents an entry', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(ledger, { type: 'system', subtype: 'task_updated', task_id: 'gone',
    patch: { status: 'killed' } } as never)
  foldBackgroundCommand(ledger, { type: 'system', subtype: 'task_notification', task_id: 'gone',
    status: 'stopped' } as never)
  foldBackgroundCommand(ledger, { type: 'system', subtype: 'task_updated', task_id: 't1',
    patch: null } as never)
  foldBackgroundCommand(ledger, { type: 'system', subtype: 'task_updated', task_id: 't1',
    patch: ['killed'] } as never)
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a garbled patch on a live entry leaves it exactly as it was', () => {
  // Unsettled going in, unsettled coming out: a shape change must not be able
  // to flip a state either way.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: { done: true } }))
  foldBackgroundCommand(ledger, taskNotification('t1', { status: ['completed'] }))
  expect(lostBackgroundCommands(ledger)).toBe(1)
})

test('a settled entry is not resurrected by a later garbled message', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskNotification('t1', { status: 'completed' }))
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'unknown-to-us' }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('cancelledWithoutInterrupt survives every wrong shape it could be handed', () => {
  expect(cancelledWithoutInterrupt(null as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: null } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: {} } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: [null] } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: [[]] } as never)).toBe(false)
  expect(cancelledWithoutInterrupt({ type: 'user', tool_result_meta: ['cancelled'] } as never)).toBe(
    false,
  )
  expect(cancelledWithoutInterrupt(userCancelled(null))).toBe(false)
  expect(cancelledWithoutInterrupt(userCancelled(['cancelled']))).toBe(false)
  // Case matters: only the SDK's own literal counts, not something like it.
  expect(cancelledWithoutInterrupt(userCancelled('Cancelled'))).toBe(false)
  // A rejection that carries a reason is a boundary, not harness noise.
  expect(cancelledWithoutInterrupt(userCancelled('rejected'))).toBe(false)
})

test('a cancellation anywhere in tool_result_meta is found, not just the first entry', () => {
  expect(
    cancelledWithoutInterrupt({
      type: 'user',
      tool_result_meta: [{ id: 'a' }, null, { id: 'b', non_execution_kind: 'cancelled' }],
    } as never),
  ).toBe(true)
})

// --- two fixes from an independent review -------------------------------------
//
// Both confirmed with concrete inputs against the first version of this file:
// an ambient/skip_transcript flag on a *settle* message (not the enrolling
// task_started) dropped the settle instead of applying it, and two commands
// lost in one turn were never exercised together.

test('an ambient flag on the settling task_notification does not block the settle', () => {
  // The guard only does real work in the task_started branch, where it keeps
  // an ambient task off the ledger entirely. Repeating it here on a
  // *settling* message for an already-enrolled real command was the bug: it
  // returned before `task.status = 'settled'` ran, leaving a command that
  // reported `completed` still reading as unsettled — a false alarm on a
  // healthy turn, not a suppressed one.
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskNotification('t1', { status: 'completed', ambient: true }))
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('a skip_transcript flag on the settling task_notification does not block it either', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskNotification('t1', { status: 'completed', skip_transcript: true }),
  )
  expect(lostBackgroundCommands(ledger)).toBe(0)
})

test('two backgrounded commands lost in the same turn both count', () => {
  const ledger: BackgroundCommandLedger = new Map()
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't1', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(
    ledger,
    taskStarted({ task_id: 't2', task_type: 'local_bash', is_backgrounded: true }),
  )
  foldBackgroundCommand(ledger, taskUpdated('t1', { status: 'killed' }))
  foldBackgroundCommand(ledger, taskUpdated('t2', { status: 'killed' }))
  expect(lostBackgroundCommands(ledger)).toBe(2)
})

