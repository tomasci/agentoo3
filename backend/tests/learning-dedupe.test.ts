// features/learning/dedupe.ts: the deterministic layer (free, exact), the
// judge call (mocked SDK, same style tests/idea-prompt-worker.test.ts already
// uses for a one-shot structured-output call), honouring the judge's answer,
// treating an unknown id as null, and failing closed when the judge call
// itself fails.

import { afterEach, expect, mock, test } from 'bun:test'
import './setup-env'
import '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

/** What the SDK's query() yields for the next call. Set per test. */
let turnBehaviour: () => AsyncIterable<unknown> = () => empty()
async function* empty(): AsyncIterable<unknown> {}

const queryCalls: { prompt: string; options: Record<string, unknown> }[] = []

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(params)
    return turnBehaviour()
  },
}))

const { renderMarkdown } = await import(`${B}/features/learning/candidates.ts`)
const { isDeterministicDuplicate, judgeDuplicates } = await import(`${B}/features/learning/dedupe.ts`)
import type { ValidatedCandidate } from '@/features/learning/candidates'
import type { DedupeTarget } from '@/features/learning/dedupe'

afterEach(() => {
  queryCalls.length = 0
  turnBehaviour = () => empty()
})

function candidate(partial: Partial<ValidatedCandidate> = {}): ValidatedCandidate {
  const proposedMarkdown = renderMarkdown('agent', 'scout', {
    role: 'subagent',
    team: true,
    description: 'An improved description',
    prompt: 'Original prompt body.',
  })
  return {
    kind: 'agent',
    action: 'modify',
    name: 'scout',
    title: 'Clarify scout',
    rationale: 'Sessions kept asking scout for X',
    sourceSessionIds: ['s1'],
    proposed: { role: 'subagent', team: true, description: 'An improved description', prompt: 'Original prompt body.' },
    proposedMarkdown,
    ...partial,
  }
}

function target(partial: Partial<DedupeTarget> = {}): DedupeTarget {
  return {
    id: 'existing-1',
    kind: 'agent',
    action: 'modify',
    name: 'scout',
    title: 'Clarify scout',
    rationale: 'Sessions kept asking scout for X',
    proposedMarkdown: candidate().proposedMarkdown,
    ...partial,
  }
}

function successStream(answer: unknown, costUsd = 0.01) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
    yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), total_cost_usd: costUsd }
  })()
}

function failureStream(subtype: string, errors: string[] = ['boom']) {
  return (async function* () {
    yield { type: 'result', subtype, is_error: true, errors, total_cost_usd: 0.005 }
  })()
}

// --- deterministic layer -----------------------------------------------------

test('deterministic: same kind+action+name+identical proposed markdown is a duplicate', () => {
  const dup = isDeterministicDuplicate(candidate(), [target()])
  expect(dup?.id).toBe('existing-1')
})

test('deterministic: a different proposed markdown for the same target is NOT a duplicate', () => {
  const differentMarkdown = renderMarkdown('agent', 'scout', {
    role: 'subagent',
    team: true,
    description: 'A totally different improvement',
    prompt: 'Original prompt body.',
  })
  const dup = isDeterministicDuplicate(candidate(), [target({ proposedMarkdown: differentMarkdown })])
  expect(dup).toBeUndefined()
})

test('deterministic: a different name is NOT a duplicate even with identical markdown text', () => {
  const dup = isDeterministicDuplicate(candidate({ name: 'ranger' }), [target({ name: 'scout' })])
  expect(dup).toBeUndefined()
})

test('deterministic: no existing targets at all is never a duplicate', () => {
  expect(isDeterministicDuplicate(candidate(), [])).toBeUndefined()
})

// --- the judge call -----------------------------------------------------------

test('no candidates: the judge is not called at all', async () => {
  const result = await judgeDuplicates([], [target()])
  expect(result).toEqual({ ok: true, duplicateOf: [], costUsd: 0 })
  expect(queryCalls).toHaveLength(0)
})

test('judge marks a candidate as a duplicate of a given existing id', async () => {
  turnBehaviour = () =>
    successStream({ results: [{ candidateIndex: 0, duplicateOfId: 'existing-1', reason: 'same idea' }] })
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.duplicateOf).toEqual(['existing-1'])
  expect(result.costUsd).toBeGreaterThan(0)
})

test('judge says null: not a duplicate', async () => {
  turnBehaviour = () =>
    successStream({ results: [{ candidateIndex: 0, duplicateOfId: null, reason: 'genuinely new' }] })
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.duplicateOf).toEqual([null])
})

test('an id the judge invents that is not in the existing list counts as null', async () => {
  turnBehaviour = () =>
    successStream({
      results: [{ candidateIndex: 0, duplicateOfId: 'not-a-real-id', reason: 'hallucinated' }],
    })
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.duplicateOf).toEqual([null])
})

test('a candidate index the judge never mentions defaults to null, not a duplicate', async () => {
  turnBehaviour = () => successStream({ results: [] })
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.duplicateOf).toEqual([null])
})

test('judge call failure (result error) fails closed: ok is false, cost still reported', async () => {
  turnBehaviour = () => failureStream('error_during_execution')
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason.length).toBeGreaterThan(0)
  expect(result.costUsd).toBeGreaterThan(0)
})

test('judge call failure (malformed JSON) fails closed', async () => {
  turnBehaviour = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'not json', total_cost_usd: 0.002 }
    })()
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(false)
})

test('judge call failure (answer does not match the expected shape) fails closed', async () => {
  turnBehaviour = () => successStream({ somethingElse: true })
  const result = await judgeDuplicates([candidate()], [target()])
  expect(result.ok).toBe(false)
})

test('judges independently across multiple candidates', async () => {
  turnBehaviour = () =>
    successStream({
      results: [
        { candidateIndex: 0, duplicateOfId: 'existing-1', reason: 'dup' },
        { candidateIndex: 1, duplicateOfId: null, reason: 'new' },
      ],
    })
  const result = await judgeDuplicates(
    [candidate({ name: 'scout' }), candidate({ name: 'ranger' })],
    [target()],
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.duplicateOf).toEqual(['existing-1', null])
})
