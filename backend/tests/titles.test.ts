import { expect, test } from 'bun:test'
import { titleFor } from '../src/features/sessions/titles'

const m = (o: unknown) => o as never

test('a delegated task is titled by its subagent type and description', () => {
  expect(
    titleFor(m({ type: 'system', subtype: 'task_started', subagent_type: 'architect',
      description: 'design the session runner' }), 'orchestrator'),
  ).toBe('architect: design the session runner')
})

test('housekeeping tasks get no row', () => {
  expect(titleFor(m({ type: 'system', subtype: 'task_started', ambient: true,
    description: 'watcher' }), 'orchestrator')).toBeNull()
  expect(titleFor(m({ type: 'system', subtype: 'task_started', skip_transcript: true,
    description: 'cache' }), 'orchestrator')).toBeNull()
})

test('a progress ping gets no row of its own', () => {
  // It is emitted at the top level with no parent_tool_use_id, so a row here
  // lands beside the orchestrator's steps and repeats work already nested in
  // the subagent's group. The transcript shows these as progress on the group.
  expect(titleFor(m({ type: 'system', subtype: 'task_progress', subagent_type: 'tester',
    summary: 'checking the SSE endpoint' }), 'x')).toBeNull()
  expect(titleFor(m({ type: 'system', subtype: 'task_progress', subagent_type: 'tester',
    last_tool_name: 'Grep' }), 'x')).toBeNull()
})

test('a turn that only spawns subagents gets no row', () => {
  // The group below it carries the prompt and the work; "orchestrator: Agent"
  // adds nothing.
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Agent' },
  ] } }), 'orchestrator')).toBeNull()
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Task' }, { type: 'tool_use', name: 'Task' },
  ] } }), 'orchestrator')).toBeNull()
  // But a spawn alongside real work still counts as work.
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Agent' }, { type: 'tool_use', name: 'Read' },
  ] } }), 'orchestrator')).toBe('orchestrator: Agent, Read')
  // And text always wins over tools.
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Delegating this.' }, { type: 'tool_use', name: 'Agent' },
  ] } }), 'orchestrator')).toBe('orchestrator: Delegating this.')
})

test('an assistant turn is titled by its first sentence', () => {
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'text', text: 'I will start by reading the schema. Then I will plan.' },
  ] } }), 'orchestrator')).toBe('orchestrator: I will start by reading the schema.')
})

test('a silent tool turn is titled by what it called, with counts', () => {
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' },
    { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' },
  ] } }), 'orchestrator')).toBe('orchestrator: Read ×3, Grep')
})

test('long titles are cut on a word boundary', () => {
  const long = `${'alpha bravo '.repeat(30)}end`
  const out = titleFor(m({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } }), 'x')
  expect(out!.length).toBeLessThanOrEqual(122)
  expect(out!.endsWith('…')).toBe(true)
  // The kept text must end where a word ends in the original, not mid-word.
  const kept = out!.slice('x: '.length, -1)
  expect(long.startsWith(kept)).toBe(true)
  expect(long[kept.length]).toBe(' ')
})

test('tool results and init produce no row of their own', () => {
  expect(titleFor(m({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), 'x')).toBeNull()
  expect(titleFor(m({ type: 'system', subtype: 'init' }), 'x')).toBeNull()
})

test('results say whether the turn worked', () => {
  expect(titleFor(m({ type: 'result', subtype: 'success' }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'error_during_execution', is_error: true }), 'x')).toBe('Turn failed')
})

test('an errored task-notification result still gets a row', () => {
  // The zero-turn notification check exists to stop confirming work that
  // never ran; it must not also hide a turn that ran and failed. The killed
  // background push behind this whole change is one kind of "nothing to
  // report" — an error is not, and still needs the reader told.
  expect(titleFor(m({ type: 'result', subtype: 'error_during_execution', is_error: true,
    num_turns: 0, origin: { kind: 'task-notification' } }), 'x')).toBe('Turn failed')
  expect(titleFor(m({ type: 'result', subtype: 'error_max_budget_usd', is_error: true,
    num_turns: 0, origin: { kind: 'task-notification' } }), 'x')).toBe('Turn failed')
})

test('an empty task-notification result gets no row', () => {
  // A background job killed at the turn boundary: zero turns ran, so there is
  // nothing to confirm as "complete".
  expect(
    titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
      origin: { kind: 'task-notification' } }), 'x'),
  ).toBeNull()
  // Both conditions are required. A task-notification that actually ran turns
  // still gets the normal wording.
  expect(
    titleFor(m({ type: 'result', subtype: 'success', num_turns: 2,
      origin: { kind: 'task-notification' } }), 'x'),
  ).toBe('Turn complete')
  // And a zero-turn result with no task-notification origin — an ordinary
  // turn, not a stray notification — is untouched too.
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0 }), 'x')).toBe('Turn complete')
})

test('whitespace in a title is collapsed to one line', () => {
  expect(titleFor(m({ type: 'assistant', message: { content: [
    { type: 'text', text: '  Reading\n\n  the   schema now.' },
  ] } }), 'orchestrator')).toBe('orchestrator: Reading the schema now.')
})

test('a namespaced subagent is titled without the plugin prefix', () => {
  expect(
    titleFor(m({ type: 'system', subtype: 'task_started', subagent_type: 'agentoo:scout',
      description: 'read notes.txt' }), 'lead'),
  ).toBe('scout: read notes.txt')
})

test('a turn that threw before producing a result still gets a row', () => {
  // Otherwise the transcript just stops, with the reason only on the session row.
  expect(titleFor(m({ type: 'error', message: 'Claude Code process exited with code 1' }), 'lead'))
    .toBe('Turn failed: Claude Code process exited with code 1')
  expect(titleFor(m({ type: 'error', message: '' }), 'lead')).toBe('Turn failed: unknown error')
})

test('the untitled-result predicate stays narrow enough to leave real turns alone', () => {
  // Blast radius: the frontend drops rows the backend declined to title, and
  // markAnswers closes a turn on the result node to promote the reply above it.
  // A predicate that widened by one field would stop promoting answers
  // session-wide, so every neighbouring shape is pinned here.
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
    origin: { kind: 'human' } }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
    origin: { kind: 'auto-continuation' } }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 1,
    origin: { kind: 'task-notification' } }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success',
    origin: { kind: 'task-notification' } }), 'x')).toBe('Turn complete')
})

test('a malformed origin or num_turns degrades to titling, never to a dropped row', () => {
  // Losing a row is the expensive direction: it takes the answer promotion with
  // it. Anything the reader cannot make sense of has to keep its heading.
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
    origin: 'task-notification' }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
    origin: null }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: 0,
    origin: [{ kind: 'task-notification' }] }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: '0',
    origin: { kind: 'task-notification' } }), 'x')).toBe('Turn complete')
  expect(titleFor(m({ type: 'result', subtype: 'success', num_turns: null,
    origin: { kind: 'task-notification' } }), 'x')).toBe('Turn complete')
})
