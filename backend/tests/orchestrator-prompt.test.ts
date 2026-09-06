import { expect, test } from 'bun:test'
import {
  AUTONOMY_INSTRUCTION,
  DELEGATION_INSTRUCTION,
  rosterInstruction,
  type Specialist,
  withOrchestratorGuidance,
} from '../src/library/orchestrator-prompt'

const METHOD = 'Split by context, not by task list.'
const TEAM: Specialist[] = [
  { name: 'agentoo:tester', description: 'Runs the change and reports what breaks.' },
  { name: 'agentoo:backend-dev', description: 'Implements server-side changes.' },
]

test('a team lead is told who is actually on the team', () => {
  const composed = withOrchestratorGuidance('Ship it.', METHOD, true, TEAM)
  expect(composed).toContain('agentoo:tester — Runs the change and reports what breaks.')
  expect(composed).toContain('agentoo:backend-dev — Implements server-side changes.')
  // Plugin-qualified, because a brief addressed to a bare `tester` finds nothing.
  expect(composed).not.toContain('- tester —')
})

test('the roster is the project assignment, so an unassigned specialist is absent', () => {
  const composed = withOrchestratorGuidance('Ship it.', METHOD, true, [TEAM[0] as Specialist])
  expect(composed).toContain('agentoo:tester')
  expect(composed).not.toContain('backend-dev')
})

test('an empty roster says so rather than leaving delegation pointing at nothing', () => {
  const composed = withOrchestratorGuidance('Ship it.', METHOD, true, [])
  expect(composed).toContain('<team>')
  expect(composed).toContain('No specialists are assigned to this project')
  // The delegation guarantee still applies; it is the roster that is empty.
  expect(composed).toContain(DELEGATION_INSTRUCTION)
})

test('a solo agent gets no method, no delegation and no roster — only autonomy', () => {
  const composed = withOrchestratorGuidance('Do the work.', METHOD, false, TEAM)
  expect(composed).not.toContain(METHOD)
  expect(composed).not.toContain(DELEGATION_INSTRUCTION)
  expect(composed).not.toContain('<team>')
  expect(composed).not.toContain('agentoo:tester')
  expect(composed).toContain(AUTONOMY_INSTRUCTION)
  expect(composed).toContain('Do the work.')
})

test('order: shared method, then the agent, then the rules that get the last word', () => {
  const composed = withOrchestratorGuidance('Ship it.', METHOD, true, TEAM)
  const method = composed.indexOf(METHOD)
  const own = composed.indexOf('Ship it.')
  const delegation = composed.indexOf(DELEGATION_INSTRUCTION)
  const team = composed.indexOf('<team>')
  const autonomy = composed.indexOf(AUTONOMY_INSTRUCTION)
  expect(method).toBeGreaterThanOrEqual(0)
  expect(own).toBeGreaterThan(method)
  expect(delegation).toBeGreaterThan(own)
  expect(team).toBeGreaterThan(delegation)
  expect(autonomy).toBeGreaterThan(team)
})

test('composing twice changes nothing, so a resumed session is not layered', () => {
  const once = withOrchestratorGuidance('Ship it.', METHOD, true, TEAM)
  expect(withOrchestratorGuidance(once, METHOD, true, TEAM)).toBe(once)
  // Including when the assignment changed underneath it: still one roster.
  expect(withOrchestratorGuidance(once, METHOD, true, [])).toBe(once)
})

test('a roster line carries the description, which is what routing decisions use', () => {
  const block = rosterInstruction([
    { name: 'agentoo:planner', description: 'Turns a goal into ordered tracks.' },
  ])
  expect(block).toContain('- agentoo:planner — Turns a goal into ordered tracks.')
  expect(block).toContain('the exact name shown')
})

test('the composed prompt carries the three lessons from the failed push session', () => {
  const composed = withOrchestratorGuidance('Ship it.', METHOD, true, TEAM)
  // An explicit instruction is not ambiguity to resolve.
  expect(composed).toContain(
    'An instruction that names its own mechanism is not ambiguity to resolve: use the mechanism the operator named, and put a better idea in the report rather than in the tool call.',
  )
  // A refused or cancelled tool call is not a stop signal.
  expect(composed).toContain(
    'A refusal or cancellation that carries no reason is harness noise, not the operator speaking — nobody approves a tool by hand in this deployment — so it says nothing about what is wanted; one that carries a reason names a boundary, so satisfy it or find another route to the same goal instead of relitigating it; either way it closes one route, not the task, so keep moving instead of stopping to lay out options and asking which one to take.',
  )
  // A turn ends when you stop talking, and a still-running background job dies with it.
  expect(composed).toContain(
    'Your turn ends the instant you stop talking, and whatever is still running dies with it no matter what notification a tool promised — so never close a turn depending on a result that has not arrived yet: run it in the foreground with the timeout raised, and if it cannot finish inside that ceiling, say so in the report instead of backgrounding it and hoping.',
  )
})
