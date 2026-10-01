// Two layers of "has this already been proposed", run in order, against every
// current pending/rejected library_suggestions row, every candidate this same
// run has already accepted, and (new in both layers) every earlier candidate
// still alive within the very same batch — see db/schema.ts's own comment on
// library_suggestions for why a rejected row still blocks until a human
// deletes it: matching has to be semantic, not only a string match, because
// the same idea worded differently is still the same idea.
//
// Layer 1 (isDeterministicDuplicate) is exact and free: same kind, action,
// name and byte-identical proposed markdown. Layer 2 (judgeDuplicates) is an
// LLM call, and is the one that catches the same idea worded differently —
// but it can fail like any model call, and a failed judge call must fail
// *closed*: nothing from that batch is inserted, full stop, rather than
// falling back to "layer 1 alone said nothing, so insert it anyway" and
// risking a real duplicate on file.

import type { ValidatedCandidate } from './candidates'
import { runOneShotQuery } from './model-call'
import { DEDUPE_JUDGE_ANSWER_JSON_SCHEMA, dedupeJudgeAnswerSchema } from './review-schema'

/** One thing a candidate might duplicate: an existing `library_suggestions`
 * row (pending or rejected, `id` is its real uuid), a candidate already
 * accepted earlier in this same run (`id` is also its real uuid, assigned at
 * insert time), or — only within one batch's own dedupe pass — an earlier
 * candidate in that very batch that has not been inserted anywhere yet (`id`
 * is the synthetic `candidate:<index>`, matching the index the judge is
 * shown for it, see `buildJudgePrompt` below). Nothing downstream ever needs
 * to resolve the synthetic form back to a row: "duplicates X" only ever
 * means "skip this one", the same outcome as duplicating a database row. */
export interface DedupeTarget {
  id: string
  kind: 'agent' | 'skill'
  action: 'create' | 'modify'
  name: string
  title: string
  rationale: string
  proposedMarkdown: string
}

/** Same kind + action + name + byte-identical proposed markdown as something
 * already on file (or already accepted this run) is a duplicate regardless of
 * what any model call says — this is the free, deterministic half. */
export function isDeterministicDuplicate(
  candidate: ValidatedCandidate,
  existing: readonly DedupeTarget[],
): DedupeTarget | undefined {
  return existing.find(
    (e) =>
      e.kind === candidate.kind &&
      e.action === candidate.action &&
      e.name === candidate.name &&
      e.proposedMarkdown === candidate.proposedMarkdown,
  )
}

const DEDUPE_JUDGE_INSTRUCTION = `
You judge whether a proposed library change duplicates one already on file, or duplicates another candidate earlier in this same list.

A duplicate is the same idea or change as an existing one, even if worded differently — the same target, the same kind of change, addressing the same underlying pattern. A genuinely different improvement to the same agent or skill is NOT a duplicate, even when it touches the same file.

You are given a numbered list of existing items, each with an id, and a numbered list of candidates, each also carrying an id of the form "candidate:<index>". For every candidate, decide whether it duplicates an existing item or an earlier candidate in this same list — never a later candidate, and never itself. If it does, answer with that exact id (an existing item's id, or an earlier candidate's "candidate:<index>" id). If it does not duplicate anything, answer null. Judge each candidate on its own merits. Never invent an id that was not given to you — if you are unsure which item or earlier candidate a candidate matches, or none clearly do, answer null rather than guessing.

Return a JSON object: { "results": [ { "candidateIndex": <the candidate's 0-based index>, "duplicateOfId": <an id from the existing list, an earlier candidate's "candidate:<index>" id, or null>, "reason": "<one sentence>" }, ... ] }. Include exactly one entry per candidate.
`.trim()

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function buildJudgePrompt(
  candidates: ValidatedCandidate[],
  existing: readonly DedupeTarget[],
): string {
  const existingBlock = existing.length
    ? existing
        .map(
          (e, i) =>
            `${i + 1}. id=${e.id} kind=${e.kind} action=${e.action} name=${e.name}\n` +
            `   title: ${truncate(e.title, 200)}\n   rationale: ${truncate(e.rationale, 400)}`,
        )
        .join('\n')
    : '(none)'

  const candidatesBlock = candidates
    .map(
      (c, i) =>
        `${i}. id=candidate:${i} kind=${c.kind} action=${c.action} name=${c.name}\n` +
        `   title: ${truncate(c.title, 200)}\n   rationale: ${truncate(c.rationale, 400)}\n` +
        `   proposed markdown (truncated): ${truncate(c.proposedMarkdown, 1000)}`,
    )
    .join('\n')

  return (
    `## Existing suggestions (pending or rejected), plus candidates already accepted this run\n\n${existingBlock}\n\n` +
    `## Candidates to judge\n\n${candidatesBlock}`
  )
}

