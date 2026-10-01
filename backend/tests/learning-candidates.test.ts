// features/learning/candidates.ts: validating one raw model-proposed
// candidate against the library's current state and the real library
// schemas — pure, no filesystem or database involved (the library snapshot
// is handed in directly).

import { expect, test } from 'bun:test'
import './setup-env'
// createAgentSchema/createSkillSchema call `.openapi()` on their fields —
// that method only exists once @hono/zod-openapi has patched zod's
// prototype (its own module does this as a side effect at import time), per
// tests/system-models.test.ts's identical precedent.
import '@hono/zod-openapi'
import {
  type LibrarySnapshot,
  renderMarkdown,
  validateCandidate,
} from '@/features/learning/candidates'
import type { ReviewCandidate } from '@/features/learning/review-schema'

const existingAgentMarkdown = renderMarkdown('agent', 'scout', {
  role: 'subagent',
  team: true,
  description: 'Original description',
  prompt: 'Original prompt body.',
})
const existingSkillMarkdown = renderMarkdown('skill', 'triage', {
  description: 'Original triage description',
  body: 'Step one.',
})

function library(): LibrarySnapshot {
  return {
    agents: new Map([['scout', existingAgentMarkdown]]),
    skills: new Map([['triage', existingSkillMarkdown]]),
  }
}

function candidate(partial: Partial<ReviewCandidate>): ReviewCandidate {
  return {
    kind: 'agent',
    action: 'create',
    name: 'new-agent',
    title: 'A title',
    rationale: 'A rationale',
    sourceSessionIds: [],
    proposed: { description: 'A new agent', prompt: 'Do the thing.' },
    ...partial,
  }
}

const sessions = new Set(['s1', 's2'])

test('create: an invalid name is dropped', () => {
  const result = validateCandidate(candidate({ name: 'Not Valid!' }), library(), sessions)
  expect(result.ok).toBe(false)
})

test('create: a name already in the library (agent) is dropped', () => {
  const result = validateCandidate(candidate({ name: 'scout' }), library(), sessions)
  expect(result.ok).toBe(false)
})

test('create: a name already in the library (skill) is dropped', () => {
  const result = validateCandidate(
    candidate({ kind: 'skill', name: 'triage', proposed: { description: 'x', body: 'y' } }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(false)
})

test('create: an invalid proposed body is dropped', () => {
  const result = validateCandidate(
    candidate({ name: 'ok-name', proposed: { description: '' } }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(false)
})

test('create: a valid, available name and body is accepted', () => {
  const result = validateCandidate(
    candidate({ name: 'ok-name', sourceSessionIds: ['s1', 'unrelated-session'] }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.candidate.name).toBe('ok-name')
  expect(result.candidate.action).toBe('create')
  // Filtered down to only the ids actually present in this batch.
  expect(result.candidate.sourceSessionIds).toEqual(['s1'])
  expect(result.candidate.proposedMarkdown).toContain('A new agent')
})

test('modify: a target that does not exist is dropped', () => {
  const result = validateCandidate(
    candidate({ action: 'modify', name: 'nonexistent', proposed: { description: 'x', prompt: 'y' } }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(false)
})

test('modify: an invalid proposed body is dropped even though the target exists', () => {
  const result = validateCandidate(
    candidate({ action: 'modify', name: 'scout', proposed: { description: '' } }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(false)
})

test('modify: proposed markdown identical to the current file is dropped', () => {
  const result = validateCandidate(
    candidate({
      action: 'modify',
      name: 'scout',
      proposed: { role: 'subagent', team: true, description: 'Original description', prompt: 'Original prompt body.' },
    }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(false)
})

test('modify: proposed markdown that genuinely differs is accepted', () => {
  const result = validateCandidate(
    candidate({
      action: 'modify',
      name: 'scout',
      proposed: { role: 'subagent', team: true, description: 'An improved description', prompt: 'Original prompt body.' },
    }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.candidate.proposedMarkdown).not.toBe(existingAgentMarkdown)
  expect(result.candidate.proposedMarkdown).toContain('An improved description')
})

test('modify: a skill target resolves against the skills map, not the agents one', () => {
  const result = validateCandidate(
    candidate({
      kind: 'skill',
      action: 'modify',
      name: 'triage',
      proposed: { description: 'An improved triage description', body: 'Step one.' },
    }),
    library(),
    sessions,
  )
  expect(result.ok).toBe(true)
})
