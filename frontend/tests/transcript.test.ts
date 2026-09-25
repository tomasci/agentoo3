import { expect, test } from 'bun:test'
import {
  buildTranscript,
  displayAgent,
  modelOf,
  textOf,
  thinkingOf,
  toolCallsOf,
} from '../src/features/sessions/lib/transcript'

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
  // The task_started was compacted away, lost, or simply not loaded into this
  // window yet — the work still has to show up. It now does so nested inside
  // a partial group named for the tool_use_id nothing else claimed, rather
  // than flattened at the top level: see transcript-partial-window.test.ts
  // for the row-count bug that shape used to cause.
  const nodes = buildTranscript([msg({ type: 'assistant', parentToolUseId: 'gone', title: 'x: work' })])
  expect(nodes.length).toBe(1)
  const [group] = nodes
  if (group?.kind !== 'task') throw new Error('expected a partial task group')
  expect(group.partial).toBe(true)
  expect(group.id).toBe('task:gone')
  expect(group.children.map((c) => (c.kind === 'event' ? c.message.title : c.kind))).toEqual(['x: work'])
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

const say = (text: string, over: Record<string, unknown> = {}) =>
  msg({ type: 'assistant', title: `orchestrator: ${text}`, payload: { message: { content: [{ type: 'text', text }] } }, ...over })

test("a turn's closing reply is promoted out of the collapsed rows", () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'what is this?' } }),
    say('Let me look.'),
    msg({ type: 'assistant', title: 'orchestrator: Read', payload: { message: { content: [{ type: 'tool_use', name: 'Read' }] } } }),
    say('# agentoo\n\nA self-hosted platform.'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])

  expect(nodes.map((x) => x.kind)).toEqual(['prompt', 'event', 'event', 'answer', 'event'])
  const answer = nodes[3]
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.text).toBe('# agentoo\n\nA self-hosted platform.')
})

test('only the last reply of each turn is the answer', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'one' } }),
    say('first answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
    msg({ type: 'prompt', payload: { text: 'two' } }),
    say('working'),
    say('second answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  const answers = nodes.filter((x) => x.kind === 'answer')
  expect(answers.length).toBe(2)
  expect(answers.map((a) => (a.kind === 'answer' ? a.text : ''))).toEqual(['first answer', 'second answer'])
})

test("a subagent's reply is never promoted — it belongs to its group", () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'system', title: 'scout: look', payload: {
      subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', subagent_type: 'scout', description: 'look',
    } }),
    say('nested reply', { parentToolUseId: 'tu1' }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  expect(nodes.some((x) => x.kind === 'answer')).toBe(false)
})

test('a turn still running has no answer yet', () => {
  n = 0
  const nodes = buildTranscript([msg({ type: 'prompt', payload: { text: 'go' } }), say('thinking about it')])
  expect(nodes.some((x) => x.kind === 'answer')).toBe(false)
})

test('modelOf reads the model straight off an assistant frame, and is null everywhere else', () => {
  const withModel = { payload: { message: { model: 'claude-opus-5', content: [] } } } as never
  expect(modelOf(withModel)).toBe('claude-opus-5')

  n = 0
  const prompt = msg({ type: 'prompt', payload: { text: 'go' } })
  const result = msg({ type: 'result', payload: { subtype: 'success' } })
  expect(modelOf(prompt)).toBeNull()
  expect(modelOf(result)).toBeNull()
})

test("the answer node carries the model of the message it replaces, since markAnswers drops the message itself", () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    msg({
      type: 'assistant',
      title: 'orchestrator: replying',
      payload: { message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] } },
    }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  const answer = nodes[1]
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.model).toBe('claude-opus-5')
})

test('an answer promoted from a message with no model carries model: null, not undefined', () => {
  n = 0
  const nodes = buildTranscript([
    say('done'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  const answer = nodes[0]
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.model).toBeNull()
})

test('thinking is read out of the payload rather than dumped as JSON', () => {
  const m = { payload: { message: { content: [
    { type: 'thinking', thinking: 'Clean tree.' },
    { type: 'text', text: 'visible' },
  ] } } } as never
  expect(thinkingOf(m)).toBe('Clean tree.')
  expect(textOf(m)).toBe('visible')
})
