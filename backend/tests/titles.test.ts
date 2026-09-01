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

test('progress prefers the rolling summary, then the last tool', () => {
  expect(titleFor(m({ type: 'system', subtype: 'task_progress', subagent_type: 'reviewer',
    summary: 'checking the SSE endpoint' }), 'x')).toBe('reviewer: checking the SSE endpoint')
  expect(titleFor(m({ type: 'system', subtype: 'task_progress', subagent_type: 'reviewer',
    last_tool_name: 'Grep' }), 'x')).toBe('reviewer: Grep')
  expect(titleFor(m({ type: 'system', subtype: 'task_progress' }), 'x')).toBeNull()
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
