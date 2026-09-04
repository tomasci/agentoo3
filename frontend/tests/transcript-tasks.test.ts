// What a task row is, and when it stops being "running".
//
// Every fixture here is the real shape from an exported session in which 132 of
// the 158 `task_started` messages were not delegations at all but backgrounded
// shell commands, and all 165 completion notifications were discarded — so
// almost every task row stayed blue "running" forever and the shell ones
// rendered as an empty box titled with a raw 124-character command.

import { expect, test } from 'bun:test'
import { buildTranscript } from '../src/features/sessions/lib/transcript'

type M = Parameters<typeof buildTranscript>[0][number]
let n = 0
const msg = (o: Partial<M> & { type: string }): M =>
  ({
    id: `m${n}`,
    sessionId: 's',
    seq: n++,
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: {},
    createdAt: '',
    ...o,
  }) as M

const task = (payload: Record<string, unknown>, title: string | null = null) =>
  msg({ type: 'system', title, payload: { subtype: 'task_started', ...payload } })

const tasks = (nodes: ReturnType<typeof buildTranscript>) =>
  nodes.filter((node): node is Extract<typeof node, { kind: 'task' }> => node.kind === 'task')

const LONG_COMMAND =
  'cd /opt/agentoo/projects/agentoo3/worktrees/10182dae-442e-441e-baf7-ca9103d49839/frontend && bun test tests/ 2>&1 | tail -40'

test('a backgrounded shell command is not shown as a delegated agent', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({
        task_type: 'local_bash',
        task_id: 't1',
        tool_use_id: 'tu1',
        description: LONG_COMMAND,
      }),
    ]),
  )
  // It used to read 'subagent', which is what sent the operator looking for a
  // delegation that never existed.
  expect(row?.agent).toBe('shell')
  expect(row?.agent).not.toBe('subagent')
  // The command belongs in the body, where it can wrap; the title stays short.
  expect(row?.command).toBe(LONG_COMMAND)
  expect(row?.title).not.toContain('bun test')
  expect((row?.title ?? '').length).toBeLessThan(40)
  // A shell call has no brief and no children, so `prompt` must not claim one.
  expect(row?.prompt).toBeNull()
})

test('a real delegation still carries its agent and its brief', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({
        task_type: 'local_agent',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'agentoo:frontend-dev',
        description: 'Migrate the app shell',
        prompt: 'Move the shell onto the design system.',
      }),
    ]),
  )
  expect(row?.agent).toBe('frontend-dev')
  expect(row?.title).toBe('Migrate the app shell')
  expect(row?.prompt).toBe('Move the shell onto the design system.')
  expect(row?.command).toBeNull()
})

test('an empty description falls back rather than rendering a blank title', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task(
        { task_type: 'local_agent', task_id: 't1', tool_use_id: 'tu1', description: '' },
        'tester: verify',
      ),
    ]),
  )
  // `??` let '' through as a title; `||` is what makes the fallback reachable.
  expect(row?.title).toBe('tester: verify')
})

test('a completion notification resolves a task that would otherwise stay running', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({ task_type: 'local_bash', task_id: 't1', tool_use_id: 'tu1', description: 'bun test' }),
      // The signal the UI used to throw away: untitled, so it has to be handled
      // before the guard that drops everything the backend declined to title.
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 't1', status: 'completed' } }),
    ]),
  )
  expect(row?.status).toBe('completed')
})

test('a background agent stopped at shutdown is killed, not completed', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({
        task_type: 'local_agent',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'agentoo:frontend-dev',
        description: 'Add stylelint enforcement',
      }),
      // Every 'stopped' notification in the real session was a killed agent:
      // "No completion record was found for background agent ...".
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 't1', status: 'stopped' } }),
    ]),
  )
  expect(row?.status).toBe('killed')
})

test('a failed notification is reported as failed', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({ task_type: 'local_bash', task_id: 't1', tool_use_id: 'tu1', description: 'bun test' }),
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 't1', status: 'failed' } }),
    ]),
  )
  expect(row?.status).toBe('failed')
})

test('an unknown or absent notification status leaves the task alone', () => {
  n = 0
  const [row] = tasks(
    buildTranscript([
      task({ task_type: 'local_bash', task_id: 't1', tool_use_id: 'tu1', description: 'bun test' }),
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 't1', status: 'pondering' } }),
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 't1' } }),
    ]),
  )
  expect(row?.status).toBe('running')
})

test('a notification for an unknown task is ignored rather than throwing', () => {
  n = 0
  expect(() =>
    buildTranscript([
      msg({ type: 'system', payload: { subtype: 'task_notification', task_id: 'nope', status: 'completed' } }),
    ]),
  ).not.toThrow()
})

test('a notification never becomes a row of its own', () => {
  n = 0
  const nodes = buildTranscript([
    task({ task_type: 'local_bash', task_id: 't1', tool_use_id: 'tu1', description: 'bun test' }),
    msg({
      type: 'system',
      title: 'this should still not appear',
      payload: { subtype: 'task_notification', task_id: 't1', status: 'completed' },
    }),
  ])
  expect(nodes).toHaveLength(1)
  expect(nodes[0]?.kind).toBe('task')
})
