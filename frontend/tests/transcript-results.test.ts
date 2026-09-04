// Pairing a tool call with what it returned.
//
// Tool results were collected by the backend and then dropped by the frontend:
// a comment claimed they were "rendered under the tool call that asked for
// them" and no such rendering existed. The visible symptom was a `ListAgents`
// row showing an empty `{}` and nothing else, when the result it discarded was
// the roster the operator actually wanted to read.

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

/** An assistant turn that makes one tool call. */
const callMsg = (id: string, name: string, input: unknown, title = `orchestrator: ${name}`) =>
  msg({
    type: 'assistant',
    title,
    payload: { message: { content: [{ type: 'tool_use', id, name, input }] } },
  })

/** The user-role message the engine replays a tool result on. */
const resultMsg = (toolUseId: string, content: unknown, isError = false) =>
  msg({
    type: 'user',
    payload: {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError && { is_error: true }) },
        ],
      },
    },
  })

const events = (nodes: ReturnType<typeof buildTranscript>) =>
  nodes.filter((node): node is Extract<typeof node, { kind: 'event' }> => node.kind === 'event')

const ROSTER = 'Subagents (2):\n  a914e17  ·  agentoo:frontend-dev  ·  running'

test('a result is attached to the call that asked for it', () => {
  n = 0
  const [row] = events(
    buildTranscript([callMsg('tu1', 'ListAgents', {}), resultMsg('tu1', ROSTER)]),
  )
  expect(row?.results.tu1?.text).toBe(ROSTER)
  expect(row?.results.tu1?.isError).toBe(false)
})

test('a result block carrying text blocks rather than a bare string is read too', () => {
  n = 0
  const [row] = events(
    buildTranscript([
      callMsg('tu1', 'Bash', { command: 'ls' }),
      resultMsg('tu1', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
    ]),
  )
  expect(row?.results.tu1?.text).toBe('one\n\ntwo')
})

test('an error result is marked as one', () => {
  n = 0
  const [row] = events(
    buildTranscript([callMsg('tu1', 'Bash', { command: 'false' }), resultMsg('tu1', 'boom', true)]),
  )
  expect(row?.results.tu1?.isError).toBe(true)
  expect(row?.results.tu1?.text).toBe('boom')
})

test('each result goes to its own call, not to whichever came last', () => {
  n = 0
  const nodes = events(
    buildTranscript([
      callMsg('tu1', 'Read', { file_path: '/a' }),
      callMsg('tu2', 'Read', { file_path: '/b' }),
      resultMsg('tu2', 'contents of b'),
      resultMsg('tu1', 'contents of a'),
    ]),
  )
  expect(nodes[0]?.results.tu1?.text).toBe('contents of a')
  expect(nodes[0]?.results.tu2).toBeUndefined()
  expect(nodes[1]?.results.tu2?.text).toBe('contents of b')
})

test('a result still never becomes a transcript row of its own', () => {
  n = 0
  // Even titled — the rule is about what a tool result *is*, not about titling.
  const nodes = buildTranscript([
    callMsg('tu1', 'ListAgents', {}),
    { ...resultMsg('tu1', ROSTER), title: 'should not appear' } as M,
  ])
  expect(nodes).toHaveLength(1)
  expect(nodes[0]?.kind).toBe('event')
})

test('a result whose call was never seen is dropped without throwing', () => {
  n = 0
  expect(() => buildTranscript([resultMsg('orphan', 'nobody asked')])).not.toThrow()
})

test('a call with no result yet simply has none', () => {
  n = 0
  const [row] = events(buildTranscript([callMsg('tu1', 'Bash', { command: 'sleep 60' })]))
  expect(row?.results).toEqual({})
})

test("a subagent's own tool results stay inside its group", () => {
  n = 0
  const nodes = buildTranscript([
    msg({
      type: 'system',
      title: 'frontend-dev: migrate',
      payload: {
        subtype: 'task_started',
        task_type: 'local_agent',
        task_id: 't1',
        tool_use_id: 'tu-task',
        subagent_type: 'agentoo:frontend-dev',
        description: 'migrate',
        prompt: 'go',
      },
    }),
    { ...callMsg('tu1', 'Read', { file_path: '/a' }, 'frontend-dev: Read'), parentToolUseId: 'tu-task' } as M,
    { ...resultMsg('tu1', 'file body'), parentToolUseId: 'tu-task' } as M,
  ])
  const group = nodes.find((node) => node.kind === 'task')
  if (group?.kind !== 'task') throw new Error('no task group')
  const child = group.children[0]
  if (child?.kind !== 'event') throw new Error('no nested event')
  expect(child.results.tu1?.text).toBe('file body')
})
