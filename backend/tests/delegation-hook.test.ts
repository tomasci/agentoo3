// The two delegation rules that are enforced rather than asked for.
//
// Both come from the same exported session: it delegated nine subagents into the
// background and had seven of them killed when the turn ended, and it twice
// addressed `Explore` — a generic agent the harness ships, which the roster
// prompt had assured it would "resolve to nothing".

import { expect, test } from 'bun:test'
import { delegationHook } from '../src/features/sessions/runner-options'
import type { Specialist } from '../src/library/orchestrator-prompt'

const TEAM: Specialist[] = [
  { name: 'agentoo:frontend-dev', description: 'Client-side changes.' },
  { name: 'agentoo:tester', description: 'Exercises the change.' },
]

/** Run the matcher's hook the way the SDK would, on a PreToolUse event. */
const call = (specialists: Specialist[], tool: string, input: unknown) => {
  const matcher = delegationHook(specialists)
  const hook = matcher.hooks[0]
  if (!hook) throw new Error('delegationHook registered no callback')
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
      tool_use_id: 'toolu_test',
    } as never,
    'toolu_test',
    { signal: AbortSignal.timeout(1000) },
  )
}

const decision = (out: Awaited<ReturnType<typeof call>>) =>
  (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput

test('delegation is forced into the foreground when the model leaves it unset', async () => {
  // The default is background, and the session that relied on it lost work: the
  // CLI exits with the turn and takes anything still backgrounded with it.
  const out = decision(
    await call(TEAM, 'Agent', { subagent_type: 'agentoo:tester', description: 'Verify' }),
  )
  expect(out?.permissionDecision).toBe('allow')
  expect(out?.updatedInput).toMatchObject({
    subagent_type: 'agentoo:tester',
    description: 'Verify',
    run_in_background: false,
  })
})

test('an explicit request to background is overridden too', async () => {
  const out = decision(
    await call(TEAM, 'Agent', { subagent_type: 'agentoo:tester', run_in_background: true }),
  )
  expect((out?.updatedInput as Record<string, unknown>).run_in_background).toBe(false)
})

test('a call already in the foreground is left exactly as it is', async () => {
  const out = await call(TEAM, 'Agent', {
    subagent_type: 'agentoo:tester',
    run_in_background: false,
  })
  expect(decision(out)).toBeUndefined()
})

test('an agent outside the roster is refused, and told what it may address', async () => {
  const out = decision(await call(TEAM, 'Agent', { subagent_type: 'Explore' }))
  expect(out?.permissionDecision).toBe('deny')
  const reason = String(out?.permissionDecisionReason)
  expect(reason).toContain('Explore')
  // The names have to come back, or the model cannot retry correctly.
  expect(reason).toContain('agentoo:frontend-dev')
  expect(reason).toContain('agentoo:tester')
})

test('a roster agent is not refused', async () => {
  const out = decision(await call(TEAM, 'Agent', { subagent_type: 'agentoo:frontend-dev' }))
  expect(out?.permissionDecision).toBe('allow')
})

test('the older Task name is governed identically', async () => {
  expect(decision(await call(TEAM, 'Task', { subagent_type: 'Explore' }))?.permissionDecision).toBe(
    'deny',
  )
})

test('an empty roster leaves delegation alone, since there is nothing to prefer', async () => {
  // A project may legitimately have an orchestrator and no specialists; the
  // roster prompt tells it to fall back on the harness's own agents.
  const out = decision(await call([], 'Agent', { subagent_type: 'Explore' }))
  expect(out?.permissionDecision).toBe('allow')
  expect((out?.updatedInput as Record<string, unknown>).run_in_background).toBe(false)
})

test('tools that are not delegation are untouched', async () => {
  expect(decision(await call(TEAM, 'Bash', { command: 'ls' }))).toBeUndefined()
  expect(decision(await call(TEAM, 'Write', { file_path: '/tmp/x' }))).toBeUndefined()
})

test('a malformed tool input still gets the foreground rule and does not throw', async () => {
  const out = decision(await call(TEAM, 'Agent', null))
  expect((out?.updatedInput as Record<string, unknown>).run_in_background).toBe(false)
})
