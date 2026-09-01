import { expect, test } from 'bun:test'
import { buildTranscript, displayAgent, textOf, toolCallsOf } from '../src/features/sessions/lib/transcript'

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

test('a delegation becomes one group holding its prompt and its work', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'build it' } }),
    msg({ type: 'assistant', title: 'orchestrator: delegating', payload: {} }),
    msg({
      type: 'system',
      title: 'architect: design the runner',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'design the runner',
        prompt: 'Design the session runner. Do not write files.',
      },
    }),
    // Everything the subagent does carries the Task call's id.
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading schema' }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: writing the design' }),
    msg({ type: 'system', payload: { subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } } }),
    msg({ type: 'assistant', title: 'orchestrator: applying it' }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])

  expect(nodes.map((x) => x.kind)).toEqual(['prompt', 'event', 'task', 'event', 'event'])
  const task = nodes[2]
  if (task?.kind !== 'task') throw new Error('expected a task node')
  expect(task.agent).toBe('architect')
  expect(task.prompt).toBe('Design the session runner. Do not write files.')
  expect(task.status).toBe('completed')
  // The subagent's work nests, and does not leak into the top level.
  expect(task.children.map((c) => (c.kind === 'event' ? c.message.title : c.kind))).toEqual([
    'architect: reading schema',
    'architect: writing the design',
  ])
})

test('a subagent that spawns its own subagent nests two deep', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', title: 'lead: plan', payload: { subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', subagent_type: 'lead' } }),
    msg({ type: 'system', parentToolUseId: 'tu1', title: 'helper: dig', payload: { subtype: 'task_started', task_id: 't2', tool_use_id: 'tu2', subagent_type: 'helper' } }),
    msg({ type: 'assistant', parentToolUseId: 'tu2', title: 'helper: grepping' }),
  ])

  expect(nodes.length).toBe(1)
  const lead = nodes[0]
  if (lead?.kind !== 'task') throw new Error('expected lead task')
  const helper = lead.children[0]
  if (helper?.kind !== 'task') throw new Error('expected nested helper task')
  expect(helper.agent).toBe('helper')
  expect(helper.children.length).toBe(1)
})

test('housekeeping tasks are dropped, and their status patch does not resurrect them', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', title: null, payload: { subtype: 'task_started', task_id: 't9', tool_use_id: 'tu9', ambient: true } }),
    msg({ type: 'system', payload: { subtype: 'task_updated', task_id: 't9', patch: { status: 'completed' } } }),
  ])
  expect(nodes).toEqual([])
})

test('untitled rows are dropped, since the backend titles everything worth showing', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', payload: { subtype: 'init' } }),
    msg({ type: 'user', payload: { message: { content: [{ type: 'tool_result' }] } } }),
    msg({ type: 'assistant', title: 'orchestrator: hi' }),
  ])
  expect(nodes.length).toBe(1)
})

test('out-of-order arrival is sorted by seq, not by arrival', () => {
  const nodes = buildTranscript([
    { id: 'b', sessionId: 's', seq: 2, type: 'assistant', title: 'second', parentToolUseId: null, pending: false, payload: {}, createdAt: '' },
    { id: 'a', sessionId: 's', seq: 1, type: 'assistant', title: 'first', parentToolUseId: null, pending: false, payload: {}, createdAt: '' },
  ] as never)
  expect(nodes.map((x) => (x.kind === 'event' ? x.message.title : ''))).toEqual(['first', 'second'])
})

test('an orphaned child does not vanish', () => {
  n = 0
  // The task_started was compacted away or lost; the work still has to show up.
  const nodes = buildTranscript([msg({ type: 'assistant', parentToolUseId: 'gone', title: 'x: work' })])
  expect(nodes.length).toBe(1)
})

test('text and tool calls are read out of the payload', () => {
  const m = {
    payload: { message: { content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
      { type: 'text', text: 'world' },
    ] } },
  } as never
  expect(textOf(m)).toBe('hello\n\nworld')
  expect(toolCallsOf(m)).toEqual([{ id: 'tu1', name: 'Read', input: { file_path: '/a' } }])
})

test('the plugin namespace is dropped from an agent name', () => {
  // The engine reports library agents as `agentoo:<name>`; every one carries it.
  expect(displayAgent('agentoo:scout')).toBe('scout')
  expect(displayAgent('Explore')).toBe('Explore')
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', title: 'scout: read it', payload: {
      subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', subagent_type: 'agentoo:scout',
    } }),
  ])
  const task = nodes[0]
  if (task?.kind !== 'task') throw new Error('expected a task node')
  expect(task.agent).toBe('scout')
})

test('progress pings do not leak beside the orchestrator steps', () => {
  n = 0
  // The reported bug: task_progress has no parentToolUseId, so each ping became
  // a top-level "architect: Bash" row duplicating work already nested below.
  const nodes = buildTranscript([
    msg({ type: 'assistant', title: 'orchestrator: delegating' }),
    msg({ type: 'system', title: 'architect: investigate', payload: {
      subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1',
      subagent_type: 'architect', description: 'investigate',
    } }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading' }),
    msg({ type: 'system', title: 'architect: Bash', payload: {
      subtype: 'task_progress', task_id: 't1', subagent_type: 'architect', last_tool_name: 'Bash',
    } }),
    msg({ type: 'system', title: 'architect: Bash', payload: {
      subtype: 'task_progress', task_id: 't1', subagent_type: 'architect', summary: 'listing files',
    } }),
  ])

  expect(nodes.map((x) => x.kind)).toEqual(['event', 'task'])
  const task = nodes[1]
  if (task?.kind !== 'task') throw new Error('expected a task node')
  // The pings become progress on the group, not rows of their own.
  expect(task.progress).toBe('listing files')
  expect(task.children.length).toBe(1)
})

test('a task heading is the description alone, since the badge names the agent', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', title: 'architect: investigate project structure', payload: {
      subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1',
      subagent_type: 'architect', description: 'investigate project structure',
    } }),
  ])
  const task = nodes[0]
  if (task?.kind !== 'task') throw new Error('expected a task node')
  expect(task.agent).toBe('architect')
  expect(task.title).toBe('investigate project structure')
})