export type JudgeResult =
  | { ok: true; duplicateOf: (string | null)[]; costUsd: number }
  | { ok: false; reason: string; costUsd: number }

/**
 * Calls the judge once for the whole batch of surviving candidates. Returns
 * `duplicateOf[i]` for each candidate — the existing item's id it duplicates,
 * or null — in the same order as `candidates`. An index the judge did not
 * mention at all is treated as null (not a duplicate): the judge's job is to
 * flag matches, and silence about a candidate is not evidence either way.
 */
export async function judgeDuplicates(
  candidates: ValidatedCandidate[],
  existing: readonly DedupeTarget[],
): Promise<JudgeResult> {
  if (candidates.length === 0) return { ok: true, duplicateOf: [], costUsd: 0 }

  const result = await runOneShotQuery({
    systemPrompt: DEDUPE_JUDGE_INSTRUCTION,
    prompt: buildJudgePrompt(candidates, existing),
    outputJsonSchema: DEDUPE_JUDGE_ANSWER_JSON_SCHEMA,
  })
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason ?? 'the judge call failed for an unknown reason',
      costUsd: result.costUsd,
    }
  }

  const parsed = dedupeJudgeAnswerSchema.safeParse(result.data)
  if (!parsed.success) {
    return {
      ok: false,
      reason: `judge answer did not match the expected shape: ${parsed.error.message}`,
      costUsd: result.costUsd,
    }
  }

  // Never trust the steer: an id the judge names that is not one we actually
  // showed it counts as null — not "treat it as a duplicate of something we
  // cannot identify".
  const existingIds = new Set(existing.map((e) => e.id))
  const duplicateOf: (string | null)[] = candidates.map(() => null)
  for (const entry of parsed.data.results) {
    if (entry.candidateIndex < 0 || entry.candidateIndex >= candidates.length) continue
    duplicateOf[entry.candidateIndex] = resolveDuplicateOfId(
      entry.duplicateOfId,
      entry.candidateIndex,
      existingIds,
    )
  }
  return { ok: true, duplicateOf, costUsd: result.costUsd }
}

const CANDIDATE_SELF_ID = /^candidate:(\d+)$/

/**
 * Resolves one judge-reported id against what it is actually allowed to
 * mean: a real existing item's id, or an earlier candidate's synthetic
 * `candidate:<index>` id — "earlier" meaning strictly less than the
 * candidate's own index, since a candidate cannot duplicate itself or a
 * candidate the judge has not reached yet (that candidate's own duplicate
 * status is not decided until its own entry in `results`, so pointing
 * forward would make the answer depend on an order the judge does not
 * actually follow). Anything else — an unrecognised id, a malformed
 * synthetic id, an index that is not strictly earlier — counts as null, the
 * same fail-closed-to-null treatment an unknown id already gets above.
 */
function resolveDuplicateOfId(
  duplicateOfId: string | null,
  candidateIndex: number,
  existingIds: ReadonlySet<string>,
): string | null {
  if (duplicateOfId === null) return null
  if (existingIds.has(duplicateOfId)) return duplicateOfId
  const match = CANDIDATE_SELF_ID.exec(duplicateOfId)
  if (!match?.[1]) return null
  const referencedIndex = Number(match[1])
  return referencedIndex < candidateIndex ? duplicateOfId : null
}
