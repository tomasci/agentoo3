// `modelOf` and the `model` it puts on an `answer` node.
//
// `payload` is `z.unknown()` on the wire (see streamedMessageSchema, and the
// note at the top of tests/streamed-message-real-frames.test.ts), so every
// shape below is something the transcript can actually be handed rather than
// a defensive fantasy: nothing between the SDK and this function parses it.
// The one rule the renderer depends on is that a miss is `null` — not
// `undefined`, not the string "undefined", and never a throw, because the
// answer node's field is typed `string | null` and the row is rendered on
// truthiness.

import { expect, test } from 'bun:test'
import { buildTranscript, modelOf } from '../src/features/sessions/lib/transcript'

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
    createdAt: '2026-09-06T11:40:23.812Z',
    ...o,
  }) as M

/** An assistant frame in the shape the backend really publishes — the
 * `message` envelope of tests/streamed-message-real-frames.test.ts:54, cut
 * down to the keys this reads. */
const assistant = (model: string | undefined, text: string, extra: Partial<M> = {}): M =>
  msg({
    type: 'assistant',
    title: `orchestrator: ${text}`,
    payload: {
      type: 'assistant',
      message: {
        id: 'msg_011CenG3EJ5EpzsZ2HPvgFfL',
        role: 'assistant',
        type: 'message',
        ...(model === undefined ? {} : { model }),
        content: [{ type: 'text', text }],
      },
    },
    ...extra,
  })

test('modelOf reads an assistant frame’s model, verbatim', () => {
  n = 0
  expect(modelOf(assistant('claude-opus-5', 'done'))).toBe('claude-opus-5')
  // Brackets and version suffixes reach the transcript exactly as the SDK
  // wrote them; nothing here prettifies or normalises.
  expect(modelOf(assistant('claude-opus-5-5[1m]', 'done'))).toBe('claude-opus-5-5[1m]')
  expect(modelOf(assistant('claude-haiku-4-5-20251001', 'done'))).toBe('claude-haiku-4-5-20251001')
})

test('every row that names no model gives exactly null, never undefined', () => {
  n = 0
  const rows: [string, M][] = [
    ['a user prompt', msg({ type: 'prompt', payload: { text: 'commit & push' } })],
    ['a result frame', msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } })],
    [
      'a system/init frame',
      msg({
        type: 'system',
        payload: { subtype: 'init', session_id: 'a37320fc', tools: [], model: 'claude-opus-5' },
      }),
    ],
    ['a null payload', msg({ type: 'assistant', title: 'x', payload: null as never })],
    ['an undefined payload', msg({ type: 'assistant', title: 'x', payload: undefined as never })],
    ['a message with no model key', assistant(undefined, 'done')],
    ['payload.message === null', msg({ type: 'assistant', title: 'x', payload: { message: null } })],
    ['payload.message a string', msg({ type: 'assistant', title: 'x', payload: { message: 'hi' } })],
    ['payload itself a string', msg({ type: 'assistant', title: 'x', payload: 'hi' as never })],
    ['payload itself an array', msg({ type: 'assistant', title: 'x', payload: [] as never })],
    ['model a number', msg({ type: 'assistant', title: 'x', payload: { message: { model: 5 } } })],
    ['model an object', msg({ type: 'assistant', title: 'x', payload: { message: { model: { id: 'opus' } } } })],
    ['model an array', msg({ type: 'assistant', title: 'x', payload: { message: { model: ['opus'] } } })],
    ['model null', msg({ type: 'assistant', title: 'x', payload: { message: { model: null } } })],
    ['model true', msg({ type: 'assistant', title: 'x', payload: { message: { model: true } } })],
  ]

  for (const [name, row] of rows) {
    const got = modelOf(row)
    // Object.is, because `toBeNull()` would pass for a value that is merely
    // nullish and the field is declared `string | null`.
    expect({ name, isNull: Object.is(got, null), got }).toEqual({ name, isNull: true, got: null })
  }
})

test('a system/init frame’s own top-level `model` is not mistaken for a message model', () => {
  // The init frame genuinely carries `model` at the payload root — it names
  // the session default, not the model that wrote any particular message, and
  // reading it here would put a label on rows nothing produced.
  n = 0
  const init = msg({
    type: 'system',
    title: 'session started',
    payload: { subtype: 'init', model: 'claude-opus-5' },
  })
  expect(modelOf(init)).toBeNull()
})

test('the answer node carries the model of the message it was promoted from', () => {
  // markAnswers rebuilds the node from `text` alone and drops the source
  // message, so the model has to be read before that happens or it is gone.
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    assistant('claude-haiku-4-5', 'thinking out loud'),
    assistant('claude-opus-5', 'the answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])

  const answer = nodes.find((x) => x.kind === 'answer')
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.text).toBe('the answer')
  // The promoted message's own model — not the earlier reply's, and not a
  // value hoisted off the first assistant frame in the turn.
  expect(answer.model).toBe('claude-opus-5')
})

test('an answer promoted from a message with no model gets null, not undefined', () => {
  n = 0
  const nodes = buildTranscript([
    assistant(undefined, 'the answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  const answer = nodes[0]
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(Object.is(answer.model, null)).toBe(true)
  expect('model' in answer).toBe(true)
})

test('two turns keep their own answers’ models apart', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'one' } }),
    assistant('claude-opus-5', 'first answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
    msg({ type: 'prompt', payload: { text: 'two' } }),
    assistant('claude-sonnet-5', 'second answer'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])

  const answers = nodes.filter((x) => x.kind === 'answer')
  expect(answers.map((a) => (a.kind === 'answer' ? [a.text, a.model] : null))).toEqual([
    ['first answer', 'claude-opus-5'],
    ['second answer', 'claude-sonnet-5'],
  ])
})

test('a subagent’s model is kept on its own nested row, not merged with the orchestrator’s', () => {
  // Both frames below are the real shapes from
  // tests/streamed-message-real-frames.test.ts (:54 is the subagent, with a
  // parentToolUseId; :94 is the orchestrator). The models differ here because
  // that is the case the per-message label exists for — a session can run a
  // cheap subagent under an expensive orchestrator.
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'build it' } }),
    msg({
      type: 'system',
      title: 'tester: check the capture',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'toolu_01QmjoUcD2n9Yf5JS921B1xY',
        subagent_type: 'tester',
        description: 'check the capture',
      },
    }),
    assistant('claude-haiku-4-5', 'Let me check the background live capture.', {
      parentToolUseId: 'toolu_01QmjoUcD2n9Yf5JS921B1xY',
    }),
    assistant('claude-opus-5', 'All fixes landed.'),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])

  const task = nodes.find((x) => x.kind === 'task')
  if (task?.kind !== 'task') throw new Error('expected a task node')
  const nested = task.children[0]
  if (nested?.kind !== 'event') throw new Error('expected the subagent row to nest')
  expect(modelOf(nested.message)).toBe('claude-haiku-4-5')

  const answer = nodes.find((x) => x.kind === 'answer')
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.model).toBe('claude-opus-5')
})
