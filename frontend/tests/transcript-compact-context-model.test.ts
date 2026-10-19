// A `compact_context` message — the summary a compacted session starts from —
// as the transcript model sees it.
//
// The backend writes it as seq 0 with `title: null` and `pending: false`, and
// untitled rows are exactly what `buildTranscript` drops (the init handshake,
// turn bookkeeping), so the one thing that must hold is that this one is
// handled *before* that guard. The other is the boundary: `payload` is
// `unknown` on the wire (see tests/transcript-model.test.ts), so a payload
// that is missing, the wrong shape, or has the wrong type in any one field
// must produce a node with whatever could be read, never a throw — one bad
// first message cannot be allowed to take the whole transcript down.

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
    createdAt: '2026-10-18T09:00:00.000Z',
    ...o,
  }) as M

const PAYLOAD = {
  summary: '## Goal\n\nShip the **compactor**.',
  sourceSessionId: 'src-1',
  sourceTitle: 'Old work',
  sourceTotalCostUsd: 1234.5,
  sourceBranch: 'agentoo/s-old',
  method: 'sdk_compact',
}

const context = (payload: unknown, o: Partial<M> = {}) =>
  msg({ type: 'compact_context', payload, ...o })

const prompt = (text: string) => msg({ type: 'prompt', payload: { text } })

test('a compact_context message becomes a compactContext node, first, with every field parsed', () => {
  n = 0
  const nodes = buildTranscript([context(PAYLOAD), prompt('carry on')])
  expect(nodes.map((node) => node.kind)).toEqual(['compactContext', 'prompt'])
  const [node] = nodes
  if (node?.kind !== 'compactContext') throw new Error('expected a compactContext node')
  expect(node.id).toBe('m0')
  expect(node.seq).toBe(0)
  expect(node.summary).toBe('## Goal\n\nShip the **compactor**.')
  expect(node.sourceSessionId).toBe('src-1')
  expect(node.sourceTitle).toBe('Old work')
  expect(node.sourceTotalCostUsd).toBe(1234.5)
  expect(node.sourceBranch).toBe('agentoo/s-old')
  expect(node.method).toBe('sdk_compact')
  expect(node.createdAt).toBe('2026-10-18T09:00:00.000Z')
})

test('it survives the guard that drops untitled rows, which is the whole point of its own branch', () => {
  n = 0
  // Same shape as the init handshake that guard exists for: no title.
  const nodes = buildTranscript([
    msg({ type: 'system', payload: { subtype: 'init' } }),
    context(PAYLOAD),
  ])
  expect(nodes.map((node) => node.kind)).toEqual(['compactContext'])
})

test('it stays at the top level and in seq order even when delivered after later messages', () => {
  n = 0
  const nodes = buildTranscript([prompt('second'), context(PAYLOAD, { seq: -1 })])
  expect(nodes.map((node) => node.kind)).toEqual(['compactContext', 'prompt'])
})

test('a transcript that is only the context message still has a node', () => {
  n = 0
  expect(buildTranscript([context(PAYLOAD)]).length).toBe(1)
})

test('the other method value is kept, and an unknown one is null rather than passed through', () => {
  n = 0
  const [a] = buildTranscript([context({ ...PAYLOAD, method: 'transcript_summary' })])
  const [b] = buildTranscript([context({ ...PAYLOAD, method: 'telepathy' })])
  const [c] = buildTranscript([context({ ...PAYLOAD, method: 7 })])
  expect(a?.kind === 'compactContext' && a.method).toBe('transcript_summary')
  expect(b?.kind === 'compactContext' && b.method).toBe(null)
  expect(c?.kind === 'compactContext' && c.method).toBe(null)
})

test('an untitled or blank source title is null, so the card falls back to a name of its own', () => {
  n = 0
  const [a] = buildTranscript([context({ ...PAYLOAD, sourceTitle: null })])
  const [b] = buildTranscript([context({ ...PAYLOAD, sourceTitle: '   ' })])
  expect(a?.kind === 'compactContext' && a.sourceTitle).toBe(null)
  expect(b?.kind === 'compactContext' && b.sourceTitle).toBe(null)
})

const MALFORMED: [string, unknown][] = [
  ['a null payload', null],
  ['an undefined payload', undefined],
  ['an empty object', {}],
  ['a string', 'summary'],
  ['a number', 42],
  ['an array', ['summary']],
  [
    'every field the wrong type',
    {
      summary: 5,
      sourceSessionId: { id: 1 },
      sourceTitle: ['x'],
      sourceTotalCostUsd: '1000',
      sourceBranch: false,
      method: null,
    },
  ],
  ['a non-finite cost', { ...PAYLOAD, sourceTotalCostUsd: Number.NaN }],
]

for (const [name, payload] of MALFORMED) {
  test(`${name} does not throw, and yields an empty-but-valid node`, () => {
    n = 0
    let nodes: ReturnType<typeof buildTranscript> = []
    expect(() => {
      nodes = buildTranscript([context(payload), prompt('still here')])
    }).not.toThrow()
    // The rest of the transcript is untouched by it.
    expect(nodes.map((node) => node.kind)).toEqual(['compactContext', 'prompt'])
    const [node] = nodes
    if (node?.kind !== 'compactContext') throw new Error('expected a compactContext node')
    expect(typeof node.summary).toBe('string')
    expect(node.sourceTotalCostUsd === null || Number.isFinite(node.sourceTotalCostUsd)).toBe(true)
    // Nothing unreadable leaks through as a non-string.
    for (const field of [node.sourceSessionId, node.sourceTitle, node.sourceBranch]) {
      expect(field === null || typeof field === 'string').toBe(true)
    }
  })
}

test('a payload with no summary has an empty summary, not undefined', () => {
  n = 0
  const [node] = buildTranscript([context({ ...PAYLOAD, summary: undefined })])
  expect(node?.kind === 'compactContext' && node.summary).toBe('')
})

test('an ordinary untitled message of another type is still dropped', () => {
  n = 0
  expect(buildTranscript([msg({ type: 'system', payload: { subtype: 'init' } })])).toEqual([])
})
