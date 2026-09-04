// Regression cover for the two things a turn has to get right once it is over:
// what it cost, and whether it actually finished.
//
// The numbers here are not invented. They are lifted from an exported 3.5-hour
// session that recorded $494.91 for $72.78 of work and reported five "crashes"
// that were not crashes, because both signals were being read wrong.

import { expect, test } from 'bun:test'
import { lostSubagents, newSpend } from '../src/queue/session-run.worker'

/** A result message, with only the fields these two helpers look at. */
const result = (stats?: Record<string, unknown>, cost?: number) =>
  ({
    type: 'result',
    subtype: 'success',
    ...(cost !== undefined && { total_cost_usd: cost }),
    ...(stats && { subagent_stats: stats }),
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
