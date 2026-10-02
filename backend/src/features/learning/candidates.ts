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

/** Turns an already-parsed proposal body (zod's own output, in the schema's
 * declared key order) into markdown. The low-level half of
 * `renderProposalMarkdown` below — kept separate because `validateCandidate`
 * already has a parsed body in hand from its own schema check and has no
 * reason to parse `proposed` a second time. */
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
 * Renders a suggestion's markdown straight from its raw `proposed` object —
 * parsing it through the same create schema first, so the result is always
 * in the schema's own key order, never whatever order the object's own keys
 * happen to be in. That matters specifically for a `proposed` read back out
 * of library_suggestions' jsonb column: Postgres's jsonb does not preserve a
 * stored object's original key order, so rendering straight from the raw row
 * (as every caller of this function used to do on its own, each slightly
 * differently) produced markdown whose frontmatter key order silently
 * disagreed with what applying the suggestion actually wrote — the bytes
 * `applySuggestion` writes always go through this same parse (via
 * `suggestions.ts`'s own `validateProposed`), so reparsing here, rather than
 * trusting the object's own order, is what keeps a preview and a dedupe
 * comparison byte-identical to the real write. The one place every caller
 * that only has a raw `proposed` object — never an already-parsed body —
 * goes through: suggestions.ts's detail view and engine.ts's dedupe targets.
 *
 * Throws rather than returning ok:false: every caller of this one is
 * rendering a suggestion that already exists (inserted through
 * insertSuggestion, which validated it against this exact schema), so a
 * parse failure here means something is wrong with already-trusted data, not
 * an ordinary "the model proposed something invalid" outcome — that case is
 * `validateCandidate`'s own, on a raw, not-yet-accepted candidate.
 */
export function renderProposalMarkdown(
  kind: 'agent' | 'skill',
  name: string,
  proposed: Record<string, unknown>,
): string {
  const schema = kind === 'agent' ? createAgentSchema : createSkillSchema
  const parsed = schema.safeParse({ name, ...proposed })
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(
      `Cannot render ${kind} "${name}": stored proposal no longer validates: ${detail}`,
    )
  }
  const { name: _name, ...body } = parsed.data
  return renderMarkdown(kind, name, body)
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
