// Turning one raw model-proposed candidate (features/learning/review-schema.ts's
// `ReviewCandidate`) into something safe to dedupe against and, eventually,
// insert — or dropping it with a logged reason. Pure over its inputs (a
// library snapshot, the batch's own session ids) and unit-tested
// (tests/learning-candidates.test.ts); no I/O of its own.
//
// This is the second validation stage insertSuggestion (features/learning/
// suggestions.ts) already documents needing: that function re-validates
// `proposed` again at insert
// time regardless of what passed here, so the two-stage shape (loose here,
// strict again right before the write) is deliberate, not redundant — the
// same "validate at every boundary" rule this project already applies
// everywhere a model's output is about to become library content.

import {
  type CreateAgentInput,
  type CreateSkillInput,
  createAgentSchema,
  createSkillSchema,
} from '@/features/library/schema'
import { agentToMarkdown, skillToMarkdown } from '@/library'
import { checkLibraryName } from '@/library/types'
import type { ReviewCandidate } from './review-schema'

/** The library's current state, read once per run (engine.ts) — name ->
 * the item's full markdown exactly as it reads on disk right now, never
 * re-rendered, so a byte-for-byte "did this change" comparison is possible
 * (the same baseMarkdown-vs-current comparison features/learning/
 * suggestions.ts's own `stale` check already relies on). */
export interface LibrarySnapshot {
  agents: Map<string, string>
  skills: Map<string, string>
}

export interface ValidatedCandidate {
  kind: 'agent' | 'skill'
  action: 'create' | 'modify'
  name: string
  title: string
  rationale: string
  sourceSessionIds: string[]
  /** Exactly createAgentSchema/createSkillSchema's output minus `name` — the
   * same shape insertSuggestion's own `proposed` column expects. */
  proposed: Record<string, unknown>
  /** What `proposed` renders to — computed once here so dedupe.ts's
   * deterministic layer, and the eventual insert, never re-render it twice
   * and risk the two disagreeing. */
  proposedMarkdown: string
}

export type CandidateResult =
  | { ok: true; candidate: ValidatedCandidate }
  | { ok: false; reason: string }

/** Exactly suggestions.ts's own (private) renderProposedMarkdown — kept as a
 * second, small copy rather than an import: that function takes the row
 * shape stored in the database, not a freshly-validated zod body, and the
 * learning engine must never write to LIBRARY_DIR or import anything that
 * could tempt it to. */
export function renderMarkdown(
  kind: 'agent' | 'skill',
  name: string,
  body: Omit<CreateAgentInput, 'name'> | Omit<CreateSkillInput, 'name'>,
): string {
  if (kind === 'agent') {
    return agentToMarkdown(body as Omit<CreateAgentInput, 'name'>)
  }
  const skill = body as Omit<CreateSkillInput, 'name'>
  return skillToMarkdown(name, skill.description, skill.body)
}

/**
 * Validates one raw candidate against the library's current state and the
 * real create schemas. Every failure returns `{ ok: false, reason }` rather
 * than throwing — a model's output is untrusted input, and an invalid
 * candidate is an ordinary, expected outcome here, not a bug to crash the
 * batch over.
 */
export function validateCandidate(
  raw: ReviewCandidate,
  library: LibrarySnapshot,
  batchSessionIds: ReadonlySet<string>,
): CandidateResult {
  const sourceSessionIds = raw.sourceSessionIds.filter((id) => batchSessionIds.has(id))

  if (raw.action === 'create') {
    const nameCheck = checkLibraryName(raw.name)
    if (!nameCheck.ok) {
      return { ok: false, reason: `create "${raw.name}" has an invalid name: ${nameCheck.reason}` }
    }
    const taken = raw.kind === 'agent' ? library.agents.has(raw.name) : library.skills.has(raw.name)
    if (taken) {
      return { ok: false, reason: `create "${raw.name}" (${raw.kind}): that name already exists` }
    }
  } else {
    const current =
      raw.kind === 'agent' ? library.agents.get(raw.name) : library.skills.get(raw.name)
    if (current === undefined) {
      return {
        ok: false,
        reason: `modify "${raw.name}" (${raw.kind}): no such item in the library`,
      }
    }
  }

  const schema = raw.kind === 'agent' ? createAgentSchema : createSkillSchema
  const parsed = schema.safeParse({ name: raw.name, ...raw.proposed })
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return {
      ok: false,
      reason: `${raw.action} "${raw.name}" (${raw.kind}): proposed body is invalid: ${detail}`,
    }
  }
  const { name: _name, ...body } = parsed.data
  const proposedMarkdown = renderMarkdown(raw.kind, raw.name, body)

  if (raw.action === 'modify') {
    const current =
      raw.kind === 'agent' ? library.agents.get(raw.name) : library.skills.get(raw.name)
    if (current === proposedMarkdown) {
      return {
        ok: false,
        reason: `modify "${raw.name}" (${raw.kind}): proposed markdown is identical to the current file`,
      }
    }
  }

  return {
    ok: true,
    candidate: {
      kind: raw.kind,
      action: raw.action,
      name: raw.name,
      title: raw.title,
      rationale: raw.rationale,
      sourceSessionIds,
      proposed: body,
      proposedMarkdown,
    },
  }
}
